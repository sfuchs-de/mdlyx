import { describe, expect, it, vi } from "vitest";
import { installDesktopCloseGuard, type DesktopCloseRequest } from "./desktop-close-guard";

describe("desktop close recovery guard", () => {
  it("prevents close until the recovery flush completes", async () => {
    let handler!: (event: DesktopCloseRequest) => Promise<void>;
    let release!: () => void;
    const flush = new Promise<void>((resolve) => { release = resolve; });
    const destroy = vi.fn(async () => undefined);
    await installDesktopCloseGuard({
      onCloseRequested: async (next) => {
        handler = async (event) => { await next(event); };
        return () => undefined;
      },
      destroy,
    }, () => flush);
    const preventDefault = vi.fn();
    const closing = handler({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    release();
    await closing;
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("keeps the window open and allows retry after a failed flush", async () => {
    let handler!: (event: DesktopCloseRequest) => Promise<void>;
    const destroy = vi.fn(async () => undefined);
    const failure = vi.fn();
    let attempts = 0;
    await installDesktopCloseGuard({
      onCloseRequested: async (next) => {
        handler = async (event) => { await next(event); };
        return () => undefined;
      },
      destroy,
    }, async () => {
      if (++attempts === 1) throw new Error("quota");
    }, failure);
    await handler({ preventDefault() {} });
    expect(destroy).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledOnce();
    await handler({ preventDefault() {} });
    expect(destroy).toHaveBeenCalledOnce();
  });
});
