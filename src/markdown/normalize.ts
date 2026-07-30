// Normalize LLM/ChatGPT-flavoured Markdown so our parser renders it.
//
// LLMs delimit math with `\(…\)` (inline) and `\[…\]` (display), not `$…$`/`$$`.
// Worse, when a ChatGPT answer is copied from the *rendered* view, the display
// delimiters degrade to bare `[` / `]` lines and the equation's `=` sign becomes
// a setext-heading underline (`====`), with stray `#` heading cruft. We detect
// these shapes and rewrite them to our `$`/`$$` form.
//
// Everything here is deliberately conservative: fenced/inline CODE is masked out
// so it is never rewritten, escaped `\\(` is left alone, and the paren-wrapping
// heuristic skips structural TeX commands (`\left`, `\ref`, `\text…`) so ordinary
// prose parentheticals are not turned into equations.

// Commands that mark a parenthetical as *prose about* TeX (or a `\left(…\right)`
// delimiter pair) rather than a standalone inline equation — never paren-wrap these.
const STRUCTURAL_CMD =
  /\\(?:left|right|middle|ref|eqref|pageref|autoref|cite[a-z]*|label|begin|end|text[a-z]*|mbox|emph|footnote|url|href|caption|item|section|subsection|subsubsection|paragraph|newcommand|renewcommand)\b/;

// Private-use sentinels wrapping a masked code region's index. They contain no
// character any normalization step matches (`\`, `$`, `[`, `]`, `=`, `(`, `)`).
const MASK_OPEN = "\uE000";
const MASK_CLOSE = "\uE001";

// Replace fenced code blocks and inline code with opaque placeholders so no
// rewriting touches them. Returns the masked text plus the captured code.
function maskCode(text: string): { masked: string; codes: string[] } {
  const codes: string[] = [];
  const stash = (s: string) => `${MASK_OPEN}${codes.push(s) - 1}${MASK_CLOSE}`;

  // Fenced blocks first (line-based, so an unterminated fence still masks to EOF).
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (open) {
      const marker = open[1][0];
      const start = i++;
      const close = new RegExp(`^\\s*${marker}{${open[1].length},}\\s*$`);
      while (i < lines.length && !close.test(lines[i])) i++;
      const end = Math.min(i, lines.length - 1);
      out.push(stash(lines.slice(start, end + 1).join("\n")));
    } else {
      out.push(lines[i]);
    }
  }

  // Then inline code spans (single line), on what remains.
  const masked = out
    .join("\n")
    .replace(/(`+)([^\n]*?)\1/g, (s) => stash(s));
  return { masked, codes };
}

function unmaskCode(text: string, codes: string[]): string {
  return text.replace(
    new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, "g"),
    (_, n) => codes[Number(n)] ?? "",
  );
}

// Does the text look like it carries LLM-style math worth converting? Callers
// should pass CODE-MASKED text so a `\(` inside a code sample doesn't count.
export function looksLikeLlmMarkdown(text: string): boolean {
  if (/(?<!\\)\\[[\]()]/.test(text)) return true; // \[ \] \( \)
  // the copied-from-rendered shape: a bare `[` line and a `====` setext rule
  return /^[ \t]*\[[ \t]*$/m.test(text) && /^[ \t]*={3,}[ \t]*$/m.test(text);
}

// Should a paste be routed through our Markdown parser (so its math renders)
// rather than pasted as literal text? True only on a *real* math signal — not on
// prose that merely contains dollar amounts like "$5 and $10". Code is ignored.
export function hasRenderableMath(text: string): boolean {
  const { masked } = maskCode(text);
  if (looksLikeLlmMarkdown(masked)) return true;
  if (/\$\$[\s\S]*?\$\$/.test(masked)) return true; // a `$$…$$` display block
  // an inline `$…$` whose body actually looks like math (a command, a sub/
  // superscript, or a brace group) — excludes prose prices ("$5 and $10").
  return /\$[^$\n]*[\\^_{}][^$\n]*\$/.test(masked);
}

// Rewrite bare `[ … ]` display blocks (degraded `\[ … \]`): a line that is only
// `[` opens and only `]` closes, IF a matching close exists and the block holds
// LaTeX. A setext rule (`====`) is the equation's `=` ONLY when it sits between
// content lines (a leading/trailing underline — e.g. a title — is dropped, not
// turned into a bogus `=`). Leading `#`/`##` is heading cruft to strip.
function fixBareDisplayBlocks(text: string): string {
  const isRule = (t: string) => /^={3,}$/.test(t) || /^-{3,}$/.test(t);
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "[") {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "]") j++;
      const block = lines.slice(i + 1, j);
      const isMath = j < lines.length && block.some((l) => l.includes("\\"));
      if (isMath) {
        // indices of real content (non-empty, non-rule) lines within the block
        const content = block
          .map((l, k) => ({ t: l.trim(), k }))
          .filter((x) => x.t && !isRule(x.t))
          .map((x) => x.k);
        const first = content[0] ?? -1;
        const last = content[content.length - 1] ?? -1;
        out.push("$$");
        block.forEach((l, k) => {
          const t = l.trim();
          if (/^={3,}$/.test(t)) {
            if (k > first && k < last) out.push("="); // infix `=`; else drop
          } else if (/^-{3,}$/.test(t)) {
            out.push(""); // stray rule → blank line
          } else {
            out.push(l.replace(/^#{1,6}[ \t]+/, "")); // strip ATX heading cruft
          }
        });
        out.push("$$");
        i = j; // skip past the `]`
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

export function normalizeLlmMarkdown(input: string): string {
  const { masked, codes } = maskCode(input.replace(/\r\n/g, "\n"));
  let t = masked;
  // Standard LLM delimiters (but never an escaped `\\(`/`\\[`). Put display `$$`
  // on their own lines so our block parser sees them; inline `\(…\)` → `$…$`.
  t = t.replace(/(?<!\\)\\\[/g, "\n$$$$\n").replace(/(?<!\\)\\\]/g, "\n$$$$\n");
  t = t.replace(/(?<!\\)\\\(/g, "$").replace(/(?<!\\)\\\)/g, "$");
  // Degraded (copied-from-rendered) display blocks.
  t = fixBareDisplayBlocks(t);
  // Inline math the degraded copy left as `(\cmd …)` — parens on one line that
  // contain a backslash command. `(M)` (no backslash) is left alone, and a
  // structural command (`\left(`, `(cf. \ref{x})`) is skipped so prose isn't
  // eaten. Applied ONLY outside existing math spans, so `\left(…\right)` and
  // `(\sigma-1)` inside a `$$…$$` block are preserved.
  t = mapOutsideMath(t, (seg) =>
    seg.replace(/\(([^()\n]*\\[a-zA-Z][^()\n]*)\)/g, (m, inner) =>
      STRUCTURAL_CMD.test(inner) ? m : `$${inner}$`,
    ),
  );
  // Collapse the runs of blank lines the `\[`→`\n$$\n` insertion can create.
  t = t.replace(/\n{3,}/g, "\n\n");
  return unmaskCode(t, codes);
}

// Apply `fn` to the parts of `t` that are NOT inside a `$$…$$` block or `$…$`
// inline span (those are left verbatim).
function mapOutsideMath(t: string, fn: (segment: string) => string): string {
  const parts = t.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/);
  return parts.map((p, i) => (i % 2 === 0 ? fn(p) : p)).join("");
}
