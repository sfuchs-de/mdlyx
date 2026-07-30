import { describe, expect, it } from "vitest";
import { mapCompileDiagnostics } from "./types";

describe("compile diagnostics", () => {
  it("maps generated TeX lines back to the originating Markdown block", () => {
    expect(mapCompileDiagnostics([
      { severity: "error", message: "Undefined control sequence", generatedLine: 42 },
    ], [
      { generatedFrom: 40, generatedTo: 45, markdownBlock: 3, markdownLine: 12 },
    ])[0]).toMatchObject({ markdownBlock: 3, markdownLine: 14 });
  });

  it("retains an unmapped diagnostic without inventing a source location", () => {
    expect(mapCompileDiagnostics([
      { severity: "warning", message: "Rerun", generatedLine: 2 },
    ], [])[0]).not.toHaveProperty("markdownLine");
  });
});
