import katex from "katex";
import { effectiveEnv } from "./math-ast";

// KaTeX needs `aligned`/`gathered`/`cases` wrappers for multi-line environments;
// the node stores only the mathematical body, so we wrap at render time. The env
// is resolved from content too, so an untagged body that uses alignment markers
// still renders as a grid rather than erroring (#I14).
export function wrapForKatex(latex: string, env: string): string {
  switch (effectiveEnv(env, latex)) {
    case "align":
      return `\\begin{aligned}${latex}\\end{aligned}`;
    case "gather":
      return `\\begin{gathered}${latex}\\end{gathered}`;
    case "cases":
      return `\\begin{cases}${latex}\\end{cases}`;
    default:
      return latex;
  }
}

// Does this fragment render without error? Used by the element editor to decide
// whether the active element can show its live glyph (`\int` → ∫) or must fall
// back to showing its source while it's still an incomplete command (`\in`).
export function rendersCleanly(latex: string, macros: Record<string, string> = {}): boolean {
  if (latex.trim() === "") return false;
  try {
    katex.renderToString(latex, { throwOnError: true, macros, trust: true, strict: false });
    return true;
  } catch {
    return false;
  }
}

// Render LaTeX into `element`. Never throws: invalid LaTeX shows inline in red
// instead of taking down the editor.
export function renderKatex(
  latex: string,
  element: HTMLElement,
  displayMode: boolean,
  macros: Record<string, string> = {},
  env = "equation",
  // `trust` enables \htmlClass (used to tag editable elements for measuring).
  trust = false,
): void {
  const source = displayMode ? wrapForKatex(latex, env) : latex;
  try {
    katex.render(source, element, {
      displayMode,
      throwOnError: false,
      macros,
      trust,
      strict: false,
    });
  } catch (err) {
    element.textContent = latex;
    element.classList.add("math-error");
    element.title = err instanceof Error ? err.message : String(err);
  }
}
