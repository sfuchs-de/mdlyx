import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../editor/schema";
import { isSafeLinkHref } from "./links";
import { decodeTableCellBlock } from "./table-cell-block";

const XREF_KINDS = new Set([
  "eq",
  "sec",
  "fig",
  "tbl",
  "thm",
  "lem",
  "prop",
  "cor",
  "def",
]);

// Characters a leading backslash escapes into a literal (CommonMark-style). The
// serializer escapes the subset it needs (#I60); the parser accepts the full set.
// CommonMark backslash escapes consume ASCII punctuation only. In particular,
// `\\q` is a literal backslash plus `q`, not an escape for `q`. Keep this as a
// predicate rather than a stateful regular expression because it is also used
// while scanning link labels and destinations.
function isEscapable(char: string | undefined): boolean {
  if (!char || char.length !== 1) return false;
  const code = char.charCodeAt(0);
  return (code >= 0x21 && code <= 0x2f)
    || (code >= 0x3a && code <= 0x40)
    || (code >= 0x5b && code <= 0x60)
    || (code >= 0x7b && code <= 0x7e);
}

// --- inline ---------------------------------------------------------------
function markNodes(nodes: PMNode[], mark: ReturnType<typeof schema.marks.em.create>): PMNode[] {
  // Mark atoms (inline math / xref) too, not just text — so emphasis that wraps
  // an equation (`*a $x$*`, `*$x$*`) keeps the mark ON the equation and serializes
  // back correctly, instead of the serializer having to guess from neighbours.
  return nodes.map((n) => n.mark(mark.addToSet(n.marks)));
}

function starRunLength(text: string, start: number): number {
  let length = 0;
  while (text[start + length] === "*") length++;
  return length;
}

type EmphasisName = "strong" | "em";

// These are the only meaningful stacks when each mark type is present at most
// once. The order matters while consuming delimiters, even though ProseMirror
// ultimately stores the marks as a set. `strong,em` is the canonical order for
// a same-span `***both***` run.
const EMPHASIS_STATES: readonly (readonly EmphasisName[])[] = [
  [],
  ["strong"],
  ["em"],
  ["strong", "em"],
  ["em", "strong"],
];

const emphasisWidth = (name: EmphasisName) => name === "strong" ? 2 : 1;

function commonStatePrefix(
  left: readonly EmphasisName[],
  right: readonly EmphasisName[],
): number {
  let keep = 0;
  while (keep < left.length && keep < right.length && left[keep] === right[keep]) keep++;
  return keep;
}

interface EmphasisScore {
  literalStars: number;
  operations: number;
  lexRank: number;
}

interface EmphasisChoice {
  from: number;
  to: number;
  keep: number;
  leftover: number;
  previousLexRank: number;
  score: EmphasisScore;
}

function betterEmphasisChoice(candidate: EmphasisChoice, incumbent?: EmphasisChoice): boolean {
  if (!incumbent) return true;
  if (candidate.score.literalStars !== incumbent.score.literalStars) {
    return candidate.score.literalStars < incumbent.score.literalStars;
  }
  if (candidate.score.operations !== incumbent.score.operations) {
    return candidate.score.operations < incumbent.score.operations;
  }
  if (candidate.previousLexRank !== incumbent.previousLexRank) {
    return candidate.previousLexRank < incumbent.previousLexRank;
  }
  return candidate.keep > incumbent.keep;
}

// Resolve all star runs together instead of recursively grabbing the first
// plausible closer. This makes the serializer's staggered spans reversible:
//
//   *a **b*****c**  => em(a), em+strong(b), strong(c)
//   **a *b****c*    => strong(a), strong+em(b), em(c)
//
// A run is a stack transition: close a suffix, then open a suffix. We consider
// every shared-prefix length, including zero, which also handles an explicit
// close+reopen run of length six. Dynamic programming minimizes literal stars
// first and delimiter churn second; unmatched/malformed runs therefore remain
// ordinary text instead of being discarded.
function applyEmphasis(segments: PMNode[][], runs: number[]): PMNode[] {
  let scores = new Map<number, EmphasisScore>();
  scores.set(0, { literalStars: 0, operations: 0, lexRank: 0 });
  const history: Array<Array<EmphasisChoice | undefined>> = [];

  for (const run of runs) {
    const choices: Array<EmphasisChoice | undefined> = new Array(EMPHASIS_STATES.length);
    for (const [fromIndex, score] of scores) {
      const from = EMPHASIS_STATES[fromIndex];
      for (let toIndex = 0; toIndex < EMPHASIS_STATES.length; toIndex++) {
        const to = EMPHASIS_STATES[toIndex];
        const common = commonStatePrefix(from, to);
        for (let keep = 0; keep <= common; keep++) {
          const closed = from.slice(keep);
          const opened = to.slice(keep);
          const used = [...closed, ...opened]
            .reduce((sum, name) => sum + emphasisWidth(name), 0);
          if (used > run) continue;
          const candidate: EmphasisChoice = {
            from: fromIndex,
            to: toIndex,
            keep,
            leftover: run - used,
            previousLexRank: score.lexRank,
            score: {
              literalStars: score.literalStars + run - used,
              operations: score.operations + closed.length + opened.length,
              lexRank: 0,
            },
          };
          if (betterEmphasisChoice(candidate, choices[toIndex])) choices[toIndex] = candidate;
        }
      }
    }

    // Rank surviving signatures lexicographically without retaining/copying the
    // whole state sequence at every step. This keeps parsing linear in the
    // number of delimiter runs even for hostile star-heavy paragraphs.
    const ranked = choices.filter((choice): choice is EmphasisChoice => !!choice)
      .sort((left, right) =>
        left.previousLexRank - right.previousLexRank || left.to - right.to
      );
    ranked.forEach((choice, rank) => { choice.score.lexRank = rank; });
    scores = new Map(ranked.map((choice) => [choice.to, choice.score]));
    history.push(choices);
  }

  // The all-literal path always ends closed, so this is defensive only.
  if (!scores.has(0)) return segments.flat();

  const states = new Array<number>(segments.length);
  const keeps = new Array<number>(runs.length);
  const leftovers = new Array<number>(runs.length);
  let state = 0;
  states[runs.length] = state;
  for (let runIndex = runs.length - 1; runIndex >= 0; runIndex--) {
    const choice = history[runIndex][state];
    if (!choice) return segments.flat();
    keeps[runIndex] = choice.keep;
    leftovers[runIndex] = choice.leftover;
    state = choice.from;
    states[runIndex] = state;
  }

  const marked = (nodes: PMNode[], stateIndex: number): PMNode[] => {
    let result = nodes;
    for (const name of EMPHASIS_STATES[stateIndex]) {
      result = markNodes(result, schema.marks[name].create());
    }
    return result;
  };

  const out: PMNode[] = [];
  for (let index = 0; index < segments.length; index++) {
    out.push(...marked(segments[index], states[index]));
    if (index >= runs.length) continue;
    const literal = leftovers[index];
    if (!literal) continue;
    const keptState = EMPHASIS_STATES[states[index]].slice(0, keeps[index]);
    let stars: PMNode[] = [schema.text("*".repeat(literal))];
    for (const name of keptState) stars = markNodes(stars, schema.marks[name].create());
    out.push(...stars);
  }
  return out;
}

interface InlineLinkMatch {
  end: number;
  label: string;
  href: string;
  title: string | null;
  source: string;
  permissiveMathStarts: number[];
}

// Parse a Markdown inline link without a `[^)]*` shortcut. Destinations may
// contain balanced parentheses and backslash escapes; an unmatched destination
// is not partially consumed. Link text also balances brackets, which prevents a
// nested/escaped `]` from ending the label early.
function parseInlineLinkAt(text: string, start: number): InlineLinkMatch | null {
  if (text[start] !== "[") return null;
  let depth = 1;
  let cursor = start + 1;
  const permissiveMathStarts: number[] = [];
  while (cursor < text.length && depth > 0) {
    if (text[cursor] === "\\" && isEscapable(text[cursor + 1])) {
      cursor += 2;
      continue;
    }
    // A bracket inside a code span or Mathdown inline-math atom is label
    // content, not the end of the Markdown link. This is required for links
    // produced from ProseMirror code/math nodes such as [`a]b`](...) and
    // [$x]y$](...).
    if (text[cursor] === "`") {
      const code = /^(`+)([^\n]*?)\1(?!`)/.exec(text.slice(cursor));
      if (code) {
        cursor += code[0].length;
        continue;
      }
    }
    if (text[cursor] === "$") {
      const strictMath = parseInlineMathAt(text, cursor);
      const permissiveMath = strictMath ?? parseInlineMathAt(text, cursor, true);
      // Boundary whitespace is normally rejected to avoid treating currency as
      // math. Inside a link label, allow it only when a bracket in the atom would
      // otherwise terminate or unbalance the label produced by our serializer.
      const math = strictMath ?? (
        permissiveMath && /[\[\]]/.test(permissiveMath.latex)
          ? permissiveMath
          : null
      );
      if (math) {
        if (!strictMath) permissiveMathStarts.push(cursor - (start + 1));
        cursor = math.end;
        continue;
      }
    }
    if (text[cursor] === "[") depth++;
    else if (text[cursor] === "]") depth--;
    cursor++;
  }
  if (depth !== 0 || text[cursor] !== "(") return null;
  const labelEnd = cursor - 1;
  cursor++;

  let href = "";
  let destinationDepth = 0;
  let separator = false;
  // Angle-bracket destinations are the standards-compliant way to preserve
  // spaces in an authored URL. Backslash escapes still only consume ASCII
  // punctuation, so ordinary path backslashes survive.
  if (text[cursor] === "<") {
    cursor++;
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === "\\" && isEscapable(text[cursor + 1])) {
        href += text[cursor + 1];
        cursor += 2;
        continue;
      }
      if (char === ">") {
        cursor++;
        separator = true;
        break;
      }
      if (char === "\n" || char === "<") return null;
      href += char;
      cursor++;
    }
    if (!separator) return null;
  }
  while (cursor < text.length) {
    const char = text[cursor];
    if (separator) break;
    if (char === "\\" && isEscapable(text[cursor + 1])) {
      href += text[cursor + 1];
      cursor += 2;
      continue;
    }
    if (char === "(") {
      destinationDepth++;
      href += char;
      cursor++;
      continue;
    }
    if (char === ")") {
      if (destinationDepth > 0) {
        destinationDepth--;
        href += char;
        cursor++;
        continue;
      }
      const end = cursor + 1;
      return {
        end,
        label: text.slice(start + 1, labelEnd),
        href,
        title: null,
        source: text.slice(start, end),
        permissiveMathStarts,
      };
    }
    if (/\s/.test(char) && destinationDepth === 0) {
      separator = true;
      break;
    }
    if (char === "\n") return null;
    href += char;
    cursor++;
  }
  if (!separator) return null;

  while (cursor < text.length && /[ \t]/.test(text[cursor])) cursor++;
  if (text[cursor] === ")") {
    const end = cursor + 1;
    return {
      end,
      label: text.slice(start + 1, labelEnd),
      href,
      title: null,
      source: text.slice(start, end),
      permissiveMathStarts,
    };
  }
  if (text[cursor] !== '"') return null;
  cursor++;
  let title = "";
  let closedTitle = false;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === "\\" && isEscapable(text[cursor + 1])) {
      title += text[cursor + 1];
      cursor += 2;
      continue;
    }
    if (char === '"') {
      cursor++;
      closedTitle = true;
      break;
    }
    if (char === "\n") return null;
    title += char;
    cursor++;
  }
  if (!closedTitle) return null;
  while (cursor < text.length && /[ \t]/.test(text[cursor])) cursor++;
  if (text[cursor] !== ")") return null;
  const end = cursor + 1;
  return {
    end,
    label: text.slice(start + 1, labelEnd),
    href,
    title,
    source: text.slice(start, end),
    permissiveMathStarts,
  };
}

function parseInlineMathAt(
  text: string,
  start: number,
  allowBoundaryWhitespace = false,
): { end: number; latex: string } | null {
  const first = text[start + 1];
  if (!first || first === "$" || (!allowBoundaryWhitespace && /\s/.test(first))) return null;
  let cursor = start + 1;
  while (cursor < text.length && text[cursor] !== "\n") {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (text[cursor] === "$") {
      const before = text[cursor - 1];
      const after = text[cursor + 1] ?? "";
      // In ordinary text, a closing `$` cannot be preceded by whitespace or
      // followed by a digit. Those checks keep currency (`$5 and $10`) out of
      // math. A bounded link label is already known to contain serialized math,
      // so it may preserve either boundary verbatim.
      if (!allowBoundaryWhitespace && (/\s/.test(before) || /\d/.test(after))) return null;
      return { end: cursor + 1, latex: text.slice(start + 1, cursor) };
    }
    cursor++;
  }
  return null;
}

// Replace the literal "\n" inside a paragraph's inline nodes with real
// soft_break nodes (carrying the run's marks), so a source line-wrap survives
// editing instead of collapsing on the first keystroke (#I02).
function withSoftBreaks(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const n of nodes) {
    if (n.isText && n.text && n.text.includes("\n")) {
      const parts = n.text.split("\n");
      parts.forEach((part, idx) => {
        if (idx > 0) out.push(schema.nodes.soft_break.create(null, undefined, n.marks));
        if (part) out.push(schema.text(part, n.marks));
      });
    } else {
      out.push(n);
    }
  }
  return out;
}

interface ParseInlineOptions {
  permissiveMathStarts?: ReadonlySet<number>;
}

interface ParsedDocumentLink {
  end: number;
  target: string;
  anchor: string | null;
  label: string | null;
  source: string;
}

function unescapeWikiText(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "\\" && isEscapable(value[index + 1])) {
      out += value[index + 1];
      index++;
    } else {
      out += value[index];
    }
  }
  return out;
}

/**
 * Parse a stable-ID wiki link without making GFM table escaping part of the
 * destination. In a table the separator must be authored as `\|`; the same
 * spelling also occurs in prose copied from those tables. Soft source wrapping
 * inside the visible label is accepted, but a blank line still terminates the
 * construct so malformed markup cannot absorb later paragraphs.
 */
function parseDocumentLinkAt(text: string, start: number): ParsedDocumentLink | null {
  if (text.slice(start, start + 2) !== "[[") return null;
  let cursor = start + 2;
  let end = -1;
  while (cursor < text.length - 1) {
    if (text[cursor] === "\\" && isEscapable(text[cursor + 1])) {
      cursor += 2;
      continue;
    }
    if (text[cursor] === "]" && text[cursor + 1] === "]") {
      end = cursor + 2;
      break;
    }
    cursor++;
  }
  if (end < 0) return null;

  const inner = text.slice(start + 2, end - 2);
  if (!inner || /\n[ \t]*\n/.test(inner)) return null;

  let separator = -1;
  let separatorLength = 0;
  for (let index = 0; index < inner.length; index++) {
    if (inner[index] === "\\" && inner[index + 1] === "|") {
      separator = index;
      separatorLength = 2;
      break;
    }
    if (inner[index] === "|") {
      separator = index;
      separatorLength = 1;
      break;
    }
    if (inner[index] === "\\" && isEscapable(inner[index + 1])) index++;
  }

  const destination = unescapeWikiText(
    separator < 0 ? inner : inner.slice(0, separator),
  );
  const labelSource = separator < 0
    ? null
    : inner.slice(separator + separatorLength);
  if (
    !destination
    || /\s|\]|\|/.test(destination)
    || destination.startsWith("#")
    || destination.endsWith("#")
  ) return null;

  const hash = destination.indexOf("#");
  if (hash >= 0 && destination.indexOf("#", hash + 1) >= 0) return null;
  const target = hash < 0 ? destination : destination.slice(0, hash);
  const anchor = hash < 0 ? null : destination.slice(hash + 1);
  if (!target || (anchor != null && !anchor)) return null;

  const label = labelSource == null
    ? null
    : unescapeWikiText(labelSource).replace(/\s+/g, " ").trim();
  if (labelSource != null && !label) return null;
  return {
    end,
    target,
    anchor,
    label,
    source: text.slice(start, end),
  };
}

export function parseInline(text: string, options: ParseInlineOptions = {}): PMNode[] {
  const segments: PMNode[][] = [[]];
  const runs: number[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      segments[segments.length - 1].push(schema.text(buf));
      buf = "";
    }
  };
  const push = (...nodes: PMNode[]) => {
    flush();
    segments[segments.length - 1].push(...nodes);
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpExecArray | null;

    // Backslash escape: `\X` (X escapable) is the literal X, and X is NOT treated
    // as a delimiter. A backslash before a non-escapable char stays literal.
    if (text[i] === "\\" && isEscapable(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    // Inline HTML breaks are common in readable GFM tables, where a physical
    // newline would terminate the row. Treat the standard spellings as a real
    // line break instead of exposing the literal tag to readers.
    if (text[i] === "<" && (m = /^<br\s*\/?>/i.exec(rest))) {
      push(schema.nodes.hard_break.create());
      i += m[0].length;
      continue;
    }
    // Code span: an opening run of N backticks closes at the first run of exactly
    // N backticks, so a wider fence can contain shorter runs (`` ``a`b`` `` → `a`b`).
    // A single space of surrounding padding is stripped (lets the content start or
    // end with a backtick). See #I79.
    if (text[i] === "`" && (m = /^(`+)([^\n]*?)\1(?!`)/.exec(rest))) {
      let code = m[2];
      // ProseMirror cannot represent an empty marked text node. Empty delimiter
      // pairs are therefore literal source, not a code node (and must not throw).
      if (code.length === 0) {
        buf += m[0];
        i += m[0].length;
        continue;
      }
      if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "")
        code = code.slice(1, -1);
      push(schema.text(code, [schema.marks.code.create()]));
      i += m[0].length;
      continue;
    }
    if (text[i] === "$") {
      const math = parseInlineMathAt(text, i, options.permissiveMathStarts?.has(i) === true);
      if (math) {
        push(schema.nodes.math_inline.create({ latex: math.latex }));
        i = math.end;
        continue;
      }
    }
    if (text[i] === "*") {
      flush();
      const length = starRunLength(text, i);
      runs.push(length);
      segments.push([]);
      i += length;
      continue;
    }
    // Standard Markdown links run before citations: `[@smith](paper.pdf)` is a
    // link whose visible text starts with `@`, not a citation followed by a
    // dangling destination.
    if (text[i] === "[") {
      const linkMatch = parseInlineLinkAt(text, i);
      if (linkMatch) {
        if (linkMatch.label.length === 0) {
          // ProseMirror has no representation for an empty linked text run. Keep
          // the complete source literal, including destinations that contain @,
          // rather than activating atoms from inside the rejected construct.
          buf += linkMatch.source;
          i = linkMatch.end;
          continue;
        }
        if (!isSafeLinkHref(linkMatch.href)) {
          // Preserve an unsafe destination as one literal unit so its label is
          // not reinterpreted as a citation/xref after the link is rejected.
          buf += linkMatch.source;
          i = linkMatch.end;
          continue;
        }
        const link = schema.marks.link.create({
          href: linkMatch.href,
          title: linkMatch.title,
        });
        push(...markNodes(parseInline(linkMatch.label, {
          permissiveMathStarts: new Set(linkMatch.permissiveMathStarts),
        }), link));
        i = linkMatch.end;
        continue;
      }
    }
    if (text[i] === "[" && (m = /^\[\^([A-Za-z0-9_.:-]+)\]/.exec(rest))) {
      push(schema.nodes.footnote_ref.create({ label: m[1] }));
      i += m[0].length;
      continue;
    }
    // Pandoc citation cluster. Preserve the authored source inside the brackets
    // so prefixes, locators, multiple keys and suppress-author markers survive.
    if (
      text[i] === "["
      && (m = /^\[((?:-?@[A-Za-z0-9_.:/-]+)[^\]\n]*)\]/.exec(rest))
      && rest[m[0].length] !== "("
    ) {
      push(schema.nodes.citation.create({ source: m[1] }));
      i += m[0].length;
      continue;
    }
    // Internal library link. Targets use the stable frontmatter document id;
    // an optional fragment addresses a labelled block in that document. Labels
    // are deliberately plain text because the link is an inline atom.
    // Invalid or incomplete wiki syntax falls through as ordinary prose.
    const documentLink = text[i] === "[" && text[i + 1] === "["
      ? parseDocumentLinkAt(text, i)
      : null;
    if (documentLink) {
      push(
        schema.nodes.doc_link.create({
          target: documentLink.target,
          anchor: documentLink.anchor,
          label: documentLink.label,
          source: documentLink.source,
        }),
      );
      i = documentLink.end;
      continue;
    }
    if (text[i] === "@" && (m = /^@\{([a-zA-Z][\w:-]*)\}/.exec(rest))) {
      const target = m[1];
      const prefix = target.includes(":") ? target.split(":")[0] : "";
      const kind = XREF_KINDS.has(prefix) ? prefix : "generic";
      push(schema.nodes.xref.create({ target, kind }));
      i += m[0].length;
      continue;
    }
    if (text[i] === "@" && (m = /^@([a-zA-Z][\w:-]*)/.exec(rest))) {
      const target = m[1];
      const prefix = target.includes(":") ? target.split(":")[0] : "";
      const kind = XREF_KINDS.has(prefix) ? prefix : "generic";
      push(schema.nodes.xref.create({ target, kind }));
      i += m[0].length;
      continue;
    }

    buf += text[i];
    i++;
  }
  flush();
  return applyEmphasis(segments, runs);
}

// --- attribute braces: `{#label env=align numbered=false}` ----------------
interface Attrs {
  id?: string;
  label?: string;
  env?: string;
  numbered?: boolean;
  tag?: string;
}

function parseAttrBrace(raw: string): Attrs {
  const attrs: Attrs = {};
  for (const token of raw.trim().split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith("#")) {
      attrs.id = token.slice(1);
      attrs.label = token.slice(1);
    } else if (token.includes("=")) {
      const [k, v] = token.split("=");
      if (k === "env") attrs.env = v;
      else if (k === "numbered") attrs.numbered = v !== "false";
      else if (k === "tag") attrs.tag = v;
    }
  }
  return attrs;
}

// Parse the complete theorem header rather than extracting whatever fragments
// happen to look valid. This keeps malformed attributes/trailing prose literal
// instead of silently dropping them when the document is saved.
function parseTheoremHeader(
  source: string,
): { kind: string; title: string | null; id: string | null } | null {
  const match = /^([A-Za-z][\w-]*)(?:\s+\{([^#{}][^{}]*)\})?(?:\s+(?:\{#([\w:-]+)\}|#([\w:-]+)))?\s*$/.exec(
    source,
  );
  if (!match) return null;
  return {
    kind: match[1],
    title: match[2]?.trim() || null,
    id: match[3] ?? match[4] ?? null,
  };
}

// --- tables (GFM pipe tables) ---------------------------------------------
const isTableRow = (l: string) => l.includes("|");
// A delimiter row: only pipes, dashes, colons, spaces — and at least one dash.
const isDelimiterRow = (l: string) =>
  /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes("-");
const isHorizontalRule = (l: string) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);

// Split a table row on unescaped `|` (GFM semantics — a pipe inside a code span
// or math must be authored as `\|`, exactly what our serializer emits). An
// earlier span-aware variant let an unpaired `$`/backtick in one cell swallow
// the next cell's separator, merging cells in ordinary currency text — GFM's
// blind split plus escape handling is the correct contract. The walker (rather
// than a lookbehind regex) keeps `a\\|b` splitting correctly after an escaped
// backslash.
function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      cell += s[i] + s[i + 1];
      i += 2;
      continue;
    }
    if (c === "|") {
      cells.push(cell);
      cell = "";
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  cells.push(cell);
  return cells.map((c) => c.trim().replace(/\\\|/g, "|"));
}

type Align = "left" | "center" | "right" | null;

// Classify each delimiter cell (`:---` left, `---:` right, `:---:` center) so
// column alignment survives the round-trip (#I15).
function parseAligns(delimLine: string): Align[] {
  return splitCells(delimLine).map((c) => {
    const s = c.trim();
    const l = s.startsWith(":");
    const r = s.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : null;
  });
}

function cellNode(text: string, header: boolean, align: Align): PMNode {
  const type = header ? schema.nodes.table_header : schema.nodes.table_cell;
  // GFM tables cannot contain blank physical lines, but inline HTML is valid
  // Markdown. Ordinary paragraphs keep the historical explicit separator;
  // structured blocks use a typed readable wrapper that is decoded here.
  const blocks = text.split("<br data-mdlyx-paragraph><br>")
    .map((part) => {
      const encoded = decodeTableCellBlock(part);
      if (encoded) {
        try {
          const parsed = parseBlocks(encoded.markdown);
          if (parsed.length === 1 && parsed[0].type.name === encoded.type) return parsed[0];
        } catch {
          // A hand-edited/malformed extension stays literal instead of making
          // the entire document fail to open.
        }
      }
      return schema.nodes.paragraph.create(null, parseInline(part));
    });
  return type.create({ align }, blocks);
}

function padRow(cells: string[], cols: number): string[] {
  // A row with MORE cells than the header (e.g. a hand-authored `|` inside a
  // code span) must not lose text: fold the overflow into the last column
  // instead of truncating it (the old slice silently deleted those cells).
  const out = cells.slice(0, cols);
  if (cells.length > cols && cols > 0) {
    out[cols - 1] = cells.slice(cols - 1).join(" | ");
  }
  while (out.length < cols) out.push("");
  return out;
}

function buildTable(
  header: string[],
  body: string[][],
  cols: number,
  aligns: Align[],
  attrs: { caption: string | null; id: string | null } = { caption: null, id: null },
): PMNode {
  const al = (ci: number): Align => aligns[ci] ?? null;
  const rows: PMNode[] = [
    schema.nodes.table_row.create(
      null,
      padRow(header, cols).map((t, ci) => cellNode(t, true, al(ci))),
    ),
  ];
  for (const r of body) {
    rows.push(
      schema.nodes.table_row.create(
        null,
        padRow(r, cols).map((t, ci) => cellNode(t, false, al(ci))),
      ),
    );
  }
  return schema.nodes.table.create(attrs, rows);
}

function tableMetadata(line: string): { caption: string | null; id: string | null } | null {
  const wrapper = /^\{([^}]*)\}\s*$/.exec(line.trim());
  if (!wrapper) return null;
  const id = /(?:^|\s)#([A-Za-z][\w:.-]*)/.exec(wrapper[1])?.[1] ?? null;
  const captionSource = /(?:^|\s)caption="((?:\\.|[^"])*)"/.exec(wrapper[1])?.[1];
  const caption = captionSource == null
    ? null
    : captionSource.replace(/\\([\\"])/g, "$1");
  return id || caption != null ? { id, caption } : null;
}

// --- lists (nestable) ------------------------------------------------------
const indentOf = (l: string): number => /^\s*/.exec(l)![0].length;

interface ListMarker {
  indent: number; // leading-space column of the marker
  ordered: boolean;
  num: number; // ordered-list start number (1 for bullets)
  text: string; // content after the marker
  contentCol: number; // column where `text` starts (for dedenting the item body)
}

function listMarker(line: string): ListMarker | null {
  const m = /^(\s*)([-*]|\d+\.)(\s+)(.*)$/.exec(line);
  if (!m) return null;
  const ordered = /\d/.test(m[2]);
  return {
    indent: m[1].length,
    ordered,
    num: ordered ? parseInt(m[2], 10) : 1,
    text: m[4],
    contentCol: m[1].length + m[2].length + m[3].length,
  };
}

const nextNonBlank = (lines: string[], from: number): number => {
  let j = from;
  while (j < lines.length && lines[j].trim() === "") j++;
  return j;
};

// Parse a list whose first marker sits at column `indent`, recursing for
// deeper-indented sub-lists (#I03b). Each item's body (its marker text plus every
// more-indented line, dedented to the content column) is parsed with `parseBlocks`
// so a nested list, a wrapped continuation (→ soft break), or extra blocks all
// fall out naturally. Returns the list node and the index just past it.
function parseListAt(lines: string[], start: number, indent: number): { node: PMNode; next: number } {
  const first = listMarker(lines[start])!;
  const ordered = first.ordered;
  const items: PMNode[] = [];
  let i = start;
  while (i < lines.length) {
    // Blank line between items: stay in the list only if a sibling follows (loose
    // list); otherwise the list ends.
    if (lines[i].trim() === "") {
      const j = nextNonBlank(lines, i);
      const sib = j < lines.length ? listMarker(lines[j]) : null;
      if (sib && sib.indent === indent && sib.ordered === ordered) { i = j; continue; }
      break;
    }
    const mk = listMarker(lines[i]);
    if (!mk || mk.indent !== indent || mk.ordered !== ordered) break;

    const body: string[] = [mk.text];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        const j = nextNonBlank(lines, i);
        if (j < lines.length && indentOf(lines[j]) > indent) { body.push(""); i++; continue; }
        break;
      }
      if (indentOf(line) > indent) {
        body.push(line.slice(Math.min(mk.contentCol, indentOf(line))));
        i++;
        continue;
      }
      break; // a sibling/shallower line ends this item
    }

    let children = parseBlocks(body.join("\n"));
    // A list item must lead with a paragraph (schema `paragraph block*`); a body
    // that starts with a nested list or is empty gets an empty leading paragraph.
    if (children.length === 0 || children[0].type.name !== "paragraph") {
      children = [schema.nodes.paragraph.create(), ...children];
    }
    items.push(schema.nodes.list_item.create(null, children));
  }
  const node = ordered
    ? schema.nodes.ordered_list.create({ start: first.num }, items)
    : schema.nodes.bullet_list.create(null, items);
  return { node, next: i };
}

// --- blocks ---------------------------------------------------------------
// Mathdown's contract tooling places source-only audit/navigation markers on
// their own lines. Recognise only the constrained Mathdown namespace: arbitrary
// HTML comments remain ordinary authored text and are never silently hidden.
function parseMathdownSourceMarker(line: string): string | null {
  const match = /^<!--\s*(mathdown(?:-[a-z0-9-]+)?:[A-Za-z0-9][A-Za-z0-9._:-]*)\s*-->\s*$/i
    .exec(line);
  return match?.[1] ?? null;
}

function parseHtmlCommentBlock(
  lines: string[],
  start: number,
): { source: string; next: number } | null {
  if (!/^\s*<!--/.test(lines[start])) return null;
  const source: string[] = [];
  for (let index = start; index < lines.length; index++) {
    const line = lines[index];
    source.push(line);
    const close = line.indexOf("-->");
    if (close < 0) continue;
    // Only a standalone HTML comment is source-only. A comment followed by
    // authored prose on the same line stays literal so no visible text is lost.
    if (line.slice(close + 3).trim()) return null;
    return { source: source.join("\n"), next: index + 1 };
  }
  // Unclosed comments are malformed authored text and remain visible.
  return null;
}

const DETAILS_OPEN_RE = /^\s*<details(?:\s+[^>]*)?>\s*$/i;
const DETAILS_CLOSE_RE = /^\s*<\/details>\s*$/i;
const DETAILS_SUMMARY_RE = /^\s*<summary>(.*?)<\/summary>\s*$/i;

function parseDetailsBlock(
  lines: string[],
  start: number,
): { node: PMNode; next: number } | null {
  const openSource = lines[start];
  if (!DETAILS_OPEN_RE.test(openSource)) return null;

  // Keep the accepted extension deliberately small and predictable: the
  // summary must immediately follow the opening tag on one physical line.
  const summarySource = lines[start + 1] ?? "";
  const summaryMatch = DETAILS_SUMMARY_RE.exec(summarySource);
  if (!summaryMatch) return null;

  let depth = 1;
  let close = start + 2;
  for (; close < lines.length; close++) {
    if (DETAILS_OPEN_RE.test(lines[close])) {
      depth++;
      continue;
    }
    if (!DETAILS_CLOSE_RE.test(lines[close])) continue;
    depth--;
    if (depth === 0) break;
  }
  if (close >= lines.length) return null;

  const body = parseBlocks(lines.slice(start + 2, close).join("\n"));
  const summary = summaryMatch[1].replace(/<[^>]*>/g, "").trim() || "Details";
  return {
    node: schema.nodes.details_disclosure.create(
      {
        summary,
        openSource,
        summarySource,
        closeSource: lines[close],
        initiallyOpen: /\sopen(?:\s|=|>)/i.test(openSource),
      },
      body.length ? body : [schema.nodes.paragraph.create()],
    ),
    next: close + 1,
  };
}

export function parseBlocks(md: string): PMNode[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: PMNode[] = [];
  let i = 0;

  const isBullet = (l: string) => /^\s*[-*]\s+/.test(l);
  const isOrdered = (l: string) => /^\s*\d+\.\s+/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const sourceMarker = parseMathdownSourceMarker(line);
    if (sourceMarker) {
      blocks.push(schema.nodes.mathdown_source_marker.create({ directive: sourceMarker }));
      i++;
      continue;
    }

    const htmlComment = parseHtmlCommentBlock(lines, i);
    if (htmlComment) {
      blocks.push(schema.nodes.html_comment.create({ source: htmlComment.source }));
      i = htmlComment.next;
      continue;
    }

    const details = parseDetailsBlock(lines, i);
    if (details) {
      blocks.push(details.node);
      i = details.next;
      continue;
    }

    // Horizontal rule: --- / *** / ___ (checked before tables; it has no pipes).
    if (isHorizontalRule(line)) {
      blocks.push(schema.nodes.horizontal_rule.create());
      i++;
      continue;
    }

    // Source-preserving raw LaTeX. It is deliberately never interpreted in the
    // editor; export/compilation receives the exact fenced body.
    if (/^```\{=latex\}\s*$/.test(line)) {
      i++;
      const latex: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        latex.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(schema.nodes.raw_latex.create({ latex: latex.join("\n") }));
      continue;
    }

    const figure = /^!\[((?:\\.|[^\]])*)\]\(([^)\s]+)\)(?:\{([^}]*)\})?\s*$/.exec(line);
    if (figure && isSafeLinkHref(figure[2])) {
      const attrs = parseAttrBrace(figure[3] ?? "");
      const width = /(?:^|\s)width=([^\s]+)/.exec(figure[3] ?? "")?.[1] ?? null;
      const caption = figure[1].replace(/\\([\\\]])/g, "$1");
      blocks.push(schema.nodes.figure.create({
        src: figure[2],
        alt: caption,
        caption,
        id: attrs.id ?? null,
        width,
      }));
      i++;
      continue;
    }

    const footnote = /^\[\^([A-Za-z0-9_.:-]+)\]:\s*(.*)$/.exec(line);
    if (footnote) {
      const body = [footnote[2]];
      i++;
      while (i < lines.length) {
        if (/^(?: {2,}|\t)/.test(lines[i])) {
          body.push(lines[i].replace(/^(?: {2,4}|\t)/, ""));
          i++;
          continue;
        }
        if (lines[i].trim() === "" && /^(?: {2,}|\t)/.test(lines[i + 1] ?? "")) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      const content = parseBlocks(body.join("\n"));
      blocks.push(schema.nodes.footnote_definition.create(
        { label: footnote[1] },
        content.length ? content : [schema.nodes.paragraph.create()],
      ));
      continue;
    }

    // GFM table: a pipe row immediately followed by a delimiter row.
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      isDelimiterRow(lines[i + 1])
    ) {
      const header = splitCells(line);
      const cols = header.length;
      const aligns = parseAligns(lines[i + 1]);
      i += 2; // consume header + delimiter
      const body: string[][] = [];
      while (i < lines.length && lines[i].trim() !== "" && isTableRow(lines[i])) {
        body.push(splitCells(lines[i]));
        i++;
      }
      const metadata = i < lines.length ? tableMetadata(lines[i]) : null;
      if (metadata) i++;
      blocks.push(buildTable(header, body, cols, aligns, metadata ?? undefined));
      continue;
    }

    // Display math: opening line is exactly `$$`.
    if (line.trim() === "$$") {
      i++;
      const body: string[] = [];
      let attrs: Attrs = {};
      while (i < lines.length) {
        const closing = /^\s*\$\$(?:\s*\{([^}]*)\})?\s*$/.exec(lines[i]);
        if (closing) {
          if (closing[1]) attrs = parseAttrBrace(closing[1]);
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      blocks.push(
        schema.nodes.math_display.create({
          latex: body.join("\n").trim(),
          label: attrs.label ?? null,
          env: attrs.env ?? "equation",
          numbered: attrs.numbered ?? true,
          tag: attrs.tag ?? null,
        }),
      );
      continue;
    }

    // Pandoc-style theorem-like fenced div. A longer outer fence permits nested
    // blocks (`:::: theorem` containing `::: proof`). A closing fence may be
    // longer than its opener. Same-or-longer nested openers are ambiguous, so
    // the whole outer construct stays literal rather than swallowing content.
    const theoremOpen = /^(:{3,})\s+(.+?)\s*$/.exec(line.trim());
    const theoremHeader = theoremOpen ? parseTheoremHeader(theoremOpen[2]) : null;
    if (theoremHeader) {
      const fenceLength = theoremOpen![1].length;
      let close = i + 1;
      let closingFenceLength: number | null = null;
      let ambiguous = false;
      while (close < lines.length) {
        const candidate = lines[close].trim();
        const nestedOpen = /^(:{3,})\s+(.+?)\s*$/.exec(candidate);
        if (
          nestedOpen
          && nestedOpen[1].length >= fenceLength
          && parseTheoremHeader(nestedOpen[2])
        ) {
          ambiguous = true;
          break;
        }
        const theoremClose = /^(:{3,})\s*$/.exec(candidate);
        if (theoremClose && theoremClose[1].length >= fenceLength) {
          closingFenceLength = theoremClose[1].length;
          break;
        }
        close++;
      }
      if (!ambiguous && closingFenceLength != null) {
        const inner = lines.slice(i + 1, close);
        i = close + 1;
        const body = parseBlocks(inner.join("\n"));
        blocks.push(
          schema.nodes.theorem.create(
            {
              ...theoremHeader,
              fenceLength,
              closingFenceLength,
            },
            body.length ? body : [schema.nodes.paragraph.create()],
          ),
        );
        continue;
      }
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      let content = heading[2];
      let id: string | null = null;
      // A trailing `{#id}` sets the heading id — unless the brace is escaped
      // (`\{#…}`), which keeps it as literal text (#I79).
      const idMatch = /(?<!\\)\{#([\w:-]+)\}\s*$/.exec(content);
      if (idMatch) {
        id = idMatch[1];
        content = content.slice(0, idMatch.index);
      }
      blocks.push(
        schema.nodes.heading.create(
          { level: heading[1].length, id },
          parseInline(content.trim()),
        ),
      );
      i++;
      continue;
    }

    // Fenced code block.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // closing fence
      const codeText = code.join("\n");
      blocks.push(
        schema.nodes.code_block.create(
          { language: fence[1] || null },
          // guard the empty string — `schema.text("")` throws (e.g. a fence whose
          // only content is one blank line: code === [""], join === "")
          codeText ? schema.text(codeText) : undefined,
        ),
      );
      continue;
    }

    // Blockquote.
    if (/^\s*>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        inner.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        schema.nodes.blockquote.create(null, parseBlocks(inner.join("\n"))),
      );
      continue;
    }

    // Lists (nestable). A single recursive parser handles indentation depth,
    // wrapped continuations, and nested sub-lists (#I03/#I03b).
    if (isBullet(line) || isOrdered(line)) {
      const { node, next } = parseListAt(lines, i, indentOf(line));
      blocks.push(node);
      i = next;
      continue;
    }

    // Paragraph: this is the fallthrough branch (every block-starter was checked
    // above), so ALWAYS consume the current line first — otherwise a line that is
    // none of the above yet trips a stop-condition (e.g. a lone delimiter-shaped
    // row like `---|---`) advances `i` nowhere and loops forever (OOM on reopen).
    const para: string[] = [lines[i]];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      lines[i].trim() !== "$$" &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^!\[(?:\\.|[^\]])*\]\([^)\s]+\)(?:\{[^}]*\})?\s*$/.test(lines[i]) &&
      !/^\[\^[A-Za-z0-9_.:-]+\]:/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !isBullet(lines[i]) &&
      !isOrdered(lines[i]) &&
      !isHorizontalRule(lines[i]) &&
      !parseMathdownSourceMarker(lines[i]) &&
      !DETAILS_OPEN_RE.test(lines[i]) &&
      !DETAILS_CLOSE_RE.test(lines[i]) &&
      // stop at a table start (pipe row followed by a delimiter row)
      !(isTableRow(lines[i]) && isDelimiterRow(lines[i + 1] ?? "")) &&
      !isDelimiterRow(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    // Preserve the author's line wrapping within a paragraph (join with "\n",
    // not " ") so saving a hand-wrapped .md doesn't reflow it into one long line
    // (#I02). Soft newlines render as spaces but round-trip faithfully.
    blocks.push(
      schema.nodes.paragraph.create(null, withSoftBreaks(parseInline(para.join("\n")))),
    );
  }

  return blocks;
}

export function parseMarkdown(md: string): PMNode {
  const blocks = parseBlocks(md);
  return schema.nodes.doc.create(
    null,
    blocks.length ? blocks : [schema.nodes.paragraph.create()],
  );
}
