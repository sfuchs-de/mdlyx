import type { LibraryFile } from "./library";
import { docTitle } from "./doc-meta";

// Pure search / filter / grouping logic for the library view — separated from the
// DOM so it can be unit-tested directly.

export type GroupBy = "flat" | "folder" | "project" | "kind" | "tag" | "status";
export const GROUPS: GroupBy[] = ["flat", "folder", "project", "kind", "tag", "status"];
export const OTHER_NOTES_LABEL = "Other notes";
export const OTHER_NOTES_FOLDER = "other-notes";

export function isOtherNotesEntry(entry: LibraryFile): boolean {
  return entry.meta.projects.length === 0 && (
    entry.folder === OTHER_NOTES_FOLDER
    || entry.folder.startsWith(`${OTHER_NOTES_FOLDER}/`)
  );
}

/** Place a note name inside the collection while preserving requested subfolders. */
export function otherNotePath(rawName: string): string {
  const name = rawName.trim().replace(/^\/+|\/+$/g, "");
  if (!name || name === OTHER_NOTES_FOLDER) return "";
  if (name.startsWith(`${OTHER_NOTES_FOLDER}/`)) return name;
  return `${OTHER_NOTES_FOLDER}/${name}`;
}

// Unique key for a file within the library ("folder/name", or just "name" at root).
export function entryPath(e: LibraryFile): string {
  return e.folder ? `${e.folder}/${e.name}` : e.name;
}

/** Reader navigation excludes support files while stable IDs remain addressable. */
export function isReaderDocument(e: LibraryFile): boolean {
  return e.meta.visibility !== "support";
}

/**
 * Support files stay out of ordinary search. An exact stable ID or path is a
 * deliberate compatibility lookup and may reveal the retained document.
 */
export function matchesDocumentVisibility(e: LibraryFile, query: string): boolean {
  if (isReaderDocument(e)) return true;
  const exact = query.trim().toLocaleLowerCase();
  if (!exact) return false;
  return exact === (e.meta.id ?? "").toLocaleLowerCase()
    || exact === entryPath(e).toLocaleLowerCase();
}

// Free-text search across the title, filename, folder, kind, status, tags,
// projects and "contains".
export function matchesQuery(e: LibraryFile, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    e.meta.id ?? "",
    docTitle(e.meta, e.name),
    e.name,
    e.folder,
    e.meta.kind ?? "",
    e.meta.status ?? "",
    ...e.meta.tags,
    ...e.meta.projects,
    ...e.meta.contains,
    ...(isOtherNotesEntry(e) ? [OTHER_NOTES_LABEL] : []),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

// Active filters are "tag:foo" / "project:bar", ANDed: a file must carry every
// selected label.
export function matchesFilters(e: LibraryFile, filters: Iterable<string>): boolean {
  for (const f of filters) {
    const [facet, val] = splitFilter(f);
    if (facet === "collection") {
      if (val !== OTHER_NOTES_FOLDER || !isOtherNotesEntry(e)) return false;
      continue;
    }
    const pool = facet === "tag" ? e.meta.tags : e.meta.projects;
    if (!pool.includes(val)) return false;
  }
  return true;
}

export function splitFilter(f: string): [facet: string, value: string] {
  const i = f.indexOf(":");
  return [f.slice(0, i), f.slice(i + 1)];
}

export interface Group {
  /** Bucket key; a "— …" prefix marks the missing-facet placeholder bucket. */
  key: string;
  files: LibraryFile[];
}

// Group entries for a non-flat grouping. `tag`/`project` place a file under each
// of its labels; the others use a single key with a "— …" bucket for files that
// lack the facet. Buckets are sorted alphabetically with placeholders pushed last.
export function groupEntries(
  entries: LibraryFile[],
  groupBy: Exclude<GroupBy, "flat">,
): Group[] {
  const map = new Map<string, LibraryFile[]>();
  const push = (key: string, e: LibraryFile) => {
    const g = map.get(key);
    if (g) g.push(e);
    else map.set(key, [e]);
  };
  for (const e of entries) {
    if (groupBy === "folder") {
      push(e.folder || "— (root)", e);
    } else if (groupBy === "tag") {
      if (e.meta.tags.length) e.meta.tags.forEach((t) => push(t, e));
      else push("— untagged", e);
    } else if (groupBy === "project") {
      if (e.meta.projects.length) e.meta.projects.forEach((p) => push(p, e));
      else if (isOtherNotesEntry(e)) push(`— ${OTHER_NOTES_LABEL}`, e);
      else push("— no project", e);
    } else if (groupBy === "kind") {
      push(e.meta.kind ?? "— unkinded", e);
    } else {
      push(e.meta.status ?? "— no status", e);
    }
  }
  return [...map.keys()]
    .sort(sortGroupKeys)
    .map((key) => ({ key, files: map.get(key)! }));
}

function sortGroupKeys(a: string, b: string): number {
  // A real collection follows named facets but precedes generic missing-data
  // buckets such as “no project”.
  const pa = a === `— ${OTHER_NOTES_LABEL}` ? 1 : a.startsWith("— ") ? 2 : 0;
  const pb = b === `— ${OTHER_NOTES_LABEL}` ? 1 : b.startsWith("— ") ? 2 : 0;
  return pa - pb || a.localeCompare(b);
}
