import { describe, it, expect } from "vitest";
import {
  parseMath,
  mathToLatex,
  hasVisualStructure,
  instrumentMath,
  parseEnvRows,
  LEAF_CLASS,
} from "./math-ast";

const roundTrip = (s: string) => mathToLatex(parseMath(s));

describe("math-ast parser", () => {
  it("round-trips a variety of structured LaTeX exactly", () => {
    for (const src of [
      "x^2",
      "x^{2}",
      "a_i",
      "a_{ij}",
      "mc^2",
      "E=mc^2",
      "\\frac{1}{2}",
      "\\frac{1}{2}x^2",
      "\\sqrt{x+1}",
      "\\sqrt[3]{x}",
      "\\frac{\\sqrt{a}}{b^2}",
      "\\alpha^2",
      "\\hat{y} + \\bar{x}",
      "x^2_i",
      "{a+b}",
    ]) {
      expect(roundTrip(src), src).toBe(src);
    }
  });

  it("splits a fraction into numerator and denominator slots", () => {
    const [term] = parseMath("\\frac{a+b}{c}");
    expect(term.kind).toBe("frac");
    if (term.kind === "frac") {
      expect(mathToLatex(term.num)).toBe("a+b");
      expect(mathToLatex(term.den)).toBe("c");
    }
  });

  it("binds a script to the last atom only", () => {
    // `mc^2` → text "m", then script on base "c"
    const terms = parseMath("mc^2");
    expect(terms[0]).toEqual({ kind: "text", text: "m" });
    expect(terms[1].kind).toBe("script");
    if (terms[1].kind === "script") {
      expect(terms[1].base).toEqual({ kind: "text", text: "c" });
      expect(mathToLatex(terms[1].scripts[0].body)).toBe("2");
      expect(terms[1].scripts[0].braced).toBe(false);
    }
  });

  it("captures the radical index", () => {
    const [term] = parseMath("\\sqrt[3]{x}");
    expect(term.kind).toBe("sqrt");
    if (term.kind === "sqrt") {
      expect(mathToLatex(term.index!)).toBe("3");
      expect(mathToLatex(term.rad)).toBe("x");
    }
  });

  it("instruments each leaf with a tagged wrapper, editable via the live term", () => {
    const terms = parseMath("\\frac{a}{b}");
    const { latex, leaves } = instrumentMath(terms);
    // Two leaves (numerator "a", denominator "b"), each wrapped + indexed.
    expect(leaves).toHaveLength(2);
    expect(latex).toContain(`\\htmlClass{${LEAF_CLASS} ${LEAF_CLASS}-0}{a}`);
    expect(latex).toContain(`\\htmlClass{${LEAF_CLASS} ${LEAF_CLASS}-1}{b}`);
    // The fraction structure is preserved around the tagged leaves.
    expect(latex).toContain("\\frac{");
    // Editing a leaf's live term is reflected by the canonical serializer.
    leaves[1].term.text = "c";
    expect(mathToLatex(terms)).toBe("\\frac{a}{c}");
  });

  it("parses a matrix environment into rows × cells", () => {
    const [term] = parseMath("\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}");
    expect(term.kind).toBe("env");
    if (term.kind === "env") {
      expect(term.name).toBe("pmatrix");
      expect(term.rows).toHaveLength(2);
      expect(term.rows[0]).toHaveLength(2);
      expect(mathToLatex(term.rows[0][0])).toBe("a");
      expect(mathToLatex(term.rows[1][1])).toBe("d");
    }
  });

  it("parses cases and reconstructs to valid LaTeX", () => {
    const src = "\\begin{cases}x & x>0 \\\\ 0 & \\text{else}\\end{cases}";
    const [term] = parseMath(src);
    expect(term.kind).toBe("env");
    const out = mathToLatex(parseMath(src));
    expect(out).toContain("\\begin{cases}");
    expect(out).toContain("\\end{cases}");
    expect(out).toContain("x>0");
    expect(out).toContain("\\text{else}");
  });

  it("editing one matrix cell reconstructs the whole environment", () => {
    const terms = parseMath("\\begin{bmatrix}a & b \\\\ c & d\\end{bmatrix}");
    const env = terms[0];
    if (env.kind === "env") {
      const cell = env.rows[0][1][0]; // "b"
      if (cell.kind === "text") cell.text = "z";
    }
    const out = mathToLatex(terms);
    expect(out).toBe("\\begin{bmatrix}a & z \\\\ c & d\\end{bmatrix}");
  });

  it("preserves exact grid separators, whitespace, and optional row spacing (#I33)", () => {
    for (const src of [
      "\\begin{aligned}a&b\\\\[2pt]c &  d\\end{aligned}",
      "\\begin{matrix}  a &b  \\\\[.5em] c& d \\\\ \\end{matrix}",
      "\\begin{array}{cc}a&&b\\\\[-1ex]c&d\\end{array}",
    ]) {
      expect(roundTrip(src), src).toBe(src);
    }
  });

  it("keeps authored grid formatting while editing a cell (#I33)", () => {
    const terms = parseMath("\\begin{bmatrix}a& b\\\\[2pt] c &d\\end{bmatrix}");
    const env = terms[0];
    if (env.kind === "env") {
      const cell = env.rows[1][0][0];
      if (cell.kind === "text") cell.text = "z";
    }
    expect(mathToLatex(terms)).toBe(
      "\\begin{bmatrix}a& b\\\\[2pt] z &d\\end{bmatrix}",
    );
  });

  it("keeps an unknown environment opaque", () => {
    const [term] = parseMath("\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}");
    expect(term.kind).toBe("raw");
  });

  it("instruments each matrix cell as an editable leaf", () => {
    const { leaves } = instrumentMath(
      parseMath("\\begin{matrix}a & b \\\\ c & d\\end{matrix}"),
    );
    expect(leaves.map((l) => l.term.text)).toEqual(["a", "b", "c", "d"]);
  });

  it("detects visual structure", () => {
    expect(hasVisualStructure("\\frac{1}{2}")).toBe(true);
    expect(hasVisualStructure("x^2")).toBe(true);
    expect(hasVisualStructure("\\sqrt{x}")).toBe(true);
    expect(hasVisualStructure("a + b")).toBe(false);
    expect(hasVisualStructure("\\alpha")).toBe(false);
  });

  // Adversarial-review regressions.
  it("parses unbraced \\frac / \\sqrt arguments as single tokens (#I29)", () => {
    // Was corrupted to `\frac{ }{a}b` (the space became the numerator).
    expect(roundTrip("\\frac ab")).toBe("\\frac{a}{b}");
    expect(roundTrip("\\frac 1 2")).toBe("\\frac{1}{2}");
    expect(roundTrip("\\sqrt x")).toBe("\\sqrt{x}");
  });

  it("keeps an unbraced command argument attached (\\mathsf b) so it renders (#I51)", () => {
    // `\mathsf b` must be ONE leaf; splitting it left a bare `\mathsf` that
    // KaTeX-errored when the equation was opened for editing.
    const { leaves } = instrumentMath(parseMath("y=\\mathsf b\\,L^{s_L}"));
    expect(leaves.some((l) => l.term.text === "\\mathsf b")).toBe(true);
    expect(leaves.some((l) => l.term.text === "\\mathsf")).toBe(false);
    expect(roundTrip("\\bar u + \\vec v")).toBe("\\bar u + \\vec v");
    expect(roundTrip("\\mathbb R")).toBe("\\mathbb R");
  });

  it("keeps sized delimiters with their delimiter, and \\left…\\right as one leaf (#I51)", () => {
    // `\Big[` split from `[` left a bare `\Big` that KaTeX-errored on edit.
    const big = instrumentMath(parseMath("\\chi\\Big[a\\Big]"));
    expect(big.leaves.some((l) => l.term.text === "\\Big[")).toBe(true);
    expect(big.leaves.some((l) => l.term.text === "\\Big]")).toBe(true);
    // \left…\right must not be split across leaves.
    const lr = instrumentMath(parseMath("\\left(\\frac{a}{b}\\right)"));
    expect(lr.leaves.some((l) => l.term.text.startsWith("\\left("))).toBe(true);
    expect(roundTrip("\\left( x \\right)")).toBe("\\left( x \\right)");
  });

  it("keeps \\limits/\\nolimits attached to their operator (#I53)", () => {
    // `\sum\limits_i^n` split into `\sum` + `\limits` KaTeX-errored on edit.
    const { leaves } = instrumentMath(parseMath("\\sum\\limits_{i}^{n} x"));
    expect(leaves.some((l) => l.term.text.startsWith("\\sum\\limits"))).toBe(true);
    expect(roundTrip("\\int\\limits_a^b f")).toBe("\\int\\limits_a^b f");
    expect(roundTrip("\\prod\\nolimits_k")).toBe("\\prod\\nolimits_k");
  });

  it("escapes % in instrumented leaves so it can't comment out the wrapper (#I54)", () => {
    // `\htmlClass{…}{a % comment}` — KaTeX reads % as a comment and eats the `}`.
    const { latex } = instrumentMath(parseMath("a % comment"));
    expect(latex).not.toMatch(/[^\\]%/); // no bare (unescaped) % in the output
    expect(roundTrip("a % comment")).toBe("a % comment"); // stored value keeps it
  });

  it("does not delete user-authored empty grid rows (#I30)", () => {
    // `a \\ \\` is 2 rows (a, empty) in LaTeX; only the trailing terminator row
    // is dropped — the old while-loop collapsed it all the way to 1 row.
    const rows = parseEnvRows("a \\\\ \\\\ ");
    expect(rows).toHaveLength(2);
    expect(rows[0][0][0]).toMatchObject({ text: "a" });
  });

  it("does not split outer grid rows or cells inside nested environments", () => {
    const rows = parseEnvRows(
      "A & \\begin{matrix}a & b \\\\ c & d\\end{matrix} \\\\ z & 1",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(2);
    expect(rows[1]).toHaveLength(2);
    expect(mathToLatex(rows[0][1])).toContain("\\begin{matrix}a & b \\\\ c & d\\end{matrix}");
  });
});
