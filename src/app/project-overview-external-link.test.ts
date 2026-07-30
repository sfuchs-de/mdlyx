// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExternalLink } from "./project-overview-view";

afterEach(() => vi.restoreAllMocks());

describe("project task authority links", () => {
  it("uses the native-aware shared opener while retaining safe link metadata", async () => {
    const open = vi.fn(async () => undefined);
    const link = createExternalLink(
      "Open Task Manager",
      "https://tasks.example.test/project",
      "overview-button",
      open,
    );

    link.click();
    await Promise.resolve();
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("https://tasks.example.test/project");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(link.href).toBe("https://tasks.example.test/project");
  });

  it("falls back to a safe browser tab when the native opener fails", async () => {
    const fallback = vi.spyOn(window, "open").mockReturnValue(null);
    const link = createExternalLink(
      "Open Task Manager",
      "https://tasks.example.test/project",
      "overview-button",
      vi.fn(async () => {
        throw new Error("native opener unavailable");
      }),
    );

    link.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fallback).toHaveBeenCalledWith(
      "https://tasks.example.test/project",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
