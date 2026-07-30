// Synthesize large documents for performance testing (Phase 10 fixtures).

export interface BigDocOptions {
  paragraphs?: number;
  inlineEqs?: number;
  displayEqs?: number;
  scholarlyBlocks?: number;
}

export function bigDoc(options: BigDocOptions = {}): string {
  const {
    paragraphs = 0,
    inlineEqs = 0,
    displayEqs = 0,
    scholarlyBlocks = 0,
  } = options;
  const lines: string[] = ["# Performance fixture", ""];

  for (let i = 0; i < paragraphs; i++) {
    lines.push(
      `Paragraph ${i}: some prose with **bold**, *italic* and a \`token\` to keep the line realistic.`,
      "",
    );
  }
  for (let i = 0; i < inlineEqs; i++) {
    lines.push(
      `Equation ${i} inline: $x_{${i}} = \\frac{a_{${i}}}{b_{${i}}} + \\sqrt{${i}}$ and trailing text.`,
      "",
    );
  }
  for (let i = 0; i < displayEqs; i++) {
    lines.push("$$", `\\int_0^{${i}} f_{${i}}(x)\\,dx = ${i}`, `$$ {#eq:d${i}}`, "");
  }
  for (let i = 0; i < scholarlyBlocks; i++) {
    lines.push(
      `:::: theorem {Result ${i}} {#thm:result-${i}}`,
      `Claim ${i} follows from [@source${i}, p. ${i + 1}] and @eq:d${i}.`,
      "",
      "::: proof",
      `Apply the displayed identity with $x_{${i}}$ and use the stated assumptions.`,
      ":::",
      "::::",
      "",
    );
  }

  return lines.join("\n");
}
