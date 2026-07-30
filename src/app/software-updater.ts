import type {
  CheckOptions,
  DownloadEvent,
  DownloadOptions,
} from "@tauri-apps/plugin-updater";
import {
  desktopSessionStore,
  isTauriRuntime,
  type DesktopSessionStore,
} from "./tauri-bridge";

export type SoftwareUpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "restart-required"
  | "relaunching"
  | "auth-required"
  | "error";

export type SoftwareUpdateErrorStage = "check" | "download" | "install" | "relaunch";

export interface SoftwareUpdateSnapshot {
  phase: SoftwareUpdatePhase;
  currentVersion: string | null;
  availableVersion: string | null;
  publishedAt: string | null;
  notes: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  checkedAt: number | null;
  error: string | null;
  errorStage: SoftwareUpdateErrorStage | null;
}

interface NativeSoftwareUpdate {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  download(
    onEvent?: (event: DownloadEvent) => void,
    options?: DownloadOptions,
  ): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}

type NativeCheck = (options?: CheckOptions) => Promise<NativeSoftwareUpdate | null>;
type Relaunch = () => Promise<void>;
type Listener = (snapshot: SoftwareUpdateSnapshot) => void;
type SessionProbe = (headers: Record<string, string>) => Promise<boolean>;

export interface SoftwareUpdaterControl {
  snapshot(): SoftwareUpdateSnapshot;
  subscribe(listener: Listener): () => void;
  setPrepareForRelaunch(prepare: () => Promise<void>): void;
  check(): Promise<void>;
  download(): Promise<void>;
  installAndRelaunch(): Promise<void>;
}

const CHECK_TIMEOUT_MS = 90_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export async function probeSoftwareUpdateSession(
  headers: Record<string, string>,
  apiUrl = import.meta.env.VITE_LIBRARY_API_URL?.trim().replace(/\/$/, "") ?? "",
  request: typeof fetch = (input, init) => fetch(input, init),
): Promise<boolean> {
  if (!apiUrl) throw new Error("The desktop release service URL is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await request(`${apiUrl}/auth/session`, {
      credentials: "omit",
      headers: { authorization: headers.Authorization },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) throw new Error(`Desktop release session check failed (${response.status}).`);
    const body = await response.json().catch(() => null) as { authenticated?: unknown } | null;
    if (!body || typeof body.authenticated !== "boolean") {
      throw new Error("The desktop release service returned an invalid session response.");
    }
    return body.authenticated;
  } finally {
    clearTimeout(timeout);
  }
}

const initialSnapshot = (supported: boolean): SoftwareUpdateSnapshot => ({
  phase: supported ? "idle" : "unsupported",
  currentVersion: null,
  availableVersion: null,
  publishedAt: null,
  notes: null,
  downloadedBytes: 0,
  totalBytes: null,
  checkedAt: null,
  error: null,
  errorStage: null,
});

/**
 * Coordinates the signed Tauri updater without ever exposing the desktop bearer
 * to the DOM. Checks happen silently; downloading and installation are invoked
 * only by explicit Settings actions.
 */
export class SoftwareUpdater implements SoftwareUpdaterControl {
  private state: SoftwareUpdateSnapshot;
  private update: NativeSoftwareUpdate | null = null;
  private checkFlight: Promise<void> | null = null;
  private readonly listeners = new Set<Listener>();
  private prepareForRelaunch: () => Promise<void> = async () => undefined;

  constructor(
    private readonly supported = isTauriRuntime && import.meta.env.VITE_ENABLE_UPDATER === "true",
    private readonly sessionStore: DesktopSessionStore = desktopSessionStore,
    private readonly nativeCheck: NativeCheck = async (options) => {
      const { check } = await import("@tauri-apps/plugin-updater");
      return check(options);
    },
    private readonly relaunch: Relaunch = async () => {
      const process = await import("@tauri-apps/plugin-process");
      await process.relaunch();
    },
    private readonly now: () => number = Date.now,
    private readonly sessionProbe: SessionProbe = probeSoftwareUpdateSession,
  ) {
    this.state = initialSnapshot(supported);
  }

  snapshot(): SoftwareUpdateSnapshot {
    return { ...this.state };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  setPrepareForRelaunch(prepare: () => Promise<void>): void {
    this.prepareForRelaunch = prepare;
  }

  check(): Promise<void> {
    if (!this.supported) return Promise.resolve();
    if (this.checkFlight) return this.checkFlight;
    if (!checkable(this.state)) return Promise.resolve();
    // Claim the busy state before releasing stale native state or reading the
    // Keychain. Those are both asynchronous; setting `checking` afterwards let
    // two rapid Settings/startup calls enter the native updater concurrently.
    const checkedAt = this.state.checkedAt;
    this.set({
      ...initialSnapshot(true),
      phase: "checking",
      checkedAt,
    });
    const operation = this.performCheck();
    const flight = operation.finally(() => {
      if (this.checkFlight === flight) this.checkFlight = null;
    });
    this.checkFlight = flight;
    return flight;
  }

  private async performCheck(): Promise<void> {
    // Drop any previously offered native resource before authentication. If the
    // session has expired, reconnecting must perform a fresh metadata check
    // rather than reviving a stale download URL.
    await this.releaseUpdate();
    const headers = await this.authenticatedHeaders("check");
    if (!headers) return;
    try {
      if (!await this.sessionProbe(headers)) {
        await this.sessionStore.clear().catch(() => undefined);
        this.set({
          ...initialSnapshot(true),
          phase: "auth-required",
          checkedAt: this.state.checkedAt,
          error: "The saved GitHub session expired. Reconnect GitHub in Library & GitHub Sync, then check again.",
          errorStage: "check",
        });
        return;
      }
      const update = await this.nativeCheck({ headers, timeout: CHECK_TIMEOUT_MS });
      const checkedAt = this.now();
      if (!update) {
        this.set({
          ...initialSnapshot(true),
          phase: "up-to-date",
          checkedAt,
        });
        return;
      }
      this.update = update;
      this.set({
        phase: "available",
        currentVersion: update.currentVersion,
        availableVersion: update.version,
        publishedAt: update.date ?? null,
        notes: update.body?.trim() || null,
        downloadedBytes: 0,
        totalBytes: null,
        checkedAt,
        error: null,
        errorStage: null,
      });
    } catch (error) {
      this.fail("check", error, "Could not check for an MdLyx update.");
    }
  }

  async download(): Promise<void> {
    if (!this.update || !downloadable(this.state)) return;
    const headers = await this.authenticatedHeaders("download");
    if (!headers) {
      await this.releaseUpdate();
      return;
    }
    this.set({
      ...this.state,
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      errorStage: null,
    });
    try {
      await this.update.download(
        (event) => this.onDownloadEvent(event),
        { headers, timeout: DOWNLOAD_TIMEOUT_MS },
      );
      this.set({ ...this.state, phase: "downloaded", error: null, errorStage: null });
    } catch (error) {
      this.fail("download", error, "The update could not be downloaded.");
      if (this.state.phase === "auth-required") await this.releaseUpdate();
    }
  }

  async installAndRelaunch(): Promise<void> {
    if (!this.update) return;
    const alreadyInstalled = this.state.phase === "restart-required" || this.state.errorStage === "relaunch";
    if (!alreadyInstalled && this.state.phase !== "downloaded" && this.state.errorStage !== "install") return;
    if (!alreadyInstalled) {
      this.set({ ...this.state, phase: "installing", error: null, errorStage: null });
      if (!await this.prepare("install")) return;
      try {
        await this.update.install();
      } catch (error) {
        this.fail("install", error, "The update could not be installed. MdLyx was not restarted.");
        return;
      }
    }
    this.set({ ...this.state, phase: "relaunching", error: null, errorStage: null });
    if (!await this.prepare("relaunch")) {
      this.set({ ...this.state, phase: "restart-required" });
      return;
    }
    try {
      await this.relaunch();
    } catch (error) {
      this.fail("relaunch", error, "The update was installed, but MdLyx could not relaunch. Quit and reopen the app.");
      this.set({ ...this.state, phase: "restart-required" });
    }
  }

  private async prepare(stage: "install" | "relaunch"): Promise<boolean> {
    try {
      await this.prepareForRelaunch();
      return true;
    } catch (error) {
      this.fail(
        stage,
        error,
        stage === "install"
          ? "MdLyx could not preserve the newest recovery snapshot, so the update was not installed."
          : "MdLyx could not preserve the newest recovery snapshot, so it was not relaunched.",
      );
      return false;
    }
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    await this.releaseUpdate();
  }

  private async authenticatedHeaders(stage: SoftwareUpdateErrorStage): Promise<Record<string, string> | null> {
    if (!this.sessionStore.enabled) {
      this.fail(stage, new Error("Desktop session storage is unavailable."), "Desktop updates are unavailable.");
      return null;
    }
    try {
      const bearer = (await this.sessionStore.get())?.trim();
      if (!bearer) {
        this.set({
          ...this.state,
          phase: "auth-required",
          error: "Connect GitHub in Library & GitHub Sync to check private desktop releases.",
          errorStage: stage,
        });
        return null;
      }
      return {
        Authorization: `Bearer ${bearer}`,
        Origin: "tauri://localhost",
      };
    } catch (error) {
      this.fail(stage, error, "MdLyx could not read the GitHub session from macOS Keychain.");
      return null;
    }
  }

  private onDownloadEvent(event: DownloadEvent): void {
    if (event.event === "Started") {
      this.set({
        ...this.state,
        downloadedBytes: 0,
        totalBytes: event.data.contentLength ?? null,
      });
      return;
    }
    if (event.event === "Progress") {
      this.set({
        ...this.state,
        downloadedBytes: this.state.downloadedBytes + event.data.chunkLength,
      });
    }
  }

  private fail(stage: SoftwareUpdateErrorStage, error: unknown, fallback: string): void {
    const raw = error instanceof Error ? error.message : "";
    const auth = /(?:401|403|unauthori[sz]ed|forbidden|authentication)/i.test(raw);
    this.set({
      ...this.state,
      phase: auth ? "auth-required" : "error",
      error: auth
        ? "Desktop release access was not authorized. Reconnect GitHub, then check again."
        : safeError(raw, fallback),
      errorStage: stage,
    });
  }

  private async releaseUpdate(): Promise<void> {
    const previous = this.update;
    this.update = null;
    if (previous) {
      try {
        await previous.close();
      } catch {
        // Releasing a stale native resource is best-effort and must not block a
        // fresh update check.
      }
    }
  }

  private set(next: SoftwareUpdateSnapshot): void {
    this.state = next;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function checkable(snapshot: SoftwareUpdateSnapshot): boolean {
  return snapshot.phase === "idle"
    || snapshot.phase === "up-to-date"
    || snapshot.phase === "available"
    || snapshot.phase === "auth-required"
    || (snapshot.phase === "error" && snapshot.errorStage === "check");
}

function downloadable(snapshot: SoftwareUpdateSnapshot): boolean {
  return snapshot.phase === "available"
    || (snapshot.phase === "error" && snapshot.errorStage === "download");
}

function safeError(raw: string, fallback: string): string {
  const message = raw.trim();
  if (!message) return fallback;
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "the update service")
    .slice(0, 280);
}

export const softwareUpdater = new SoftwareUpdater();
