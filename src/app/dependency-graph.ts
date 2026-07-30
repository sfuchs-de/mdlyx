import type { Node as PMNode } from "prosemirror-model";
import { parseFrontmatter } from "../markdown/frontmatter";
import { parseMarkdown } from "../markdown/parse";

export const VALIDATION_STATES = [
  "validated",
  "partial",
  "unvalidated",
  "disputed",
] as const;

export type ValidationState = (typeof VALIDATION_STATES)[number];

export interface ResultNode {
  id: string;
  title: string;
  ownerId: string;
  ownerLabel: string;
  validation: ValidationState;
  dependsOn: string[];
  evidence: string;
  condition: string;
  curatedStatus?: "final" | "review" | "draft" | "superseded";
  claimClass?: string;
  modelState?: string;
  branch?: string;
  jointBlock?: string;
  ownerAnchor?: string;
  project: string;
  manifestDocumentId: string;
  manifestPath: string;
  row: number;
}

/**
 * Ordered fallbacks keep Contract-v2 source markers precise while remaining
 * compatible with external manifests that use a heading anchor equal to the
 * result ID.
 */
export function resultOwnerAnchors(result: ResultNode): string[] {
  if (result.ownerAnchor?.trim()) return [result.ownerAnchor.trim()];
  return [
    `mathdown-claim:${result.id}`,
    `mathdown-derivation:${result.id}`,
    result.id,
  ];
}

export interface DependencyManifest {
  project: string;
  documentId: string;
  title: string;
  path: string;
  results: ResultNode[];
  projectionDigest?: string;
  acknowledgedWarnings: Map<string, { dependencies: string[]; scope: string }>;
}

export type DiagnosticSeverity = "error" | "warning";

export interface GraphDiagnostic {
  code:
    | "manifest-project"
    | "manifest-document-id"
    | "manifest-heading"
    | "manifest-table"
    | "missing-column"
    | "missing-result-id"
    | "missing-result-title"
    | "missing-owner"
    | "invalid-validation"
    | "duplicate-result-id"
    | "duplicate-project-manifest"
    | "missing-owner-document"
    | "missing-dependency"
    | "dependency-cycle"
    | "validated-on-unresolved";
  severity: DiagnosticSeverity;
  message: string;
  project?: string;
  resultId?: string;
  path?: string;
  row?: number;
  acknowledged?: boolean;
  scope?: string;
}

export interface ParsedDependencyManifest {
  manifest: DependencyManifest | null;
  diagnostics: GraphDiagnostic[];
}

export interface CatalogDocument {
  id: string;
  title: string;
}

export interface DependencyManifestSource {
  path: string;
  project: string;
  documentId: string;
  title: string;
  read(): Promise<string>;
  open(): Promise<void>;
}

export interface DependencyCatalog {
  manifests: DependencyManifest[];
  results: ResultNode[];
  byId: Map<string, ResultNode>;
  diagnostics: GraphDiagnostic[];
}

interface DependencyTraversalIndex {
  /** Reverse edges: prerequisite ID -> direct dependent IDs. */
  dependents: Map<string, string[]>;
  /** Lazily memoized transitive dependent sets for repeated dashboard renders. */
  downstream: Map<string, ReadonlySet<string>>;
}

const traversalIndexes = new WeakMap<DependencyCatalog, DependencyTraversalIndex>();

function traversalIndex(catalog: DependencyCatalog): DependencyTraversalIndex {
  const existing = traversalIndexes.get(catalog);
  if (existing) return existing;
  const dependents = new Map<string, string[]>();
  for (const result of catalog.results) {
    for (const dependency of result.dependsOn) {
      if (!catalog.byId.has(dependency)) continue;
      const list = dependents.get(dependency) ?? [];
      list.push(result.id);
      dependents.set(dependency, list);
    }
  }
  const created = { dependents, downstream: new Map<string, ReadonlySet<string>>() };
  traversalIndexes.set(catalog, created);
  return created;
}

const REQUIRED_COLUMNS = [
  "result id",
  "result",
  "owner",
  "validation",
  "depends on",
  "evidence",
  "remaining condition",
] as const;

const COLUMN_ALIASES = new Map<string, (typeof REQUIRED_COLUMNS)[number]>([
  ["result id", "result id"],
  ["id", "result id"],
  ["result", "result"],
  ["title", "result"],
  ["owner", "owner"],
  ["owner document", "owner"],
  ["validation", "validation"],
  ["validation state", "validation"],
  ["depends on", "depends on"],
  ["dependencies", "depends on"],
  ["prerequisites", "depends on"],
  ["evidence", "evidence"],
  ["remaining condition", "remaining condition"],
  ["remaining conditions", "remaining condition"],
]);

function diagnostic(
  code: GraphDiagnostic["code"],
  severity: DiagnosticSeverity,
  message: string,
  extra: Partial<Omit<GraphDiagnostic, "code" | "severity" | "message">> = {},
): GraphDiagnostic {
  return { code, severity, message, ...extra };
}

function resultContext(result: ResultNode): Partial<GraphDiagnostic> {
  return {
    project: result.project,
    resultId: result.id,
    path: result.manifestPath,
    row: result.row,
  };
}

function normaliseHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function cellText(cell: PMNode | undefined): string {
  return cell?.textContent.trim().replace(/\s+/g, " ") ?? "";
}

function documentLink(cell: PMNode | undefined): { id: string; label: string } | null {
  if (!cell) return null;
  let found: { id: string; label: string } | null = null;
  cell.descendants((node) => {
    if (found || node.type.name !== "doc_link") return !found;
    const id = typeof node.attrs.target === "string" ? node.attrs.target.trim() : "";
    const label = typeof node.attrs.label === "string" ? node.attrs.label.trim() : "";
    if (id) found = { id, label: label || id };
    return false;
  });
  return found;
}

function dependencyIds(value: string): string[] {
  const emptyToken = /^(?:-|\u2013|\u2014|none|n\/a)$/i;
  const trimmed = value.trim();
  if (!trimmed || emptyToken.test(trimmed.replace(/^`+|`+$/g, "").trim())) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of trimmed.split(/[,;\n]/)) {
    const id = part.trim().replace(/^`+|`+$/g, "");
    if (id && !emptyToken.test(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function validationState(value: string): ValidationState | null {
  const state = value.trim().toLowerCase();
  return (VALIDATION_STATES as readonly string[]).includes(state)
    ? state as ValidationState
    : null;
}

/**
 * Parse the table immediately following `## ... {#dependency-graph}`. The
 * Contract v2 tables may be generated read-only projections. Older ordinary
 * Markdown manifests remain valid for external/local libraries.
 */
export function parseDependencyManifest(markdown: string, path: string): ParsedDependencyManifest {
  const parsed = parseFrontmatter(markdown);
  const meta = parsed.frontmatter.library;
  const diagnostics: GraphDiagnostic[] = [];
  const project = meta.projects.length === 1 ? meta.projects[0] : "";
  const projection = meta.projection;
  const acknowledgedWarnings = new Map(
    (projection?.kind === "generated-result-manifest"
      ? projection.acknowledged_warnings
      : []).map((warning) => [
      warning.result_id,
      { dependencies: [...warning.dependencies].sort(), scope: warning.scope },
    ]) ?? [],
  );

  if (meta.projects.length !== 1) {
    diagnostics.push(diagnostic(
      "manifest-project",
      "error",
      "A dependency manifest must belong to exactly one project.",
      { path },
    ));
  }
  if (!meta.id) {
    diagnostics.push(diagnostic(
      "manifest-document-id",
      "error",
      "A dependency manifest needs a stable document id.",
      { project, path },
    ));
  }

  const doc = parseMarkdown(parsed.body);
  let headingIndex = -1;
  for (let index = 0; index < doc.childCount; index++) {
    const node = doc.child(index);
    if (node.type.name === "heading" && node.attrs.id === "dependency-graph") {
      headingIndex = index;
      break;
    }
  }
  if (headingIndex < 0) {
    diagnostics.push(diagnostic(
      "manifest-heading",
      "error",
      "Add a heading with the id {#dependency-graph} before the result table.",
      { project, path },
    ));
    return { manifest: null, diagnostics };
  }

  let table: PMNode | null = null;
  for (let index = headingIndex + 1; index < doc.childCount; index++) {
    const node = doc.child(index);
    if (node.type.name === "heading") break;
    if (node.type.name === "table") {
      table = node;
      break;
    }
  }
  if (!table || table.childCount < 1) {
    diagnostics.push(diagnostic(
      "manifest-table",
      "error",
      "The dependency-graph heading must be followed by a Markdown table.",
      { project, path },
    ));
    return { manifest: null, diagnostics };
  }

  const headerRow = table.child(0);
  const columns = new Map<string, number>();
  for (let index = 0; index < headerRow.childCount; index++) {
    const header = normaliseHeader(cellText(headerRow.child(index)));
    columns.set(COLUMN_ALIASES.get(header) ?? header, index);
  }
  for (const column of REQUIRED_COLUMNS) {
    if (!columns.has(column)) {
      diagnostics.push(diagnostic(
        "missing-column",
        "error",
        `The dependency table is missing the “${column}” column.`,
        { project, path },
      ));
    }
  }
  if (diagnostics.some((item) => item.code === "missing-column")) {
    return { manifest: null, diagnostics };
  }

  const valueAt = (row: PMNode, column: string): PMNode | undefined => {
    const index = columns.get(column);
    return index === undefined || index >= row.childCount ? undefined : row.child(index);
  };
  const results: ResultNode[] = [];
  for (let index = 1; index < table.childCount; index++) {
    const tableRow = index + 1;
    const row = table.child(index);
    const id = cellText(valueAt(row, "result id")).replace(/^`+|`+$/g, "");
    const title = cellText(valueAt(row, "result"));
    const owner = documentLink(valueAt(row, "owner"));
    const validationText = cellText(valueAt(row, "validation"));
    const validation = validationState(validationText);
    const base = { project, path, row: tableRow, resultId: id || undefined };
    if (!id) {
      diagnostics.push(diagnostic("missing-result-id", "error", "A result row has no Result ID.", base));
      continue;
    }
    if (!title) {
      diagnostics.push(diagnostic("missing-result-title", "error", `${id} has no result title.`, base));
    }
    if (!owner) {
      diagnostics.push(diagnostic(
        "missing-owner",
        "error",
        `${id} must name its owner with an internal document link.`,
        base,
      ));
    }
    if (!validation) {
      diagnostics.push(diagnostic(
        "invalid-validation",
        "error",
        `${id} has an unknown validation state “${validationText || "(empty)"}”.`,
        base,
      ));
    }
    if (!title || !owner || !validation) continue;
    results.push({
      id,
      title,
      ownerId: owner.id,
      ownerLabel: owner.label,
      validation,
      dependsOn: dependencyIds(cellText(valueAt(row, "depends on"))),
      evidence: cellText(valueAt(row, "evidence")),
      condition: cellText(valueAt(row, "remaining condition")),
      curatedStatus: curatedStatus(cellText(valueAt(row, "curated status"))),
      claimClass: optionalCell(valueAt(row, "claim class")),
      modelState: optionalCell(valueAt(row, "model state")),
      branch: optionalCell(valueAt(row, "branch")),
      jointBlock: optionalCell(valueAt(row, "joint block")),
      ownerAnchor: optionalCell(valueAt(row, "owner anchor")),
      project,
      manifestDocumentId: meta.id ?? "",
      manifestPath: path,
      row: tableRow,
    });
  }

  return {
    manifest: project && meta.id
      ? {
          project,
          documentId: meta.id,
          title: meta.title ?? path.split("/").pop()?.replace(/\.(md|markdown)$/i, "") ?? path,
          path,
          results,
          projectionDigest: projection?.digest,
          acknowledgedWarnings,
        }
      : null,
    diagnostics,
  };
}

export function buildDependencyCatalog(
  parsed: ParsedDependencyManifest[],
  documents: CatalogDocument[],
): DependencyCatalog {
  const candidates = parsed.flatMap((item) => item.manifest ? [item.manifest] : []);
  const diagnostics = parsed.flatMap((item) => item.diagnostics);
  const byId = new Map<string, ResultNode>();
  const documentIds = new Set(documents.map((document) => document.id));
  const manifestsByProject = new Map<string, DependencyManifest[]>();

  for (const manifest of candidates) {
    const project = manifestsByProject.get(manifest.project) ?? [];
    project.push(manifest);
    manifestsByProject.set(manifest.project, project);
  }
  for (const [project, projectManifests] of manifestsByProject) {
    if (projectManifests.length < 2) continue;
    for (const manifest of projectManifests) {
      diagnostics.push(diagnostic(
        "duplicate-project-manifest",
        "error",
        `Project “${project}” has more than one dependency manifest; none were indexed.`,
        { project, path: manifest.path },
      ));
    }
  }
  // A duplicate authoritative source is ambiguous. Reject every manifest for
  // that project instead of silently choosing one or mixing their result rows.
  const manifests = candidates.filter(
    (manifest) => manifestsByProject.get(manifest.project)?.length === 1,
  );

  for (const manifest of manifests) {
    for (const result of manifest.results) {
      const duplicate = byId.get(result.id);
      if (duplicate) {
        diagnostics.push(diagnostic(
          "duplicate-result-id",
          "error",
          `Result ID ${result.id} is also declared in ${duplicate.manifestPath}.`,
          resultContext(result),
        ));
      } else {
        byId.set(result.id, result);
      }
      if (!documentIds.has(result.ownerId)) {
        diagnostics.push(diagnostic(
          "missing-owner-document",
          "error",
          `${result.id} refers to missing owner document “${result.ownerId}”.`,
          resultContext(result),
        ));
      }
    }
  }

  for (const result of byId.values()) {
    for (const dependency of result.dependsOn) {
      if (!byId.has(dependency)) {
        diagnostics.push(diagnostic(
          "missing-dependency",
          "error",
          `${result.id} depends on missing result ${dependency}.`,
          resultContext(result),
        ));
      }
    }
  }

  diagnostics.push(...cycleDiagnostics(byId));
  for (const result of byId.values()) {
    if (result.validation !== "validated") continue;
    const unresolved = [...upstreamOf({ manifests, results: [...byId.values()], byId, diagnostics }, result.id)]
      .map((id) => byId.get(id))
      .filter((node): node is ResultNode => !!node && node.validation !== "validated");
    if (unresolved.length) {
      const dependencyIds = unresolved.map((node) => node.id).sort();
      const declared = resultManifest(manifests, result)?.acknowledgedWarnings.get(result.id);
      const acknowledged = !!declared
        && declared.dependencies.length === dependencyIds.length
        && declared.dependencies.every((id, index) => id === dependencyIds[index]);
      diagnostics.push(diagnostic(
        "validated-on-unresolved",
        "warning",
        acknowledged
          ? `${result.id} is conditionally validated with an acknowledged scope: ${declared.scope}.`
          : `${result.id} is validated but relies on unresolved ${dependencyIds.join(", ")}.`,
        { ...resultContext(result), acknowledged, scope: acknowledged ? declared.scope : undefined },
      ));
    }
  }

  return { manifests, results: [...byId.values()], byId, diagnostics };
}

function optionalCell(cell: PMNode | undefined): string | undefined {
  const value = cellText(cell);
  return value || undefined;
}

function curatedStatus(value: string): ResultNode["curatedStatus"] {
  const status = value.trim().toLowerCase();
  return ["final", "review", "draft", "superseded"].includes(status)
    ? status as ResultNode["curatedStatus"]
    : undefined;
}

function resultManifest(
  manifests: DependencyManifest[],
  result: ResultNode,
): DependencyManifest | undefined {
  return manifests.find((manifest) => manifest.documentId === result.manifestDocumentId);
}

function cycleDiagnostics(byId: Map<string, ResultNode>): GraphDiagnostic[] {
  const diagnostics: GraphDiagnostic[] = [];
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const reported = new Set<string>();
  const visit = (id: string) => {
    if (state.get(id) === "visited") return;
    if (state.get(id) === "visiting") {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(Math.max(0, start)), id];
      const key = [...new Set(cycle)].sort().join("|");
      if (!reported.has(key)) {
        reported.add(key);
        const result = byId.get(id);
        diagnostics.push(diagnostic(
          "dependency-cycle",
          "error",
          `Dependency cycle: ${cycle.join(" → ")}.`,
          result ? resultContext(result) : { resultId: id },
        ));
      }
      return;
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dependency)) visit(dependency);
    }
    stack.pop();
    state.set(id, "visited");
  };
  for (const id of byId.keys()) visit(id);
  return diagnostics;
}

export function upstreamOf(catalog: DependencyCatalog, id: string): Set<string> {
  const seen = new Set<string>();
  const visit = (current: string) => {
    for (const dependency of catalog.byId.get(current)?.dependsOn ?? []) {
      if (catalog.byId.has(dependency) && !seen.has(dependency)) {
        seen.add(dependency);
        visit(dependency);
      }
    }
  };
  visit(id);
  return seen;
}

export function downstreamOf(catalog: DependencyCatalog, id: string): Set<string> {
  const index = traversalIndex(catalog);
  const cached = index.downstream.get(id);
  if (cached) return new Set(cached);
  const seen = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const current = pending.pop() as string;
    for (const dependent of index.dependents.get(current) ?? []) {
      if (!seen.has(dependent)) {
        seen.add(dependent);
        pending.push(dependent);
      }
    }
  }
  // A dependency cycle can lead back to the starting node. Exposure means
  // *other* results reachable from it, so never count the source itself.
  seen.delete(id);
  index.downstream.set(id, new Set(seen));
  return seen;
}

/** Project nodes plus transitive prerequisites from other project manifests. */
export function resultsForProject(catalog: DependencyCatalog, project: string): ResultNode[] {
  const ids = new Set(catalog.results.filter((result) => result.project === project).map((result) => result.id));
  for (const id of [...ids]) {
    for (const upstream of upstreamOf(catalog, id)) ids.add(upstream);
  }
  return [...ids].flatMap((id) => {
    const result = catalog.byId.get(id);
    return result ? [result] : [];
  });
}
