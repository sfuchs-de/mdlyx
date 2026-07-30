import type { CitationStyle } from "../markdown/frontmatter";

export interface BibliographyEntry {
  key: string;
  type: string;
  fields: Record<string, string>;
  sourcePath: string;
  /** Exact declaration source, including its original field formatting. */
  raw: string;
  start: number;
  end: number;
}

/** Backward-compatible name retained for existing authoring callers. */
export type CitationEntry = BibliographyEntry;

export interface CitationUsage {
  key: string;
  documentId?: string;
  documentTitle: string;
  documentPath: string;
  occurrences: number;
}

export interface CitationDiagnostic {
  severity: "error" | "warning";
  code:
    | "duplicate-key"
    | "conflicting-key"
    | "malformed-entry"
    | "missing-key"
    | "unsafe-url";
  message: string;
  key?: string;
  sourcePath?: string;
}

export interface BibliographySource {
  sourcePath: string;
  source: string;
  entries: readonly BibliographyEntry[];
  diagnostics: readonly CitationDiagnostic[];
}

export interface CitationCatalogSnapshot {
  entries: ReadonlyMap<string, BibliographyEntry>;
  diagnostics: readonly CitationDiagnostic[];
  order: readonly string[];
  sources: ReadonlyMap<string, BibliographySource>;
  usages: ReadonlyMap<string, readonly CitationUsage[]>;
}

export interface ParsedCitationItem {
  key: string;
  suppressAuthor: boolean;
  prefix: string;
  locator: string;
}

export interface FormattedCitation {
  text: string;
  missingKeys: string[];
  ariaLabel: string;
}

export interface BibliographyEntryInput {
  type: string;
  fields: Record<string, string>;
}

const MAX_BIBTEX_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
const SAFE_URL = /^(?:https?):\/\/[^\s<>"']+$/i;

export class CitationCatalog {
  private readonly entries = new Map<string, BibliographyEntry>();
  private readonly order: string[] = [];
  private readonly diagnostics: CitationDiagnostic[] = [];
  private readonly sources = new Map<string, BibliographySource>();
  private usages = new Map<string, readonly CitationUsage[]>();

  addBibTeX(sourcePath: string, source: string): void {
    if (new TextEncoder().encode(source).byteLength > MAX_BIBTEX_BYTES) {
      const diagnostic: CitationDiagnostic = {
        severity: "error",
        code: "malformed-entry",
        sourcePath,
        message: `${sourcePath} exceeds the 5 MiB bibliography limit`,
      };
      this.diagnostics.push(diagnostic);
      this.sources.set(sourcePath, {
        sourcePath,
        source,
        entries: [],
        diagnostics: [diagnostic],
      });
      return;
    }
    const parsed = parseBibTeXDocument(sourcePath, source);
    this.sources.set(sourcePath, parsed);
    this.diagnostics.push(...parsed.diagnostics);
    for (const entry of parsed.entries) {
      if (this.entries.size >= MAX_ENTRIES) break;
      const existing = this.entries.get(entry.key);
      if (existing) {
        if (!bibliographyEntriesAgree(existing, entry)) {
          this.diagnostics.push({
            severity: "error",
            code: "conflicting-key",
            key: entry.key,
            sourcePath,
            message: `Citation key “${entry.key}” conflicts with its declaration in ${existing.sourcePath}`,
          });
        }
        continue;
      }
      this.entries.set(entry.key, entry);
      this.order.push(entry.key);
    }
  }

  setUsages(usages: Iterable<CitationUsage>): void {
    const grouped = new Map<string, CitationUsage[]>();
    for (const usage of usages) {
      const rows = grouped.get(usage.key) ?? [];
      rows.push(usage);
      grouped.set(usage.key, rows);
    }
    this.usages = new Map(grouped);
  }

  resolve(keys: Iterable<string>): CitationCatalogSnapshot {
    const diagnostics = [...this.diagnostics];
    const seenMissing = new Set<string>();
    for (const key of keys) {
      if (!this.entries.has(key) && !seenMissing.has(key)) {
        seenMissing.add(key);
        diagnostics.push({
          severity: "warning",
          code: "missing-key",
          key,
          message: `Citation key “${key}” is not present in the project bibliography`,
        });
      }
    }
    return {
      entries: new Map(this.entries),
      diagnostics,
      order: [...this.order],
      sources: new Map(this.sources),
      usages: new Map(this.usages),
    };
  }

  preview(key: string, style: CitationStyle): string | undefined {
    if (!this.entries.has(key)) return undefined;
    return formatCitationCluster(`@${key}`, this.resolve([]), style).text;
  }
}

export function parseBibTeXDocument(sourcePath: string, source: string): BibliographySource {
  const entries: BibliographyEntry[] = [];
  const diagnostics: CitationDiagnostic[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("@", cursor);
    if (start < 0) break;
    const header = /^@([A-Za-z]+)\s*([({])/.exec(source.slice(start));
    if (!header) {
      cursor = start + 1;
      continue;
    }
    const type = header[1].toLowerCase();
    const opener = header[2];
    const closer = opener === "{" ? "}" : ")";
    const bodyStart = start + header[0].length;
    const end = balancedEnd(source, bodyStart, opener, closer);
    if (end < 0) {
      diagnostics.push({
        severity: "error",
        code: "malformed-entry",
        sourcePath,
        message: `Unclosed @${type} declaration near byte ${start}`,
      });
      break;
    }
    cursor = end + 1;
    if (["comment", "preamble", "string"].includes(type)) continue;
    const body = source.slice(bodyStart, end);
    const comma = topLevelComma(body);
    const key = (comma < 0 ? body : body.slice(0, comma)).trim();
    if (!key || !/^[A-Za-z0-9_.:/-]+$/.test(key)) {
      diagnostics.push({
        severity: "error",
        code: "malformed-entry",
        sourcePath,
        message: `@${type} declaration near byte ${start} has no valid citation key`,
      });
      continue;
    }
    const fields = comma < 0 ? {} : parseFields(body.slice(comma + 1));
    entries.push({
      key,
      type,
      fields,
      sourcePath,
      raw: source.slice(start, end + 1),
      start,
      end: end + 1,
    });
    const url = fields.url?.trim();
    if (url && !SAFE_URL.test(stripLatexForDisplay(url))) {
      diagnostics.push({
        severity: "error",
        code: "unsafe-url",
        key,
        sourcePath,
        message: `Citation key “${key}” contains an unsafe URL`,
      });
    }
  }
  return { sourcePath, source, entries, diagnostics };
}

/**
 * Rewrite exactly one selected declaration. Everything outside its byte range
 * remains untouched, including comments, @string declarations and spacing.
 */
export function updateBibTeXEntry(
  bibliography: BibliographySource,
  key: string,
  input: BibliographyEntryInput,
): string {
  const entry = bibliography.entries.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Citation key “${key}” was not found`);
  const replacement = patchBibTeXEntry(entry, input);
  const reparsed = parseBibTeXDocument(entry.sourcePath, replacement);
  if (
    reparsed.diagnostics.some((item) => item.severity === "error")
    || reparsed.entries.length !== 1
    || reparsed.entries[0].key !== key
  ) {
    throw new Error(`The structured changes would make citation key “${key}” invalid`);
  }
  return bibliography.source.slice(0, entry.start)
    + replacement
    + bibliography.source.slice(entry.end);
}

export function addBibTeXEntry(
  bibliography: BibliographySource,
  key: string,
  input: BibliographyEntryInput,
): string {
  if (bibliography.entries.some((entry) => entry.key === key)) {
    throw new Error(`Citation key “${key}” already exists`);
  }
  const prefix = bibliography.source.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${serializeBibTeXEntry(key, input)}\n`;
}

export function deleteBibTeXEntry(bibliography: BibliographySource, key: string): string {
  const entry = bibliography.entries.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Citation key “${key}” was not found`);
  let start = entry.start;
  let end = entry.end;
  while (start > 0 && bibliography.source[start - 1] === "\n" && bibliography.source[start - 2] === "\n") {
    start--;
  }
  while (end < bibliography.source.length && bibliography.source[end] === "\n") end++;
  return bibliography.source.slice(0, start) + bibliography.source.slice(end);
}

export function serializeBibTeXEntry(key: string, input: BibliographyEntryInput): string {
  if (!/^[A-Za-z0-9_.:/-]+$/.test(key)) throw new Error("Citation key is invalid");
  const type = input.type.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(type)) throw new Error("BibTeX entry type is invalid");
  const fields = Object.entries(input.fields)
    .filter(([name, value]) => /^[A-Za-z][\w-]*$/.test(name) && value.trim())
    .map(([name, value]) => `  ${name.toLowerCase()} = {${value.trim()}},`);
  return [`@${type}{${key},`, ...fields, "}"].join("\n");
}

interface BibFieldRange {
  name: string;
  segmentStart: number;
  segmentEnd: number;
  valueStart: number;
  valueEnd: number;
  hasComma: boolean;
}

/**
 * Patch the selected declaration in place. Unchanged field expressions retain
 * their exact bytes, so string macros, `#` concatenation, raw LaTeX, casing,
 * comments, ordering and spacing remain semantically and textually intact.
 */
function patchBibTeXEntry(
  entry: BibliographyEntry,
  input: BibliographyEntryInput,
): string {
  const type = input.type.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(type)) throw new Error("BibTeX entry type is invalid");
  const header = /^@([A-Za-z]+)\s*([({])/.exec(entry.raw);
  if (!header) throw new Error(`Citation key “${entry.key}” has an invalid declaration header`);
  const ranges = bibFieldRanges(entry.raw, header[0].length);
  const supplied = new Map(
    Object.entries(input.fields)
      .filter(([name]) => /^[A-Za-z][\w-]*$/.test(name))
      .map(([name, value]) => [name.toLowerCase(), value.trim()]),
  );
  const edits: Array<{ start: number; end: number; text: string }> = [];
  if (header[1].toLowerCase() !== type) {
    edits.push({ start: 1, end: 1 + header[1].length, text: type });
  }
  const existing = new Set<string>();
  for (const range of ranges) {
    existing.add(range.name);
    const next = supplied.get(range.name);
    if (!next) {
      edits.push({ start: range.segmentStart, end: range.segmentEnd, text: "" });
      continue;
    }
    if (next !== (entry.fields[range.name] ?? "").trim()) {
      edits.push({
        start: range.valueStart,
        end: range.valueEnd,
        text: `{${next}}`,
      });
    }
  }

  const additions = [...supplied]
    .filter(([name, value]) => value && !existing.has(name));
  if (additions.length) {
    const close = entry.raw.length - 1;
    let insertion = close;
    while (insertion > 0 && /\s/.test(entry.raw[insertion - 1])) insertion--;
    const lastRange = ranges.at(-1);
    const comma = lastRange && !lastRange.hasComma ? "," : "";
    const prefix = entry.raw.slice(0, insertion).endsWith("\n") ? "" : "\n";
    const lines = additions.map(([name, value]) => `  ${name} = {${value}},`);
    edits.push({
      start: insertion,
      end: insertion,
      text: `${comma}${prefix}${lines.join("\n")}\n`,
    });
  }

  let result = entry.raw;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function bibFieldRanges(raw: string, bodyStart: number): BibFieldRange[] {
  const close = raw.length - 1;
  const body = raw.slice(bodyStart, close);
  const keyComma = topLevelComma(body);
  if (keyComma < 0) return [];
  const ranges: BibFieldRange[] = [];
  let cursor = bodyStart + keyComma + 1;
  while (cursor < close) {
    const match = /^\s*,?\s*([A-Za-z][\w-]*)\s*=\s*/.exec(raw.slice(cursor, close));
    if (!match) break;
    const segmentStart = cursor;
    const valueStart = cursor + match[0].length;
    const comma = topLevelComma(raw.slice(valueStart, close));
    const valueBoundary = comma < 0 ? close : valueStart + comma;
    let valueEnd = valueBoundary;
    while (valueEnd > valueStart && /\s/.test(raw[valueEnd - 1])) valueEnd--;
    ranges.push({
      name: match[1].toLowerCase(),
      segmentStart,
      segmentEnd: comma < 0 ? valueBoundary : valueBoundary + 1,
      valueStart,
      valueEnd,
      hasComma: comma >= 0,
    });
    if (comma < 0) break;
    cursor = valueBoundary + 1;
  }
  return ranges;
}

export function createCitationKey(
  input: Pick<BibliographyEntryInput, "fields">,
  existingKeys: Iterable<string> = [],
): string {
  const author = input.fields.author?.split(/\s+and\s+/i)[0] ?? "source";
  const family = author.includes(",")
    ? author.split(",")[0]
    : author.trim().split(/\s+/).at(-1) ?? "source";
  const year = /\d{4}/.exec(input.fields.year ?? "")?.[0] ?? "nd";
  const ignored = new Set(["a", "an", "and", "of", "on", "the", "to", "with"]);
  const titleToken = stripLatexForDisplay(input.fields.title ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((token) => token && !ignored.has(token)) ?? "work";
  const stem = `${asciiToken(family) || "source"}${year}${asciiToken(titleToken) || "work"}`;
  const used = new Set(existingKeys);
  if (!used.has(stem)) return stem;
  for (let suffix = 0; suffix < 26; suffix++) {
    const candidate = `${stem}${String.fromCharCode(97 + suffix)}`;
    if (!used.has(candidate)) return candidate;
  }
  let number = 2;
  while (used.has(`${stem}${number}`)) number++;
  return `${stem}${number}`;
}

export function parseCitationCluster(source: string): ParsedCitationItem[] {
  return splitCitationCluster(source).flatMap((part) => {
    const match = /(-?)@([A-Za-z0-9_.:/-]+)/.exec(part);
    if (!match) return [];
    const before = part.slice(0, match.index).trim();
    const after = part.slice(match.index + match[0].length).trim();
    return [{
      key: match[2],
      suppressAuthor: match[1] === "-",
      prefix: before,
      locator: after.replace(/^,\s*/, ""),
    }];
  });
}

export function citationKeysFromSource(source: string): string[] {
  return parseCitationCluster(source).map((item) => item.key);
}

export function formatCitationCluster(
  source: string,
  catalog: CitationCatalogSnapshot,
  style: CitationStyle,
): FormattedCitation {
  const items = parseCitationCluster(source);
  const missingKeys = items
    .filter((item) => !catalog.entries.has(item.key))
    .map((item) => item.key);
  if (!items.length || missingKeys.length) {
    const text = `[${source}]`;
    return {
      text,
      missingKeys,
      ariaLabel: missingKeys.length
        ? `${text}. Unresolved citation ${missingKeys.join(", ")}`
        : `${text}. Citation source could not be formatted`,
    };
  }
  const rendered = items.map((item) => {
    const entry = catalog.entries.get(item.key)!;
    if (style === "numeric") {
      const number = catalog.order.indexOf(item.key) + 1;
      return `${item.prefix ? `${item.prefix} ` : ""}${number || "?"}${item.locator ? `, ${item.locator}` : ""}`;
    }
    const author = item.suppressAuthor ? "" : authorLabel(entry);
    const year = stripLatexForDisplay(entry.fields.year ?? "");
    const label = [author, year].filter(Boolean).join(" ") || item.key;
    return `${item.prefix ? `${item.prefix} ` : ""}${label}${item.locator ? `, ${item.locator}` : ""}`;
  });
  const text = style === "numeric"
    ? `[${rendered.join("; ")}]`
    : `(${rendered.join("; ")})`;
  return {
    text,
    missingKeys: [],
    ariaLabel: `${text}. Citation`,
  };
}

export function bibliographyEntriesAgree(
  left: Pick<BibliographyEntry, "type" | "fields">,
  right: Pick<BibliographyEntry, "type" | "fields">,
): boolean {
  return left.type.toLowerCase() === right.type.toLowerCase()
    && stableFields(left.fields) === stableFields(right.fields);
}

export function normalizedBibliographyMetadata(
  entry: Pick<BibliographyEntry, "type" | "fields">,
): Record<string, string> {
  return {
    type: entry.type.toLowerCase(),
    ...Object.fromEntries(Object.entries(entry.fields)
      .map(([key, value]) => [key.toLowerCase(), normalizeSpace(stripLatexForDisplay(value))])
      .sort(([left], [right]) => left.localeCompare(right))),
  };
}

function stableFields(fields: Record<string, string>): string {
  return JSON.stringify(Object.entries(fields)
    .map(([key, value]) => [key.toLowerCase(), normalizeSpace(stripLatexForDisplay(value))])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function splitCitationCluster(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let braces = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "{" && source[index - 1] !== "\\") braces++;
    else if (char === "}" && source[index - 1] !== "\\") braces = Math.max(0, braces - 1);
    else if (char === ";" && braces === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function authorLabel(entry: BibliographyEntry): string {
  const authors = (entry.fields.author ?? "")
    .split(/\s+and\s+/i)
    .map((author) => author.trim())
    .filter(Boolean);
  const families = authors.map((author) => {
    const family = author.includes(",")
      ? author.split(",")[0]
      : author.split(/\s+/).at(-1) ?? author;
    return stripLatexForDisplay(family);
  });
  if (families.length > 2) return `${families[0]} et al.`;
  if (families.length === 2) return `${families[0]} and ${families[1]}`;
  return families[0] ?? entry.key;
}

function asciiToken(value: string): string {
  return value.normalize("NFKD").replace(/[^\x00-\x7F]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeSpace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function stripLatexForDisplay(value: string): string {
  return value
    .replace(/\\(?:textit|textbf|emph|mathrm|operatorname)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\["'`^~=.uvHckbdtr]\s*\{?([A-Za-z])\}?/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\\&/g, "&")
    .replace(/\\_/g, "_")
    .trim();
}

function balancedEnd(source: string, start: number, opener: string, closer: string): number {
  const stack = [closer];
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === "{") stack.push("}");
    else if (char === "(" && opener === "(") stack.push(")");
    else if (char === "}" || (char === ")" && opener === "(")) {
      if (stack.at(-1) !== char) continue;
      stack.pop();
      if (!stack.length) return index;
    }
  }
  return -1;
}

function topLevelComma(source: string): number {
  let braces = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (char === "," && braces === 0) return index;
  }
  return -1;
}

function parseFields(source: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let rest = source;
  while (rest.trim()) {
    const match = /^\s*,?\s*([A-Za-z][\w-]*)\s*=\s*/.exec(rest);
    if (!match) break;
    rest = rest.slice(match[0].length);
    const comma = topLevelComma(rest);
    const raw = (comma < 0 ? rest : rest.slice(0, comma)).trim();
    fields[match[1].toLowerCase()] = stripOuterBibValue(raw);
    rest = comma < 0 ? "" : rest.slice(comma + 1);
  }
  return fields;
}

function stripOuterBibValue(value: string): string {
  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1).trim();
  }
  return value;
}
