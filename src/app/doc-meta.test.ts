import { describe, it, expect } from "vitest";
import { parseList, docTitle, labelColor, newDocId } from "./doc-meta";
import { emptyMeta } from "../markdown/frontmatter";

describe("doc-meta helpers", () => {
  it("parseList trims, splits on comma/newline, and de-dupes case-insensitively", () => {
    expect(parseList("  a ,b\nc , A ,, b ")).toEqual(["a", "b", "c"]);
    expect(parseList("")).toEqual([]);
  });

  it("docTitle falls back to the filename without extension", () => {
    expect(docTitle(emptyMeta(), "wasserstein-flow.md")).toBe("wasserstein-flow");
    expect(docTitle({ ...emptyMeta(), title: "Nice Title" }, "x.md")).toBe("Nice Title");
  });

  it("labelColor is deterministic per label", () => {
    expect(labelColor("trade-networks")).toBe(labelColor("trade-networks"));
    expect(labelColor("a")).not.toBe(labelColor("b"));
    expect(labelColor("x")).toMatch(/^hsl\(/);
  });

  it("newDocId produces distinct ids", () => {
    expect(newDocId()).not.toBe(newDocId());
  });
});
