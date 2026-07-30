import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  buildDependencyCatalog,
  parseDependencyManifest,
  type DependencyCatalog,
} from "../src/app/dependency-graph";
import {
  buildProjectCatalog,
  parseProjectOverview,
  type ProjectDocumentSummary,
} from "../src/app/project-overview";
import { parseFrontmatter, type ParsedDocument } from "../src/markdown/frontmatter";
import { parseMarkdown } from "../src/markdown/parse";
import {
  bibliographyEntriesAgree,
  citationKeysFromSource,
  parseBibTeXDocument,
  type BibliographySource,
} from "../src/publication/citation-catalog";

export type LibraryValidationSeverity = "error" | "warning";

export interface LibraryValidationDiagnostic {
  severity: LibraryValidationSeverity;
  code: string;
  message: string;
  path?: string;
  project?: string;
  documentId?: string;
  resultId?: string;
}

export interface LibraryValidationReport {
  root: string;
  valid: boolean;
  summary: {
    documents: number;
    projects: number;
    results: number;
    citations: number;
    bibliographies: number;
    errors: number;
    warnings: number;
  };
  diagnostics: LibraryValidationDiagnostic[];
}

interface IndexedDocument {
  path: string;
  source: string;
  parsed: ParsedDocument;
  document: ReturnType<typeof parseMarkdown> | null;
  anchors: Set<string>;
  citations: string[];
}

const SUPPORT_MARKDOWN = new Set([
  "AGENTS.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
]);
const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const PROJECT_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function diagnostic(
  severity: LibraryValidationSeverity,
  code: string,
  message: string,
  extra: Omit<LibraryValidationDiagnostic, "severity" | "code" | "message"> = {},
): LibraryValidationDiagnostic {
  return { severity, code, message, ...extra };
}

function portable(relative: string): string {
  return relative.split(path.sep).join("/");
}

async function markdownFiles(
  root: string,
  relative = "",
  diagnostics: LibraryValidationDiagnostic[] = [],
): Promise<string[]> {
  const absolute = path.join(root, ...relative.split("/").filter(Boolean));
  const entries = await readdir(absolute, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      diagnostics.push(diagnostic(
        "error",
        "unsafe-symlink",
        "Library validation does not follow symbolic links.",
        { path: child },
      ));
      continue;
    }
    if (entry.isDirectory()) {
      found.push(...await markdownFiles(root, child, diagnostics));
    } else if (
      entry.isFile()
      && /\.(?:md|markdown)$/i.test(entry.name)
      && !SUPPORT_MARKDOWN.has(entry.name)
    ) {
      found.push(child);
    }
  }
  return found;
}

function collectDocumentStructure(
  indexed: IndexedDocument,
  diagnostics: LibraryValidationDiagnostic[],
): void {
  if (!indexed.document) return;
  const meta = indexed.parsed.frontmatter.library;
  const seenAnchors = new Set<string>();
  indexed.document.descendants((node) => {
    const id = typeof node.attrs.id === "string" ? node.attrs.id.trim() : "";
    if (id) {
      if (seenAnchors.has(id)) {
        diagnostics.push(diagnostic(
          "error",
          "duplicate-anchor",
          `Anchor “${id}” is declared more than once in this document.`,
          { path: indexed.path, documentId: meta.id },
        ));
      }
      seenAnchors.add(id);
      indexed.anchors.add(id);
    }
    if (node.type.name === "citation" && typeof node.attrs.source === "string") {
      indexed.citations.push(...citationKeysFromSource(node.attrs.source));
    }
    return true;
  });
}

function resolveAssetPath(
  sourcePath: string,
  declared: string,
  diagnostics: LibraryValidationDiagnostic[],
): string | null {
  const value = declared.trim();
  if (
    !value
    || value.includes("\\")
    || value.includes("\0")
    || path.posix.isAbsolute(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    diagnostics.push(diagnostic(
      "error",
      "unsafe-asset-path",
      `Asset path ${JSON.stringify(declared)} must be a portable relative path.`,
      { path: sourcePath },
    ));
    return null;
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), value));
  if (resolved === ".." || resolved.startsWith("../")) {
    diagnostics.push(diagnostic(
      "error",
      "unsafe-asset-path",
      `Asset path ${JSON.stringify(declared)} escapes the library root.`,
      { path: sourcePath },
    ));
    return null;
  }
  return resolved;
}

async function loadBibliography(
  root: string,
  relative: string,
  cache: Map<string, BibliographySource | null>,
  diagnostics: LibraryValidationDiagnostic[],
): Promise<BibliographySource | null> {
  if (cache.has(relative)) return cache.get(relative) ?? null;
  try {
    const source = await readFile(path.join(root, ...relative.split("/")), "utf8");
    const parsed = parseBibTeXDocument(relative, source);
    cache.set(relative, parsed);
    diagnostics.push(...parsed.diagnostics.map((item) => diagnostic(
      item.severity,
      item.code,
      item.message,
      { path: item.sourcePath },
    )));
    return parsed;
  } catch (error) {
    cache.set(relative, null);
    diagnostics.push(diagnostic(
      "error",
      "missing-bibliography",
      `Could not read bibliography ${relative}: ${error instanceof Error ? error.message : String(error)}`,
      { path: relative },
    ));
    return null;
  }
}

function collectWikiLinks(
  indexed: IndexedDocument,
): Array<{ target: string; anchor: string | null }> {
  if (!indexed.document) return [];
  const links: Array<{ target: string; anchor: string | null }> = [];
  indexed.document.descendants((node) => {
    if (node.type.name !== "doc_link") return true;
    links.push({
      target: typeof node.attrs.target === "string" ? node.attrs.target : "",
      anchor: typeof node.attrs.anchor === "string" && node.attrs.anchor
        ? node.attrs.anchor
        : null,
    });
    return false;
  });
  return links;
}

function appendCatalogDiagnostics(
  diagnostics: LibraryValidationDiagnostic[],
  catalog: DependencyCatalog,
): void {
  diagnostics.push(...catalog.diagnostics.map((item) => diagnostic(
    item.severity,
    item.code,
    item.message,
    {
      path: item.path,
      project: item.project,
      resultId: item.resultId,
    },
  )));
}

export async function validateLibrary(rootInput: string): Promise<LibraryValidationReport> {
  const root = path.resolve(rootInput);
  const diagnostics: LibraryValidationDiagnostic[] = [];
  const paths = await markdownFiles(root, "", diagnostics);
  const indexed: IndexedDocument[] = [];

  for (const relative of paths) {
    const source = await readFile(path.join(root, ...relative.split("/")), "utf8");
    const parsed = parseFrontmatter(source);
    const meta = parsed.frontmatter.library;
    if (!parsed.hadFrontmatter) {
      diagnostics.push(diagnostic(
        "error",
        "missing-frontmatter",
        "Indexed Markdown needs a frontmatter block with library metadata.",
        { path: relative },
      ));
    }
    if (!meta.id) {
      diagnostics.push(diagnostic(
        "error",
        "missing-document-id",
        "Indexed Markdown needs a stable library document ID.",
        { path: relative },
      ));
    } else if (!DOCUMENT_ID.test(meta.id)) {
      diagnostics.push(diagnostic(
        "error",
        "invalid-document-id",
        `Document ID “${meta.id}” contains unsupported characters.`,
        { path: relative, documentId: meta.id },
      ));
    }
    if (!meta.title) {
      diagnostics.push(diagnostic(
        "warning",
        "missing-document-title",
        "Add a library title so the document is identifiable in navigation.",
        { path: relative, documentId: meta.id },
      ));
    }
    for (const project of meta.projects) {
      if (!PROJECT_KEY.test(project)) {
        diagnostics.push(diagnostic(
          "error",
          "invalid-project-key",
          `Project key “${project}” is not a portable lowercase slug.`,
          { path: relative, documentId: meta.id, project },
        ));
      }
    }
    let document: ReturnType<typeof parseMarkdown> | null = null;
    try {
      document = parseMarkdown(parsed.body);
    } catch (error) {
      diagnostics.push(diagnostic(
        "error",
        "markdown-parse",
        `Markdown could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        { path: relative, documentId: meta.id },
      ));
    }
    const item: IndexedDocument = {
      path: relative,
      source,
      parsed,
      document,
      anchors: new Set(),
      citations: [],
    };
    collectDocumentStructure(item, diagnostics);
    indexed.push(item);
  }

  const byId = new Map<string, IndexedDocument>();
  for (const item of indexed) {
    const id = item.parsed.frontmatter.library.id;
    if (!id) continue;
    const existing = byId.get(id);
    if (existing) {
      diagnostics.push(diagnostic(
        "error",
        "duplicate-document-id",
        `Document ID “${id}” is also declared in ${existing.path}.`,
        { path: item.path, documentId: id },
      ));
    } else {
      byId.set(id, item);
    }
  }

  for (const item of indexed) {
    const meta = item.parsed.frontmatter.library;
    const links = [
      ...collectWikiLinks(item),
      ...meta.related.map((related) => ({ target: related.id, anchor: null })),
    ];
    for (const link of links) {
      const target = byId.get(link.target);
      if (!target) {
        diagnostics.push(diagnostic(
          "error",
          "missing-document-link",
          `Internal link target “${link.target}” does not exist.`,
          { path: item.path, documentId: meta.id },
        ));
      } else if (link.anchor && !target.anchors.has(link.anchor)) {
        diagnostics.push(diagnostic(
          "error",
          "missing-document-anchor",
          `Internal link target “${link.target}” has no anchor “${link.anchor}”.`,
          { path: item.path, documentId: meta.id },
        ));
      }
    }
  }

  const summaries: ProjectDocumentSummary[] = indexed.flatMap((item) => {
    const meta = item.parsed.frontmatter.library;
    return meta.id
      ? [{
          id: meta.id,
          title: meta.title ?? path.posix.basename(item.path).replace(/\.(?:md|markdown)$/i, ""),
          path: item.path,
          projects: meta.projects,
          contains: meta.contains,
          visibility: meta.visibility,
          unresolvedCommentCount: item.parsed.frontmatter.comments
            .filter((comment) => comment.resolved !== true).length,
        }]
      : [];
  });
  const overviews = indexed
    .filter((item) => item.parsed.frontmatter.library.contains.includes("project-overview"))
    .map((item) => parseProjectOverview(item.source, item.path));
  const parsedManifests = indexed
    .filter((item) => item.parsed.frontmatter.library.contains.includes("dependency-graph"))
    .map((item) => parseDependencyManifest(item.source, item.path));
  const dependencyCatalog = buildDependencyCatalog(
    parsedManifests,
    summaries.map((item) => ({ id: item.id, title: item.title })),
  );
  appendCatalogDiagnostics(diagnostics, dependencyCatalog);
  const projectCatalog = buildProjectCatalog(overviews, dependencyCatalog, summaries);
  diagnostics.push(...projectCatalog.diagnostics.map((item) => diagnostic(
    item.severity,
    item.code,
    item.message,
    {
      path: item.path,
      project: item.project,
    },
  )));

  const projects = new Set(indexed.flatMap((item) => item.parsed.frontmatter.library.projects));
  const overviewProjects = new Set(
    overviews.flatMap((item) => item.overview ? [item.overview.project] : []),
  );
  const manifestProjects = new Set(
    parsedManifests.flatMap((item) => item.manifest ? [item.manifest.project] : []),
  );
  for (const project of projects) {
    if (!overviewProjects.has(project)) {
      diagnostics.push(diagnostic(
        "warning",
        "missing-project-overview",
        `Project “${project}” has no project overview.`,
        { project },
      ));
    }
    if (!manifestProjects.has(project)) {
      diagnostics.push(diagnostic(
        "warning",
        "missing-project-manifest",
        `Project “${project}” has no dependency manifest.`,
        { project },
      ));
    }
  }

  for (const result of dependencyCatalog.results) {
    if (!result.ownerAnchor) continue;
    const owner = byId.get(result.ownerId);
    if (owner && !owner.anchors.has(result.ownerAnchor)) {
      diagnostics.push(diagnostic(
        "error",
        "missing-result-owner-anchor",
        `${result.id} refers to missing anchor “${result.ownerAnchor}” in ${result.ownerId}.`,
        {
          path: result.manifestPath,
          project: result.project,
          resultId: result.id,
        },
      ));
    }
  }

  const projectBibliographies = new Map<string, string[]>();
  for (const parsed of overviews) {
    const overview = parsed.overview;
    if (!overview?.publication) continue;
    const resolved = overview.publication.settings.bibliography.flatMap((declared) => {
      const asset = resolveAssetPath(overview.path, declared, diagnostics);
      return asset ? [asset] : [];
    });
    projectBibliographies.set(overview.project, resolved);
  }

  const bibliographyCache = new Map<string, BibliographySource | null>();
  let citationCount = 0;
  for (const item of indexed) {
    citationCount += item.citations.length;
    const overrides = item.parsed.frontmatter.publicationOverrides;
    let bibliographyPaths: string[];
    if (Object.prototype.hasOwnProperty.call(overrides, "bibliography")) {
      bibliographyPaths = (overrides.bibliography ?? []).flatMap((declared) => {
        const asset = resolveAssetPath(item.path, declared, diagnostics);
        return asset ? [asset] : [];
      });
    } else {
      bibliographyPaths = [...new Set(
        item.parsed.frontmatter.library.projects.flatMap(
          (project) => projectBibliographies.get(project) ?? [],
        ),
      )];
    }
    const sources = (await Promise.all(
      bibliographyPaths.map((relative) =>
        loadBibliography(root, relative, bibliographyCache, diagnostics)),
    )).filter((source): source is BibliographySource => source !== null);
    const entries = new Map<string, BibliographySource["entries"][number]>();
    for (const source of sources) {
      for (const entry of source.entries) {
        const existing = entries.get(entry.key);
        if (existing && !bibliographyEntriesAgree(existing, entry)) {
          diagnostics.push(diagnostic(
            "error",
            "conflicting-citation-key",
            `Citation key “${entry.key}” conflicts between ${existing.sourcePath} and ${entry.sourcePath}.`,
            { path: item.path, documentId: item.parsed.frontmatter.library.id },
          ));
        } else if (!existing) {
          entries.set(entry.key, entry);
        }
      }
    }
    for (const key of new Set(item.citations)) {
      if (!entries.has(key)) {
        diagnostics.push(diagnostic(
          "error",
          "missing-citation-key",
          `Citation key “${key}” is not present in this document’s effective bibliography.`,
          { path: item.path, documentId: item.parsed.frontmatter.library.id },
        ));
      }
    }
  }

  const uniqueDiagnostics = [...new Map(diagnostics.map((item) => [
    JSON.stringify(item),
    item,
  ])).values()].sort((left, right) =>
    (left.severity === right.severity ? 0 : left.severity === "error" ? -1 : 1)
    || (left.path ?? "").localeCompare(right.path ?? "")
    || left.code.localeCompare(right.code),
  );
  const errors = uniqueDiagnostics.filter((item) => item.severity === "error").length;
  const warnings = uniqueDiagnostics.length - errors;
  return {
    root,
    valid: errors === 0,
    summary: {
      documents: indexed.length,
      projects: projects.size,
      results: dependencyCatalog.results.length,
      citations: citationCount,
      bibliographies: [...bibliographyCache.values()].filter(Boolean).length,
      errors,
      warnings,
    },
    diagnostics: uniqueDiagnostics,
  };
}
