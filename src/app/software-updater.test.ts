import { describe, expect, it, vi } from "vitest";
import type { DownloadEvent, DownloadOptions } from "@tauri-apps/plugin-updater";
import type { DesktopSessionStore } from "./tauri-bridge";
import { probeSoftwareUpdateSession, SoftwareUpdater } from "./software-updater";

const authorized = async () => true;

function session(value: string | null = "desktop-session"): DesktopSessionStore {
  return {
    enabled: true,
    get: vi.fn(async () => value),
    set: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
}

function nativeUpdate() {
  const download = vi.fn<(
    listener?: (event: DownloadEvent) => void,
    options?: DownloadOptions,
  ) => Promise<void>>(async () => undefined);
  return {
    currentVersion: "0.3.1",
    version: "0.4.0",
    date: "2026-07-12T10:00:00Z",
    body: "Reliable desktop updates",
    download,
    install: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("SoftwareUpdater", () => {
  it("leaves browser builds unsupported and never loads the native checker", async () => {
    const check = vi.fn();
    const updater = new SoftwareUpdater(false, session(), check);
    await updater.check();
    expect(updater.snapshot().phase).toBe("unsupported");
    expect(check).not.toHaveBeenCalled();
  });

  it("requires the Keychain bearer before checking", async () => {
    const check = vi.fn();
    const updater = new SoftwareUpdater(true, session(null), check);
    await updater.check();
    expect(updater.snapshot()).toMatchObject({
      phase: "auth-required",
      errorStage: "check",
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("authenticates update checks with the desktop origin and reports current releases", async () => {
    const check = vi.fn(async () => null);
    const probe = vi.fn(async () => true);
    const updater = new SoftwareUpdater(true, session("secret-token"), check, vi.fn(), () => 42, probe);
    await updater.check();
    expect(probe).toHaveBeenCalledWith({
      Authorization: "Bearer secret-token",
      Origin: "tauri://localhost",
    });
    expect(check).toHaveBeenCalledWith({
      headers: {
        Authorization: "Bearer secret-token",
        Origin: "tauri://localhost",
      },
      timeout: 90_000,
    });
    expect(updater.snapshot()).toMatchObject({ phase: "up-to-date", checkedAt: 42 });
  });

  it("enters the busy state before awaits and shares one in-flight check", async () => {
    let releaseToken!: (value: string | null) => void;
    const pendingToken = new Promise<string | null>((resolve) => {
      releaseToken = resolve;
    });
    const store = session();
    vi.mocked(store.get).mockReturnValue(pendingToken);
    const check = vi.fn(async () => null);
    const probe = vi.fn(async () => true);
    const updater = new SoftwareUpdater(true, store, check, vi.fn(), () => 42, probe);

    const first = updater.check();
    expect(updater.snapshot().phase).toBe("checking");
    const second = updater.check();
    expect(second).toBe(first);

    releaseToken("desktop-session");
    await first;
    expect(store.get).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledOnce();
    expect(updater.snapshot()).toMatchObject({ phase: "up-to-date", checkedAt: 42 });
  });

  it("downloads with a freshly-read bearer, tracks progress, then installs and relaunches", async () => {
    const store = session("first-token");
    const release = nativeUpdate();
    release.download.mockImplementation(async (listener, options) => {
      expect(options).toEqual({
        headers: {
          Authorization: "Bearer second-token",
          Origin: "tauri://localhost",
        },
        timeout: 600_000,
      });
      listener?.({ event: "Started", data: { contentLength: 100 } });
      listener?.({ event: "Progress", data: { chunkLength: 25 } });
      listener?.({ event: "Progress", data: { chunkLength: 50 } });
      listener?.({ event: "Finished" });
    });
    vi.mocked(store.get)
      .mockResolvedValueOnce("first-token")
      .mockResolvedValueOnce("second-token");
    const check = vi.fn(async () => release);
    const relaunch = vi.fn(async () => undefined);
    const updater = new SoftwareUpdater(true, store, check, relaunch, Date.now, authorized);
    const prepare = vi.fn(async () => undefined);
    updater.setPrepareForRelaunch(prepare);

    await updater.check();
    expect(updater.snapshot()).toMatchObject({
      phase: "available",
      currentVersion: "0.3.1",
      availableVersion: "0.4.0",
      notes: "Reliable desktop updates",
    });
    await updater.download();
    expect(updater.snapshot()).toMatchObject({
      phase: "downloaded",
      downloadedBytes: 75,
      totalBytes: 100,
    });
    expect(release.install).not.toHaveBeenCalled();

    await updater.installAndRelaunch();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(release.install).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
    expect(updater.snapshot().phase).toBe("relaunching");
  });

  it("aborts installation when the newest recovery snapshot cannot be persisted", async () => {
    const release = nativeUpdate();
    const relaunch = vi.fn(async () => undefined);
    const updater = new SoftwareUpdater(true, session(), vi.fn(async () => release), relaunch, Date.now, authorized);
    updater.setPrepareForRelaunch(vi.fn(async () => {
      throw new Error("IndexedDB quota exhausted");
    }));

    await updater.check();
    await updater.download();
    await updater.installAndRelaunch();

    expect(release.install).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(updater.snapshot()).toMatchObject({
      phase: "error",
      errorStage: "install",
      error: "IndexedDB quota exhausted",
    });
  });

  it("does not relaunch after installation when the final recovery flush fails", async () => {
    const release = nativeUpdate();
    const relaunch = vi.fn(async () => undefined);
    const prepare = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("recovery verification failed"));
    const updater = new SoftwareUpdater(true, session(), vi.fn(async () => release), relaunch, Date.now, authorized);
    updater.setPrepareForRelaunch(prepare);

    await updater.check();
    await updater.download();
    await updater.installAndRelaunch();

    expect(release.install).toHaveBeenCalledOnce();
    expect(relaunch).not.toHaveBeenCalled();
    expect(updater.snapshot()).toMatchObject({
      phase: "restart-required",
      errorStage: "relaunch",
      error: "recovery verification failed",
    });
  });

  it("does not install before an update has finished downloading", async () => {
    const release = nativeUpdate();
    const updater = new SoftwareUpdater(true, session(), vi.fn(async () => release), undefined, Date.now, authorized);
    await updater.check();
    await updater.installAndRelaunch();
    expect(release.install).not.toHaveBeenCalled();
  });

  it("does not reinstall when relaunch fails and is retried", async () => {
    const release = nativeUpdate();
    const relaunch = vi.fn()
      .mockRejectedValueOnce(new Error("restart denied"))
      .mockResolvedValueOnce(undefined);
    const updater = new SoftwareUpdater(true, session(), vi.fn(async () => release), relaunch, Date.now, authorized);
    await updater.check();
    await updater.download();
    await updater.installAndRelaunch();
    expect(updater.snapshot()).toMatchObject({
      phase: "restart-required",
      errorStage: "relaunch",
      error: "restart denied",
    });
    await updater.installAndRelaunch();
    expect(release.install).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledTimes(2);
    expect(updater.snapshot().phase).toBe("relaunching");
  });

  it("classifies expired authorization without leaking bearer values", async () => {
    const check = vi.fn(async () => {
      throw new Error("401 Unauthorized Bearer very-secret-value");
    });
    const updater = new SoftwareUpdater(true, session(), check, undefined, Date.now, authorized);
    await updater.check();
    expect(updater.snapshot()).toMatchObject({
      phase: "auth-required",
      errorStage: "check",
    });
    expect(updater.snapshot().error).not.toContain("very-secret-value");
  });

  it("retains update metadata after a failed download so the action can be retried", async () => {
    const release = nativeUpdate();
    release.download.mockRejectedValueOnce(new Error("network stopped"));
    const updater = new SoftwareUpdater(true, session(), vi.fn(async () => release), undefined, Date.now, authorized);
    await updater.check();
    await updater.download();
    expect(updater.snapshot()).toMatchObject({
      phase: "error",
      errorStage: "download",
      availableVersion: "0.4.0",
      error: "network stopped",
    });
    await updater.download();
    expect(release.download).toHaveBeenCalledTimes(2);
    expect(updater.snapshot().phase).toBe("downloaded");
  });

  it("clears a stale native update when authorization expires and requires a fresh check", async () => {
    const store = session("valid-session");
    const stale = nativeUpdate();
    const fresh = nativeUpdate();
    fresh.version = "0.5.0";
    const check = vi.fn()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(fresh);
    const updater = new SoftwareUpdater(true, store, check, undefined, Date.now, authorized);

    await updater.check();
    vi.mocked(store.get).mockResolvedValueOnce(null);
    await updater.check();
    expect(stale.close).toHaveBeenCalledOnce();
    expect(updater.snapshot().phase).toBe("auth-required");

    vi.mocked(store.get).mockResolvedValue("renewed-session");
    await updater.download();
    expect(stale.download).not.toHaveBeenCalled();
    await updater.check();
    expect(updater.snapshot()).toMatchObject({ phase: "available", availableVersion: "0.5.0" });
  });

  it("does not discard already downloaded and verified bytes during another check", async () => {
    const release = nativeUpdate();
    const check = vi.fn(async () => release);
    const updater = new SoftwareUpdater(true, session(), check, undefined, Date.now, authorized);

    await updater.check();
    await updater.download();
    await updater.check();

    expect(check).toHaveBeenCalledOnce();
    expect(release.close).not.toHaveBeenCalled();
    expect(updater.snapshot().phase).toBe("downloaded");
  });

  it("clears an expired bearer before invoking the native updater", async () => {
    const store = session("expired-session");
    const check = vi.fn(async () => null);
    const probe = vi.fn(async () => false);
    const updater = new SoftwareUpdater(true, store, check, undefined, Date.now, probe);

    await updater.check();

    expect(probe).toHaveBeenCalledOnce();
    expect(store.clear).toHaveBeenCalledOnce();
    expect(check).not.toHaveBeenCalled();
    expect(updater.snapshot()).toMatchObject({
      phase: "auth-required",
      errorStage: "check",
      error: expect.stringContaining("saved GitHub session expired"),
    });
  });

  it("preflights the authenticated API without relying on cookies", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer desktop-session");
      return new Response(JSON.stringify({ authenticated: true }), {
        headers: { "content-type": "application/json" },
      });
    });

    await expect(probeSoftwareUpdateSession(
      { Authorization: "Bearer desktop-session", Origin: "tauri://localhost" },
      "https://updates.example.test",
      request as typeof fetch,
    )).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith(
      "https://updates.example.test/auth/session",
      expect.objectContaining({ credentials: "omit" }),
    );
  });
});
