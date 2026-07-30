import type { Node as PMNode, Mark } from "prosemirror-model";
import { schema } from "../editor/schema";
import { isSafeLinkHref } from "./links";
import { encodeTableCellBlock } from "./table-cell-block";

// Build the ` {#label env=align numbered=false}` suffix for a display equation,
// emitting only the attributes that differ from their defaults.
function displayAttrs(node: PMNode): string {
  const parts: string[] = [];
  if (node.attrs.label) parts.push(`#${node.attrs.label}`);
  if (node.attrs.env && node.attrs.env !== "equation")
    parts.push(`env=${node.attrs.env}`);
  if (node.attrs.numbered === false) parts.push("numbered=false");
  if (node.attrs.tag) parts.push(`tag=${node.attrs.tag}`);
  return parts.length ? ` {${parts.join(" ")}}` : "";
}

// Nesting order (outer → inner). Marks open/close as a stack so a run of marks
// shared by adjacent pieces is emitted with a single pair of delimiters.
const MARK_ORDER = ["link", "strong", "em", "code"];

function markOpen(m: Mark): string {
  switch (m.type.name) {
    case "strong": return "**";
    case "em": return "*";
    case "code": return "`";
    case "link": return "[";
    default: return "";
  }
}
function markClose(m: Mark): string {
  switch (m.type.name) {
    case "strong": return "**";
    case "em": return "*";
    case "code": return "`";
    case "link":
      return `](${escapeLinkHref(m.attrs.href as string)}${
        m.attrs.title != null ? ` "${escapeLinkTitle(m.attrs.title as string)}"` : ""
      })`;
    default: return "";
  }
}

// Destinations are decoded by parseInlineLinkAt. Bare destinations escape
// punctuation that changes their balance; destinations containing whitespace
// use CommonMark's angle-bracket form. This preserves nested parentheses,
// whitespace, and literal backslashes.
function escapeLinkHref(href: string): string {
  if (/\s/.test(href)) {
    return `<${href.replace(/[\\<>]/g, "\\$&")}>`;
  }
  return href.replace(/[\\()]/g, "\\$&");
}

function escapeLinkTitle(title: string): string {
  return title
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ");
}
function sameMark(a: Mark, b: Mark): boolean {
  if (a.type !== b.type) return false;
  if (a.type.name === "link")
    return a.attrs.href === b.attrs.href && a.attrs.title === b.attrs.title;
  return true;
}
function markKey(m: Mark): string {
  return m.type.name === "link"
    ? `link\u0000${m.attrs.href}\u0000${m.attrs.title ?? ""}`
    : m.type.name;
}

// A document normally reaches the serializer through parseMarkdown, which has
// already rejected unsafe links. Filter again here so an externally constructed
// ProseMirror document cannot serialize an executable URL.
function safeMarks(marks: readonly Mark[]): Mark[] {
  return marks.filter(
    (m) => m.type.name !== "link" || isSafeLinkHref(m.attrs.href),
  );
}

// Escape the inline-active characters so literal prose isn't reparsed as markup
// on reopen (#I60): backslash first, then the delimiters our inline parser acts
// on, then `@` only where it would start an xref. Math/code/link-href are emitted
// verbatim elsewhere, so this runs only on plain (non-code) text runs.
function escapeText(s: string, inLink = false): string {
  const out = s.replace(/[\\`*$[]/g, "\\$&").replace(/@(?=[A-Za-z])/g, "\\@");
  // Inside link text, also escape `]` so a literal `]` doesn't close the link
  // early (the parser accepts `\]` in link text). Elsewhere a lone `]` is inert.
  return inLink ? out.replace(/]/g, "\\]") : out;
}

// Wrap a code span's content in a backtick fence wide enough to contain it (#I79):
// the fence is a run of backticks one longer than the longest run inside, and if
// the content starts or ends with a backtick we pad with a space (the parser strips
// a single surrounding space). So `` `a`b` `` round-trips as ``` ``a`b`` ``` instead
// of corrupting on reopen.
function fenceCode(content: string): string {
  const runs = content.match(/`+/g);
  const n = runs ? Math.max(...runs.map((r) => r.length)) + 1 : 1;
  const fence = "`".repeat(n);
  const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${pad}${content}${pad}${fence}`;
}

// Escape a leading character that would make a line parse as a block construct
// (heading / list / quote / rule). `*`, `` ` ``, `$` starts are already handled by
// escapeText; this covers `#`, `-`, `>`, `_`, and ordered-list `N.`.
function escapeLeadingBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*#{1,6}\s/.test(line)) return line.replace(/^(\s*)#/, "$1\\#");
      if (/^\s*>/.test(line)) return line.replace(/^(\s*)>/, "$1\\>");
      if (/^\s*-\s/.test(line)) return line.replace(/^(\s*)-/, "$1\\-");
      if (/^\s*\d+\.\s/.test(line)) return line.replace(/^(\s*\d+)\./, "$1\\.");
      if (/^\s*[-_](\s*[-_]){2,}\s*$/.test(line)) return line.replace(/^(\s*)([-_])/, "$1\\$2");
      return line;
    })
    .join("\n");
}

interface InlinePiece {
  str: string;
  marks: Mark[];
  atom: boolean; // math/xref — carries no marks of its own
  xrefTarget?: string;
}

// Emit inline content with a mark stack, so `em` (etc.) spanning a math atom
// stays a single `*…*` run rather than being split around it. Atoms carry their
// own marks (the parser marks them), so no neighbour-guessing is needed.
function serializeInline(node: PMNode): string {
  const pieces: InlinePiece[] = [];
  node.forEach((child) => {
    if (child.isText) {
      // A code span is literal between backticks — handle it here (not via the
      // mark stack) so the fence can be widened to contain backticks (#I79). Any
      // em/strong/link wrapping it stays on the stack.
      const codeMark = child.marks.find((m) => m.type === schema.marks.code);
      if (codeMark) {
        const marks = child.marks.filter((m) => m.type !== schema.marks.code);
        pieces.push({ str: fenceCode(child.text ?? ""), marks: safeMarks(marks), atom: false });
      } else {
        const marks = safeMarks(child.marks);
        pieces.push({
          str: escapeText(child.text ?? "", marks.some((m) => m.type === schema.marks.link)),
          marks,
          atom: false,
        });
      }
    } else if (child.type === schema.nodes.math_inline)
      pieces.push({ str: `$${child.attrs.latex}$`, marks: safeMarks(child.marks), atom: true });
    else if (child.type === schema.nodes.xref) {
      const target = child.attrs.target as string;
      pieces.push({ str: `@${target}`, marks: safeMarks(child.marks), atom: true, xrefTarget: target });
    }
    else if (child.type === schema.nodes.citation)
      pieces.push({ str: `[${child.attrs.source as string}]`, marks: safeMarks(child.marks), atom: true });
    else if (child.type === schema.nodes.footnote_ref)
      pieces.push({ str: `[^${child.attrs.label as string}]`, marks: safeMarks(child.marks), atom: true });
    else if (child.type === schema.nodes.doc_link) {
      const target = child.attrs.target as string;
      const anchor = child.attrs.anchor as string | null;
      const label = child.attrs.label as string | null;
      const source = child.attrs.source as string | null;
      const destination = `${target}${anchor ? `#${anchor}` : ""}`;
      pieces.push({
        str: source || (label ? `[[${destination}|${label}]]` : `[[${destination}]]`),
        marks: safeMarks(child.marks),
        atom: true,
      });
    }
    else if (child.type === schema.nodes.soft_break)
      pieces.push({ str: "\n", marks: safeMarks(child.marks), atom: true });
    else if (child.type === schema.nodes.hard_break)
      pieces.push({ str: "  \n", marks: [], atom: true });
  });

  // `@eq:euler` followed by `-tail`, `:part`, or a word would otherwise reopen
  // as one larger target. Use the braced spelling only where a lexical boundary
  // is needed; ordinary authored xrefs retain their compact source spelling.
  for (let index = 0; index + 1 < pieces.length; index++) {
    const piece = pieces[index];
    if (piece.xrefTarget && /^[\w:-]/.test(pieces[index + 1].str)) {
      piece.str = `@{${piece.xrefTarget}}`;
    }
  }

  // Nesting order follows the actual spans: a mark covering a wider run of
  // pieces is more outer. (A fixed rank would mis-nest `*a **b** c*`, where em
  // is outer but strong would otherwise be forced outside it.)
  // A mark may occur in multiple disjoint runs. Treat each contiguous run as a
  // separate span; using one global first/last range incorrectly made a strong
  // mark on `a` and `c` look as though it also covered `b`, producing ambiguous
  // close/reopen runs that the parser could not distinguish semantically.
  const spanCache = new Map<string, { first: number; last: number }>();
  const spanAt = (pieceIndex: number, mark: Mark) => {
    const cacheKey = `${pieceIndex}\u0000${markKey(mark)}`;
    const cached = spanCache.get(cacheKey);
    if (cached) return cached;
    let first = pieceIndex;
    let last = pieceIndex;
    while (
      first > 0
      && pieces[first - 1].marks.some((candidate) => sameMark(candidate, mark))
    ) first--;
    while (
      last + 1 < pieces.length
      && pieces[last + 1].marks.some((candidate) => sameMark(candidate, mark))
    ) last++;
    const span = { first, last };
    for (let index = first; index <= last; index++) {
      spanCache.set(`${index}\u0000${markKey(mark)}`, span);
    }
    return span;
  };
  const sortMarks = (marks: readonly Mark[], pieceIndex: number): Mark[] =>
    [...marks].sort((a, b) => {
      const sa = spanAt(pieceIndex, a);
      const sb = spanAt(pieceIndex, b);
      if (sa.first !== sb.first) return sa.first - sb.first; // earlier start = outer
      if (sa.last !== sb.last) return sb.last - sa.last; // later end = outer
      return MARK_ORDER.indexOf(a.type.name) - MARK_ORDER.indexOf(b.type.name);
    });

  let out = "";
  let open: Mark[] = [];
  for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex++) {
    const p = pieces[pieceIndex];
    const want = sortMarks(p.marks, pieceIndex);
    let keep = 0;
    while (keep < open.length && keep < want.length && sameMark(open[keep], want[keep]))
      keep++;
    for (let k = open.length - 1; k >= keep; k--) out += markClose(open[k]);
    open = open.slice(0, keep);
    for (let k = keep; k < want.length; k++) {
      out += markOpen(want[k]);
      open.push(want[k]);
    }
    out += p.str;
  }
  for (let k = open.length - 1; k >= 0; k--) out += markClose(open[k]);
  return out;
}

// GFM tables have no physical multi-paragraph syntax. Inline HTML breaks are
// valid Markdown; the data attribute makes this structural representation
// distinct from an ordinary authored `<br><br>`. Pipes are escaped only after
// all paragraphs have been assembled.
function cellText(cell: PMNode): string {
  const blocks: string[] = [];
  cell.forEach((child) => {
    blocks.push(child.type === schema.nodes.paragraph
      // A physical Markdown hard break cannot live inside a GFM table row.
      // Use its equivalent inline HTML spelling and parse that spelling back
      // into the same hard_break node.
      ? serializeInline(child).replace(/ {2}\n/g, "<br>").trim()
      : encodeTableCellBlock(child.type.name, serializeBlock(child)));
  });
  return blocks.join("<br data-mdlyx-paragraph><br>").replace(/\|/g, "\\|");
}

// The GFM delimiter cell for a column's alignment (#I15).
function alignMarker(align: unknown): string {
  switch (align) {
    case "left": return ":---";
    case "right": return "---:";
    case "center": return ":---:";
    default: return "---";
  }
}

function serializeTable(node: PMNode): string {
  const rows: string[][] = [];
  const aligns: unknown[] = [];
  node.forEach((row, _o, rIdx) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      cells.push(cellText(cell));
      if (rIdx === 0) aligns.push(cell.attrs.align); // column alignment from the header row
    });
    rows.push(cells);
  });
  if (!rows.length) return "";
  const cols = rows[0].length;
  const delim = Array.from({ length: cols }, (_, c) => alignMarker(aligns[c]));
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const out = [line(rows[0]), line(delim)];
  for (let r = 1; r < rows.length; r++) out.push(line(rows[r]));
  const attributes: string[] = [];
  if (node.attrs.id) attributes.push(`#${node.attrs.id as string}`);
  if (node.attrs.caption != null) {
    const caption = (node.attrs.caption as string).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    attributes.push(`caption="${caption}"`);
  }
  return `${out.join("\n")}${attributes.length ? `\n{${attributes.join(" ")}}` : ""}`;
}

function validTheoremFenceLength(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 3
    ? value
    : null;
}

// Return the widest serialized theorem fence below `node`, including theorem
// blocks nested through lists, quotes, footnotes, or disclosure bodies.
function widestNestedTheoremFence(node: PMNode): number {
  let widest = 2;
  node.forEach((child) => {
    if (child.type === schema.nodes.theorem) {
      widest = Math.max(widest, theoremFenceLength(child));
      return;
    }
    widest = Math.max(widest, widestNestedTheoremFence(child));
  });
  return widest;
}

function theoremFenceLength(node: PMNode): number {
  const authored = validTheoremFenceLength(node.attrs.fenceLength) ?? 3;
  return Math.max(authored, widestNestedTheoremFence(node) + 1);
}

function serializeBlock(node: PMNode): string {
  switch (node.type.name) {
    case "heading": {
      const hashes = "#".repeat(node.attrs.level as number);
      // A literal trailing `{#word}` in the heading text would be re-read as an id
      // on reopen; escape its brace so it stays literal (the parser skips an
      // escaped `\{`). The real id suffix is appended after, unescaped (#I79).
      const text = serializeInline(node).replace(/\{(#[\w:-]+\})$/, "\\{$1");
      const id = node.attrs.id ? ` {#${node.attrs.id}}` : "";
      return `${hashes} ${text}${id}`;
    }
    case "paragraph":
      return escapeLeadingBlock(serializeInline(node));
    case "blockquote":
      return node.content.content
        .map((child) => serializeBlock(child))
        .join("\n\n")
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    case "code_block": {
      const lang = (node.attrs.language as string) || "";
      return "```" + lang + "\n" + node.textContent + "\n```";
    }
    case "bullet_list":
      return node.content.content
        .map((item) => serializeListItem(item, "- "))
        .join("\n");
    case "ordered_list": {
      let n = node.attrs.start as number;
      return node.content.content
        .map((item) => serializeListItem(item, `${n++}. `))
        .join("\n");
    }
    case "theorem": {
      const fenceLength = theoremFenceLength(node);
      const closingFenceLength = Math.max(
        fenceLength,
        validTheoremFenceLength(node.attrs.closingFenceLength) ?? fenceLength,
      );
      const parts = [`${":".repeat(fenceLength)} ${node.attrs.kind as string}`];
      if (node.attrs.title) parts.push(`{${node.attrs.title as string}}`);
      if (node.attrs.id) parts.push(`{#${node.attrs.id as string}}`);
      const body = node.content.content.map((c) => serializeBlock(c)).join("\n\n");
      return `${parts.join(" ")}\n${body}\n${":".repeat(closingFenceLength)}`;
    }
    case "math_display":
      return `$$\n${node.attrs.latex}\n$$${displayAttrs(node)}`;
    case "figure": {
      const id = node.attrs.id ? `#${node.attrs.id as string}` : "";
      const width = node.attrs.width ? `width=${node.attrs.width as string}` : "";
      const attrs = [id, width].filter(Boolean);
      const suffix = attrs.length ? `{${attrs.join(" ")}}` : "";
      const caption = (node.attrs.caption as string).replace(/\\/g, "\\\\").replace(/]/g, "\\]");
      return `![${caption}](${node.attrs.src as string})${suffix}`;
    }
    case "footnote_definition": {
      const body = node.content.content.map((child) => serializeBlock(child)).join("\n\n");
      const [first = "", ...rest] = body.split("\n");
      return `[^${node.attrs.label as string}]: ${first}${rest.map((line) => `\n    ${line}`).join("")}`;
    }
    case "raw_latex":
      return `\`\`\`{=latex}\n${node.attrs.latex as string}\n\`\`\``;
    case "mathdown_source_marker":
      return `<!-- ${node.attrs.directive as string} -->`;
    case "html_comment":
      return node.attrs.source as string;
    case "details_disclosure": {
      const body = node.content.content.map((child) => serializeBlock(child)).join("\n\n");
      return [
        node.attrs.openSource as string,
        node.attrs.summarySource as string,
        "",
        body,
        "",
        node.attrs.closeSource as string,
      ].join("\n");
    }
    case "table":
      return serializeTable(node);
    case "horizontal_rule":
      return "---";
    default:
      return serializeInline(node);
  }
}

function serializeListItem(item: PMNode, marker: string): string {
  // A nested list hugs the preceding block (single newline, tight); separate
  // paragraphs/blocks keep a blank line between them.
  let body = "";
  item.content.forEach((child, _offset, idx) => {
    const s = serializeBlock(child);
    if (idx === 0) {
      body = s;
      return;
    }
    const isList = child.type.name === "bullet_list" || child.type.name === "ordered_list";
    body += (isList ? "\n" : "\n\n") + s;
  });
  const indent = " ".repeat(marker.length);
  const [first, ...rest] = body.split("\n");
  return (
    marker +
    first +
    rest.map((line) => (line ? `\n${indent}${line}` : "\n")).join("")
  );
}

export function serializeMarkdown(doc: PMNode): string {
  let markdown = "";
  let previous: PMNode | null = null;
  doc.forEach((node) => {
    if (previous) {
      // Synthesis-order regions intentionally contain compact runs of one
      // marker per line. Keep those runs compact; other block boundaries retain
      // the canonical blank line used throughout the serializer.
      const previousIsSourceOnly = previous.type === schema.nodes.mathdown_source_marker
        || previous.type === schema.nodes.html_comment;
      const currentIsSourceOnly = node.type === schema.nodes.mathdown_source_marker
        || node.type === schema.nodes.html_comment;
      markdown += previousIsSourceOnly
        && currentIsSourceOnly
        ? "\n"
        : "\n\n";
    }
    markdown += serializeBlock(node);
    previous = node;
  });
  return markdown + "\n";
}
