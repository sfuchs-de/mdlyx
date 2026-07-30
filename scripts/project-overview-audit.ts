import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { countUnresolvedComments, parseFrontmatter } from "../src/markdown/frontmatter";
import {
  buildDependencyCatalog,
  parseDependencyManifest,
  upstreamOf,
  type DependencyCatalog,
  type GraphDiagnostic,
  type ValidationState,
} from "../src/app/dependency-graph";
import {
  buildProjectCatalog,
  parseProjectOverview,
  projectStatusCounts,
  type ProjectCatalogSnapshot,
  type ProjectDiagnostic,
  type ProjectDocumentSummary,
  type TaskState,
} from "../src/app/project-overview";

export const REVIEW_CONFIG_NAME = "library-review.yaml";
export const REVIEW_SCHEMA_VERSION = "2.0";
const SUPPORTED_REVIEW_SCHEMA_VERSIONS = new Set(["1.0", "2.0"]);
const IGNORED_LIBRARY_DIRECTORIES = new Set(["node_modules", "docs"]);

const RESULT_STATES: readonly ValidationState[] = [
  "validated",
  "partial",
  "unvalidated",
  "disputed",
];
const TASK_STATES: readonly TaskState[] = ["next", "in-progress", "blocked", "later", "done"];

interface IndexedSource {
  path: string;
  text: string;
  document: ProjectDocumentSummary;
}

interface IndexedLibrary {
  sources: IndexedSource[];
  diagnostics: AuditDiagnostic[];
}

export interface ReviewExpectedCounts {
  documents: number;
  openQuestions: number;
  unresolvedComments: number;
  results: Record<ValidationState, number>;
  tasks: Record<TaskState, number>;
}

export interface ReviewProject {
  id: string;
  status: string;
  root: string;
  overviewId: string;
  manifestId: string;
  taskAuthority: string;
  expected: ReviewExpectedCounts;
  sourcePins: ReviewSourcePin[];
}

export interface ReviewDraftProject {
  id: string;
  status: "draft";
  root: string;
}

export interface AcceptedDiagnostic {
  code: string;
  project: string;
  resultId: string;
  dependencies: string[];
  scope: string;
  reason: string;
  reviewedAt: string;
  reviewExpires: string;
}

export interface ReviewSupportFile {
  path: string;
  reason: string;
}

export interface ReviewSourcePin {
  path: string;
  value: string;
  jsonPointer?: string;
}

export interface LibraryReviewConfig {
  path: string;
  schemaVersion: string;
  reviewedAt: string;
  projects: Map<string, ReviewProject>;
  draftProjects: Map<string, ReviewDraftProject>;
  supportFiles: ReviewSupportFile[];
  acceptedDiagnostics: AcceptedDiagnostic[];
  expectedDocumentCount?: number;
}

export interface AuditDiagnostic {
  source: "dependency" | "overview" | "review";
  scope: "library" | "project";
  code: string;
  severity: "error" | "warning";
  message: string;
  project?: string;
  resultId?: string;
  taskId?: string;
  path?: string;
  row?: number;
  dependencies?: string[];
  acceptance?: {
    scope: string;
    reason: string;
    reviewedAt: string;
    reviewExpires: string;
  };
}

export interface ProjectAuditCounts extends ReviewExpectedCounts {
  graphErrors: number;
  graphWarnings: number;
}

export interface CountMismatch {
  field: string;
  expected: number;
  actual: number;
}

export interface ProjectAuditReport {
  counts: ProjectAuditCounts;
  diagnostics: AuditDiagnostic[];
  countMismatches: CountMismatch[];
}

export interface ProjectOverviewAuditReport {
  root: string;
  review: {
    path: string;
    schemaVersion: string;
    reviewedAt: string;
  };
  projects: Record<string, ProjectAuditReport>;
  libraryDiagnostics: AuditDiagnostic[];
  summary: {
    errors: number;
    warnings: number;
    acceptedWarnings: number;
    countMismatches: number;
    strictPassed: boolean;
  };
}

export interface ProjectOverviewAuditOptions {
  reviewConfigPath?: string;
  project?: string;
  now?: Date;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value.trim();
}

function countValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer.`);
  }
  return value;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be a list of nonempty strings.`);
  }
  return value.map((item) => (item as string).trim());
}

function optionalString(value: unknown, label: string): string {
  return value === undefined || value === null ? "" : stringValue(value, label, true);
}

function parseExpected(value: unknown, label: string): ReviewExpectedCounts {
  const expected = record(value, label);
  const resultSource = record(expected.results, `${label}.results`);
  const taskSource = record(expected.tasks, `${label}.tasks`);
  return {
    documents: countValue(expected.documents, `${label}.documents`),
    openQuestions: countValue(expected.open_questions, `${label}.open_questions`),
    unresolvedComments: countValue(expected.unresolved_comments, `${label}.unresolved_comments`),
    results: Object.fromEntries(RESULT_STATES.map((state) => [
      state,
      countValue(resultSource[state], `${label}.results.${state}`),
    ])) as Record<ValidationState, number>,
    tasks: Object.fromEntries(TASK_STATES.map((state) => [
      state,
      countValue(taskSource[state], `${label}.tasks.${state}`),
    ])) as Record<TaskState, number>,
  };
}

function parseProject(id: string, value: unknown, label: string): ReviewProject {
  const project = record(value, label);
  const status = stringValue(project.status, `${label}.status`);
  const taskAuthority = stringValue(project.task_authority, `${label}.task_authority`);
  if (!new Set(["active", "draft", "archived"]).has(status)) {
    throw new Error(`${label}.status must be active, draft, or archived.`);
  }
  if (taskAuthority !== "local" && taskAuthority !== "external") {
    throw new Error(`${label}.task_authority must be local or external.`);
  }
  return {
    id,
    status,
    root: relativeReviewPath(project.root, `${label}.root`).replace(/\/$/, ""),
    overviewId: stringValue(project.overview_id, `${label}.overview_id`),
    manifestId: stringValue(project.manifest_id, `${label}.manifest_id`),
    taskAuthority,
    expected: parseExpected(project.expected, `${label}.expected`),
    sourcePins: parseSourcePins(project.source_pins, `${label}.source_pins`),
  };
}

function relativeReviewPath(value: unknown, label: string): string {
  const candidate = stringValue(value, label).replace(/\\/g, "/").replace(/^\.\//, "");
  const normalized = path.posix.normalize(candidate);
  if (
    path.posix.isAbsolute(candidate)
    || path.posix.isAbsolute(normalized)
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new Error(`${label} must stay within the library root.`);
  }
  return normalized;
}

function parseSourcePins(value: unknown, label: string): ReviewSourcePin[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a nonempty list.`);
  }
  return value.map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    const pin = record(item, itemLabel);
    const jsonPointer = optionalString(pin.json_pointer, `${itemLabel}.json_pointer`);
    if (jsonPointer && !jsonPointer.startsWith("/")) {
      throw new Error(`${itemLabel}.json_pointer must begin with '/'.`);
    }
    return {
      path: relativeReviewPath(pin.path, `${itemLabel}.path`),
      value: stringValue(pin.value, `${itemLabel}.value`),
      ...(jsonPointer ? { jsonPointer } : {}),
    };
  });
}

function parseSupportFiles(value: unknown): ReviewSupportFile[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("support_files must be a list.");
  return value.map((item, index) => {
    const label = `support_files[${index}]`;
    const support = record(item, label);
    return {
      path: relativeReviewPath(support.path, `${label}.path`),
      reason: stringValue(support.reason, `${label}.reason`),
    };
  });
}

function parseProjects(value: unknown, label: string): Map<string, ReviewProject> {
  if (value === undefined || value === null) return new Map();
  return new Map(Object.entries(record(value, label)).map(([id, project]) => {
    const parsed = parseProject(id, project, `${label}.${id}`);
    if (parsed.status !== "active") throw new Error(`${label}.${id}.status must be active.`);
    return [id, parsed];
  }));
}

function parseDraftProjects(value: unknown): Map<string, ReviewDraftProject> {
  if (value === undefined || value === null) return new Map();
  return new Map(Object.entries(record(value, "draft_projects")).map(([id, value]) => {
    const label = `draft_projects.${id}`;
    const draft = record(value, label);
    const status = stringValue(draft.status, `${label}.status`);
    if (status !== "draft") throw new Error(`${label}.status must be draft.`);
    return [id, {
      id,
      status: "draft" as const,
      root: relativeReviewPath(draft.root, `${label}.root`).replace(/\/$/, ""),
    }];
  }));
}

function isoDate(value: unknown, label: string): string {
  const source = stringValue(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(source);
  if (!match) {
    throw new Error(`${label} must be an ISO date (YYYY-MM-DD).`);
  }
  const instant = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    instant.getUTCFullYear() !== Number(match[1])
    || instant.getUTCMonth() !== Number(match[2]) - 1
    || instant.getUTCDate() !== Number(match[3])
  ) {
    throw new Error(`${label} must be a real ISO calendar date (YYYY-MM-DD).`);
  }
  return source;
}

function parseAcceptedDiagnostics(value: unknown): AcceptedDiagnostic[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("accepted_diagnostics must be a list.");
  return value.map((item, index) => {
    const label = `accepted_diagnostics[${index}]`;
    const diagnostic = record(item, label);
    const accepted = {
      code: stringValue(diagnostic.code, `${label}.code`),
      project: stringValue(diagnostic.project, `${label}.project`),
      resultId: optionalString(diagnostic.result_id, `${label}.result_id`),
      dependencies: diagnostic.dependencies === undefined
        ? []
        : stringList(diagnostic.dependencies, `${label}.dependencies`),
      scope: stringValue(diagnostic.scope, `${label}.scope`),
      reason: stringValue(diagnostic.reason, `${label}.reason`),
      reviewedAt: isoDate(diagnostic.reviewed_at, `${label}.reviewed_at`),
      reviewExpires: isoDate(diagnostic.review_expires, `${label}.review_expires`),
    };
    if (accepted.code !== "validated-on-unresolved") {
      throw new Error(`${label}.code must be validated-on-unresolved.`);
    }
    if (!accepted.resultId || accepted.dependencies.length === 0) {
      throw new Error(`${label} must identify a result and its unresolved dependencies.`);
    }
    if (accepted.reviewExpires < accepted.reviewedAt) {
      throw new Error(`${label}.review_expires cannot be earlier than reviewed_at.`);
    }
    if (accepted.code === "validated-on-unresolved" && !accepted.scope.startsWith("conditional-")) {
      throw new Error(`${label}.scope must describe a conditional scope for validated-on-unresolved.`);
    }
    return accepted;
  });
}

/** Read the versioned review contract owned by the library repository. */
export async function loadLibraryReviewConfig(
  root: string,
  explicitPath?: string,
): Promise<LibraryReviewConfig> {
  const configPath = path.resolve(explicitPath ?? path.join(root, REVIEW_CONFIG_NAME));
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${configPath}: ${detail}`);
  }
  const yaml = parseDocument(source, { uniqueKeys: true, merge: true });
  if (yaml.errors.length) {
    throw new Error(`Invalid ${REVIEW_CONFIG_NAME}: ${yaml.errors.map((item) => item.message).join("; ")}`);
  }
  const sourceRoot = record(yaml.toJS(), REVIEW_CONFIG_NAME);
  const schemaVersion = String(sourceRoot.schema_version ?? "").trim();
  if (!SUPPORTED_REVIEW_SCHEMA_VERSIONS.has(schemaVersion)) {
    throw new Error(
      `${REVIEW_CONFIG_NAME}.schema_version must be 1.0 or ${REVIEW_SCHEMA_VERSION}; received ${JSON.stringify(schemaVersion)}.`,
    );
  }
  if (schemaVersion === "2.0") {
    return loadLibraryReviewConfigV2(configPath, sourceRoot);
  }
  return {
    path: configPath,
    schemaVersion,
    reviewedAt: isoDate(sourceRoot.reviewed_at, "reviewed_at"),
    projects: parseProjects(sourceRoot.projects, "projects"),
    draftProjects: parseDraftProjects(sourceRoot.draft_projects),
    supportFiles: parseSupportFiles(sourceRoot.support_files),
    acceptedDiagnostics: parseAcceptedDiagnostics(sourceRoot.accepted_diagnostics),
  };
}

interface V2LockProject {
  document_count: number;
  open_question_count: number;
  unresolved_comment_count: number;
  result_count: number;
  validation_counts: Record<ValidationState, number>;
  task_counts: Record<TaskState, number>;
}

function parseV2Expected(value: unknown, label: string): ReviewExpectedCounts {
  const item = record(value, label) as unknown as V2LockProject;
  const results = record(item.validation_counts, `${label}.validation_counts`);
  const tasks = record(item.task_counts, `${label}.task_counts`);
  const expected: ReviewExpectedCounts = {
    documents: countValue(item.document_count, `${label}.document_count`),
    openQuestions: countValue(item.open_question_count, `${label}.open_question_count`),
    unresolvedComments: countValue(item.unresolved_comment_count, `${label}.unresolved_comment_count`),
    results: Object.fromEntries(RESULT_STATES.map((state) => [
      state,
      countValue(results[state], `${label}.validation_counts.${state}`),
    ])) as Record<ValidationState, number>,
    tasks: Object.fromEntries(TASK_STATES.map((state) => [
      state,
      countValue(tasks[state], `${label}.task_counts.${state}`),
    ])) as Record<TaskState, number>,
  };
  const declaredResults = countValue(item.result_count, `${label}.result_count`);
  const summedResults = Object.values(expected.results).reduce((sum, count) => sum + count, 0);
  if (declaredResults !== summedResults) {
    throw new Error(`${label}.result_count does not match validation_counts.`);
  }
  return expected;
}

async function loadYamlMapping(filePath: string, label: string): Promise<Record<string, unknown>> {
  const source = await readFile(filePath, "utf8");
  const document = parseDocument(source, { uniqueKeys: true, merge: true });
  if (document.errors.length) {
    throw new Error(`Invalid ${label}: ${document.errors.map((item) => item.message).join("; ")}`);
  }
  return record(document.toJS(), label);
}

async function loadLibraryReviewConfigV2(
  configPath: string,
  sourceRoot: Record<string, unknown>,
): Promise<LibraryReviewConfig> {
  const root = path.dirname(configPath);
  const activeProjects = stringList(sourceRoot.active_projects, "active_projects");
  if (new Set(activeProjects).size !== activeProjects.length) {
    throw new Error("active_projects must not contain duplicate keys.");
  }
  const draftKeys = sourceRoot.draft_projects === undefined
    ? []
    : stringList(sourceRoot.draft_projects, "draft_projects");
  const lockPath = path.join(root, "library-review.lock.json");
  const lock = record(JSON.parse(await readFile(lockPath, "utf8")), "library-review.lock.json");
  if (String(lock.schema_version ?? "") !== "2.0") {
    throw new Error("library-review.lock.json.schema_version must be 2.0.");
  }
  const lockedProjects = record(lock.projects, "library-review.lock.json.projects");
  const projectConfigs = new Map<string, { root: string; value: Record<string, unknown> }>();
  const projectDirectories = await readdir(path.join(root, "projects"), { withFileTypes: true });
  for (const directory of projectDirectories) {
    if (!directory.isDirectory() || directory.name.startsWith(".")) continue;
    const relativeRoot = `projects/${directory.name}`;
    const projectPath = path.join(root, relativeRoot, "project.yaml");
    let value: Record<string, unknown>;
    try {
      value = await loadYamlMapping(projectPath, `${relativeRoot}/project.yaml`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const project = record(value.project, `${relativeRoot}/project.yaml.project`);
    const key = stringValue(project.key, `${relativeRoot}/project.yaml.project.key`);
    const lifecycle = stringValue(project.lifecycle, `${relativeRoot}/project.yaml.project.lifecycle`);
    if (lifecycle !== "active" && lifecycle !== "draft" && lifecycle !== "archived") {
      throw new Error(`${relativeRoot}/project.yaml.project.lifecycle is invalid.`);
    }
    if (projectConfigs.has(key)) throw new Error(`Duplicate project.yaml key ${key}.`);
    projectConfigs.set(key, { root: relativeRoot, value });
  }

  const projects = new Map<string, ReviewProject>();
  const acceptedDiagnostics: AcceptedDiagnostic[] = [];
  for (const key of activeProjects) {
    const discovered = projectConfigs.get(key);
    if (!discovered) throw new Error(`Active project ${key} has no discovered project.yaml.`);
    const paths = record(discovered.value.paths, `${key}.paths`);
    const authority = record(discovered.value.authority, `${key}.authority`);
    const declaredTaskAuthority = stringValue(authority.tasks, `${key}.authority.tasks`);
    const taskAuthority = declaredTaskAuthority === "local-overview"
      ? "local"
      : declaredTaskAuthority;
    if (taskAuthority !== "local" && taskAuthority !== "external") {
      throw new Error(`${key}.authority.tasks must be local-overview or external.`);
    }
    const overviewRelative = relativeReviewPath(paths.overview, `${key}.paths.overview`);
    const projectionRelative = relativeReviewPath(paths.projection, `${key}.paths.projection`);
    const exceptionRelative = relativeReviewPath(paths.exceptions, `${key}.paths.exceptions`);
    const overviewText = await readFile(path.join(root, discovered.root, overviewRelative), "utf8");
    const projectionText = await readFile(path.join(root, discovered.root, projectionRelative), "utf8");
    const overviewId = parseFrontmatter(overviewText).frontmatter.library.id;
    const manifestId = parseFrontmatter(projectionText).frontmatter.library.id;
    if (!overviewId || !manifestId) throw new Error(`${key} overview/projection lacks a stable document ID.`);
    const expected = parseV2Expected(lockedProjects[key], `library-review.lock.json.projects.${key}`);
    projects.set(key, {
      id: key,
      status: "active",
      root: discovered.root,
      overviewId,
      manifestId,
      taskAuthority,
      expected,
      sourcePins: [],
    });
    const exceptionFile = await loadYamlMapping(
      path.join(root, discovered.root, exceptionRelative),
      `${discovered.root}/${exceptionRelative}`,
    );
    const exceptions = exceptionFile.exceptions;
    if (!Array.isArray(exceptions)) throw new Error(`${key} exceptions must be a list.`);
    for (const [index, exceptionValue] of exceptions.entries()) {
      const label = `${key}.exceptions[${index}]`;
      const exception = record(exceptionValue, label);
      acceptedDiagnostics.push({
        code: stringValue(exception.code, `${label}.code`),
        project: key,
        resultId: stringValue(exception.result_id, `${label}.result_id`),
        dependencies: stringList(exception.dependencies, `${label}.dependencies`),
        scope: stringValue(exception.scope, `${label}.scope`),
        reason: stringValue(exception.reason, `${label}.reason`),
        reviewedAt: isoDate(exception.reviewed_at, `${label}.reviewed_at`),
        reviewExpires: isoDate(exception.review_expires, `${label}.review_expires`),
      });
    }
  }
  const unknown = [...projectConfigs.keys()].filter((key) =>
    !activeProjects.includes(key) && !draftKeys.includes(key)
  );
  if (unknown.length) throw new Error(`Unregistered project.yaml files: ${unknown.sort().join(", ")}.`);
  const lockedKeys = Object.keys(lockedProjects).sort();
  const expectedKeys = [...activeProjects].sort();
  if (
    lockedKeys.length !== expectedKeys.length
    || lockedKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("library-review.lock.json project keys do not match active_projects.");
  }
  const lockedResultCount = countValue(
    lock.formal_result_count,
    "library-review.lock.json.formal_result_count",
  );
  const expectedResultCount = [...projects.values()].reduce(
    (sum, project) => sum + Object.values(project.expected.results).reduce((total, count) => total + count, 0),
    0,
  );
  if (lockedResultCount !== expectedResultCount) {
    throw new Error("library-review.lock.json.formal_result_count does not match project counts.");
  }
  const supportFiles = parseSupportFiles(sourceRoot.support_files);
  return {
    path: configPath,
    schemaVersion: "2.0",
    reviewedAt: isoDate(sourceRoot.reviewed_at, "reviewed_at"),
    projects,
    draftProjects: new Map(draftKeys.map((id) => [id, {
      id,
      status: "draft" as const,
      root: projectConfigs.get(id)?.root ?? `projects/${id}`,
    }])),
    supportFiles,
    acceptedDiagnostics,
    expectedDocumentCount: countValue(lock.document_count, "library-review.lock.json.document_count"),
  };
}

async function markdownFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && IGNORED_LIBRARY_DIRECTORIES.has(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(root, child));
    else if (entry.isFile() && /\.(?:md|markdown)$/i.test(entry.name)) files.push(child);
  }
  return files;
}

async function indexLibrary(root: string, excludedPaths: ReadonlySet<string>): Promise<IndexedLibrary> {
  const diagnostics: AuditDiagnostic[] = [];
  const sources = await Promise.all((await markdownFiles(root)).sort()
    .filter((relativePath) => !excludedPaths.has(relativePath.split(path.sep).join("/")))
    .map(async (relativePath) => {
      const text = await readFile(path.join(root, relativePath), "utf8");
      const parsed = parseFrontmatter(text);
      const { frontmatter } = parsed;
      const meta = frontmatter.library;
      const normalizedPath = relativePath.split(path.sep).join("/");
      const frontmatterSource = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? "";
      const hasLibraryMetadata = parsed.hadFrontmatter && /^library\s*:/m.test(frontmatterSource);
      if (!hasLibraryMetadata) {
        const diagnostic = reviewDiagnostic(
          "unindexed-markdown",
          "error",
          `${normalizedPath} has no library metadata and is not an allowlisted support file.`,
        );
        diagnostic.path = normalizedPath;
        diagnostics.push(diagnostic);
      } else if (!meta.id?.trim()) {
        const diagnostic = reviewDiagnostic(
          "missing-document-id",
          "error",
          `${normalizedPath} has library metadata without a stable document ID.`,
        );
        diagnostic.path = normalizedPath;
        diagnostics.push(diagnostic);
      }
      return {
        path: normalizedPath,
        text,
        document: {
          id: meta.id ?? "",
          title: meta.title ?? path.basename(relativePath).replace(/\.(?:md|markdown)$/i, ""),
          path: normalizedPath,
          projects: meta.projects,
          contains: meta.contains,
          unresolvedCommentCount: countUnresolvedComments(frontmatter.comments),
        },
      };
    }));
  const ids = new Map<string, string>();
  for (const source of sources) {
    if (!source.document.id) continue;
    const firstPath = ids.get(source.document.id);
    if (firstPath) {
      const diagnostic = reviewDiagnostic(
        "duplicate-document-id",
        "error",
        `Document ID ${source.document.id} is declared by both ${firstPath} and ${source.path}.`,
      );
      diagnostic.path = source.path;
      diagnostics.push(diagnostic);
    } else {
      ids.set(source.document.id, source.path);
    }
  }
  return { sources, diagnostics };
}

function graphDependencies(diagnostic: GraphDiagnostic, catalog: DependencyCatalog): string[] {
  if (diagnostic.code !== "validated-on-unresolved" || !diagnostic.resultId) return [];
  return [...upstreamOf(catalog, diagnostic.resultId)]
    .flatMap((id) => {
      const result = catalog.byId.get(id);
      return result && result.validation !== "validated" ? [id] : [];
    })
    .sort((a, b) => a.localeCompare(b));
}

function diagnosticProject(
  diagnostic: GraphDiagnostic | ProjectDiagnostic,
  snapshot: ProjectCatalogSnapshot,
  pathProjects: Map<string, string>,
): string | undefined {
  if (diagnostic.code === "duplicate-result-id") return undefined;
  if (diagnostic.code === "dependency-cycle" && "resultId" in diagnostic && diagnostic.resultId) {
    const involvedProjects = new Set(
      [diagnostic.resultId, ...upstreamOf(snapshot.dependencyCatalog, diagnostic.resultId)]
        .flatMap((id) => {
          const result = snapshot.dependencyCatalog.byId.get(id);
          return result ? [result.project] : [];
        }),
    );
    if (involvedProjects.size > 1) return undefined;
  }
  if (diagnostic.project) return diagnostic.project;
  if ("resultId" in diagnostic && diagnostic.resultId) {
    const result = snapshot.dependencyCatalog.byId.get(diagnostic.resultId);
    if (result) return result.project;
  }
  if (diagnostic.path) return pathProjects.get(diagnostic.path);
  return undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort((one, two) => one.localeCompare(two));
  const b = [...right].sort((one, two) => one.localeCompare(two));
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function acceptanceFor(
  diagnostic: AuditDiagnostic,
  accepted: AcceptedDiagnostic[],
  now: Date,
): AcceptedDiagnostic | undefined {
  if (diagnostic.severity !== "warning" || diagnostic.scope !== "project") return undefined;
  const today = now.toISOString().slice(0, 10);
  return accepted.find((item) =>
    item.reviewedAt <= today
    && item.reviewExpires >= today
    && item.code === diagnostic.code
    && item.project === diagnostic.project
    && item.resultId === (diagnostic.resultId ?? "")
    && sameStrings(item.dependencies, diagnostic.dependencies ?? [])
  );
}

function toAuditDiagnostic(
  source: "dependency" | "overview",
  diagnostic: GraphDiagnostic | ProjectDiagnostic,
  snapshot: ProjectCatalogSnapshot,
  pathProjects: Map<string, string>,
  accepted: AcceptedDiagnostic[],
  now: Date,
): AuditDiagnostic {
  const project = diagnosticProject(diagnostic, snapshot, pathProjects);
  const dependencies = source === "dependency"
    ? graphDependencies(diagnostic as GraphDiagnostic, snapshot.dependencyCatalog)
    : [];
  const converted: AuditDiagnostic = {
    source,
    scope: project ? "project" : "library",
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    project,
    resultId: "resultId" in diagnostic ? diagnostic.resultId : undefined,
    taskId: "taskId" in diagnostic ? diagnostic.taskId : undefined,
    path: diagnostic.path,
    row: diagnostic.row,
    dependencies: dependencies.length ? dependencies : undefined,
  };
  const acceptance = acceptanceFor(converted, accepted, now);
  if (acceptance) {
    converted.acceptance = {
      scope: acceptance.scope,
      reason: acceptance.reason,
      reviewedAt: acceptance.reviewedAt,
      reviewExpires: acceptance.reviewExpires,
    };
  }
  return converted;
}

function projectCounts(
  snapshot: ProjectCatalogSnapshot,
  project: string,
  diagnostics: AuditDiagnostic[],
): ProjectAuditCounts {
  const status = projectStatusCounts(snapshot, project);
  const projectTasks = snapshot.tasksByProject.get(project) ?? [];
  return {
    documents: status.documents,
    openQuestions: snapshot.documents.filter((document) =>
      document.projects.includes(project) && document.contains.includes("open-questions")
    ).length,
    unresolvedComments: status.unresolvedComments,
    results: status.results,
    tasks: Object.fromEntries(TASK_STATES.map((state) => [
      state,
      projectTasks.filter((task) => task.state === state).length,
    ])) as Record<TaskState, number>,
    graphErrors: diagnostics.filter((item) =>
      item.source === "dependency" && item.severity === "error"
    ).length,
    graphWarnings: diagnostics.filter((item) =>
      item.source === "dependency" && item.severity === "warning"
    ).length,
  };
}

function countMismatches(actual: ProjectAuditCounts, expected: ReviewExpectedCounts): CountMismatch[] {
  const comparisons: Array<[string, number, number]> = [
    ["documents", expected.documents, actual.documents],
    ["open_questions", expected.openQuestions, actual.openQuestions],
    ["unresolved_comments", expected.unresolvedComments, actual.unresolvedComments],
    ...RESULT_STATES.map((state): [string, number, number] => [
      `results.${state}`,
      expected.results[state],
      actual.results[state],
    ]),
    ...TASK_STATES.map((state): [string, number, number] => [
      `tasks.${state}`,
      expected.tasks[state],
      actual.tasks[state],
    ]),
  ];
  return comparisons.flatMap(([field, expectedValue, actualValue]) =>
    expectedValue === actualValue ? [] : [{ field, expected: expectedValue, actual: actualValue }]
  );
}

function reviewDiagnostic(
  code: string,
  severity: "error" | "warning",
  message: string,
  project?: string,
): AuditDiagnostic {
  return {
    source: "review",
    scope: project ? "project" : "library",
    code,
    severity,
    message,
    project,
  };
}

function isWithinProjectRoot(documentPath: string, projectRoot: string): boolean {
  return documentPath === projectRoot || documentPath.startsWith(`${projectRoot}/`);
}

function projectContractDiagnostics(
  project: ReviewProject,
  snapshot: ProjectCatalogSnapshot,
): AuditDiagnostic[] {
  const diagnostics: AuditDiagnostic[] = [];
  const overviews = snapshot.overviews.filter((item) => item.project === project.id);
  const manifests = snapshot.dependencyCatalog.manifests.filter((item) => item.project === project.id);
  if (overviews.length === 0) {
    diagnostics.push(reviewDiagnostic(
      "missing-project-overview",
      "error",
      `Project ${project.id} has no parseable project overview.`,
      project.id,
    ));
  } else if (overviews.length === 1) {
    const overview = overviews[0];
    if (overview.documentId !== project.overviewId) {
      diagnostics.push(reviewDiagnostic(
        "overview-id-mismatch",
        "error",
        `Expected overview id ${project.overviewId}, got ${overview.documentId}.`,
        project.id,
      ));
    }
    const actualAuthority = overview.taskAuthority ? "external" : "local";
    if (actualAuthority !== project.taskAuthority) {
      diagnostics.push(reviewDiagnostic(
        "task-authority-mismatch",
        "error",
        `Expected ${project.taskAuthority} task authority, got ${actualAuthority}.`,
        project.id,
      ));
    }
  }
  if (manifests.length === 0) {
    diagnostics.push(reviewDiagnostic(
      "missing-project-manifest",
      "error",
      `Project ${project.id} has no parseable dependency manifest.`,
      project.id,
    ));
  } else if (manifests.length === 1 && manifests[0].documentId !== project.manifestId) {
    diagnostics.push(reviewDiagnostic(
      "manifest-id-mismatch",
      "error",
      `Expected manifest id ${project.manifestId}, got ${manifests[0].documentId}.`,
      project.id,
    ));
  }
  for (const document of snapshot.documents.filter((item) => item.projects.includes(project.id))) {
    if (!isWithinProjectRoot(document.path, project.root)) {
      const diagnostic = reviewDiagnostic(
        "project-root-mismatch",
        "error",
        `${document.path} declares project ${project.id} but is outside ${project.root}/.`,
        project.id,
      );
      diagnostic.path = document.path;
      diagnostics.push(diagnostic);
    }
  }
  for (const document of snapshot.documents.filter((item) =>
    isWithinProjectRoot(item.path, project.root) && !item.projects.includes(project.id)
  )) {
    const diagnostic = reviewDiagnostic(
      "unassigned-project-document",
      "error",
      `${document.path} is inside ${project.root}/ but does not declare project ${project.id}.`,
      project.id,
    );
    diagnostic.path = document.path;
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

function acceptanceKey(item: AcceptedDiagnostic): string {
  return [item.code, item.project, item.resultId, [...item.dependencies].sort().join(",")].join("|");
}

async function containedRealPath(root: string, relativePath: string): Promise<string> {
  const [realRoot, realTarget] = await Promise.all([
    realpath(root),
    realpath(path.resolve(root, relativePath)),
  ]);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`${relativePath} resolves outside the library root.`);
  }
  return realTarget;
}

function jsonPointerValue(source: unknown, pointer: string): unknown {
  let value = source;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) {
      if (!/^\d+$/.test(key)) throw new Error(`invalid array index ${JSON.stringify(key)}`);
      value = value[Number(key)];
    } else if (value && typeof value === "object") {
      if (!(key in value)) throw new Error(`missing key ${JSON.stringify(key)}`);
      value = (value as Record<string, unknown>)[key];
    } else {
      throw new Error(`cannot traverse ${JSON.stringify(key)}`);
    }
  }
  return value;
}

async function sourcePinDiagnostics(
  root: string,
  projects: Iterable<ReviewProject>,
): Promise<AuditDiagnostic[]> {
  const diagnostics: AuditDiagnostic[] = [];
  for (const project of projects) {
    for (const pin of project.sourcePins) {
      let source: string;
      try {
        source = await readFile(await containedRealPath(root, pin.path), "utf8");
      } catch (error) {
        const item = reviewDiagnostic(
          "source-pin-missing",
          "error",
          `Cannot read source pin ${pin.path}: ${error instanceof Error ? error.message : String(error)}`,
          project.id,
        );
        item.path = pin.path;
        diagnostics.push(item);
        continue;
      }
      if (pin.jsonPointer) {
        try {
          const actual = jsonPointerValue(JSON.parse(source), pin.jsonPointer);
          if (String(actual) !== pin.value) {
            const item = reviewDiagnostic(
              "source-pin-drift",
              "error",
              `${pin.path}${pin.jsonPointer} expected ${pin.value}, got ${String(actual)}.`,
              project.id,
            );
            item.path = pin.path;
            diagnostics.push(item);
          }
        } catch (error) {
          const item = reviewDiagnostic(
            "source-pin-invalid",
            "error",
            `Cannot resolve ${pin.jsonPointer} in ${pin.path}: ${error instanceof Error ? error.message : String(error)}`,
            project.id,
          );
          item.path = pin.path;
          diagnostics.push(item);
        }
      } else if (!source.includes(pin.value)) {
        const item = reviewDiagnostic(
          "source-pin-drift",
          "error",
          `${pin.path} no longer records source revision ${pin.value}.`,
          project.id,
        );
        item.path = pin.path;
        diagnostics.push(item);
      }
    }
  }
  return diagnostics;
}

/** Build the same catalog that powers the app, then compare it to the library-owned baseline. */
export async function auditProjectOverviews(
  rootArg: string,
  options: ProjectOverviewAuditOptions = {},
): Promise<ProjectOverviewAuditReport> {
  const root = path.resolve(rootArg);
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const review = await loadLibraryReviewConfig(root, options.reviewConfigPath);
  const registered = new Map(review.projects);
  if (options.project && !registered.has(options.project)) {
    throw new Error(`Project ${JSON.stringify(options.project)} is not registered in ${review.path}.`);
  }
  const selectedProjects = options.project ? [options.project] : [...registered.keys()].sort();

  const supportPaths = new Set(review.supportFiles.map((item) => item.path));
  const indexed = await indexLibrary(root, supportPaths);
  const sources = indexed.sources;
  const documents = sources.map((source) => source.document);
  const overviews = sources
    .filter((source) => source.document.contains.includes("project-overview"))
    .map((source) => parseProjectOverview(source.text, source.path));
  const manifests = sources
    .filter((source) => source.document.contains.includes("dependency-graph"))
    .map((source) => parseDependencyManifest(source.text, source.path));
  const dependencyCatalog = buildDependencyCatalog(
    manifests,
    documents.map(({ id, title }) => ({ id, title })),
  );
  const snapshot = buildProjectCatalog(overviews, dependencyCatalog, documents);
  const pathProjects = new Map<string, string>();
  for (const source of sources) {
    if (source.document.projects.length === 1) pathProjects.set(source.path, source.document.projects[0]);
  }
  for (const project of registered.values()) {
    const normalizedRoot = project.root.replace(/^\.\//, "").replace(/\/$/, "");
    for (const source of sources) {
      if (!pathProjects.has(source.path) && source.path.startsWith(`${normalizedRoot}/`)) {
        pathProjects.set(source.path, project.id);
      }
    }
  }
  const indexDiagnostics = indexed.diagnostics.map((item) => {
    if (
      !item.path
      || (item.code !== "unindexed-markdown" && item.code !== "missing-document-id")
    ) return item;
    const owners = [...registered.values()].filter((project) =>
      isWithinProjectRoot(item.path!, project.root)
    );
    if (owners.length !== 1) return item;
    return { ...item, scope: "project" as const, project: owners[0].id };
  });

  const rawDiagnostics = [
    ...indexDiagnostics,
    ...dependencyCatalog.diagnostics.map((item) => toAuditDiagnostic(
      "dependency",
      item,
      snapshot,
      pathProjects,
      review.acceptedDiagnostics,
      now,
    )),
    ...snapshot.diagnostics.map((item) => toAuditDiagnostic(
      "overview",
      item,
      snapshot,
      pathProjects,
      review.acceptedDiagnostics,
      now,
    )),
  ];
  if (
    review.expectedDocumentCount !== undefined
    && review.expectedDocumentCount !== sources.length
  ) {
    rawDiagnostics.push(reviewDiagnostic(
      "library-document-count-mismatch",
      "error",
      `Library lock expects ${review.expectedDocumentCount} indexed documents, got ${sources.length}.`,
    ));
  }
  rawDiagnostics.push(...await sourcePinDiagnostics(root, registered.values()));
  if (review.reviewedAt > today) {
    rawDiagnostics.push(reviewDiagnostic(
      "future-baseline-review",
      "error",
      `${REVIEW_CONFIG_NAME} claims a future review date ${review.reviewedAt}.`,
    ));
  }
  const acceptedKeys = new Set<string>();
  for (const acceptance of review.acceptedDiagnostics) {
    const key = acceptanceKey(acceptance);
    if (acceptedKeys.has(key)) {
      rawDiagnostics.push(reviewDiagnostic(
        "duplicate-accepted-diagnostic",
        "error",
        `Accepted diagnostic ${key} is declared more than once.`,
      ));
    }
    acceptedKeys.add(key);
    const project = registered.get(acceptance.project);
    const result = dependencyCatalog.byId.get(acceptance.resultId);
    const missingDependencies = acceptance.dependencies.filter((id) => !dependencyCatalog.byId.has(id));
    if (!project) {
      rawDiagnostics.push(reviewDiagnostic(
        "accepted-diagnostic-project",
        "error",
        `Accepted diagnostic references unregistered active project ${acceptance.project}.`,
      ));
    }
    if (!result || result.project !== acceptance.project) {
      rawDiagnostics.push(reviewDiagnostic(
        "accepted-diagnostic-result",
        "error",
        `Accepted diagnostic references missing or mismatched result ${acceptance.resultId}.`,
      ));
    }
    if (missingDependencies.length) {
      rawDiagnostics.push(reviewDiagnostic(
        "accepted-diagnostic-dependency",
        "error",
        `Accepted diagnostic references missing dependencies ${missingDependencies.join(", ")}.`,
      ));
    }
    if (acceptance.reviewedAt > today) {
      rawDiagnostics.push(reviewDiagnostic(
        "future-accepted-diagnostic",
        "error",
        `Accepted diagnostic for ${acceptance.resultId} claims a future review date ${acceptance.reviewedAt}.`,
      ));
    }
  }
  for (const project of registered.values()) {
    rawDiagnostics.push(...projectContractDiagnostics(project, snapshot));
  }
  const knownProjects = new Set([...review.projects.keys(), ...review.draftProjects.keys()]);
  for (const source of sources) {
    if (source.document.projects.length > 1) {
      const diagnostic = reviewDiagnostic(
        "multiple-project-membership",
        "error",
        `${source.path} declares more than one research project.`,
      );
      diagnostic.path = source.path;
      rawDiagnostics.push(diagnostic);
    }
    for (const project of source.document.projects) {
      if (knownProjects.has(project)) continue;
      const diagnostic = reviewDiagnostic(
        "unregistered-project",
        "error",
        `${source.path} declares unregistered project ${project}.`,
      );
      diagnostic.path = source.path;
      rawDiagnostics.push(diagnostic);
    }
  }
  for (const supportFile of review.supportFiles) {
    try {
      await containedRealPath(root, supportFile.path);
    } catch (error) {
      const diagnostic = reviewDiagnostic(
        "missing-support-file",
        "error",
        `Configured support file ${supportFile.path} is missing or unsafe: ${error instanceof Error ? error.message : String(error)}`,
      );
      diagnostic.path = supportFile.path;
      rawDiagnostics.push(diagnostic);
    }
  }
  const allProjectReports: Record<string, ProjectAuditReport> = {};
  const allDiagnostics = [...rawDiagnostics];
  for (const project of [...registered.keys()].sort()) {
    const expected = registered.get(project)?.expected;
    if (!expected) continue;
    const diagnostics = rawDiagnostics.filter((item) => item.project === project);
    const counts = projectCounts(snapshot, project, diagnostics);
    const mismatches = countMismatches(counts, expected);
    for (const mismatch of mismatches) {
      const item = reviewDiagnostic(
        "acceptance-count-mismatch",
        "error",
        `${mismatch.field}: expected ${mismatch.expected}, got ${mismatch.actual}.`,
        project,
      );
      diagnostics.push(item);
      allDiagnostics.push(item);
    }
    allProjectReports[project] = { counts, diagnostics, countMismatches: mismatches };
  }

  const presentAcceptedKeys = new Set(
    allDiagnostics.filter((item) => item.acceptance).map((item) => [
      item.code,
      item.project ?? "",
      item.resultId ?? "",
      [...(item.dependencies ?? [])].sort().join(","),
    ].join("|")),
  );
  const acceptanceDiagnostics: AuditDiagnostic[] = [];
  for (const acceptance of review.acceptedDiagnostics) {
    if (acceptance.reviewExpires < today) {
      acceptanceDiagnostics.push(reviewDiagnostic(
        "expired-accepted-diagnostic",
        "error",
        `Accepted diagnostic ${acceptance.code} for ${acceptance.resultId || acceptance.project} expired on ${acceptance.reviewExpires}.`,
        acceptance.project,
      ));
    } else if (!presentAcceptedKeys.has(acceptanceKey(acceptance))) {
      acceptanceDiagnostics.push(reviewDiagnostic(
        "stale-accepted-diagnostic",
        "error",
        `Accepted diagnostic ${acceptance.code} for ${acceptance.resultId || acceptance.project} no longer matches a current warning.`,
        acceptance.project,
      ));
    }
  }
  for (const diagnostic of acceptanceDiagnostics) {
    allDiagnostics.push(diagnostic);
    allProjectReports[diagnostic.project ?? ""]?.diagnostics.push(diagnostic);
  }

  const libraryDiagnostics = allDiagnostics.filter((item) => item.scope === "library");
  const errors = allDiagnostics.filter((item) => item.severity === "error").length;
  const warnings = allDiagnostics.filter((item) => item.severity === "warning").length;
  const acceptedWarnings = allDiagnostics.filter((item) => item.acceptance).length;
  const countMismatchTotal = Object.values(allProjectReports)
    .reduce((total, item) => total + item.countMismatches.length, 0);
  const unacceptedWarnings = allDiagnostics.filter((item) =>
    item.severity === "warning" && !item.acceptance
  ).length;
  const projectReports = Object.fromEntries(
    selectedProjects.map((project) => [project, allProjectReports[project]]),
  );
  return {
    root,
    review: {
      path: review.path,
      schemaVersion: review.schemaVersion,
      reviewedAt: review.reviewedAt,
    },
    projects: projectReports,
    libraryDiagnostics,
    summary: {
      errors,
      warnings,
      acceptedWarnings,
      countMismatches: countMismatchTotal,
      strictPassed: errors === 0 && unacceptedWarnings === 0,
    },
  };
}
