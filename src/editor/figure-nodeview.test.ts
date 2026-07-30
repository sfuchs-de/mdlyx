// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "./schema";
import { FigureView, isLibraryFigurePath } from "./figure-nodeview";

beforeEach(() => {
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:figure-preview"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => vi.unstubAllGlobals());

function figure(src: string, caption = "Clock") {
  return schema.nodes.figure.create({
    src,
    alt: caption,
    caption,
    id: "fig:clock",
    width: "70%",
  });
}

describe("FigureView", () => {
  it("distinguishes safe library paths from external and escaping sources", () => {
    expect(isLibraryFigurePath("projects/clock/assets/figure.png")).toBe(true);
    expect(isLibraryFigurePath("https://example.com/figure.png")).toBe(false);
    expect(isLibraryFigurePath("../figure.png")).toBe(false);
    expect(isLibraryFigurePath("assets/.private/figure.png")).toBe(false);
  });

  it("never fetches an external figure source", () => {
    const reader = vi.fn();
    const view = new FigureView(figure("https://tracker.invalid/figure.png"), reader);
    expect(reader).not.toHaveBeenCalled();
    expect(view.dom.textContent).toContain("External figure source");
    expect(view.dom.querySelector("img")).toBeNull();
    view.destroy();
  });

  it("renders same-library image bytes through a blob URL", async () => {
    const reader = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
    }));
    const view = new FigureView(figure("assets/clock.png"), reader);
    await vi.waitFor(() => expect(view.dom.querySelector("img")).not.toBeNull());
    const image = view.dom.querySelector("img")!;
    expect(reader).toHaveBeenCalledWith("assets/clock.png");
    expect(image.getAttribute("src")).toBe("blob:figure-preview");
    expect(image.style.maxWidth).toBe("70%");
    view.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:figure-preview");
  });

  it("labels PDFs without trying to render them as images", async () => {
    const view = new FigureView(figure("assets/clock.pdf"), async () => ({
      bytes: new Uint8Array([1]),
      mimeType: "application/pdf",
    }));
    await vi.waitFor(() => expect(view.dom.textContent).toContain("PDF figure"));
    expect(view.dom.querySelector("img")).toBeNull();
    view.destroy();
  });
});
