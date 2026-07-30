import type { Node as PMNode, Mark } from "prosemirror-model";
import { schema } from "../editor/schema";
import { effectiveEnv } from "../editor/math/math-ast";
import type { Frontmatter } from "../markdown/frontmatter";

// Semantic LaTeX export (Phase 11). The live editor stays independent of this;
// here we reconstruct TeX environments from node attributes (#D02): the math
// body + `env`/`label`/`numbered` become `\begin{equation}\label{…}…`, and
// cross-references become `\ref`/`\eqref` so labels and refs survive export.

const SECTION_CMD = [
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
  "subparagraph",
];

// Escape the LaTeX special characters in ordinary text (never in math).
function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// Escape the characters that break `\href`'s URL argument (#I61).
function escapeUrl(url: string): string {
  return url.replace(/([#%&{}_])/g, "\\$1");
}

// Labels emitted so far in the current export. A duplicate `\label` is a LaTeX
// "multiply defined" error, so each id is emitted at most once (#I61/#I47). Reset
// at the start of every exportLatex call (export is synchronous — no re-entrancy).
let seenLabels = new Set<string>();
// Theorem-like environments used in the doc, so the preamble can `\newtheorem`
// exactly those (reset per export, like seenLabels).
let usedTheorems = new Set<string>();
let footnoteDefinitions = new Map<string, PMNode>();
let usesFigures = false;
let usesCitations = false;
let activeCitationStyle: "authoryear" | "numeric" = "authoryear";
function labelOnce(id: string | null | undefined): string {
  if (!id || seenLabels.has(id)) return "";
  seenLabels.add(id);
  return `\n\\label{${id}}`;
}

function applyMarks(text: string, marks: readonly Mark[]): string {
  let out = text;
  for (const mark of marks) {
    switch (mark.type.name) {
      case "strong":
        out = `\\textbf{${out}}`;
        break;
      case "em":
        out = `\\emph{${out}}`;
        break;
      case "code":
        out = `\\texttt{${out}}`;
        break;
      case "link":
        out = `\\href{${escapeUrl(mark.attrs.href as string)}}{${out}}`;
        break;
    }
  }
  return out;
}

// Word + reference macro per target kind, mirroring the on-screen rendering.
function xrefTex(target: string, kind: string): string {
  switch (kind) {
    case "eq":
      return `Equation~\\eqref{${target}}`;
    case "sec":
      return `Section~\\ref{${target}}`;
    case "fig":
      return `Figure~\\ref{${target}}`;
    case "tbl":
      return `Table~\\ref{${target}}`;
    case "thm":
      return `Theorem~\\ref{${target}}`;
    case "lem":
      return `Lemma~\\ref{${target}}`;
    case "prop":
      return `Proposition~\\ref{${target}}`;
    case "cor":
      return `Corollary~\\ref{${target}}`;
    case "def":
      return `Definition~\\ref{${target}}`;
    default:
      return `\\ref{${target}}`;
  }
}

function inline(node: PMNode): string {
  let out = "";
  node.forEach((child) => {
    if (child.isText) {
      out += applyMarks(escapeText(child.text ?? ""), child.marks);
    } else if (child.type === schema.nodes.math_inline) {
      out += `$${child.attrs.latex}$`;
    } else if (child.type === schema.nodes.xref) {
      out += xrefTex(child.attrs.target as string, child.attrs.kind as string);
    } else if (child.type === schema.nodes.doc_link) {
      out += escapeText((child.attrs.label as string | null) || (child.attrs.target as string));
    } else if (child.type === schema.nodes.citation) {
      usesCitations = true;
      out += citationTex(child.attrs.source as string);
    } else if (child.type === schema.nodes.footnote_ref) {
      const definition = footnoteDefinitions.get(child.attrs.label as string);
      out += definition
        ? `\\footnote{${definition.content.content.map((part) => part.isTextblock ? inline(part) : block(part)).join(" ")}}`
        : `\\textsuperscript{[${escapeText(child.attrs.label as string)}]}`;
    } else if (child.type === schema.nodes.soft_break) {
      out += "\n"; // a source line-wrap → a newline (a space in LaTeX)
    } else if (child.type === schema.nodes.hard_break) {
      out += "\\\\\n";
    }
  });
  return out;
}

function citationTex(source: string): string {
  const items = source.split(";").flatMap((part) => {
    const match = /^\s*(-?)@([A-Za-z0-9_.:/-]+)(?:\s*,\s*(.*))?\s*$/.exec(part);
    return match ? [{ suppress: match[1] === "-", key: match[2], locator: match[3] ?? "" }] : [];
  });
  if (!items.length) return escapeText(`[${source}]`);
  if (items.length === 1) {
    const item = items[0];
    const locator = item.locator ? `[${escapeText(item.locator)}]` : "";
    if (activeCitationStyle === "numeric") {
      return `\\parencite${locator}{${item.key}}`;
    }
    // BibLaTeX's starred parenthetical command is the direct equivalent of
    // Pandoc's suppress-author spelling: it keeps the cluster parentheses and
    // postnote while omitting the label name.
    return `${item.suppress ? "\\parencite*" : "\\parencite"}${locator}{${item.key}}`;
  }
  if (activeCitationStyle === "numeric") {
    // Numeric styles have no author label to suppress. Keep the complete
    // cluster in the style's ordinary multicite command instead of mixing a
    // year-only citation with bracketed numeric citations.
    return `\\autocites${items.map((item) => `${item.locator ? `[${escapeText(item.locator)}]` : ""}{${item.key}}`).join("")}`;
  }
  if (items.some((item) => item.suppress)) {
    // A mixed cluster needs exactly one pair of parentheses. Emitting one
    // `\\parencite` per item produced `(2024); (Jones 2025)`, which changes the
    // authored cluster semantics. Inside one `\\mkbibparens`, `\\citeyear`
    // supplies the suppressed item and `\\cite` supplies the ordinary item.
    const cluster = items.map((item) => {
      const locator = item.locator ? `[${escapeText(item.locator)}]` : "";
      return `${item.suppress ? "\\citeyear" : "\\cite"}${locator}{${item.key}}`;
    }).join("; ");
    return `\\mkbibparens{${cluster}}`;
  }
  return `\\autocites${items.map((item) => `${item.locator ? `[${escapeText(item.locator)}]` : ""}{${item.key}}`).join("")}`;
}

// Star an environment when the equation is unnumbered; `none` → \[ … \].
function displayMath(node: PMNode): string {
  const latex = node.attrs.latex as string;
  const label = node.attrs.label as string | null;
  const numbered = node.attrs.numbered as boolean;
  // An untagged body that uses bare alignment markers (`&`/`\\`) is invalid inside
  // `equation`; the shared resolver promotes it to `align`/`gather` so the export
  // compiles and matches how it renders/edits (#I14).
  const env = effectiveEnv((node.attrs.env as string) || "equation", latex);
  // Only a numbered environment produces a number to reference, so `\label` is
  // emitted only when numbered (and only once per id) — a `\label` in a starred
  // env is unreferenceable, and a duplicate is a "multiply defined" error (#I61).
  const labelLine = numbered ? labelOnce(label) : "";

  if (env === "none") {
    return `\\[\n${latex}\n\\]`;
  }
  const envName = numbered ? env : `${env}*`;
  return `\\begin{${envName}}\n${latex}${labelLine}\n\\end{${envName}}`;
}

// Flatten every child of a block container (table cell / list item) — not just
// the first — so multi-block content isn't silently dropped on export.
function containerInline(node: PMNode): string {
  return node.content.content
    .map((c) => (c.isTextblock ? inline(c) : block(c)))
    .join(" ")
    .trim();
}

function tableTex(node: PMNode): string {
  const rows: string[][] = [];
  const aligns: unknown[] = [];
  node.forEach((row, _o, rIdx) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      cells.push(containerInline(cell));
      if (rIdx === 0) aligns.push(cell.attrs.align);
    });
    rows.push(cells);
  });
  if (!rows.length) return "";
  const cols = rows[0].length;
  // Column alignment carries through to the tabular spec (l/c/r), #I15.
  const col = (a: unknown) => (a === "center" ? "c" : a === "right" ? "r" : "l");
  const spec = Array.from({ length: cols }, (_, c) => col(aligns[c])).join("");
  const bodyRows = rows
    .slice(1)
    .map((r) => `${r.join(" & ")} \\\\`)
    .join("\n");
  const tabular = [
    `\\begin{tabular}{${spec}}`,
    "\\hline",
    `${rows[0].join(" & ")} \\\\`,
    "\\hline",
    bodyRows,
    "\\hline",
    "\\end{tabular}",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const caption = node.attrs.caption
    ? `\n\\caption{${escapeText(node.attrs.caption as string)}}`
    : "";
  const label = labelOnce(node.attrs.id as string | null);
  const counter = !caption && label ? "\n\\refstepcounter{table}" : "";
  return caption || label
    ? `\\begin{table}[htbp]\n\\centering${counter}\n${tabular}${caption}${label}\n\\end{table}`
    : tabular;
}

// A list item's lead text goes on the `\item` line; a nested sub-list (or any
// other block child) follows as its own environment so nesting exports correctly.
function listTex(node: PMNode, env: "itemize" | "enumerate"): string {
  const items = node.content.content.map((li) => {
    const parts: string[] = [];
    li.content.forEach((child) => {
      parts.push(child.isTextblock ? inline(child) : block(child));
    });
    const [lead = "", ...rest] = parts;
    return `  \\item ${lead}${rest.length ? "\n" + rest.join("\n") : ""}`;
  });
  return `\\begin{${env}}\n${items.join("\n")}\n\\end{${env}}`;
}

function block(node: PMNode): string {
  switch (node.type.name) {
    case "heading": {
      const cmd = SECTION_CMD[(node.attrs.level as number) - 1] ?? "paragraph";
      const label = labelOnce(node.attrs.id as string | null);
      return `\\${cmd}{${inline(node)}}${label}`;
    }
    case "paragraph":
      return inline(node);
    case "blockquote":
      return `\\begin{quote}\n${node.content.content
        .map(block)
        .join("\n\n")}\n\\end{quote}`;
    case "code_block":
      return `\\begin{verbatim}\n${node.textContent}\n\\end{verbatim}`;
    case "bullet_list":
      return listTex(node, "itemize");
    case "ordered_list":
      return listTex(node, "enumerate");
    case "theorem": {
      const kind = node.attrs.kind as string;
      usedTheorems.add(kind);
      const title = node.attrs.title ? `[${escapeText(node.attrs.title as string)}]` : "";
      const label = labelOnce(node.attrs.id as string | null);
      const inner = node.content.content.map(block).join("\n\n");
      return `\\begin{${kind}}${title}${label}\n${inner}\n\\end{${kind}}`;
    }
    case "math_display":
      return displayMath(node);
    case "figure": {
      usesFigures = true;
      const width = figureWidth(node.attrs.width as string | null);
      const caption = node.attrs.caption ? `\n\\caption{${escapeText(node.attrs.caption as string)}}` : "";
      const label = labelOnce(node.attrs.id as string | null);
      const counter = !caption && label ? "\n\\refstepcounter{figure}" : "";
      return `\\begin{figure}[htbp]\n\\centering${counter}\n\\includegraphics${width}{${escapeUrl(node.attrs.src as string)}}${caption}${label}\n\\end{figure}`;
    }
    case "footnote_definition":
      return ""; // emitted at each inline reference
    case "mathdown_source_marker":
      return ""; // source/audit navigation only; never publication content
    case "raw_latex":
      return node.attrs.latex as string;
    case "table":
      return tableTex(node);
    case "horizontal_rule":
      return "\\par\\noindent\\rule{\\linewidth}{0.4pt}\\par";
    default:
      return inline(node);
  }
}

function figureWidth(width: string | null): string {
  if (!width) return "";
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(width);
  if (percent) return `[width=${Number(percent[1]) / 100}\\linewidth]`;
  return /^[0-9.]+(?:cm|mm|in|pt|\\linewidth)$/.test(width)
    ? `[width=${width}]`
    : "";
}

export interface ExportOptions {
  frontmatter?: Frontmatter;
  /** Wrap in a compilable document with preamble (default true). */
  standalone?: boolean;
  profile?: "article" | "amsart";
}

function preamble(fm?: Frontmatter, profile?: "article" | "amsart"): string {
  const requestedClass = profile ?? fm?.publication.documentClass ?? "article";
  const documentClass = /^[A-Za-z][\w-]*$/.test(requestedClass) ? requestedClass : "article";
  const lines = [
    `\\documentclass{${documentClass}}`,
    "\\usepackage{amsmath}",
    "\\usepackage{amssymb}",
    "\\usepackage{hyperref}",
  ];
  if (usesFigures) lines.push("\\usepackage{graphicx}");
  if (fm?.publication.language && fm.publication.language !== "en") {
    const language = fm.publication.language;
    if (/^[A-Za-z-]+$/.test(language)) lines.push(`\\usepackage[${language}]{babel}`);
  }
  if (usesCitations || fm?.publication.bibliography.length) {
    const style = fm?.publication.citationStyle === "numeric" ? "numeric" : "authoryear";
    lines.push(`\\usepackage[backend=biber,style=${style}]{biblatex}`);
    for (const bibliography of fm?.publication.bibliography ?? []) {
      lines.push(`\\addbibresource{${escapeUrl(bibliography)}}`);
    }
  }
  // Declare exactly the theorem-like environments the document uses (`proof` is
  // built into amsthm, so it needs no \newtheorem).
  if (usedTheorems.size) {
    lines.push("\\usepackage{amsthm}");
    for (const k of usedTheorems) {
      if (k === "proof") continue;
      lines.push(`\\newtheorem{${k}}{${k.charAt(0).toUpperCase()}${k.slice(1)}}`);
    }
  }
  if (fm) {
    for (const [name, value] of Object.entries(fm.macros)) {
      lines.push(`\\newcommand{\\${name}}{${value}}`);
    }
    if (
      fm.numbering.equations === "section"
      || fm.numbering.equations === "subsection"
    ) {
      lines.push(`\\numberwithin{equation}{${fm.numbering.equations}}`);
    }
  }
  return lines.join("\n");
}

export function exportLatex(doc: PMNode, options: ExportOptions = {}): string {
  seenLabels = new Set(); // fresh per export — dedup `\label`s within this document
  usedTheorems = new Set();
  footnoteDefinitions = new Map();
  usesFigures = false;
  usesCitations = false;
  activeCitationStyle = options.frontmatter?.publication.citationStyle === "numeric"
    ? "numeric"
    : "authoryear";
  doc.descendants((node) => {
    if (node.type === schema.nodes.footnote_definition) {
      footnoteDefinitions.set(node.attrs.label as string, node);
    }
  });
  const standalone = options.standalone !== false;
  const body: string[] = [];
  doc.forEach((node) => body.push(block(node)));
  const bodyText = body.join("\n\n");

  if (!standalone) return bodyText + "\n";
  return (
    preamble(options.frontmatter, options.profile) +
    "\n\\begin{document}\n\n" +
    bodyText +
    (usesCitations || options.frontmatter?.publication.bibliography.length ? "\n\n\\printbibliography" : "") +
    "\n\n\\end{document}\n"
  );
}
