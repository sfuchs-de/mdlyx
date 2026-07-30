import { describe, it, expect } from "vitest";
import {
  looksLikeLlmMarkdown,
  hasRenderableMath,
  normalizeLlmMarkdown,
} from "./normalize";
import { parseMarkdown } from "./parse";

describe("looksLikeLlmMarkdown", () => {
  it("detects \\(…\\) / \\[…\\] delimiters", () => {
    expect(looksLikeLlmMarkdown("energy is \\(E=mc^2\\) here")).toBe(true);
    expect(looksLikeLlmMarkdown("a display:\n\\[\n x=1 \n\\]\n")).toBe(true);
  });

  it("detects the degraded copied-from-rendered shape", () => {
    expect(looksLikeLlmMarkdown("before\n[\n\\chi_{k}\n====\n1\n]\n")).toBe(true);
  });

  it("does not fire on plain prose or plain-text tables", () => {
    expect(looksLikeLlmMarkdown("just some text\nwith two lines")).toBe(false);
    expect(looksLikeLlmMarkdown("a [link](http://x) in prose")).toBe(false);
  });
});

describe("hasRenderableMath (paste gate)", () => {
  it("is true on real math signals", () => {
    expect(hasRenderableMath("mass \\(E=mc^2\\) here\nmore")).toBe(true);
    expect(hasRenderableMath("see below\n$$\nx=1\n$$\nend")).toBe(true);
    expect(hasRenderableMath("the value $x_i$ matters\nmore")).toBe(true);
  });

  it("is FALSE on prose that merely contains dollar amounts", () => {
    expect(hasRenderableMath("Widgets cost $5 and $10 each.\nnext line")).toBe(
      false,
    );
    expect(hasRenderableMath("- Budget is $5 to $10 per item\n- next")).toBe(
      false,
    );
  });

  it("ignores math signals that live inside code", () => {
    expect(
      hasRenderableMath("```js\nconst r = /\\(foo\\)/;\n```\nplain prose here"),
    ).toBe(false);
    expect(hasRenderableMath("run `npm run \\(x\\)` now\nsecond line")).toBe(
      false,
    );
  });
});

describe("normalizeLlmMarkdown", () => {
  it("converts \\(…\\) to inline $…$", () => {
    expect(normalizeLlmMarkdown("mass \\(E=mc^2\\) yes")).toBe("mass $E=mc^2$ yes");
  });

  it("converts \\[…\\] to a $$ display block", () => {
    const out = normalizeLlmMarkdown("text\n\\[\nx = 1\n\\]\nmore");
    expect(out).toMatch(/\$\$[\s\n]*x = 1[\s\n]*\$\$/);
    expect(out).not.toContain("\\[");
    expect(out).not.toContain("\\]");
  });

  it("rewrites bare [ … ] display blocks with an infix === underline as =", () => {
    const out = normalizeLlmMarkdown("Prop:\n[\n\\chi_{klm}\n====\n0\n]\nend");
    expect(out).toContain("$$");
    expect(out).toContain("\\chi_{klm}");
    expect(out).toContain("\n=\n"); // the setext rule became the equation's =
    expect(out).not.toMatch(/^\[$/m);
  });

  it("does NOT mangle parens inside a math block", () => {
    const src = "[\n\\left( \\sigma - 1 \\right)\n====\n0\n]";
    const out = normalizeLlmMarkdown(src);
    expect(out).toContain("\\left( \\sigma - 1 \\right)");
  });

  it("wraps bare (\\cmd …) inline math but leaves (M) alone", () => {
    const out = normalizeLlmMarkdown("the term (\\chi_{k}) and the set (M) here");
    expect(out).toContain("$\\chi_{k}$");
    expect(out).toContain("(M)");
  });

  // --- Fix 2: code-awareness -------------------------------------------------
  it("leaves \\(…\\) inside a fenced code block untouched", () => {
    const src = "```js\nconst r = /\\(foo\\)/;\n```\nInline \\(y\\) here";
    const out = normalizeLlmMarkdown(src);
    expect(out).toContain("/\\(foo\\)/"); // code preserved verbatim
    expect(out).toContain("$y$"); // real inline math still converted
  });

  it("leaves LaTeX-looking inline code untouched", () => {
    const out = normalizeLlmMarkdown("call `f(\\theta)` then \\(z\\) here");
    expect(out).toContain("`f(\\theta)`"); // inline code preserved
    expect(out).toContain("$z$");
  });

  // --- Fix 3: conservative rewriting ----------------------------------------
  it("does not convert an escaped \\\\( delimiter", () => {
    const out = normalizeLlmMarkdown("literal \\\\( stays\nand \\(x\\) converts");
    expect(out).toContain("\\\\("); // escaped backslash+paren preserved
    expect(out).toContain("$x$");
  });

  it("does not wrap prose \\left(…\\right) or a \\ref parenthetical", () => {
    const a = normalizeLlmMarkdown("Using \\left( and \\right) as delimiters.\n.");
    expect(a).not.toContain("$ and $");
    const b = normalizeLlmMarkdown("The set (see \\ref{eq}) is defined.\n.");
    expect(b).toContain("(see \\ref{eq})"); // prose parenthetical untouched
  });

  // --- Fix 4: safer degraded-block repair -----------------------------------
  it("drops a trailing/leading === underline instead of inventing a bogus =", () => {
    const out = normalizeLlmMarkdown("[\n\\textbf{Theorem 1}\n====\n]");
    expect(out).toContain("\\textbf{Theorem 1}");
    expect(out).not.toMatch(/Theorem 1\}\s*\n=\s*\n/); // no fabricated trailing =
  });

  it("preserves a real equality chain (two infix underlines → two =)", () => {
    const out = normalizeLlmMarkdown("[\n\\alpha\n====\n\\beta\n====\n\\gamma\n]");
    expect((out.match(/^=$/gm) || []).length).toBe(2);
  });

  it("produces markdown our parser renders with math atoms", () => {
    const src = "Given \\(a+b\\):\n\\[\n\\int_0^1 f\n\\]\ndone";
    const doc = parseMarkdown(normalizeLlmMarkdown(src));
    const kinds: string[] = [];
    doc.descendants((n) => {
      if (n.type.name.startsWith("math_")) kinds.push(n.type.name);
    });
    expect(kinds).toContain("math_inline");
    expect(kinds).toContain("math_display");
  });
});
