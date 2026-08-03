import type { NumberingConfig } from "../editor/numbering";
import { defaultNumbering } from "../editor/numbering";
import type { StoredComment } from "../editor/comments";
import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";
import type { Document, Node, Pair } from "yaml";

// A deliberately small YAML subset covering the two blocks we support:
//
//   ---
//   macros:
//     RR: "\mathbb{R}"
//     dd: "\,\mathrm{d}"
//   numbering:
//     equations: section
//     headings: true
//   ---
//
// Convention (#D05-adjacent): values are taken literally after `key:`, with a
// single pair of surrounding quotes stripped and NO escape processing — so
// `RR: "\mathbb{R}"` yields the string `\mathbb{R}`, exactly what KaTeX wants.

// Library metadata: a document's own properties (source of truth lives here in
// frontmatter, so it travels with the file and is rebuildable into an index).
// `id` is a stable identifier that survives rename/move (relations/anchors will
// reference it). `kind`/`status` have a suggested vocabulary but accept any
// string; `tags`/`contains`/`projects` are free-form lists.
/** A typed link to another document (by stable id) — see #I70. */
export interface RelatedRef {
  id: string;
  rel: string; // extends | supersedes | derived-from | cites | see-also
}

/** A project overview may delegate task state to one external source of truth. */
export interface ExternalTaskAuthority {
  mode: "external";
  system: string;
  url: string;
}

export interface ProjectionWarningRef {
  result_id: string;
  dependencies: string[];
  scope: string;
}

/** Metadata carried by a generated Contract v2 Markdown projection. */
export interface GeneratedResultManifestRef {
  kind: "generated-result-manifest";
  schema_version: "2.0";
  sources: string[];
  digest: string;
  read_only: true;
  acknowledged_warnings: ProjectionWarningRef[];
}

/** Reader projection generated from the authoritative graph and registries. */
export interface GeneratedDependencyReaderRef {
  kind: "generated-dependency-reader";
  schema_version: "1.0" | "2.0";
  sources: string[];
  digest: string;
  read_only: true;
}

export type GeneratedProjectionRef =
  | GeneratedResultManifestRef
  | GeneratedDependencyReaderRef;

export type LibraryVisibility = "reader" | "support";

export interface DocMeta {
  id?: string;
  title?: string;
  kind?: string;
  status?: string;
  visibility: LibraryVisibility;
  tags: string[];
  contains: string[];
  projects: string[];
  related: RelatedRef[];
  task_authority?: ExternalTaskAuthority;
  projection?: GeneratedProjectionRef;
}

export function emptyMeta(): DocMeta {
  return {
    visibility: "reader",
    tags: [],
    contains: [],
    projects: [],
    related: [],
  };
}

export function metaIsEmpty(m: DocMeta): boolean {
  return (
    !m.id &&
    !m.title &&
    !m.kind &&
    !m.status &&
    m.visibility === "reader" &&
    m.tags.length === 0 &&
    m.contains.length === 0 &&
    m.projects.length === 0 &&
    m.related.length === 0 &&
    !m.task_authority &&
    !m.projection
  );
}

// Coerce arbitrary parsed JSON into a well-formed DocMeta (defensive against a
// hand-edited or AI-mangled `library:` block).
export function normalizeMeta(o: unknown): DocMeta {
  const r = (o ?? {}) as Record<string, unknown>;
  // Cap list lengths so a hostile / AI-mangled block (a 100k-item tags array)
  // can't build 100k DOM chips and freeze the UI (#I80).
  const CAP = 200;
  const arr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string").slice(0, CAP)
      : [];
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const rels = (v: unknown): RelatedRef[] =>
    Array.isArray(v)
      ? v
          .map((x) => {
            const rec = (x ?? {}) as Record<string, unknown>;
            const id = str(rec.id);
            const rel = str(rec.rel);
            return id && rel ? { id, rel } : null;
          })
          .filter((x): x is RelatedRef => x !== null)
          .slice(0, CAP)
      : [];
  const taskAuthority = (v: unknown): ExternalTaskAuthority | undefined => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const authority = v as Record<string, unknown>;
    const system = str(authority.system);
    const url = str(authority.url);
    if (authority.mode !== "external" || !system || !url) return undefined;
    try {
      const parsed = new URL(url);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.host) return undefined;
    } catch {
      return undefined;
    }
    return { mode: "external", system, url };
  };
  const projection = (v: unknown): GeneratedProjectionRef | undefined => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const value = v as Record<string, unknown>;
    if (
      (value.kind !== "generated-result-manifest" && value.kind !== "generated-dependency-reader")
      || (
        value.schema_version !== "2.0"
        && !(value.kind === "generated-dependency-reader" && value.schema_version === "1.0")
      )
      || value.read_only !== true
      || typeof value.digest !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(value.digest)
    ) return undefined;
    const sources = arr(value.sources);
    if (sources.length < 2) return undefined;
    if (value.kind === "generated-dependency-reader") {
      return {
        kind: "generated-dependency-reader",
        schema_version: value.schema_version,
        sources,
        digest: value.digest,
        read_only: true,
      };
    }
    const acknowledged_warnings = Array.isArray(value.acknowledged_warnings)
      ? value.acknowledged_warnings.flatMap((item): ProjectionWarningRef[] => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const warning = item as Record<string, unknown>;
          const result_id = str(warning.result_id);
          const scope = str(warning.scope);
          if (!result_id || !scope) return [];
          return [{ result_id, scope, dependencies: arr(warning.dependencies) }];
        }).slice(0, CAP)
      : [];
    return {
      kind: "generated-result-manifest",
      schema_version: "2.0",
      sources,
      digest: value.digest,
      read_only: true,
      acknowledged_warnings,
    };
  };
  return {
    id: str(r.id),
    title: str(r.title),
    kind: str(r.kind),
    status: str(r.status),
    visibility: r.visibility === "support" ? "support" : "reader",
    tags: arr(r.tags),
    contains: arr(r.contains),
    projects: arr(r.projects),
    related: rels(r.related),
    task_authority: taskAuthority(r.task_authority),
    projection: projection(r.projection),
  };
}

export interface Frontmatter {
  macros: Record<string, string>;
  numbering: NumberingConfig;
  comments: StoredComment[];
  library: DocMeta;
  publication: PublicationSettings;
  /**
   * Fields explicitly authored in this document's `publication` block.
   *
   * `publication` above is always normalized for legacy callers, so it cannot
   * distinguish an absent field from an authored default (most importantly an
   * explicit `bibliography: []`).  Effective project publication settings use
   * this sparse declaration to apply document overrides field-by-field.
   */
  publicationOverrides: PublicationOverrides;
  /** Raw CST source and per-section snapshots used for lossless updates. */
  source?: FrontmatterSource;
}

export type CitationStyle = "authoryear" | "numeric";
export type PublicationEngine = "tectonic";

export interface PublicationSettings {
  bibliography: string[];
  documentClass: string;
  citationStyle: CitationStyle;
  language: string;
  engine: PublicationEngine;
}

export type PublicationField = keyof PublicationSettings;

export type PublicationOverrides = Partial<PublicationSettings>;

interface FrontmatterSource {
  raw: string;
  original: Record<KnownFrontmatterKey, string>;
}

type KnownFrontmatterKey = "macros" | "numbering" | "library" | "comments" | "publication";

export function defaultPublication(): PublicationSettings {
  return {
    bibliography: [],
    documentClass: "article",
    citationStyle: "authoryear",
    language: "en",
    engine: "tectonic",
  };
}

export function normalizePublication(value: unknown): PublicationSettings {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const bibliography = Array.isArray(record.bibliography)
    ? record.bibliography.filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 100)
    : [];
  const string = (input: unknown, fallback: string) =>
    typeof input === "string" && input.trim() ? input.trim() : fallback;
  return {
    bibliography,
    documentClass: string(record.documentClass, "article"),
    citationStyle: record.citationStyle === "numeric" ? "numeric" : "authoryear",
    language: string(record.language, "en"),
    engine: "tectonic",
  };
}

/** Preserve only fields which were actually present in an authored block. */
export function normalizePublicationOverrides(value: unknown): PublicationOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const normalized = normalizePublication(record);
  const overrides: PublicationOverrides = {};
  if (Object.prototype.hasOwnProperty.call(record, "bibliography")) {
    overrides.bibliography = normalized.bibliography;
  }
  if (Object.prototype.hasOwnProperty.call(record, "documentClass")) {
    overrides.documentClass = normalized.documentClass;
  }
  if (Object.prototype.hasOwnProperty.call(record, "citationStyle")) {
    overrides.citationStyle = normalized.citationStyle;
  }
  if (Object.prototype.hasOwnProperty.call(record, "language")) {
    overrides.language = normalized.language;
  }
  if (Object.prototype.hasOwnProperty.call(record, "engine")) {
    overrides.engine = normalized.engine;
  }
  return overrides;
}

/** Count unresolved comments without trusting hand-edited JSON array members. */
export function countUnresolvedComments(comments: unknown): number {
  if (!Array.isArray(comments)) return 0;
  return comments.filter((comment) =>
    comment !== null
    && typeof comment === "object"
    && (comment as { resolved?: unknown }).resolved !== true
  ).length;
}

/**
 * A compact provider-local fingerprint for the complete persisted comment
 * field. It deliberately hashes the authored JSON representation rather than
 * comment counts: replies, edits, resolutions, and reopenings must all
 * invalidate the comment inbox even when the unresolved count is unchanged.
 */
export function commentActivityDigest(comments: unknown): string | undefined {
  if (!Array.isArray(comments) || comments.length === 0) return undefined;
  const source = JSON.stringify(comments);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function emptyFrontmatter(): Frontmatter {
  return {
    macros: {},
    numbering: { ...defaultNumbering },
    comments: [],
    library: emptyMeta(),
    publication: defaultPublication(),
    publicationOverrides: {},
  };
}

function normalizeComments(value: unknown): StoredComment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): StoredComment[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const replies = Array.isArray(record.replies)
      ? record.replies.filter((reply) => !!reply && typeof reply === "object" && !Array.isArray(reply))
      : [];
    return [{ ...record, replies } as unknown as StoredComment];
  });
}

function publicationIsDefault(value: PublicationSettings): boolean {
  const defaults = defaultPublication();
  return knownSignature(value) === knownSignature(defaults);
}

function knownSignature(value: unknown): string {
  return JSON.stringify(value);
}

function knownSnapshots(fm: Frontmatter): Record<KnownFrontmatterKey, string> {
  return {
    macros: knownSignature(fm.macros),
    numbering: knownSignature(fm.numbering),
    library: knownSignature(fm.library),
    comments: knownSignature(fm.comments),
    publication: knownSignature(fm.publication),
  };
}

// Historical Mathdown frontmatter allowed TeX inside YAML double quotes without
// YAML escaping (`RR: "\mathbb{R}"`). Make that one legacy construct valid for
// the CST parser; unchanged documents still emit their exact original bytes.
function sanitizeLegacyMacroQuotes(raw: string): string {
  const lines = raw.split("\n");
  let inMacros = false;
  return lines.map((line) => {
    if (/^macros:\s*$/.test(line)) {
      inMacros = true;
      return line;
    }
    if (/^[A-Za-z][\w-]*:/.test(line)) inMacros = false;
    if (!inMacros) return line;
    const match = /^(\s+[\w-]+:\s*)"(.*)"\s*$/.exec(line);
    if (!match || !match[2].includes("\\")) return line;
    return `${match[1]}'${match[2].replace(/'/g, "''")}'`;
  }).join("\n");
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

interface JsonAccumulation {
  buf: string;
  extra: number;
  balanced: boolean;
}

// Read a possibly pretty-printed JSON value, tracking strings and escapes so
// braces in comment text do not affect the structural depth. Serialization uses
// this exact boundary logic too; otherwise replacing a known value removed its
// indented rows but left an unindented orphan `]`/`}` in the YAML document.
function accumulateJsonLines(lines: string[], first: string, lineIndex: number): JsonAccumulation {
  const state = { depth: 0, inString: false, escaped: false, invalid: false };
  const scan = (source: string) => {
    for (const char of source) {
      if (state.escaped) {
        state.escaped = false;
        continue;
      }
      if (state.inString) {
        if (char === "\\") state.escaped = true;
        else if (char === '"') state.inString = false;
        continue;
      }
      if (char === '"') state.inString = true;
      else if (char === "{" || char === "[") state.depth++;
      else if (char === "}" || char === "]") {
        state.depth--;
        if (state.depth < 0) state.invalid = true;
      }
    }
  };

  const startsStructured = /^[\[{]/.test(first.trim());
  let buf = first;
  scan(first);
  let extra = 0;
  while (state.depth > 0 && lineIndex + 1 + extra < lines.length) {
    const next = lines[lineIndex + 1 + extra];
    buf += `\n${next}`;
    scan(next);
    extra++;
  }
  return {
    buf,
    extra,
    balanced: startsStructured
      && state.depth === 0
      && !state.inString
      && !state.escaped
      && !state.invalid,
  };
}

export interface ParsedDocument {
  frontmatter: Frontmatter;
  body: string;
  hadFrontmatter: boolean;
}

export function parseFrontmatter(md: string): ParsedDocument {
  const normalized = md.replace(/\r\n/g, "\n");
  const fm = emptyFrontmatter();

  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) {
    return { frontmatter: fm, body: normalized, hadFrontmatter: false };
  }

  const tryArray = (s: string): StoredComment[] | undefined => {
    try {
      const p = JSON.parse(s);
      if (!Array.isArray(p)) return undefined;
      return normalizeComments(p);
    } catch {
      return undefined;
    }
  };
  const tryObject = (s: string): Record<string, unknown> | undefined => {
    try {
      const p = JSON.parse(s);
      return p && typeof p === "object" && !Array.isArray(p)
        ? (p as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };

  let section: "macros" | "numbering" | null = null;
  const lines = match[1].split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.trim() === "") continue;
    // Comments are a JSON array value. Normally one line, but tolerate a
    // pretty-printed (multi-line) array — accumulate following lines until it
    // parses, so an AI reformatting the frontmatter doesn't wipe every comment.
    const commentsLine = /^comments:\s*(.+)$/.exec(line);
    if (commentsLine) {
      section = null;
      const { buf, extra } = accumulateJsonLines(lines, commentsLine[1], li);
      const parsed = tryArray(buf);
      if (parsed !== undefined) {
        fm.comments = parsed;
        li += extra;
      } else {
        console.warn("[frontmatter] could not parse `comments:` JSON — comments not loaded");
      }
      continue;
    }
    // Library metadata is a JSON object value (like `comments:`), tolerating a
    // pretty-printed multi-line form.
    const libLine = /^library:\s*(.+)$/.exec(line);
    if (libLine) {
      section = null;
      const { buf, extra } = accumulateJsonLines(lines, libLine[1], li);
      const parsed = tryObject(buf);
      if (parsed !== undefined) {
        fm.library = normalizeMeta(parsed);
        li += extra;
      } else {
        console.warn("[frontmatter] could not parse `library:` JSON — metadata not loaded");
      }
      continue;
    }
    const topLevel = /^(\w+):\s*$/.exec(line);
    if (topLevel) {
      section = topLevel[1] === "macros" ? "macros" : topLevel[1] === "numbering" ? "numbering" : null;
      continue;
    }
    const pair = /^\s+(\w+):\s*(.*)$/.exec(line);
    if (pair && section === "macros") {
      fm.macros[pair[1]] = stripQuotes(pair[2]);
    } else if (pair && section === "numbering" && pair[1] === "equations") {
      const v = stripQuotes(pair[2]);
      fm.numbering.equations =
        v === "section" || v === "subsection" ? v : "document";
    } else if (pair && section === "numbering" && pair[1] === "headings") {
      fm.numbering.headings = stripQuotes(pair[2]).toLowerCase() === "true";
    }
  }

  // Parse a standards-compliant YAML view as well. The legacy scanner above is
  // retained for malformed historical TeX quotes and exact JSON diagnostics;
  // this layer adds nested publication settings and YAML-native comments/library.
  const yaml = parseDocument(sanitizeLegacyMacroQuotes(match[1]), {
    keepSourceTokens: true,
  });
  let root: Record<string, unknown> | null | undefined;
  if (!yaml.errors.length) {
    try {
      root = yaml.toJS() as Record<string, unknown> | null;
    } catch {
      // `yaml` reports unresolved aliases only while converting the CST. Keep
      // the raw source recoverable and fall through to bounded library parsing
      // rather than crashing document open.
      root = undefined;
    }
  }
  if (root && typeof root === "object") {
    if (root.macros && typeof root.macros === "object" && !Array.isArray(root.macros)) {
      fm.macros = Object.fromEntries(
        Object.entries(root.macros as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    }
    const numbering = root.numbering as Record<string, unknown> | undefined;
    if (
      numbering?.equations === "section"
      || numbering?.equations === "subsection"
      || numbering?.equations === "document"
    ) {
      fm.numbering.equations = numbering.equations;
    }
    if (typeof numbering?.headings === "boolean") {
      fm.numbering.headings = numbering.headings;
    }
    if ("comments" in root) fm.comments = normalizeComments(root.comments);
    if ("library" in root) fm.library = normalizeMeta(root.library);
    fm.publication = normalizePublication(root.publication);
    fm.publicationOverrides = normalizePublicationOverrides(root.publication);
  } else {
    // An unrelated malformed field (most commonly historical TeX in an
    // unsupported YAML shape) must not make a valid block-style `library:` map
    // look empty. Recover that bounded block independently so a later metadata
    // edit cannot misinterpret all existing known fields as deletions.
    const recoveredLibrary = parseIsolatedLibrary(match[1]);
    if (recoveredLibrary) fm.library = recoveredLibrary;
  }

  fm.source = {
    raw: match[1],
    original: knownSnapshots(fm),
  };

  return {
    frontmatter: fm,
    body: normalized.slice(match[0].length),
    hadFrontmatter: true,
  };
}

// Re-emit frontmatter, omitting empty blocks so a doc with no metadata stays
// clean. Only emits `numbering` when it differs from the default.
export function serializeFrontmatter(fm: Frontmatter): string {
  const current = knownSnapshots(fm);
  if (
    fm.source
    && (Object.keys(current) as KnownFrontmatterKey[])
      .every((key) => current[key] === fm.source!.original[key])
  ) {
    return `---\n${fm.source.raw}\n---\n\n`;
  }

  if (
    !fm.source
    && Object.keys(fm.macros).length === 0
    && fm.numbering.equations === defaultNumbering.equations
    && metaIsEmpty(fm.library)
    && fm.comments.length === 0
    && publicationIsDefault(fm.publication)
  ) return "";

  let raw = fm.source?.raw ?? "";
  const changed = (key: KnownFrontmatterKey) =>
    !fm.source || current[key] !== fm.source.original[key];
  if (changed("macros")) {
    const keys = Object.keys(fm.macros);
    raw = replaceTopLevelBlock(raw, "macros", keys.length
      ? ["macros:", ...keys.map((key) => `  ${yamlScalar(key)}: ${yamlScalar(fm.macros[key])}`)].join("\n")
      : null);
  }
  if (changed("numbering")) {
    const fields = [
      fm.numbering.equations === defaultNumbering.equations
        ? null
        : `  equations: ${fm.numbering.equations}`,
      fm.numbering.headings === defaultNumbering.headings
        ? null
        : `  headings: ${fm.numbering.headings}`,
    ].filter((line): line is string => line !== null);
    raw = replaceTopLevelBlock(
      raw,
      "numbering",
      fields.length ? ["numbering:", ...fields].join("\n") : null,
    );
  }
  if (changed("library")) {
    raw = updateLibraryCst(raw, fm.library);
  }
  if (changed("comments")) {
    raw = replaceTopLevelBlock(raw, "comments",
      fm.comments.length ? `comments: ${JSON.stringify(fm.comments)}` : null);
  }
  if (changed("publication")) {
    raw = replaceTopLevelBlock(raw, "publication",
      publicationIsDefault(fm.publication) ? null : publicationBlock(fm.publication));
  }

  raw = raw.replace(/^\n+|\n+$/g, "");
  return raw ? `---\n${raw}\n---\n\n` : "";
}

const LIBRARY_FIELDS = [
  "id",
  "title",
  "kind",
  "status",
  "visibility",
  "tags",
  "contains",
  "projects",
  "related",
  "task_authority",
  "projection",
] as const;

// Update only Mathdown-owned fields in a standards-compliant YAML `library:`
// map. The YAML document retains comments, key order, flow/block style, and any
// nested metadata owned by another tool. An invalid `library:` block still uses
// the bounded raw-block fallback below; unrelated invalid blocks are untouched.
function updateLibraryCst(raw: string, library: DocMeta): string {
  // Prefer the complete document so aliases in `library:` can resolve against
  // anchors declared elsewhere. Sanitizing legacy TeX quotes makes historical
  // Mathdown documents parseable without changing their original source: only
  // the rendered `library:` slice is copied back below.
  let document = parseDocument(sanitizeLegacyMacroQuotes(raw), {
    keepSourceTokens: true,
  });
  const originalWasComplete = completeDocumentRoot(document).valid;
  const originalUnresolvedAliases = unresolvedAliasCounts(document);
  const originalLibraryAnchors = libraryAnchorCounts(raw);
  const wholeLibraryPairs = isMap(document.contents)
    ? document.contents.items.filter((item) =>
      resolvedScalarKey(document, item.key) === "library")
    : [];
  if (wholeLibraryPairs.length > 1) {
    throw new Error("Cannot safely update duplicate library frontmatter");
  }
  const wholeNode = wholeLibraryPairs[0]?.value;
  if (wholeNode !== undefined && !isMap(wholeNode)) {
    // Replacing a whole-map alias or scalar would detach unknown/exporter-owned
    // fields. Only an actual mapping is a safe mutation target.
    throw new Error("Cannot safely update non-map library frontmatter");
  }
  let hasResolvedLibraryKey = false;
  if (!document.errors.length) {
    try {
      const resolved = document.toJS() as Record<string, unknown> | null;
      hasResolvedLibraryKey = !!resolved
        && typeof resolved === "object"
        && Object.prototype.hasOwnProperty.call(resolved, "library");
    } catch {
      // Unresolved aliases are handled by the bounded path below, which either
      // mutates a directly located map or fails closed.
    }
  }

  const slice = extractTopLevelBlock(raw, "library");
  if (!slice) {
    if (wholeNode !== undefined || hasResolvedLibraryKey) {
      // Quoted/spaced/explicit keys, indented roots, and root flow maps are
      // valid YAML, but this source-preserving updater cannot yet splice their
      // exact range. Fail closed instead of appending a duplicate key.
      throw new Error("Cannot safely locate library frontmatter source");
    }
    if (metaIsEmpty(library)) return raw;
    if (!supportsTopLevelBlockInsertion(raw, document)) {
      throw new Error("Cannot safely add library metadata to this frontmatter layout");
    }
    const candidate = replaceTopLevelBlock(raw, "library", `library: ${JSON.stringify(library)}`);
    assertLibraryCandidate(
      candidate,
      library,
      originalWasComplete,
      originalUnresolvedAliases,
      originalLibraryAnchors,
    );
    return candidate;
  }

  let node: unknown = wholeNode;
  if (document.errors.length || !isMap(document.contents) || !isMap(node)) {
    // A malformed unrelated block must not force exporter-owned library fields
    // through the lossy JSON fallback. Parse the bounded library block alone
    // when it has no dependency on the surrounding YAML document.
    document = parseDocument(slice.lines.slice(slice.start, slice.end).join("\n"), {
      keepSourceTokens: true,
    });
    node = document.get("library", true);
    if (document.errors.length) {
      throw new Error("Cannot safely update malformed library frontmatter");
    }
  }
  if (!isMap(document.contents) || !isMap(node)) {
    throw new Error("Cannot safely update non-map library frontmatter");
  }

  const known = new Set<string>(LIBRARY_FIELDS);
  const hasUnknownFields = node.items.some((item) => {
    const value = (item.key as { value?: unknown } | null)?.value;
    return typeof value !== "string" || !known.has(value);
  });
  if (metaIsEmpty(library) && !hasUnknownFields) {
    slice.lines.splice(slice.start, slice.end - slice.start);
    const candidate = slice.lines.join("\n");
    assertLibraryCandidate(
      candidate,
      library,
      originalWasComplete,
      originalUnresolvedAliases,
      originalLibraryAnchors,
    );
    return candidate;
  }

  let root: Record<string, unknown> | null;
  try {
    root = document.toJS() as Record<string, unknown> | null;
  } catch {
    // In particular, an isolated block may contain an alias whose anchor is in
    // malformed surrounding YAML. Refuse a lossy rewrite in that case.
    throw new Error("Cannot safely update library frontmatter with unresolved aliases");
  }
  const original = normalizeMeta(root?.library);
  for (const field of LIBRARY_FIELDS) {
    const before = original[field];
    const after = library[field];
    if (knownSignature(before) === knownSignature(after)) continue;
    if (after === undefined) document.deleteIn(["library", field]);
    else document.setIn(["library", field], after);
  }

  // Clearing all Mathdown metadata must not delete exporter-owned nested data.
  if (metaIsEmpty(library) && hasUnknownFields) {
    for (const field of LIBRARY_FIELDS) document.deleteIn(["library", field]);
  }
  let rendered: string;
  try {
    rendered = String(document).replace(/\n$/, "");
  } catch {
    throw new Error("Cannot safely serialize library frontmatter");
  }
  const renderedSlice = extractTopLevelBlock(rendered, "library");
  if (!renderedSlice) throw new Error("Cannot safely locate updated library frontmatter");
  slice.lines.splice(
    slice.start,
    slice.end - slice.start,
    ...renderedSlice.lines.slice(renderedSlice.start, renderedSlice.end),
  );
  const candidate = slice.lines.join("\n");
  assertLibraryCandidate(
    candidate,
    library,
    originalWasComplete,
    originalUnresolvedAliases,
    originalLibraryAnchors,
  );
  return candidate;
}

interface CompleteDocumentRoot {
  valid: boolean;
  root: Record<string, unknown> | null;
}

function completeDocumentRoot(document: Document.Parsed): CompleteDocumentRoot {
  if (document.errors.length) return { valid: false, root: null };
  try {
    const resolved = document.toJS() as unknown;
    if (resolved == null) return { valid: true, root: null };
    if (!isMap(document.contents) || typeof resolved !== "object" || Array.isArray(resolved)) {
      return { valid: false, root: null };
    }
    return { valid: true, root: resolved as Record<string, unknown> };
  } catch {
    return { valid: false, root: null };
  }
}

function resolvedScalarKey(document: Document, key: unknown): unknown {
  if (isScalar(key)) return key.value;
  if (!isAlias(key)) return undefined;
  try {
    const resolved = key.resolve(document);
    return isScalar(resolved) ? resolved.value : undefined;
  } catch {
    return undefined;
  }
}

function resolvedLibraryPairs(document: Document): Pair<Node, Node | null>[] {
  if (!isMap(document.contents)) return [];
  return document.contents.items.filter((item) =>
    resolvedScalarKey(document, item.key) === "library") as Pair<Node, Node | null>[];
}

function supportsTopLevelBlockInsertion(raw: string, document: Document.Parsed): boolean {
  if (raw.split("\n").every((line) => line.trim() === "" || line.trimStart().startsWith("#"))) {
    return true;
  }
  if (
    document.errors.length
    || !isMap(document.contents)
    || document.contents.srcToken?.type !== "block-map"
    || document.contents.srcToken.indent !== 0
  ) return false;
  return document.contents.items.every((item) =>
    isScalar(item.key) && typeof item.key.value === "string");
}

function unresolvedAliasCounts(document: Document): Map<string, number> {
  const counts = new Map<string, number>();
  visit(document, (_key, node) => {
    if (!isAlias(node)) return;
    let resolved = false;
    try {
      resolved = node.resolve(document) !== undefined;
    } catch {
      // Treat aliases that cannot be resolved in this CST as unresolved.
    }
    if (!resolved) counts.set(node.source, (counts.get(node.source) ?? 0) + 1);
  });
  return counts;
}

function libraryAnchorCounts(raw: string): Map<string, number> {
  const slice = extractTopLevelBlock(raw, "library");
  if (!slice) return new Map();
  const source = slice.lines.slice(slice.start, slice.end).join("\n");
  const document = parseDocument(source, { keepSourceTokens: true });
  const anchors = new Map<string, number>();
  visit(document, (_key, node) => {
    if (
      !isAlias(node)
      && node
      && typeof node === "object"
      && "anchor" in node
      && typeof node.anchor === "string"
    ) anchors.set(node.anchor, (anchors.get(node.anchor) ?? 0) + 1);
  });
  return anchors;
}

function assertLibraryCandidate(
  candidate: string,
  library: DocMeta,
  requireComplete: boolean,
  originalUnresolvedAliases: Map<string, number>,
  originalLibraryAnchors: Map<string, number>,
): void {
  const complete = parseDocument(sanitizeLegacyMacroQuotes(candidate), {
    keepSourceTokens: true,
  });
  if (resolvedLibraryPairs(complete).length > 1) {
    throw new Error("Cannot safely update duplicate library frontmatter");
  }
  const candidateUnresolvedAliases = unresolvedAliasCounts(complete);
  for (const [source, count] of candidateUnresolvedAliases) {
    if (count > (originalUnresolvedAliases.get(source) ?? 0)) {
      throw new Error("Cannot safely update library frontmatter without preserving document aliases");
    }
  }
  const candidateLibraryAnchors = libraryAnchorCounts(candidate);
  for (const [anchor, count] of originalLibraryAnchors) {
    if ((candidateLibraryAnchors.get(anchor) ?? 0) < count) {
      throw new Error("Cannot safely update library frontmatter without preserving library anchors");
    }
  }
  const completeRoot = completeDocumentRoot(complete);
  if (requireComplete && !completeRoot.valid) {
    throw new Error("Cannot safely update library frontmatter without preserving document aliases");
  }

  let candidateLibrary: DocMeta;
  if (completeRoot.valid) {
    candidateLibrary = normalizeMeta(completeRoot.root?.library);
  } else {
    const isolated = parseIsolatedLibrary(candidate);
    if (!isolated && !metaIsEmpty(library)) {
      throw new Error("Cannot safely verify updated library frontmatter");
    }
    candidateLibrary = isolated ?? emptyMeta();
  }
  if (knownSignature(candidateLibrary) !== knownSignature(normalizeMeta(library))) {
    throw new Error("Updated library frontmatter does not match the intended metadata");
  }
}

interface TopLevelBlockSlice {
  lines: string[];
  start: number;
  end: number;
}

// Extract one top-level YAML block without parsing the rest of the document.
// Historical frontmatter often contains TeX in invalid YAML double quotes, so
// parsing the whole document while changing `library:` would make an unrelated
// legacy macro force the lossy JSON fallback. Flow maps need a small balanced
// scanner because their closing brace may be unindented.
function extractTopLevelBlock(raw: string, key: string): TopLevelBlockSlice | null {
  const lines = raw.split("\n");
  const pattern = new RegExp(`^${key}:\\s*(.*)$`);
  const start = lines.findIndex((line) => pattern.test(line));
  if (start < 0) return null;

  const first = pattern.exec(lines[start])?.[1] ?? "";
  const flow = flowCollectionSource(first);
  if (flow) {
    const end = flowCollectionEnd(lines, start, flow);
    return end == null ? null : { lines, start, end };
  }

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "" || /^\s/.test(line)) {
      end++;
      continue;
    }
    if (/^#/.test(line)) {
      // A column-zero YAML comment does not end an indented mapping. Include it
      // only when the next substantive source line resumes indented content;
      // otherwise it belongs to the following top-level section.
      let next = end + 1;
      while (next < lines.length && (lines[next].trim() === "" || /^#/.test(lines[next]))) next++;
      if (next < lines.length && /^\s/.test(lines[next])) {
        end++;
        continue;
      }
    }
    break;
  }
  // Blank rows between top-level blocks belong to the following source, not to
  // `library:`; leaving them outside keeps untouched frontmatter byte-stable.
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  return { lines, start, end };
}

function flowCollectionSource(source: string): string | null {
  // YAML node properties may prefix a flow collection. Detect the collection
  // after any anchors or tags so multiline `&name { ... }` and `!!map { ... }`
  // values are bounded through their actual closing delimiter.
  const match = /^(?:(?:&[^\s[\]{},]+|!(?:<[^>\r\n]+>|[^\s[\]{},]*))\s+)*([\[{][\s\S]*)$/.exec(
    source.trim(),
  );
  return match?.[1] ?? null;
}

function flowCollectionEnd(lines: string[], start: number, first: string): number | null {
  const closing = new Map([["{", "}"], ["[", "]"]]);
  const stack: string[] = [];
  let quote: "single" | "double" | null = null;
  let escaped = false;

  for (let lineIndex = start; lineIndex < lines.length; lineIndex++) {
    const source = lineIndex === start ? first : lines[lineIndex];
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (quote === "double") {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quote = null;
        continue;
      }
      if (quote === "single") {
        if (char === "'" && source[index + 1] === "'") index++;
        else if (char === "'") quote = null;
        continue;
      }
      if (char === '"') {
        quote = "double";
        continue;
      }
      if (char === "'") {
        quote = "single";
        continue;
      }
      // In YAML, `#` begins a comment only when separated from the preceding
      // scalar. A URL fragment such as `docs/x#section` remains ordinary text.
      if (char === "#" && (index === 0 || /\s/.test(source[index - 1]))) break;
      const expected = closing.get(char);
      if (expected) {
        stack.push(expected);
        continue;
      }
      if (char === "}" || char === "]") {
        if (stack.pop() !== char) return null;
        if (stack.length === 0) return lineIndex + 1;
      }
    }
  }
  return null;
}

function parseIsolatedLibrary(raw: string): DocMeta | undefined {
  const slice = extractTopLevelBlock(raw, "library");
  if (!slice) return undefined;
  const document = parseDocument(slice.lines.slice(slice.start, slice.end).join("\n"));
  if (document.errors.length || !isMap(document.contents)) return undefined;
  try {
    const root = document.toJS() as Record<string, unknown> | null;
    return root && "library" in root ? normalizeMeta(root.library) : undefined;
  } catch {
    // External aliases cannot be resolved from a bounded block. The write path
    // detects this same condition and refuses a lossy rewrite.
    return undefined;
  }
}

function replaceTopLevelBlock(raw: string, key: KnownFrontmatterKey, block: string | null): string {
  const lines = raw ? raw.split("\n") : [];
  const start = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (start < 0) {
    if (!block) return raw;
    while (lines.at(-1)?.trim() === "") lines.pop();
    if (lines.length) lines.push(block);
    else return block;
    return lines.join("\n");
  }
  let end = start + 1;
  if (key === "comments" || key === "library") {
    const first = new RegExp(`^${key}:\\s*(.*)$`).exec(lines[start])?.[1] ?? "";
    const json = accumulateJsonLines(lines, first, start);
    if (json.balanced) end = start + 1 + json.extra;
  }
  if (end === start + 1) {
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() === "" || /^\s+/.test(line)) {
        end++;
        continue;
      }
      break;
    }
  }
  lines.splice(start, end - start, ...(block ? block.split("\n") : []));
  return lines.join("\n");
}

function publicationBlock(settings: PublicationSettings): string {
  const lines = [
    "publication:",
    settings.bibliography.length ? "  bibliography:" : "  bibliography: []",
  ];
  for (const path of settings.bibliography) lines.push(`    - ${yamlScalar(path)}`);
  lines.push(
    `  documentClass: ${yamlScalar(settings.documentClass)}`,
    `  citationStyle: ${settings.citationStyle}`,
    `  language: ${yamlScalar(settings.language)}`,
    "  engine: tectonic",
  );
  return lines.join("\n");
}

function yamlScalar(value: string): string {
  return /^[A-Za-z0-9_.@/+-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "''").replace(/[\r\n]+/g, " ")}'`;
}

// Convert authored macro names (`RR`) into the backslash-prefixed keys KaTeX
// expects (`\RR`).
export function toKatexMacros(fm: Frontmatter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(fm.macros)) {
    out[`\\${name}`] = value;
  }
  return out;
}
