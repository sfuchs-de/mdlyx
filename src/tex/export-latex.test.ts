import { describe, it, expect } from "vitest";
import { schema } from "../editor/schema";
import { parseMarkdown } from "../markdown/parse";
import { parseFrontmatter } from "../markdown/frontmatter";
import { exportLatex } from "./export-latex";

const bodyTex = (md: string) =>
  exportLatex(parseMarkdown(md), { standalone: false });
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe("LaTeX export", () => {
  it("exports a numbered display equation as a labeled equation env", () => {
    const tex = bodyTex("$$\nE = mc^2\n$$ {#eq:energy}");
    expect(tex).toContain("\\begin{equation}");
    expect(tex).toContain("E = mc^2");
    expect(tex).toContain("\\label{eq:energy}");
    expect(tex).toContain("\\end{equation}");
  });

  it("stars the environment for unnumbered equations", () => {
    const tex = bodyTex("$$\nx = 1\n$$ {numbered=false}");
    expect(tex).toContain("\\begin{equation*}");
    expect(tex).toContain("\\end{equation*}");
  });

  it("uses the align environment when requested", () => {
    const tex = bodyTex("$$\na &= b\n$$ {#eq:s env=align}");
    expect(tex).toContain("\\begin{align}");
    expect(tex).toContain("\\label{eq:s}");
  });

  it("exports cross-references with the right macro per kind", () => {
    expect(bodyTex("See @eq:e.")).toContain("Equation~\\eqref{eq:e}");
    expect(bodyTex("See @sec:i.")).toContain("Section~\\ref{sec:i}");
    expect(bodyTex("See @fig:f and @tbl:t.")).toContain("Figure~\\ref{fig:f}");
    expect(bodyTex("See @fig:f and @tbl:t.")).toContain("Table~\\ref{tbl:t}");
    expect(bodyTex("See @thm:existence.")).toContain("Theorem~\\ref{thm:existence}");
  });

  it("maps headings to sectioning commands and labels", () => {
    const tex = bodyTex("# Intro {#sec:intro}\n\n## Sub {#sec:sub}");
    expect(tex).toContain("\\section{Intro}");
    expect(tex).toContain("\\label{sec:intro}");
    expect(tex).toContain("\\subsection{Sub}");
  });

  it("escapes LaTeX specials in prose but not in math", () => {
    const tex = bodyTex("100% of $a_1$ & more");
    expect(tex).toContain("100\\% of $a_1$ \\& more");
  });

  it("emits macros and section numbering in a standalone preamble", () => {
    const { frontmatter } = parseFrontmatter(
      '---\nmacros:\n  RR: "\\mathbb{R}"\nnumbering:\n  equations: section\n---\nx',
    );
    const tex = exportLatex(parseMarkdown("Over $\\RR$."), { frontmatter });
    expect(tex).toContain("\\documentclass{article}");
    expect(tex).toContain("\\newcommand{\\RR}{\\mathbb{R}}");
    expect(tex).toContain("\\numberwithin{equation}{section}");
    expect(tex).toContain("\\begin{document}");
    expect(tex).toContain("\\end{document}");
  });

  it("exports subsection-relative equation numbering", () => {
    const { frontmatter } = parseFrontmatter(
      "---\nnumbering:\n  equations: subsection\n---\n# Paper\n",
    );
    const tex = exportLatex(parseMarkdown("# Paper\n"), { frontmatter });
    expect(tex).toContain("\\numberwithin{equation}{subsection}");
  });

  it("exports citations, footnotes, figures, and raw LaTeX", () => {
    const source = [
      "Evidence [@smith2024, p. 12] with a note[^n].",
      "",
      "![Clock](assets/clock.pdf){#fig:clock width=70%}",
      "",
      "[^n]: Verified independently.",
      "",
      "```{=latex}",
      "\\clearpage",
      "```",
    ].join("\n");
    const tex = exportLatex(parseMarkdown(source));
    expect(tex).toContain("\\parencite[p. 12]{smith2024}");
    expect(tex).toContain("\\footnote{Verified independently.}");
    expect(tex).toContain("\\includegraphics[width=0.7\\linewidth]{assets/clock.pdf}");
    expect(tex).toContain("\\caption{Clock}");
    expect(tex).toContain("\\label{fig:clock}");
    expect(tex).toContain("\\clearpage");
    expect(tex).toContain("\\usepackage{graphicx}");
    expect(tex).toContain("\\usepackage[backend=biber,style=authoryear]{biblatex}");
  });

  it("steps figure and table counters when a labelled float has no caption", () => {
    const source = [
      "![](assets/clock.png){#fig:clock}",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "{#tbl:values}",
    ].join("\n");
    const tex = exportLatex(parseMarkdown(source));
    expect(tex).toContain("\\refstepcounter{figure}");
    expect(tex).toContain("\\refstepcounter{table}");
    expect(tex).toContain("\\label{fig:clock}");
    expect(tex).toContain("\\label{tbl:values}");
  });

  it("preserves Pandoc suppress-author citations in BibLaTeX output", () => {
    const tex = bodyTex("Compare [-@smith2024, p. 12; @jones2025].");
    expect(tex).toContain("\\mkbibparens{\\citeyear[p. 12]{smith2024}; \\cite{jones2025}}");
    expect(tex).not.toContain("\\autocite[p. 12]{smith2024}");
    expect(bodyTex("Compare [-@smith2024, p. 12]."))
      .toContain("\\parencite*[p. 12]{smith2024}");
  });

  it("keeps suppress-author clusters numeric under the numeric citation style", () => {
    const { frontmatter } = parseFrontmatter(`---
publication:
  citationStyle: numeric
---
body`);
    const tex = exportLatex(
      parseMarkdown("Compare [-@smith2024, p. 12; @jones2025]."),
      { frontmatter },
    );
    expect(tex).toContain("style=numeric");
    expect(tex).toContain("\\autocites[p. 12]{smith2024}{jones2025}");
    expect(tex).not.toContain("\\citeyear");
    expect(tex).not.toContain("\\mkbibparens");
  });

  it("uses publication settings and explicit export profiles", () => {
    const { frontmatter } = parseFrontmatter(`---
publication:
  bibliography: [references/library.bib]
  documentClass: amsart
  citationStyle: numeric
  language: en
  engine: tectonic
---
body`);
    const tex = exportLatex(parseMarkdown("See [@smith2024]."), { frontmatter });
    expect(tex).toContain("\\documentclass{amsart}");
    expect(tex).toContain("style=numeric");
    expect(tex).toContain("\\addbibresource{references/library.bib}");
    expect(tex).toContain("\\printbibliography");
    expect(exportLatex(parseMarkdown("Body"), { frontmatter, profile: "article" }))
      .toContain("\\documentclass{article}");
  });
});

describe("LaTeX export: escaping + label hygiene (#I61)", () => {
  it("escapes URL-breaking characters in \\href", () => {
    const link = schema.marks.link.create({ href: "http://x.com/a_b?c=1&d#e%f", title: null });
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("link", [link])]),
    ]);
    expect(exportLatex(doc, { standalone: false })).toContain(
      "\\href{http://x.com/a\\_b?c=1\\&d\\#e\\%f}{link}",
    );
  });

  it("emits a duplicate label only once (no multiply-defined)", () => {
    expect(count(bodyTex("$$\nx\n$$ {#eq:a}\n\n$$\ny\n$$ {#eq:a}"), "\\label{eq:a}")).toBe(1);
  });

  it("omits \\label inside a starred (unnumbered) environment", () => {
    const tex = bodyTex("$$\nx = 1\n$$ {#eq:a numbered=false}");
    expect(tex).toContain("\\begin{equation*}");
    expect(tex).not.toContain("\\label");
  });

  it("dedups a heading id that collides with an equation label", () => {
    expect(count(bodyTex("# Title {#dup}\n\n$$\nx\n$$ {#dup}"), "\\label{dup}")).toBe(1);
  });
});

describe("LaTeX export: theorem environments (#I23)", () => {
  it("exports a theorem with title + label to amsthm", () => {
    const tex = bodyTex("::: theorem {Pythagoras} {#thm:pyth}\nThe statement.\n:::");
    expect(tex).toContain("\\begin{theorem}[Pythagoras]");
    expect(tex).toContain("\\label{thm:pyth}");
    expect(tex).toContain("\\end{theorem}");
  });

  it("declares \\newtheorem in the preamble for each used kind", () => {
    const tex = exportLatex(parseMarkdown("::: lemma\nx\n:::"), {});
    expect(tex).toContain("\\usepackage{amsthm}");
    expect(tex).toContain("\\newtheorem{lemma}{Lemma}");
  });

  it("uses the built-in proof environment (no \\newtheorem{proof})", () => {
    const tex = exportLatex(parseMarkdown("::: proof\ntrivial\n:::"), {});
    expect(tex).toContain("\\begin{proof}");
    expect(tex).not.toContain("\\newtheorem{proof}");
  });

  it("exports nested theorem and proof fences as nested environments", () => {
    const tex = bodyTex([
      ":::: theorem {Existence} {#thm:existence}",
      "A solution exists.",
      "",
      "::: proof",
      "Apply the fixed-point theorem.",
      ":::",
      "::::",
    ].join("\n"));
    expect(tex).toContain("\\begin{theorem}[Existence]");
    expect(tex).toContain("\\label{thm:existence}");
    expect(tex).toContain("\\begin{proof}");
    expect(tex.indexOf("\\begin{proof}")).toBeGreaterThan(
      tex.indexOf("\\begin{theorem}"),
    );
    expect(tex.indexOf("\\end{proof}")).toBeLessThan(
      tex.indexOf("\\end{theorem}"),
    );
  });
});

describe("LaTeX export: Mathdown source markers", () => {
  it("omits audit/navigation markers from publication output", () => {
    const tex = bodyTex([
      "Before.",
      "",
      "<!-- mathdown-claim:R-DEMO-PRICE -->",
      "",
      "After.",
    ].join("\n"));
    expect(tex).toContain("Before.");
    expect(tex).toContain("After.");
    expect(tex).not.toContain("mathdown-claim");
  });
});
