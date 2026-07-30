import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubLibrary } from "./github-library";
import { LibrarySyncController } from "./library-sync-controller";

function fakeLibrary(overrides: Partial<Record<keyof GitHubLibrary, unknown>> = {}): GitHubLibrary {
  return {
    syncStatus: vi.fn(async () => ({ state: "ready", authenticated: false })),
    startDeviceAuthorization: vi.fn(async () => ({
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
      pendingId: "pending",
    })),
    pollDeviceAuthorization: vi.fn(async () => ({ state: "pending" })),
    cancelDeviceAuthorization: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as GitHubLibrary;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LibrarySyncController", () => {
  it("keeps a device code alive across normal polling intervals", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const library = fakeLibrary();
    const controller = new LibrarySyncController(library, vi.fn(async () => undefined), () => now);
    await controller.start();
    expect(controller.snapshot().device?.remainingSeconds).toBe(900);

    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(library.pollDeviceAuthorization).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().device?.remainingSeconds).toBe(895);
    expect(controller.snapshot().error).toBeNull();
    controller.dispose();
  });

  it("reports lost server-side state as interrupted", async () => {
    vi.useFakeTimers();
    const library = fakeLibrary({
      pollDeviceAuthorization: vi.fn(async () => ({ state: "interrupted" })),
    });
    const controller = new LibrarySyncController(library);
    await controller.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.snapshot().device).toBeNull();
    expect(controller.snapshot().error).toContain("interrupted");
    controller.dispose();
  });

  it("opens the verification URI through the injected native opener", async () => {
    vi.useFakeTimers();
    const open = vi.fn(async () => undefined);
    const controller = new LibrarySyncController(fakeLibrary(), open);
    await controller.start();
    await controller.openVerification();
    expect(open).toHaveBeenCalledWith("https://github.com/login/device");
    controller.dispose();
  });

  it("keeps the code available when the system browser cannot be opened", async () => {
    vi.useFakeTimers();
    const controller = new LibrarySyncController(
      fakeLibrary(),
      vi.fn(async () => { throw new Error("native opener failed"); }),
    );
    await controller.start();
    await controller.openVerification();
    expect(controller.snapshot().device?.userCode).toBe("WDJB-MJHT");
    expect(controller.snapshot().error).toContain("native opener failed");
    controller.dispose();
  });

  it("cancels immediately while treating server deletion as best effort", async () => {
    vi.useFakeTimers();
    const cancelDeviceAuthorization = vi.fn(async () => {
      throw new Error("offline");
    });
    const library = fakeLibrary({ cancelDeviceAuthorization });
    const controller = new LibrarySyncController(library);
    await controller.start();
    controller.cancel();
    expect(controller.snapshot().device).toBeNull();
    expect(controller.snapshot().error).toBeNull();
    expect(cancelDeviceAuthorization).toHaveBeenCalledTimes(1);
  });
});
