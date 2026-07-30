import type { DocMeta } from "../markdown/frontmatter";

// Suggested vocabularies for the document "kind" (what it does) and "status".
// These are only suggestions — the inspector lets you type any value.
export const KINDS = [
  "notes",
  "derivation",
  "proof",
  "paper",
  "review",
  "reference",
] as const;

export const STATUSES = ["draft", "review", "final"] as const;

// Typed document relations (#I70). Each has a forward phrasing (this doc → other)
// and a reverse phrasing for the backlink shown on the other doc.
export const REL_TYPES = [
  "extends",
  "supersedes",
  "derived-from",
  "cites",
  "see-also",
] as const;

const REL_FORWARD: Record<string, string> = {
  extends: "extends",
  supersedes: "supersedes",
  "derived-from": "derived from",
  cites: "cites",
  "see-also": "see also",
};
const REL_REVERSE: Record<string, string> = {
  extends: "extended by",
  supersedes: "superseded by",
  "derived-from": "basis for",
  cites: "cited by",
  "see-also": "see also",
};
export const relForward = (rel: string): string => REL_FORWARD[rel] ?? rel;
export const relReverse = (rel: string): string => REL_REVERSE[rel] ?? rel;

// A stable document id that survives rename/move (relations/anchors reference
// it). Time-ordered prefix + random suffix — good enough for a local library.
export function newDocId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Deterministic, pleasant colour for a project/tag label so the same name always
// gets the same chip colour (no registry needed).
export function labelColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  const a = Math.abs(h);
  const hue = a % 360;
  // Vary saturation + lightness from other hash bits too, so distinct labels are
  // far less likely to collide on colour than a hue-only (360-value) space.
  const sat = 44 + ((a >> 9) % 4) * 8; // 44 / 52 / 60 / 68
  const light = 38 + ((a >> 17) % 3) * 7; // 38 / 45 / 52
  return `hsl(${hue} ${sat}% ${light}%)`;
}

// Human-friendly display title for a document: its explicit title, else the
// filename without extension.
export function docTitle(meta: DocMeta, filename: string): string {
  return meta.title?.trim() || filename.replace(/\.(md|markdown)$/i, "");
}

// Split a comma/newline-separated free-text field into a clean, de-duplicated,
// order-preserving list (used by the tag/project chip inputs).
export function parseList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const t = part.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}
