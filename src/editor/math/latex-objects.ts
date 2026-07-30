// LyX-style sub-object splitting (prototype, borrowed from the lyx-markdown
// prototype's `splitLatexObjects`). A lightweight brace-depth scanner — NOT a
// TeX parser — that partitions a LaTeX body into top-level "objects" separated
// by top-level whitespace. It is deliberately source-preserving: joining the
// segments back reproduces the input character-for-character, so merely opening
// an equation for sub-object editing never mutates its LaTeX.
//
//   "E=mc^2 + \frac{1}{2}x^2"
//     → [ {object "E=mc^2"} {gap " "} {object "+"} {gap " "} {object "\frac{1}{2}x^2"} ]
//
// A control sequence and its immediately-following brace groups stay in one
// object (so `\frac{1}{2}x^2` is a single editable unit), because braces are
// depth-tracked and only *top-level* whitespace breaks an object.

export interface LatexSegment {
  latex: string;
  kind: "object" | "gap";
}

export function splitLatexSegments(latex: string): LatexSegment[] {
  const segs: LatexSegment[] = [];
  const n = latex.length;
  let i = 0;

  while (i < n) {
    // Whitespace run → a gap segment.
    if (/\s/.test(latex[i])) {
      const start = i;
      while (i < n && /\s/.test(latex[i])) i++;
      segs.push({ latex: latex.slice(start, i), kind: "gap" });
      continue;
    }

    // Object run → until the next top-level whitespace.
    const start = i;
    let depth = 0;
    while (i < n) {
      const c = latex[i];
      if (c === "\\") {
        i += 2; // control sequence / escaped char — consume the pair
        continue;
      }
      if (c === "{" || c === "[") {
        depth++;
        i++;
        continue;
      }
      if (c === "}" || c === "]") {
        depth = Math.max(0, depth - 1);
        i++;
        continue;
      }
      if (depth === 0 && /\s/.test(c)) break;
      i++;
    }
    segs.push({ latex: latex.slice(start, i), kind: "object" });
  }

  return segs;
}

export function joinLatexSegments(segs: LatexSegment[]): string {
  return segs.map((s) => s.latex).join("");
}

// Convenience: just the editable objects, tagged with their segment index.
export interface LatexObject {
  latex: string;
  index: number;
}
export function splitLatexObjects(latex: string): LatexObject[] {
  const out: LatexObject[] = [];
  splitLatexSegments(latex).forEach((seg, index) => {
    if (seg.kind === "object") out.push({ latex: seg.latex, index });
  });
  return out;
}
