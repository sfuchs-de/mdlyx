// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installBrowserRecoveryLifecycle } from "./recovery-lifecycle";

describe("browser recovery lifecycle", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => cleanup?.());

  it("flushes on hidden and pagehide without treating visible as a shutdown", () => {
    const flush = vi.fn();
    const resume = vi.fn();
    cleanup = installBrowserRecoveryLifecycle({ flush, resume });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(flush).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("removes both lifecycle listeners during cleanup", () => {
    const flush = vi.fn();
    const resume = vi.fn();
    cleanup = installBrowserRecoveryLifecycle({ flush, resume });
    cleanup();
    cleanup = undefined;

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(flush).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
});
