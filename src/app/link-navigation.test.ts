import { describe, expect, it } from "vitest";
import { resolveMarkdownLink } from "./link-navigation";

describe("Markdown link navigation", () => {
  it.each([
    ["https://example.com/paper", "https://example.com/paper"],
    ["http://example.com", "http://example.com"],
    ["mailto:author@example.com", "mailto:author@example.com"],
  ])("routes external target %s through the system opener", (href, url) => {
    expect(resolveMarkdownLink(href, "projects/source.md")).toEqual({
      kind: "external",
      url,
    });
  });

  it("decodes current-document fragments", () => {
    expect(resolveMarkdownLink("#sec%3Aevidence", "projects/source.md")).toEqual({
      kind: "anchor",
      anchor: "sec:evidence",
    });
  });

  it.each([
    ["nested/target.md", "projects/source.md", "projects/nested/target.md", undefined],
    ["../shared/target.markdown#result%3Aone", "projects/notes/source.md", "projects/shared/target.markdown", "result:one"],
    ["/projects/root.md#top", "projects/notes/source.md", "projects/root.md", "top"],
    ["target%20note.md", "projects/source.md", "projects/target note.md", undefined],
  ])("resolves library document %s from %s", (href, source, path, anchor) => {
    expect(resolveMarkdownLink(href, source)).toEqual({
      kind: "document",
      path,
      ...(anchor ? { anchor } : {}),
    });
  });

  it.each([
    "javascript:alert(1)",
    "//tracker.invalid/file.md",
    "../../secret.md",
    "../.private/secret.md",
    "assets/paper.pdf",
    "target.md?raw=1",
    "#",
    "#bad%ZZ",
  ])("fails closed for unsupported target %s", (href) => {
    expect(resolveMarkdownLink(href, "projects/source.md")).toEqual({ kind: "unsupported" });
  });
});
