// A tiny, source-preserving LaTeX structure parser — enough to expose the
// editable "slots" of the common structures (fraction numerator/denominator,
// radicand + index, script bodies, groups) for nested visual editing. It is NOT
// a full TeX parser: unrecognized commands are kept as opaque `raw` leaves.
//
// The invariant that matters: `mathToLatex(parseMath(x)) === x` for supported
// input, so opening an equation for slot editing never rewrites its source.

export type MathTerm =
  | { kind: "text"; text: string }
  | { kind: "raw"; text: string } // a command (+ its brace args) kept verbatim
  | { kind: "group"; body: MathTerm[] }
  | { kind: "frac"; num: MathTerm[]; den: MathTerm[] }
  | { kind: "sqrt"; index: MathTerm[] | null; rad: MathTerm[] }
  | { kind: "script"; base: MathTerm; scripts: Script[] }
  // A \begin{name}…\end{name} grid: rows of cells, each cell a term sequence.
  | {
      kind: "env";
      name: string;
      colspec: string;
      rows: MathTerm[][][];
      format?: EnvGridFormat;
    };

export interface EnvGridFormat {
  /** Exact whitespace surrounding each editable cell body. */
  cellAffixes: Array<Array<{ prefix: string; suffix: string }>>;
  /** Exact authored `&` separators (normally just `&`). */
  cellSeparators: string[][];
  /** Exact authored row separators, including optional spacing such as `\\[2pt]`. */
  rowSeparators: string[];
  /** A final row terminator plus trailing whitespace, when one was authored. */
  trailingRowSource?: string;
}

export interface ParsedEnvGrid {
  rows: MathTerm[][][];
  format: EnvGridFormat;
}

export interface Script {
  type: "sup" | "sub";
  braced: boolean;
  body: MathTerm[];
}

const SPECIAL = "\\{}^_";

// Commands that take one mandatory argument which may be written WITHOUT braces
// (`\mathsf b`, `\bar u`, `\vec v`). The argument must stay attached to the
// command in a single leaf, else instrumenting splits `\mathsf` from `b` and the
// bare `\mathsf` fails to render.
const ARG_COMMANDS = new Set([
  "mathbf", "mathrm", "mathit", "mathsf", "mathtt", "mathcal", "mathbb",
  "mathfrak", "mathscr", "boldsymbol", "bm", "mathring", "text", "textbf",
  "textit", "texttt", "textrm", "textsf", "operatorname", "bar", "hat", "vec",
  "tilde", "dot", "ddot", "dddot", "check", "breve", "acute", "grave", "not",
  "overline", "underline", "widehat", "widetilde", "overrightarrow",
  // Delimiter-size commands take a following delimiter (`\Big[`, `\big(`); a bare
  // `\Big` fails to render. These sized delimiters are self-contained, so keeping
  // each with its delimiter in one leaf is enough (unlike \left…\right, below).
  "big", "Big", "bigg", "Bigg", "bigl", "Bigl", "bigr", "Bigr",
  "biggl", "Biggl", "biggr", "Biggr", "bigm", "Bigm", "biggm", "Biggm",
]);

// Environments whose body is a `&`/`\\` grid we can edit per-cell.
const GRID_ENVS = new Set([
  "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix",
  "smallmatrix", "cases", "aligned", "gathered", "array", "split", "alignedat",
]);

// Split an environment body at top-level (brace-depth 0) row (`\\`) or cell
// (`&`) separators, skipping control sequences and nested groups/environments.
function splitEnv(
  body: string,
  rowMode: boolean,
): { parts: string[]; separators: string[] } {
  const parts: string[] = [];
  const separators: string[] = [];
  let depth = 0;
  let environmentDepth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "\\") {
      const environment = /^\\(begin|end)\{[^{}]+\}/.exec(body.slice(i));
      if (environment) {
        environmentDepth = environment[1] === "begin"
          ? environmentDepth + 1
          : Math.max(0, environmentDepth - 1);
        i += environment[0].length;
        continue;
      }
      if (
        rowMode && body[i + 1] === "\\" && depth === 0 &&
        environmentDepth === 0
      ) {
        const separatorStart = i;
        parts.push(body.slice(start, i));
        i += 2;
        // TeX row breaks may carry an optional vertical-spacing argument. It is
        // part of the separator, not the next cell's source.
        if (body[i] === "[") {
          let optionalDepth = 1;
          let j = i + 1;
          while (j < body.length && optionalDepth > 0) {
            if (body[j] === "\\") {
              j += 2;
              continue;
            }
            if (body[j] === "[") optionalDepth++;
            else if (body[j] === "]") optionalDepth--;
            j++;
          }
          if (optionalDepth === 0) i = j;
        }
        separators.push(body.slice(separatorStart, i));
        start = i;
        continue;
      }
      i += 2; // control sequence / escaped char
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth = Math.max(0, depth - 1);
    else if (!rowMode && c === "&" && depth === 0 && environmentDepth === 0) {
      parts.push(body.slice(start, i));
      separators.push("&");
      start = i + 1;
    }
    i++;
  }
  parts.push(body.slice(start));
  return { parts, separators };
}

// Map a display node's `env` attribute to the KaTeX grid environment used for
// editing (and back), or null if it isn't a per-cell grid.
// Derive the environment an equation should render *and* edit as. A display body
// stored as the default `equation` that nonetheless uses top-level alignment
// markers (`&` columns / `\\` row breaks, with no environment of its own) is
// treated as `align` — or `gather` for row breaks alone — so the static render,
// the fluid grid editor, and the LaTeX export all agree (#I14). Otherwise the
// render would draw a grid while the editor still parsed the body flat.
export function effectiveEnv(env: string, latex: string): string {
  if (env !== "equation") return env;
  if (/\\begin\{/.test(latex)) return env; // has its own environment
  if (/(?<!\\)&/.test(latex)) return "align";
  if (/\\\\/.test(latex)) return "gather";
  return env;
}

export function katexGridEnv(attr: string): string | null {
  const map: Record<string, string> = {
    align: "aligned",
    aligned: "aligned",
    gather: "gathered",
    gathered: "gathered",
    cases: "cases",
    split: "aligned",
  };
  return map[attr] ?? null;
}

// The inner grid (rows joined by `&`/`\\`) with no \begin/\end — for display
// nodes that store the environment body only.
export function envGridToLatex(
  rows: MathTerm[][][],
  format?: EnvGridFormat,
  cell: (terms: MathTerm[]) => string = seqToLatex,
): string {
  const rowSources = rows.map((row, rowIndex) =>
    row.map((terms, cellIndex) => {
      const affix = format?.cellAffixes[rowIndex]?.[cellIndex];
      return `${affix?.prefix ?? ""}${cell(terms)}${affix?.suffix ?? ""}`;
    }).reduce((source, cellSource, cellIndex) => {
      if (cellIndex === 0) return cellSource;
      const separator = format?.cellSeparators[rowIndex]?.[cellIndex - 1] ?? " & ";
      return `${source}${separator}${cellSource}`;
    }, "")
  );
  const source = rowSources.reduce((body, rowSource, rowIndex) => {
    if (rowIndex === 0) return rowSource;
    const separator = format?.rowSeparators[rowIndex - 1] ?? " \\\\ ";
    return `${body}${separator}${rowSource}`;
  }, "");
  return source + (format?.trailingRowSource ?? "");
}

// Body string → rows of cells plus exact separators/outer whitespace. The source
// envelope is kept separately from editable terms, so changing one cell does not
// normalize every `&`, row break, or `\\[2pt]` in the environment.
export function parseEnvGrid(body: string): ParsedEnvGrid {
  const rowSplit = splitEnv(body, true);
  const cellAffixes: EnvGridFormat["cellAffixes"] = [];
  const cellSeparators: string[][] = [];
  const rows = rowSplit.parts.map((row, rowIndex) => {
    const cellSplit = splitEnv(row, false);
    cellSeparators[rowIndex] = cellSplit.separators;
    cellAffixes[rowIndex] = [];
    return cellSplit.parts.map((source, cellIndex) => {
      const prefix = /^\s*/.exec(source)?.[0] ?? "";
      const remainder = source.slice(prefix.length);
      const suffix = /\s*$/.exec(remainder)?.[0] ?? "";
      const core = remainder.slice(0, remainder.length - suffix.length);
      cellAffixes[rowIndex][cellIndex] = { prefix, suffix };
      const terms = parseMath(core);
      return terms.length ? terms : [{ kind: "text", text: "" } as MathTerm];
    });
  });
  let trailingRowSource: string | undefined;
  // A trailing `\\` (LaTeX's optional line terminator) yields one spurious empty
  // final row — drop AT MOST that one. (The old `while` loop deleted *every*
  // trailing empty row, destroying user-authored blank rows in column vectors.)
  if (
    rows.length > 1 &&
    rowSplit.parts[rowSplit.parts.length - 1].trim() === ""
  ) {
    rows.pop();
    cellAffixes.pop();
    cellSeparators.pop();
    trailingRowSource =
      rowSplit.separators.pop()! + rowSplit.parts[rowSplit.parts.length - 1];
  }
  return {
    rows,
    format: {
      cellAffixes,
      cellSeparators,
      rowSeparators: rowSplit.separators,
      ...(trailingRowSource !== undefined ? { trailingRowSource } : {}),
    },
  };
}

export function parseEnvRows(body: string): MathTerm[][][] {
  return parseEnvGrid(body).rows;
}

function envToLatex(
  name: string,
  colspec: string,
  rows: MathTerm[][][],
  cell: (c: MathTerm[]) => string,
  format?: EnvGridFormat,
): string {
  const grid = envGridToLatex(rows, format, cell);
  return `\\begin{${name}}${colspec}${grid}\\end{${name}}`;
}

export function parseMath(src: string): MathTerm[] {
  let i = 0;
  const n = src.length;

  function parseSeq(stopAtBrace: boolean): MathTerm[] {
    const terms: MathTerm[] = [];
    while (i < n) {
      if (stopAtBrace && src[i] === "}") break;
      const term = parseTermWithScripts();
      if (!term) break;
      terms.push(term);
    }
    return terms;
  }

  function parseTermWithScripts(): MathTerm | null {
    const base = parseAtom();
    if (!base) return null;
    // `\limits`/`\nolimits` attach BACKWARD to the operator and must render in
    // the same group as it (and its scripts). Fold the whole `\sum\limits_i^n`
    // into one raw leaf, else instrumenting splits `\sum` from `\limits` and
    // KaTeX errors ("Limit controls must follow a math operator").
    if (
      (base.kind === "raw" || base.kind === "text") &&
      (src.startsWith("\\limits", i) || src.startsWith("\\nolimits", i))
    ) {
      const lim = src.startsWith("\\nolimits", i) ? "\\nolimits" : "\\limits";
      let text = base.text + lim;
      i += lim.length;
      while (src[i] === "^" || src[i] === "_") {
        text += src[i];
        i++;
        if (src[i] === "{") text += captureBalanced();
        else if (src[i] !== undefined) {
          text += src[i];
          i++;
        }
      }
      return { kind: "raw", text };
    }
    if (src[i] === "^" || src[i] === "_") {
      const scripts: Script[] = [];
      while (src[i] === "^" || src[i] === "_") {
        const type = src[i] === "^" ? "sup" : "sub";
        i++;
        scripts.push({ type, ...parseScriptArg() });
      }
      return { kind: "script", base, scripts };
    }
    return base;
  }

  function parseScriptArg(): { braced: boolean; body: MathTerm[] } {
    if (src[i] === "{") {
      i++;
      const body = parseSeq(true);
      if (src[i] === "}") i++;
      // An empty braced script (`x^{}`, or a `\sum_{}^{}` skeleton) gets one
      // empty leaf so the slot is clickable/typeable in the element editor
      // (#I34). An empty leaf serializes back to nothing, so `^{}` is preserved.
      return { braced: true, body: body.length ? body : [{ kind: "text", text: "" }] };
    }
    const t = parseSingleToken();
    return { braced: false, body: t ? [t] : [] };
  }

  function parseSingleToken(): MathTerm | null {
    if (i >= n) return null;
    if (src[i] === "\\") return parseCommand();
    if (src[i] === "{") {
      i++;
      const body = parseSeq(true);
      if (src[i] === "}") i++;
      return { kind: "group", body };
    }
    const c = src[i];
    i++;
    return { kind: "text", text: c };
  }

  // Reads a `\name` and, for known structures, its slots; otherwise keeps the
  // command plus immediately-following brace groups as a raw leaf.
  function parseCommand(): MathTerm {
    const start = i;
    i++; // backslash
    let name = "";
    if (/[a-zA-Z]/.test(src[i] ?? "")) {
      const s = i;
      while (i < n && /[a-zA-Z]/.test(src[i])) i++;
      name = src.slice(s, i);
    } else {
      name = src[i] ?? "";
      i++;
    }
    if (name === "begin") {
      if (src[i] !== "{") return { kind: "raw", text: src.slice(start, i) };
      i++;
      const es = i;
      while (i < n && src[i] !== "}") i++;
      const envName = src.slice(es, i);
      if (src[i] === "}") i++;
      // Optional argument (array column spec, alignedat count).
      const colspec = src[i] === "{" ? captureBalanced() : "";
      // Capture the body up to the matching \end{…}, honoring nested envs.
      const bodyStart = i;
      let depth = 1;
      while (i < n && depth > 0) {
        if (src.startsWith("\\begin{", i)) {
          depth++;
          i += 7;
        } else if (src.startsWith("\\end{", i)) {
          depth--;
          if (depth === 0) break;
          i += 5;
        } else {
          i++;
        }
      }
      const body = src.slice(bodyStart, i);
      if (src.startsWith("\\end{", i)) {
        i += 5;
        while (i < n && src[i] !== "}") i++;
        if (src[i] === "}") i++;
      }
      if (!GRID_ENVS.has(envName)) {
        return { kind: "raw", text: src.slice(start, i) };
      }
      const grid = parseEnvGrid(body);
      return { kind: "env", name: envName, colspec, rows: grid.rows, format: grid.format };
    }
    if (name === "frac") {
      const num = parseGroup();
      const den = parseGroup();
      return { kind: "frac", num, den };
    }
    if (name === "sqrt") {
      let index: MathTerm[] | null = null;
      if (src[i] === "[") {
        i++;
        const s = i;
        let depth = 0;
        while (i < n && !(src[i] === "]" && depth === 0)) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") depth--;
          i++;
        }
        index = parseMath(src.slice(s, i));
        if (src[i] === "]") i++;
      }
      const rad = parseGroup();
      return { kind: "sqrt", index, rad };
    }
    // `\left…\right` must stay balanced inside one group — splitting it across
    // leaves makes KaTeX error. Capture the whole (possibly nested) span as one
    // opaque leaf. (Its own delimiter is skipped by the loop's `else i++`.)
    if (name === "left") {
      let depth = 1;
      while (i < n && depth > 0) {
        if (src.startsWith("\\left", i)) {
          depth++;
          i += 5;
        } else if (src.startsWith("\\right", i)) {
          depth--;
          i += 6;
          skipDelim(); // consume \right's delimiter
        } else {
          i++;
        }
      }
      return { kind: "raw", text: src.slice(start, i) };
    }
    // An argument-taking command with an UNBRACED arg (`\mathsf b`, `\Big[`):
    // keep the command and its next token in one leaf so it stays renderable.
    if (ARG_COMMANDS.has(name) && src[i] !== "{") captureUnbracedArg();
    let raw = src.slice(start, i);
    while (src[i] === "{") raw += captureBalanced();
    return { kind: "raw", text: raw };
  }

  // Advance past a delimiter after `\right`/`\big…`: spaces, then a `\command`
  // or a single char (`(`, `|`, `.`, …).
  function skipDelim(): void {
    while (i < n && (src[i] === " " || src[i] === "\t")) i++;
    if (i >= n) return;
    if (src[i] === "\\") {
      i++;
      if (/[a-zA-Z]/.test(src[i] ?? "")) while (i < n && /[a-zA-Z]/.test(src[i])) i++;
      else i++;
    } else {
      i++;
    }
  }

  // Advance `i` past one unbraced argument: leading spaces, then a `\command`,
  // a `{…}` group, or a single character. No-op if none is available.
  function captureUnbracedArg(): void {
    const s = i;
    while (i < n && (src[i] === " " || src[i] === "\t")) i++;
    if (i >= n) {
      i = s; // nothing to take — leave the command bare
      return;
    }
    if (src[i] === "{") {
      captureBalanced();
    } else if (src[i] === "\\") {
      i++;
      if (/[a-zA-Z]/.test(src[i] ?? "")) while (i < n && /[a-zA-Z]/.test(src[i])) i++;
      else i++;
    } else {
      i++;
    }
  }

  function parseAtom(): MathTerm | null {
    if (i >= n || src[i] === "}") return null;
    if (src[i] === "\\") return parseCommand();
    if (src[i] === "{") {
      i++;
      const body = parseSeq(true);
      if (src[i] === "}") i++;
      return { kind: "group", body };
    }
    if (src[i] === "^" || src[i] === "_") {
      const c = src[i];
      i++;
      return { kind: "text", text: c }; // orphan script char
    }
    // plain text run, up to the next special character
    const start = i;
    while (i < n && !SPECIAL.includes(src[i])) i++;
    let text = src.slice(start, i);
    // A script binds to the last atom only: leave the final char as its base.
    if ((src[i] === "^" || src[i] === "_") && text.length > 1) {
      i--;
      text = text.slice(0, -1);
    }
    return { kind: "text", text };
  }

  function parseGroup(): MathTerm[] {
    // TeX skips whitespace before a command argument: `\frac ab` → num a, den b.
    // Without this the space became the (empty) numerator and operands shifted.
    while (src[i] === " " || src[i] === "\t" || src[i] === "\n") i++;
    // An empty group is a real, editable slot — `\frac{}{}` must yield a
    // navigable numerator and denominator, not zero leaves (#I50), mirroring how
    // parseScriptArg gives an empty script `[{text:""}]`.
    if (src[i] === "{") {
      i++;
      const body = parseSeq(true);
      if (src[i] === "}") i++;
      return body.length ? body : [{ kind: "text", text: "" }];
    }
    const t = parseSingleToken();
    return t ? [t] : [{ kind: "text", text: "" }];
  }

  function captureBalanced(): string {
    const start = i;
    let depth = 0;
    do {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    } while (i < n && depth > 0);
    return src.slice(start, i);
  }

  return parseSeq(false);
}

function seqToLatex(terms: MathTerm[]): string {
  return terms.map(termToLatex).join("");
}

export function termToLatex(t: MathTerm): string {
  switch (t.kind) {
    case "text":
    case "raw":
      return t.text;
    case "group":
      return `{${seqToLatex(t.body)}}`;
    case "frac":
      return `\\frac{${seqToLatex(t.num)}}{${seqToLatex(t.den)}}`;
    case "sqrt":
      return `\\sqrt${t.index ? `[${seqToLatex(t.index)}]` : ""}{${seqToLatex(t.rad)}}`;
    case "script":
      return (
        termToLatex(t.base) +
        t.scripts
          .map((s) => {
            const op = s.type === "sup" ? "^" : "_";
            const body = seqToLatex(s.body);
            return s.braced ? `${op}{${body}}` : `${op}${body}`;
          })
          .join("")
      );
    case "env":
      return envToLatex(t.name, t.colspec, t.rows, seqToLatex, t.format);
  }
}

export function mathToLatex(terms: MathTerm[]): string {
  return seqToLatex(terms);
}

// A single editable leaf (a text/raw term), in visual/source order.
export interface LeafRef {
  term: { text: string };
  index: number;
}

export const LEAF_CLASS = "mlf";

// Produce KaTeX-renderable LaTeX where every editable leaf is wrapped in
// \htmlClass{mlf mlf-N}{…} so its rendered DOM node can be located and measured.
// The equation is still ONE real KaTeX render — the design is unchanged; we only
// tag sub-expressions. `leaves[N].term` is the live term to mutate when editing
// leaf N; the canonical value comes from mathToLatex (no wrappers), so tagging
// never touches what is stored.
export function instrumentMath(
  terms: MathTerm[],
  // `activeLeaf` is the element being edited. In `glyph` mode it renders its real
  // source so the symbol shows live (`\int` → ∫) under a transparent input; in
  // `source` mode (the source is still an incomplete command that can't render)
  // it becomes an invisible box of width `padPx` so neighbours reflow and the
  // visible source input sits over it without erroring the whole equation.
  opts: { activeLeaf?: number; activeGlyph?: boolean; padPx?: number } = {},
): {
  latex: string;
  leaves: LeafRef[];
} {
  const leaves: LeafRef[] = [];

  const seq = (ts: MathTerm[]): string => ts.map(one).join("");

  const one = (t: MathTerm): string => {
    switch (t.kind) {
      case "text":
      case "raw": {
        const index = leaves.length;
        leaves.push({ term: t, index });
        let body: string;
        if (index === opts.activeLeaf && opts.activeGlyph === false) {
          // source mode: invisible strut of the reserved width (never errors).
          const w = Math.max(opts.padPx ?? 0, 6);
          body = `\\vphantom{X}\\hspace{${w}px}`;
        } else {
          // Empty leaf → a small visible placeholder box so it can be targeted.
          // Escape `%` so KaTeX doesn't read it as a comment and eat our closing
          // `}` (which errors the whole equation on edit).
          body = t.text === "" ? "\\rule{0.4em}{0.7em}" : t.text.replace(/\\%|%/g, "\\%");
        }
        return `\\htmlClass{${LEAF_CLASS} ${LEAF_CLASS}-${index}}{${body}}`;
      }
      case "group":
        return `{${seq(t.body)}}`;
      case "frac":
        return `\\frac{${seq(t.num)}}{${seq(t.den)}}`;
      case "sqrt":
        return `\\sqrt${t.index ? `[${seq(t.index)}]` : ""}{${seq(t.rad)}}`;
      case "script":
        return (
          one(t.base) +
          t.scripts
            .map((s) => {
              const op = s.type === "sup" ? "^" : "_";
              return `${op}{${seq(s.body)}}`;
            })
            .join("")
        );
      case "env":
        return envToLatex(t.name, t.colspec, t.rows, seq, t.format);
    }
  };

  return { latex: seq(terms), leaves };
}

// Does this LaTeX contain any structure worth showing as visual slots?
export function hasVisualStructure(latex: string): boolean {
  return parseMath(latex).some(isStructured);
}

function isStructured(t: MathTerm): boolean {
  return (
    t.kind === "frac" ||
    t.kind === "sqrt" ||
    t.kind === "group" ||
    t.kind === "env" ||
    (t.kind === "script" &&
      (isStructured(t.base) || t.scripts.some((s) => s.body.length > 0)))
  );
}
