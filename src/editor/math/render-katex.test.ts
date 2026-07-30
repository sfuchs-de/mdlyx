// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderKatex, wrapForKatex } from "./render-katex";

describe("renderKatex (component)", () => {
  it("renders valid LaTeX into KaTeX markup", () => {
    const el = document.createElement("span");
    renderKatex("x^2", el, false);
    expect(el.querySelector(".katex")).not.toBeNull();
    expect(el.classList.contains("math-error")).toBe(false);
  });

  it("does not throw on invalid LaTeX and flags the error", () => {
    const el = document.createElement("span");
    expect(() => renderKatex("\\frac{", el, false)).not.toThrow();
    // KaTeX renders a partial/error node rather than crashing the editor.
    expect(el.textContent).not.toBe("");
  });

  it("applies frontmatter macros", () => {
    const el = document.createElement("span");
    renderKatex("\\RR", el, true, { "\\RR": "\\mathbb{R}" });
    expect(el.querySelector(".katex")).not.toBeNull();
  });

  it("wraps multi-line environments for KaTeX", () => {
    expect(wrapForKatex("a &= b", "align")).toBe(
      "\\begin{aligned}a &= b\\end{aligned}",
    );
    expect(wrapForKatex("x", "equation")).toBe("x");
  });

  // #I14: an untagged (env=equation) body with bare alignment markers must still
  // render — auto-wrapped in `aligned` — rather than KaTeX-erroring.
  it("auto-wraps untagged display math that uses alignment markers (#I14)", () => {
    expect(wrapForKatex("a &= b \\\\ c &= d", "equation")).toBe(
      "\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}",
    );
    // A plain equation is left untouched.
    expect(wrapForKatex("E = mc^2", "equation")).toBe("E = mc^2");
    // An escaped ampersand is not an alignment marker.
    expect(wrapForKatex("a \\& b", "equation")).toBe("a \\& b");
    // A body with its own environment absorbs its own `&`/`\\` — leave it alone.
    expect(wrapForKatex("\\begin{matrix}a & b\\end{matrix}", "equation")).toBe(
      "\\begin{matrix}a & b\\end{matrix}",
    );
  });

  it("renders bare-alignment display math cleanly (#I14)", () => {
    const el = document.createElement("div");
    renderKatex("a &= b \\\\ c &= d", el, true);
    expect(el.querySelector(".katex")).not.toBeNull();
    expect(el.classList.contains("math-error")).toBe(false);
  });
});
