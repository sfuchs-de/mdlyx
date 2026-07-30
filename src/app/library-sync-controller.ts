import {
  githubLibrary,
  type GitHubDeviceAuthorization,
  type GitHubLibrary,
  type GitHubSyncStatus,
  type SharingAccess,
  type SharingInvitation,
  type SharedAccessRole,
} from "./github-library";
import { openExternalUrl } from "./tauri-bridge";

export interface DeviceConnection extends GitHubDeviceAuthorization {
  expiresAt: number;
  remainingSeconds: number;
}

export interface LibrarySyncSnapshot {
  status: GitHubSyncStatus;
  connected: boolean;
  error: string | null;
  device: DeviceConnection | null;
}

type Listener = (snapshot: LibrarySyncSnapshot) => void;

export class LibrarySyncController {
  private status: GitHubSyncStatus = { state: "unavailable", authenticated: false };
  private error: string | null = null;
  private device: DeviceConnection | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly library: GitHubLibrary = githubLibrary,
    private readonly openUrl: (url: string) => Promise<void> = openExternalUrl,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): LibrarySyncSnapshot {
    return {
      status: { ...this.status },
      connected: this.status.state === "ready" && this.status.authenticated,
      error: this.error,
      device: this.device ? { ...this.device } : null,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    this.status = await this.library.syncStatus();
    this.emit();
  }

  setError(message?: string): void {
    this.error = message ?? null;
    this.emit();
  }

  async start(): Promise<void> {
    try {
      this.cancelTimers();
      this.error = null;
      const authorization = await this.library.startDeviceAuthorization();
      this.device = {
        ...authorization,
        expiresAt: this.now() + authorization.expiresIn * 1000,
        remainingSeconds: authorization.expiresIn,
      };
      this.emit();
      this.startCountdown();
      this.schedulePoll(authorization.interval);
    } catch (error) {
      this.error = message(error, "Could not start GitHub verification.");
      this.device = null;
      this.emit();
    }
  }

  cancel(): void {
    this.cancelTimers();
    this.cancelPendingAuthorization();
    this.device = null;
    this.error = null;
    this.emit();
  }

  async openVerification(): Promise<void> {
    if (!this.device) return;
    try {
      await this.openUrl(this.device.verificationUri);
      this.error = null;
    } catch (error) {
      this.error = message(error, "Could not open GitHub. Copy the link and code instead.");
    }
    this.emit();
  }

  async copyCode(): Promise<void> {
    if (this.device) await this.copy(this.device.userCode);
  }

  async copyLink(): Promise<void> {
    if (this.device) await this.copy(this.device.verificationUri);
  }

  async logout(): Promise<void> {
    this.cancelTimers();
    await this.library.logout();
    this.device = null;
    this.error = null;
    await this.refresh();
  }

  async sharingAccess(): Promise<SharingAccess> {
    return this.library.sharingAccess();
  }

  async createInvitation(principalId: string, expiresInSeconds?: number): Promise<SharingInvitation> {
    return this.library.createInvitation(principalId, expiresInSeconds);
  }

  async revokeInvitation(id: string): Promise<void> {
    await this.library.revokeInvitation(id);
  }

  async createSharingPrincipal(
    id: string,
    displayName: string,
    grants: Record<string, SharedAccessRole>,
    expectedPolicySha: string,
  ): Promise<void> {
    await this.library.createSharingPrincipal(id, displayName, grants, expectedPolicySha);
  }

  async updateSharingPrincipal(
    id: string,
    displayName: string,
    grants: Record<string, SharedAccessRole>,
    expectedPolicySha: string,
  ): Promise<void> {
    await this.library.updateSharingPrincipal(id, displayName, grants, expectedPolicySha);
  }

  async revokeSharingSessions(id: string, expectedPolicySha: string): Promise<void> {
    await this.library.revokeSharingSessions(id, expectedPolicySha);
  }

  async removeSharingPrincipal(id: string, expectedPolicySha: string): Promise<void> {
    await this.library.removeSharingPrincipal(id, expectedPolicySha);
  }

  dispose(): void {
    this.cancelTimers();
    this.cancelPendingAuthorization();
    this.listeners.clear();
  }

  private async poll(): Promise<void> {
    this.pollTimer = null;
    if (!this.device) return;
    try {
      const result = await this.library.pollDeviceAuthorization();
      if (result.state === "authorized") {
        this.cancelTimers();
        this.device = null;
        this.error = null;
        await this.refresh();
        return;
      }
      if (result.state === "pending" || result.state === "slow_down") {
        if (result.state === "slow_down") this.device.interval += 5;
        this.schedulePoll(this.device.interval);
        return;
      }
      this.cancelTimers();
      this.device = null;
      this.error = result.state === "denied"
        ? "GitHub authorization was cancelled."
        : result.state === "interrupted"
          ? "The connection attempt was interrupted. Start again for a new code."
          : "The GitHub verification code expired. Start again for a new code.";
      this.emit();
    } catch (error) {
      this.error = message(error, "Could not check GitHub authorization.");
      this.emit();
      if (this.device) this.schedulePoll(this.device.interval);
    }
  }

  private schedulePoll(seconds: number): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), Math.max(5, seconds) * 1000);
  }

  private startCountdown(): void {
    if (this.countdownTimer !== null) clearInterval(this.countdownTimer);
    this.countdownTimer = setInterval(() => {
      if (!this.device) return;
      this.device.remainingSeconds = Math.max(0, Math.ceil((this.device.expiresAt - this.now()) / 1000));
      if (this.device.remainingSeconds === 0) {
        this.cancelTimers();
        this.cancelPendingAuthorization();
        this.device = null;
        this.error = "The GitHub verification code expired. Start again for a new code.";
      }
      this.emit();
    }, 1000);
  }

  private cancelTimers(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    if (this.countdownTimer !== null) clearInterval(this.countdownTimer);
    this.pollTimer = null;
    this.countdownTimer = null;
  }

  private cancelPendingAuthorization(): void {
    // UI cancellation is immediate. If Render is temporarily unreachable, the
    // server record remains harmless and disappears under its short Redis TTL.
    void Promise.resolve(this.library.cancelDeviceAuthorization()).catch(() => undefined);
  }

  private async copy(value: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else if (!copyWithSelection(value)) {
        throw new Error("Clipboard access is unavailable");
      }
      this.error = null;
    } catch (error) {
      if (copyWithSelection(value)) this.error = null;
      else this.error = message(error, "Could not copy to the clipboard.");
    }
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function copyWithSelection(value: string): boolean {
  if (typeof document === "undefined") return false;
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand?.("copy") ?? false;
  input.remove();
  return copied;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function sameSyncStructure(
  left: LibrarySyncSnapshot,
  right: LibrarySyncSnapshot,
): boolean {
  return left.status.state === right.status.state
    && left.status.authenticated === right.status.authenticated
    && left.status.login === right.status.login
    && left.status.principal?.id === right.status.principal?.id
    && left.status.principal?.kind === right.status.principal?.kind
    && left.connected === right.connected
    && left.error === right.error
    && left.device?.userCode === right.device?.userCode
    && left.device?.verificationUri === right.device?.verificationUri
    && left.device?.expiresAt === right.device?.expiresAt;
}
