import { describe, it, expect } from "vitest";
import {
  splitLatexSegments,
  joinLatexSegments,
  splitLatexObjects,
} from "./latex-objects";

const objs = (latex: string) => splitLatexObjects(latex).map((o) => o.latex);

describe("latex sub-object splitting", () => {
  it("splits on top-level whitespace, keeping commands + groups together", () => {
    expect(objs("E=mc^2 + \\frac{1}{2}x^2")).toEqual([
      "E=mc^2",
      "+",
      "\\frac{1}{2}x^2",
    ]);
  });

  it("keeps a whole \\frac{a}{b} as one object", () => {
    expect(objs("\\frac{a}{b}")).toEqual(["\\frac{a}{b}"]);
  });

  it("does not break inside nested braces", () => {
    expect(objs("\\sqrt{\\frac{a b}{c}}")).toEqual(["\\sqrt{\\frac{a b}{c}}"]);
  });

  it("treats an escaped space as part of the object", () => {
    // `\,` is a thin space command, not a separator.
    expect(objs("a\\,b")).toEqual(["a\\,b"]);
  });

  // The whole point: opening for editing must never mutate the source.
  it("round-trips exactly for a variety of inputs", () => {
    for (const src of [
      "x^2",
      "E = mc^2",
      "a  +   b", // irregular spacing preserved
      "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
      "a &= b + c \\\\ d &= e",
      "  leading and trailing  ",
      "",
    ]) {
      expect(joinLatexSegments(splitLatexSegments(src))).toBe(src);
    }
  });

  it("classifies segments as object vs gap", () => {
    const segs = splitLatexSegments("a + b");
    expect(segs.map((s) => s.kind)).toEqual([
      "object",
      "gap",
      "object",
      "gap",
      "object",
    ]);
  });
});
