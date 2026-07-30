// Typing ergonomics for the element source input (ported from the lyx-markdown
// prototype's mathCommands): auto-expand a command to its skeleton with the
// caret in the first slot, and insert script braces. On commit the equation
// reparses, so `\frac`+space → `\frac{}{}` → a real editable fraction.

export interface Edit {
  value: string;
  caret: number;
}

// name → { snippet, caret offset into the snippet where the cursor should land }
const COMMAND_EXPANSIONS: Record<string, Edit> = {
  frac: { value: "\\frac{}{}", caret: 6 },
  dfrac: { value: "\\dfrac{}{}", caret: 7 },
  tfrac: { value: "\\tfrac{}{}", caret: 7 },
  sqrt: { value: "\\sqrt{}", caret: 6 },
  sum: { value: "\\sum_{}^{}", caret: 6 },
  prod: { value: "\\prod_{}^{}", caret: 7 },
  int: { value: "\\int_{}^{}", caret: 6 },
  lim: { value: "\\lim_{}", caret: 6 },
  vec: { value: "\\vec{}", caret: 5 },
  hat: { value: "\\hat{}", caret: 5 },
  bar: { value: "\\bar{}", caret: 5 },
  overline: { value: "\\overline{}", caret: 10 },
  underline: { value: "\\underline{}", caret: 11 },
  text: { value: "\\text{}", caret: 6 },
};

// If a bare `\command` sits just before the caret, expand it to its skeleton.
export function expandCommand(value: string, caret: number): Edit | null {
  const before = value.slice(0, caret);
  const m = /\\([A-Za-z]+)$/.exec(before);
  if (!m) return null;
  const exp = COMMAND_EXPANSIONS[m[1]];
  if (!exp) return null;
  const start = caret - m[0].length;
  return {
    value: value.slice(0, start) + exp.value + value.slice(caret),
    caret: start + exp.caret,
  };
}

// Insert `^{}` / `_{}` at the caret (or wrap the selection), caret inside braces.
export function insertScript(
  value: string,
  from: number,
  to: number,
  op: "^" | "_",
): Edit {
  const selected = value.slice(from, to);
  const snippet = `${op}{${selected}}`;
  return {
    value: value.slice(0, from) + snippet + value.slice(to),
    // caret after the inner content (ready to keep typing the script)
    caret: from + op.length + 1 + selected.length,
  };
}

export function isExpandable(name: string): boolean {
  return name in COMMAND_EXPANSIONS;
}
