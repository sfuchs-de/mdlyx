import { describe, it, expect } from "vitest";
import { parseMarkdown } from "../markdown/parse";
import { serializeMarkdown } from "../markdown/serialize";
import { exportLatex } from "../tex/export-latex";
import { bigDoc } from "./generate-doc";

// Headless timing. Thresholds are deliberately generous — these guard against
// accidental O(n^2) regressions, not micro-benchmarks; the actual timings are
// logged so a human can watch the trend.
const BUDGET_MS = 2000;

describe("performance (headless)", () => {
  it("parses a 1000-paragraph document within budget", () => {
    const md = bigDoc({ paragraphs: 1000 });
    const t0 = performance.now();
    const doc = parseMarkdown(md);
    const dt = performance.now() - t0;
    console.log(`parse 1000 paragraphs: ${dt.toFixed(1)}ms (${doc.childCount} blocks)`);
    expect(doc.childCount).toBeGreaterThan(1000);
    expect(dt).toBeLessThan(BUDGET_MS);
  });

  it("parses 500 inline equations within budget", () => {
    const md = bigDoc({ inlineEqs: 500 });
    const t0 = performance.now();
    const doc = parseMarkdown(md);
    const dt = performance.now() - t0;
    let count = 0;
    doc.descendants((n) => {
      if (n.type.name === "math_inline") count++;
      return true;
    });
    console.log(`parse 500 inline equations: ${dt.toFixed(1)}ms (${count} nodes)`);
    expect(count).toBe(500);
    expect(dt).toBeLessThan(BUDGET_MS);
  });

  it("serializes a large mixed document within budget", () => {
    const doc = parseMarkdown(
      bigDoc({ paragraphs: 300, inlineEqs: 200, displayEqs: 50 }),
    );
    const t0 = performance.now();
    const out = serializeMarkdown(doc);
    const dt = performance.now() - t0;
    console.log(`serialize large mixed: ${dt.toFixed(1)}ms (${out.length} chars)`);
    expect(out.length).toBeGreaterThan(0);
    expect(dt).toBeLessThan(BUDGET_MS);
  });

  it("exports a large mixed document within budget", () => {
    const doc = parseMarkdown(
      bigDoc({ paragraphs: 300, inlineEqs: 200, displayEqs: 50 }),
    );
    const t0 = performance.now();
    const tex = exportLatex(doc, { standalone: false });
    const dt = performance.now() - t0;
    console.log(`export large mixed: ${dt.toFixed(1)}ms (${tex.length} chars)`);
    expect(tex.length).toBeGreaterThan(0);
    expect(dt).toBeLessThan(BUDGET_MS);
  });

  it("round-trips and exports a large scholarly document within budget", () => {
    const markdown = bigDoc({
      paragraphs: 1000,
      inlineEqs: 500,
      displayEqs: 100,
      scholarlyBlocks: 100,
    });
    const t0 = performance.now();
    const doc = parseMarkdown(markdown);
    const serialized = serializeMarkdown(doc);
    const reparsed = parseMarkdown(serialized);
    const tex = exportLatex(reparsed, { standalone: false });
    const dt = performance.now() - t0;
    let theorems = 0;
    reparsed.descendants((node) => {
      if (node.type.name === "theorem") theorems++;
      return true;
    });
    console.log(
      `scholarly round-trip/export: ${dt.toFixed(1)}ms `
      + `(${serialized.length} Markdown chars, ${tex.length} TeX chars)`,
    );
    expect(theorems).toBe(200);
    expect(serializeMarkdown(reparsed)).toBe(serialized);
    expect(tex).toContain("\\begin{theorem}");
    expect(tex).toContain("\\begin{proof}");
    expect(dt).toBeLessThan(BUDGET_MS);
  });
});
