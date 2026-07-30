import type { Node as PMNode } from "prosemirror-model";
import {
  parseFrontmatter,
  type ExternalTaskAuthority,
  type LibraryVisibility,
} from "../markdown/frontmatter";
import { parseMarkdown } from "../markdown/parse";
import type { ProjectPublicationConfig } from "../publication/project-publication";
import {
  downstreamOf,
  resultsForProject,
  type DependencyCatalog,
  type GraphDiagnostic,
  type ResultNode,
  type ValidationState,
} from "./dependency-graph";

export const TASK_STATES = ["next", "in-progress", "blocked", "later", "done"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_PRIORITIES = ["high", "medium", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface ProjectTask {
  id: string;
  title: string;
  state: TaskState;
  priority: TaskPriority;
  ownerId: string;
  ownerLabel: string;
  relatedResultIds: string[];
  dependsOn: string[];
  exitCriterion: string;
  project: string;
  overviewDocumentId: string;
  overviewPath: string;
  row: number;
  order: number;
}

export interface ProjectKeyResult {
  resultId: string;
  significance: string;
  /** Optional authored reading link, validated against the canonical result owner. */
  readingDocumentId?: string;
  readingDocumentLabel?: string;
  project: string;
  overviewDocumentId: string;
  overviewPath: string;
  row: number;
  order: number;
  /** Populated by buildProjectCatalog after library-wide result resolution. */
  result?: ResultNode;
}

export interface ProjectReadingPathEntry {
  area: string;
  section: string;
  documentId: string;
  documentLabel: string;
  purpose: string;
  project: string;
  overviewDocumentId: string;
  overviewPath: string;
  row: number;
  order: number;
  /** Populated by buildProjectCatalog after project-scoped document resolution. */
  document?: ProjectDocumentSummary;
}

export interface ProjectOverview {
  project: string;
  documentId: string;
  title: string;
  path: string;
  summary: string;
  keyDocumentIds: string[];
  keyResults: ProjectKeyResult[];
  readingPath: ProjectReadingPathEntry[];
  tasks: ProjectTask[];
  taskAuthority?: ExternalTaskAuthority;
  publication?: ProjectPublicationConfig;
}

/** The provider-neutral metadata needed to build an overview snapshot. */
export interface ProjectDocumentSummary {
  id: string;
  title: string;
  path: string;
  projects: string[];
  contains: string[];
  /** Missing values preserve the pre-visibility contract and mean reader. */
  visibility?: LibraryVisibility;
  unresolvedCommentCount: number;
  /** True when the editor has changes newer than the persisted library source. */
  dirty?: boolean;
}

export type ProjectDiagnosticSeverity = "error" | "warning";

export interface ProjectDiagnostic {
  code:
    | "overview-marker"
    | "overview-project"
    | "overview-document-id"
    | "summary-heading"
    | "summary-paragraph"
    | "priorities-heading"
    | "priorities-table"
    | "key-results-section"
    | "key-results-table"
    | "key-results-column"
    | "missing-key-result-id"
    | "blank-key-result-significance"
    | "duplicate-key-result"
    | "invalid-key-result-document"
    | "key-result-document-mismatch"
    | "missing-key-result"
    | "cross-project-key-result"
    | "reading-path-section"
    | "reading-path-table"
    | "reading-path-column"
    | "missing-reading-path-area"
    | "invalid-reading-path-document"
    | "self-reading-path-document"
    | "duplicate-reading-path-document"
    | "blank-reading-path-purpose"
    | "missing-reading-path-document"
    | "cross-project-reading-path-document"
    | "support-reading-path-document"
    | "external-task-table"
    | "missing-column"
    | "missing-task-id"
    | "missing-task-title"
    | "invalid-task-state"
    | "invalid-task-priority"
    | "missing-task-owner"
    | "missing-exit-criterion"
    | "duplicate-project-overview"
    | "duplicate-task-id"
    | "missing-owner-document"
    | "missing-related-result"
    | "missing-task-dependency"
    | "task-cycle"
    | "unfinished-task-prerequisite"
    | "missing-dependency-manifest";
  severity: ProjectDiagnosticSeverity;
  message: string;
  project?: string;
  taskId?: string;
  path?: string;
  row?: number;
}

export interface ParsedProjectOverview {
  overview: ProjectOverview | null;
  diagnostics: ProjectDiagnostic[];
}

export interface ProjectCatalogSnapshot {
  /** All syntactically usable overviews, including ambiguous duplicates. */
  overviews: ProjectOverview[];
  /** Contains only projects with exactly one authoritative overview. */
  overviewByProject: Map<string, ProjectOverview>;
  projects: string[];
  /** Valid, project-scoped tasks from unambiguous overview documents. */
  tasks: ProjectTask[];
  tasksByProject: Map<string, ProjectTask[]>;
  documents: ProjectDocumentSummary[];
  dependencyCatalog: DependencyCatalog;
  diagnostics: ProjectDiagnostic[];
}

export interface ProjectStatusCounts {
  results: Record<ValidationState, number>;
  graphErrors: number;
  graphWarnings: number;
  activeTasks: number;
  blockedTasks: number;
  laterTasks: number;
  doneTasks: number;
  documents: number;
  unresolvedComments: number;
}

export interface ProjectResultAttention {
  result: ResultNode;
  downstreamExposure: number;
}

const REQUIRED_COLUMNS = [
  "task id",
  "task",
  "state",
  "priority",
  "owner",
  "related results",
  "depends on",
  "exit criterion",
] as const;

function diagnostic(
  code: ProjectDiagnostic["code"],
  severity: ProjectDiagnosticSeverity,
  message: string,
  extra: Partial<Omit<ProjectDiagnostic, "code" | "severity" | "message">> = {},
): ProjectDiagnostic {
  return { code, severity, message, ...extra };
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

function identifierList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || /^(?:-|—|–|none|n\/a)$/i.test(trimmed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of trimmed.replace(/`/g, "").split(/[,;\n]/)) {
    const id = part.trim();
    if (id && !/^(?:-|—|–|none|n\/a)$/i.test(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function enumToken<T extends string>(value: string, allowed: readonly T[]): T | null {
  const token = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return (allowed as readonly string[]).includes(token) ? token as T : null;
}

function findHeading(doc: PMNode, id: string): number {
  for (let index = 0; index < doc.childCount; index++) {
    const node = doc.child(index);
    if (node.type.name === "heading" && node.attrs.id === id) return index;
  }
  return -1;
}

function findHeadings(doc: PMNode, id: string): number[] {
  const found: number[] = [];
  for (let index = 0; index < doc.childCount; index++) {
    const node = doc.child(index);
    if (node.type.name === "heading" && node.attrs.id === id) found.push(index);
  }
  return found;
}

function firstParagraphAfter(doc: PMNode, headingIndex: number): string {
  for (let index = headingIndex + 1; index < doc.childCount; index++) {
    const node = doc.child(index);
    if (node.type.name === "heading") break;
    if (node.type.name === "paragraph") return node.textContent.trim().replace(/\s+/g, " ");
  }
  return "";
}

function firstTableAfter(doc: PMNode, headingIndex: number): PMNode | null {
  for (let index = headingIndex + 1; index < doc.childCount; index++) {
    const node = doc.child(index);
    if (node.type.name === "heading") break;
    if (node.type.name === "table") return node;
  }
  return null;
}

function tablesInSection(doc: PMNode, headingIndex: number): PMNode[] {
  const heading = doc.child(headingIndex);
  const level = heading.type.name === "heading" && typeof heading.attrs.level === "number"
    ? heading.attrs.level
    : 2;
  const tables: PMNode[] = [];
  for (let index = headingIndex + 1; index < doc.childCount; index++) {
    const node = doc.child(index);
    if (
      node.type.name === "heading"
      && typeof node.attrs.level === "number"
      && node.attrs.level <= level
    ) break;
    if (node.type.name === "table") tables.push(node);
  }
  return tables;
}

interface GeneratedHeadline {
  resultId: string;
  significance: string;
  row: number;
}

function generatedHeadlines(markdownBody: string): GeneratedHeadline[] | null {
  const start = "<!-- mathdown:overview-headlines-v2:start -->";
  const end = "<!-- mathdown:overview-headlines-v2:end -->";
  const startIndex = markdownBody.indexOf(start);
  const endIndex = markdownBody.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) return null;

  const region = markdownBody.slice(startIndex + start.length, endIndex);
  const heading = /^###\s+.+?\s+\(`([^`]+)`\)\s*$/gm;
  const matches = [...region.matchAll(heading)];
  return matches.map((match, index) => {
    const cardStart = (match.index ?? 0) + match[0].length;
    const cardEnd = index + 1 < matches.length ? matches[index + 1].index ?? region.length : region.length;
    const card = region.slice(cardStart, cardEnd);
    const significance = card.match(
      /^-\s+\*\*Why it matters:\*\*\s*(.+?)\s*$/m,
    )?.[1]?.trim() ?? "";
    const absoluteOffset = startIndex + start.length + (match.index ?? 0);
    return {
      resultId: match[1].trim(),
      significance,
      row: markdownBody.slice(0, absoluteOffset).split("\n").length,
    };
  });
}

/** Parse one Markdown document explicitly marked as a project overview. */
export function parseProjectOverview(markdown: string, path: string): ParsedProjectOverview {
  const parsed = parseFrontmatter(markdown);
  const meta = parsed.frontmatter.library;
  const diagnostics: ProjectDiagnostic[] = [];
  const marked = meta.contains.includes("project-overview");
  const project = meta.projects.length === 1 ? meta.projects[0] : "";

  if (!marked) {
    diagnostics.push(diagnostic(
      "overview-marker",
      "error",
      "A project overview must include “project-overview” in its contains metadata.",
      { path },
    ));
  }
  if (meta.projects.length !== 1) {
    diagnostics.push(diagnostic(
      "overview-project",
      "error",
      "A project overview must belong to exactly one project.",
      { path },
    ));
  }
  if (!meta.id) {
    diagnostics.push(diagnostic(
      "overview-document-id",
      "error",
      "A project overview needs a stable document id.",
      { project, path },
    ));
  }

  const doc = parseMarkdown(parsed.body);
  const summaryHeading = findHeading(doc, "project-summary");
  let summary = "";
  if (summaryHeading < 0) {
    diagnostics.push(diagnostic(
      "summary-heading",
      "warning",
      "Add a heading with the id {#project-summary} before the project summary.",
      { project, path },
    ));
  } else {
    summary = firstParagraphAfter(doc, summaryHeading);
    if (!summary) {
      diagnostics.push(diagnostic(
        "summary-paragraph",
        "warning",
        "The project-summary heading needs a summary paragraph.",
        { project, path },
      ));
    }
  }

  const keyResults: ProjectKeyResult[] = [];
  const keyResultHeadings = findHeadings(doc, "key-results");
  if (keyResultHeadings.length > 1) {
    diagnostics.push(diagnostic(
      "key-results-section",
      "error",
      "A project overview may declare only one key-results section.",
      { project, path },
    ));
  }
  if (keyResultHeadings.length) {
    const table = firstTableAfter(doc, keyResultHeadings[0]);
    const headlineCards = generatedHeadlines(parsed.body);
    if ((!table || table.childCount < 1) && headlineCards) {
      const seen = new Set<string>();
      for (const [index, card] of headlineCards.entries()) {
        const context = { project, path, row: card.row };
        if (!card.resultId) {
          diagnostics.push(diagnostic(
            "missing-key-result-id",
            "error",
            "A generated headline has no Result ID.",
            context,
          ));
          continue;
        }
        if (seen.has(card.resultId)) {
          diagnostics.push(diagnostic(
            "duplicate-key-result",
            "error",
            `Key result ${card.resultId} is declared more than once.`,
            context,
          ));
          continue;
        }
        seen.add(card.resultId);
        if (!card.significance) {
          diagnostics.push(diagnostic(
            "blank-key-result-significance",
            "warning",
            `Key result ${card.resultId} needs a concise “Why it matters” explanation.`,
            context,
          ));
        }
        keyResults.push({
          resultId: card.resultId,
          significance: card.significance,
          project,
          overviewDocumentId: meta.id ?? "",
          overviewPath: path,
          row: card.row,
          order: index,
        });
      }
    } else if (!table || table.childCount < 1) {
      diagnostics.push(diagnostic(
        "key-results-table",
        "error",
        "The key-results heading must be followed by a Markdown table.",
        { project, path },
      ));
    } else {
      const columns = new Map<string, number>();
      const header = table.child(0);
      for (let index = 0; index < header.childCount; index++) {
        columns.set(normaliseHeader(cellText(header.child(index))), index);
      }
      for (const column of ["result id", "why it matters"] as const) {
        if (!columns.has(column)) {
          diagnostics.push(diagnostic(
            "key-results-column",
            "error",
            `The key-results table is missing the “${column}” column.`,
            { project, path },
          ));
        }
      }
      if (columns.has("result id") && columns.has("why it matters")) {
        const valueAt = (row: PMNode, column: string): PMNode | undefined => {
          const index = columns.get(column);
          return index === undefined || index >= row.childCount ? undefined : row.child(index);
        };
        const readingColumn = ["read", "document", "derivation"]
          .find((column) => columns.has(column));
        const seen = new Set<string>();
        for (let index = 1; index < table.childCount; index++) {
          const row = table.child(index);
          const tableRow = index + 1;
          const resultId = cellText(valueAt(row, "result id")).replace(/^`+|`+$/g, "");
          const significance = cellText(valueAt(row, "why it matters"));
          const context = { project, path, row: tableRow };
          if (!resultId) {
            diagnostics.push(diagnostic(
              "missing-key-result-id",
              "error",
              "A key-results row has no Result ID.",
              context,
            ));
            continue;
          }
          if (seen.has(resultId)) {
            diagnostics.push(diagnostic(
              "duplicate-key-result",
              "error",
              `Key result ${resultId} is declared more than once.`,
              context,
            ));
            continue;
          }
          seen.add(resultId);
          if (!significance) {
            diagnostics.push(diagnostic(
              "blank-key-result-significance",
              "warning",
              `Key result ${resultId} needs a concise “Why it matters” explanation.`,
              context,
            ));
          }
          const readingCell = readingColumn ? valueAt(row, readingColumn) : undefined;
          const readingCellText = cellText(readingCell);
          const readingDocument = documentLink(readingCell);
          if (readingCellText && !readingDocument) {
            diagnostics.push(diagnostic(
              "invalid-key-result-document",
              "error",
              `Key result ${resultId} must use an internal wiki link in the “${readingColumn}” column.`,
              context,
            ));
          }
          keyResults.push({
            resultId,
            significance,
            readingDocumentId: readingDocument?.id,
            readingDocumentLabel: readingDocument?.label,
            project,
            overviewDocumentId: meta.id ?? "",
            overviewPath: path,
            row: tableRow,
            order: index - 1,
          });
        }
      }
    }
  }

  const readingPath: ProjectReadingPathEntry[] = [];
  const readingPathHeadings = findHeadings(doc, "reading-path");
  if (readingPathHeadings.length > 1) {
    diagnostics.push(diagnostic(
      "reading-path-section",
      "error",
      "A project overview may declare only one reading-path section.",
      { project, path },
    ));
  }
  if (readingPathHeadings.length) {
    const tables = tablesInSection(doc, readingPathHeadings[0]);
    if (!tables.length) {
      diagnostics.push(diagnostic(
        "reading-path-table",
        "error",
        "The reading-path heading must be followed by a Markdown table.",
        { project, path },
      ));
    } else {
      let order = 0;
      const seen = new Set<string>();
      for (const table of tables) {
        const columns = new Map<string, number>();
        const header = table.child(0);
        for (let index = 0; index < header.childCount; index++) {
          columns.set(normaliseHeader(cellText(header.child(index))), index);
        }
        if (!columns.has("area") && columns.has("role")) {
          columns.set("area", columns.get("role")!);
        }
        for (const column of ["area", "document", "purpose"] as const) {
          if (!columns.has(column)) {
            diagnostics.push(diagnostic(
              "reading-path-column",
              "error",
              `The reading-path table is missing the “${column}” column.`,
              { project, path },
            ));
          }
        }
        if (["area", "document", "purpose"].every((column) => columns.has(column))) {
          const valueAt = (row: PMNode, column: string): PMNode | undefined => {
            const index = columns.get(column);
            return index === undefined || index >= row.childCount ? undefined : row.child(index);
          };
          for (let index = 1; index < table.childCount; index++) {
            const row = table.child(index);
            const tableRow = index + 1;
            const area = cellText(valueAt(row, "area"));
            const section = columns.has("section") ? cellText(valueAt(row, "section")) : "";
            const purpose = cellText(valueAt(row, "purpose"));
            const documentCell = valueAt(row, "document");
            const documentCellText = cellText(documentCell);
            const linkedDocument = documentLink(documentCell);
            const context = { project, path, row: tableRow };

            if (!area) {
              diagnostics.push(diagnostic(
                "missing-reading-path-area",
                "error",
                "A reading-path row has no Area.",
                context,
              ));
            }
            if (!linkedDocument) {
              diagnostics.push(diagnostic(
                "invalid-reading-path-document",
                "error",
                documentCellText
                  ? "A reading-path Document must be an internal wiki link."
                  : "A reading-path row has no Document.",
                context,
              ));
            } else if (linkedDocument.id === meta.id) {
              diagnostics.push(diagnostic(
                "self-reading-path-document",
                "error",
                "The project overview is automatically first in Start here and must not link to itself.",
                context,
              ));
            } else if (seen.has(linkedDocument.id)) {
              diagnostics.push(diagnostic(
                "duplicate-reading-path-document",
                "error",
                `Document “${linkedDocument.id}” appears more than once in the reading path.`,
                context,
              ));
            }
            if (!purpose) {
              diagnostics.push(diagnostic(
                "blank-reading-path-purpose",
                "warning",
                `${linkedDocument ? `Document “${linkedDocument.id}”` : "A reading-path row"} needs a concise Purpose.`,
                context,
              ));
            }
            if (!area || !linkedDocument || linkedDocument.id === meta.id || seen.has(linkedDocument.id)) {
              continue;
            }
            seen.add(linkedDocument.id);
            readingPath.push({
              area,
              section,
              documentId: linkedDocument.id,
              documentLabel: linkedDocument.label,
              purpose,
              project,
              overviewDocumentId: meta.id ?? "",
              overviewPath: path,
              row: tableRow,
              order: order++,
            });
          }
        }
      }
    }
  }

  const tasks: ProjectTask[] = [];
  const prioritiesHeading = findHeading(doc, "project-priorities");
  const taskAuthority = meta.task_authority;
  if (taskAuthority && prioritiesHeading >= 0 && firstTableAfter(doc, prioritiesHeading)) {
    diagnostics.push(diagnostic(
      "external-task-table",
      "error",
      `Remove the local project-priorities table; tasks are managed in ${taskAuthority.system}.`,
      { project, path },
    ));
  } else if (taskAuthority) {
    // Task state is intentionally read from the declared external authority.
  } else if (prioritiesHeading < 0) {
    diagnostics.push(diagnostic(
      "priorities-heading",
      "error",
      "Add a heading with the id {#project-priorities} before the task table.",
      { project, path },
    ));
  } else {
    const table = firstTableAfter(doc, prioritiesHeading);
    if (!table || table.childCount < 1) {
      diagnostics.push(diagnostic(
        "priorities-table",
        "error",
        "The project-priorities heading must be followed by a Markdown table.",
        { project, path },
      ));
    } else {
      const columns = new Map<string, number>();
      const header = table.child(0);
      for (let index = 0; index < header.childCount; index++) {
        columns.set(normaliseHeader(cellText(header.child(index))), index);
      }
      for (const column of REQUIRED_COLUMNS) {
        if (!columns.has(column)) {
          diagnostics.push(diagnostic(
            "missing-column",
            "error",
            `The project priorities table is missing the “${column}” column.`,
            { project, path },
          ));
        }
      }

      if (REQUIRED_COLUMNS.every((column) => columns.has(column))) {
        const valueAt = (row: PMNode, column: string): PMNode | undefined => {
          const index = columns.get(column);
          return index === undefined || index >= row.childCount ? undefined : row.child(index);
        };
        for (let index = 1; index < table.childCount; index++) {
          const row = table.child(index);
          const tableRow = index + 1;
          const id = cellText(valueAt(row, "task id")).replace(/^`+|`+$/g, "");
          const title = cellText(valueAt(row, "task"));
          const stateText = cellText(valueAt(row, "state"));
          const state = enumToken(stateText, TASK_STATES);
          const priorityText = cellText(valueAt(row, "priority"));
          const priority = enumToken(priorityText, TASK_PRIORITIES);
          const owner = documentLink(valueAt(row, "owner"));
          const exitCriterion = cellText(valueAt(row, "exit criterion"));
          const base = { project, path, row: tableRow, taskId: id || undefined };
          if (!id) {
            diagnostics.push(diagnostic("missing-task-id", "error", "A task row has no Task ID.", base));
          }
          if (!title) {
            diagnostics.push(diagnostic(
              "missing-task-title",
              "error",
              `${id || "A task row"} has no task title.`,
              base,
            ));
          }
          if (!state) {
            diagnostics.push(diagnostic(
              "invalid-task-state",
              "error",
              `${id || "A task row"} has an unknown state “${stateText || "(empty)"}”.`,
              base,
            ));
          }
          if (!priority) {
            diagnostics.push(diagnostic(
              "invalid-task-priority",
              "error",
              `${id || "A task row"} has an unknown priority “${priorityText || "(empty)"}”.`,
              base,
            ));
          }
          if (!owner) {
            diagnostics.push(diagnostic(
              "missing-task-owner",
              "error",
              `${id || "A task row"} must name its owner with an internal document link.`,
              base,
            ));
          }
          if (!exitCriterion) {
            diagnostics.push(diagnostic(
              "missing-exit-criterion",
              "error",
              `${id || "A task row"} has no exit criterion.`,
              base,
            ));
          }
          if (!id || !title || !state || !priority || !owner || !exitCriterion) continue;
          tasks.push({
            id,
            title,
            state,
            priority,
            ownerId: owner.id,
            ownerLabel: owner.label,
            relatedResultIds: identifierList(cellText(valueAt(row, "related results"))),
            dependsOn: identifierList(cellText(valueAt(row, "depends on"))),
            exitCriterion,
            project,
            overviewDocumentId: meta.id ?? "",
            overviewPath: path,
            row: tableRow,
            order: index - 1,
          });
        }
      }
    }
  }

  const overview = marked && project && meta.id
    ? {
        project,
        documentId: meta.id,
        title: meta.title ?? path.split("/").pop()?.replace(/\.(md|markdown)$/i, "") ?? path,
        path,
        summary,
        keyDocumentIds: [...new Set(meta.related.map((item) => item.id))],
        keyResults,
        readingPath,
        tasks,
        taskAuthority,
        publication: {
          project,
          overviewDocumentId: meta.id,
          overviewPath: path,
          settings: parsed.frontmatter.publication,
        },
      }
    : null;
  return { overview, diagnostics };
}

function taskContext(task: ProjectTask): Partial<ProjectDiagnostic> {
  return { project: task.project, taskId: task.id, path: task.overviewPath, row: task.row };
}

function taskCycleDiagnostics(project: string, tasks: Map<string, ProjectTask>): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [];
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
        const task = tasks.get(id);
        diagnostics.push(diagnostic(
          "task-cycle",
          "error",
          `Task dependency cycle: ${cycle.join(" → ")}.`,
          task ? taskContext(task) : { project, taskId: id },
        ));
      }
      return;
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of tasks.get(id)?.dependsOn ?? []) {
      if (tasks.has(dependency)) visit(dependency);
    }
    stack.pop();
    state.set(id, "visited");
  };
  for (const id of tasks.keys()) visit(id);
  return diagnostics;
}

/** Build a provider-neutral, validated snapshot for all opt-in projects. */
export function buildProjectCatalog(
  parsed: ParsedProjectOverview[],
  dependencyCatalog: DependencyCatalog,
  documents: ProjectDocumentSummary[],
): ProjectCatalogSnapshot {
  const overviews = parsed.flatMap((item) => item.overview ? [item.overview] : []);
  const diagnostics = parsed.flatMap((item) => [...item.diagnostics]);
  const grouped = new Map<string, ProjectOverview[]>();
  for (const overview of overviews) {
    const group = grouped.get(overview.project) ?? [];
    group.push(overview);
    grouped.set(overview.project, group);
  }

  const overviewByProject = new Map<string, ProjectOverview>();
  for (const [project, group] of grouped) {
    if (group.length !== 1) {
      diagnostics.push(diagnostic(
        "duplicate-project-overview",
        "error",
        `Project “${project}” has more than one project overview; none was selected.`,
        { project },
      ));
    } else {
      overviewByProject.set(project, group[0]);
    }
  }

  const documentIds = new Set(documents.map((document) => document.id));
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const tasks: ProjectTask[] = [];
  const tasksByProject = new Map<string, ProjectTask[]>();
  for (const [project, overview] of overviewByProject) {
    if (!dependencyCatalog.manifests.some((manifest) => manifest.project === project)) {
      diagnostics.push(diagnostic(
        "missing-dependency-manifest",
        "warning",
        `Project “${project}” has no dependency manifest.`,
        { project, path: overview.path },
      ));
    }

    for (const keyResult of overview.keyResults) {
      const result = dependencyCatalog.byId.get(keyResult.resultId);
      const context = {
        project,
        path: keyResult.overviewPath,
        row: keyResult.row,
      };
      if (!result) {
        diagnostics.push(diagnostic(
          "missing-key-result",
          "error",
          `Key result ${keyResult.resultId} is not present in the library result catalog.`,
          context,
        ));
        continue;
      }
      if (result.project !== project) {
        diagnostics.push(diagnostic(
          "cross-project-key-result",
          "error",
          `Key result ${keyResult.resultId} belongs to project “${result.project}”, not “${project}”.`,
          context,
        ));
        continue;
      }
      if (keyResult.readingDocumentId && keyResult.readingDocumentId !== result.ownerId) {
        diagnostics.push(diagnostic(
          "key-result-document-mismatch",
          "error",
          `Key result ${keyResult.resultId} links to “${keyResult.readingDocumentId}”, but its canonical owner is “${result.ownerId}”.`,
          context,
        ));
        // Keep the valid result visible, but never expose the conflicting
        // authored target as navigation.
        keyResult.readingDocumentId = undefined;
        keyResult.readingDocumentLabel = undefined;
      }
      keyResult.result = result;
    }

    for (const entry of overview.readingPath) {
      const context = {
        project,
        path: entry.overviewPath,
        row: entry.row,
      };
      const document = documentsById.get(entry.documentId);
      if (!document) {
        diagnostics.push(diagnostic(
          "missing-reading-path-document",
          "error",
          `Reading-path document “${entry.documentId}” is not present in the library.`,
          context,
        ));
        continue;
      }
      if (!document.projects.includes(project)) {
        diagnostics.push(diagnostic(
          "cross-project-reading-path-document",
          "error",
          `Reading-path document “${entry.documentId}” does not belong to project “${project}”.`,
          context,
        ));
        continue;
      }
      if (document.visibility === "support") {
        diagnostics.push(diagnostic(
          "support-reading-path-document",
          "error",
          `Reading-path document “${entry.documentId}” is support-only and cannot belong to the reader route.`,
          context,
        ));
        continue;
      }
      entry.document = document;
    }

    const byId = new Map<string, ProjectTask>();
    for (const task of overview.tasks) {
      if (byId.has(task.id)) {
        diagnostics.push(diagnostic(
          "duplicate-task-id",
          "error",
          `Task ID ${task.id} is declared more than once in project “${project}”.`,
          taskContext(task),
        ));
        continue;
      }
      byId.set(task.id, task);
      tasks.push(task);
      if (!documentIds.has(task.ownerId)) {
        diagnostics.push(diagnostic(
          "missing-owner-document",
          "error",
          `${task.id} refers to missing owner document “${task.ownerId}”.`,
          taskContext(task),
        ));
      }
      for (const resultId of task.relatedResultIds) {
        if (!dependencyCatalog.byId.has(resultId)) {
          diagnostics.push(diagnostic(
            "missing-related-result",
            "error",
            `${task.id} refers to missing result ${resultId}.`,
            taskContext(task),
          ));
        }
      }
    }
    const projectTasks = [...byId.values()];
    tasksByProject.set(project, projectTasks);
    for (const task of projectTasks) {
      for (const dependency of task.dependsOn) {
        if (!byId.has(dependency)) {
          diagnostics.push(diagnostic(
            "missing-task-dependency",
            "error",
            `${task.id} depends on missing task ${dependency} in project “${project}”.`,
            taskContext(task),
          ));
        }
      }
      if (task.state === "in-progress" || task.state === "done") {
        const unfinished = task.dependsOn
          .map((id) => byId.get(id))
          .filter((item): item is ProjectTask => !!item && item.state !== "done");
        if (unfinished.length) {
          diagnostics.push(diagnostic(
            "unfinished-task-prerequisite",
            "warning",
            `${task.id} is ${task.state} but relies on unfinished ${unfinished.map((item) => item.id).join(", ")}.`,
            taskContext(task),
          ));
        }
      }
    }
    diagnostics.push(...taskCycleDiagnostics(project, byId));
  }

  return {
    overviews,
    overviewByProject,
    projects: [...overviewByProject.keys()].sort((a, b) => a.localeCompare(b)),
    tasks,
    tasksByProject,
    documents,
    dependencyCatalog,
    diagnostics,
  };
}

const STATE_ORDER: Record<TaskState, number> = {
  blocked: 0,
  "in-progress": 1,
  next: 2,
  later: 3,
  done: 4,
};
const PRIORITY_ORDER: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

/** Blocked, in-progress, then next; priority and Markdown order break ties. */
export function nextActionsForProject(snapshot: ProjectCatalogSnapshot, project: string): ProjectTask[] {
  return [...(snapshot.tasksByProject.get(project) ?? [])]
    .filter((task) => task.state === "blocked" || task.state === "in-progress" || task.state === "next")
    .sort((a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state]
      || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
      || a.order - b.order,
    );
}

const VALIDATION_ATTENTION_ORDER: Record<ValidationState, number> = {
  disputed: 0,
  unvalidated: 1,
  partial: 2,
  validated: 3,
};

const attentionCache = new WeakMap<
  ProjectCatalogSnapshot,
  Map<string, ProjectResultAttention[]>
>();

/** Project-owned unresolved results ordered by global transitive exposure. */
export function resultsNeedingAttention(
  snapshot: ProjectCatalogSnapshot,
  project: string,
): ProjectResultAttention[] {
  let byProject = attentionCache.get(snapshot);
  if (!byProject) {
    byProject = new Map();
    attentionCache.set(snapshot, byProject);
  }
  const cached = byProject.get(project);
  if (cached) return cached;
  const projected = snapshot.dependencyCatalog.results
    .filter((result) => result.project === project && result.validation !== "validated")
    .map((result) => ({
      result,
      downstreamExposure: downstreamOf(snapshot.dependencyCatalog, result.id).size,
    }))
    .sort((a, b) =>
      b.downstreamExposure - a.downstreamExposure
      || VALIDATION_ATTENTION_ORDER[a.result.validation] - VALIDATION_ATTENTION_ORDER[b.result.validation]
      || a.result.id.localeCompare(b.result.id),
    );
  byProject.set(project, projected);
  return projected;
}

export function projectStatusCounts(
  snapshot: ProjectCatalogSnapshot,
  project: string,
): ProjectStatusCounts {
  const projectResults = snapshot.dependencyCatalog.results.filter((result) => result.project === project);
  const projectTasks = snapshot.tasksByProject.get(project) ?? [];
  const projectDocuments = documentsForProject(snapshot, project);
  const graphDiagnostics = graphDiagnosticsForProject(snapshot.dependencyCatalog, project);
  return {
    results: {
      validated: projectResults.filter((result) => result.validation === "validated").length,
      partial: projectResults.filter((result) => result.validation === "partial").length,
      unvalidated: projectResults.filter((result) => result.validation === "unvalidated").length,
      disputed: projectResults.filter((result) => result.validation === "disputed").length,
    },
    graphErrors: graphDiagnostics.filter((item) => item.severity === "error").length,
    graphWarnings: graphDiagnostics.filter((item) => item.severity === "warning").length,
    activeTasks: projectTasks.filter((task) =>
      task.state === "blocked" || task.state === "in-progress" || task.state === "next"
    ).length,
    blockedTasks: projectTasks.filter((task) => task.state === "blocked").length,
    laterTasks: projectTasks.filter((task) => task.state === "later").length,
    doneTasks: projectTasks.filter((task) => task.state === "done").length,
    documents: projectDocuments.length,
    unresolvedComments: projectDocuments.reduce(
      (total, document) => total + Math.max(0, document.unresolvedCommentCount),
      0,
    ),
  };
}

/** Diagnostics attached to the project, its manifest, or a visible boundary result. */
export function graphDiagnosticsForProject(
  catalog: DependencyCatalog,
  project: string,
  selectableProjects?: Iterable<string>,
): GraphDiagnostic[] {
  const resultIds = new Set(resultsForProject(catalog, project).map((result) => result.id));
  const paths = new Set(
    catalog.manifests
      .filter((manifest) => manifest.project === project)
      .map((manifest) => manifest.path),
  );
  const selectable = selectableProjects ? new Set(selectableProjects) : null;
  return catalog.diagnostics.filter((item) =>
    item.project === project
    || (!!item.resultId && resultIds.has(item.resultId))
    || (!!item.path && paths.has(item.path))
    // A malformed source can have no selectable project at all. Show those
    // diagnostics beside every valid project rather than silently dropping
    // them from the only workspace capable of explaining the problem.
    || (!!selectable && (!item.project || !selectable.has(item.project))),
  );
}

export function documentsForProject(
  snapshot: ProjectCatalogSnapshot,
  project: string,
): ProjectDocumentSummary[] {
  return snapshot.documents.filter((document) =>
    document.visibility !== "support"
    && document.projects.includes(project)
  );
}

export function keyDocumentsForProject(
  snapshot: ProjectCatalogSnapshot,
  project: string,
): ProjectDocumentSummary[] {
  const overview = snapshot.overviewByProject.get(project);
  const ids = [
    ...(overview?.keyDocumentIds ?? []),
    ...(overview?.keyResults.flatMap((item) => item.result ? [item.result.ownerId] : []) ?? []),
  ];
  const byId = new Map(
    snapshot.documents
      .filter((document) => document.visibility !== "support")
      .map((document) => [document.id, document]),
  );
  const seen = new Set<string>();
  return ids.flatMap((id) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const document = byId.get(id);
    return document ? [document] : [];
  });
}

export function keyResultsForProject(
  snapshot: ProjectCatalogSnapshot,
  project: string,
): ProjectKeyResult[] {
  return (snapshot.overviewByProject.get(project)?.keyResults ?? [])
    .filter((item): item is ProjectKeyResult & { result: ResultNode } => !!item.result)
    .sort((a, b) => a.order - b.order);
}

export function openQuestionDocumentsForProject(
  snapshot: ProjectCatalogSnapshot,
  project: string,
): ProjectDocumentSummary[] {
  return documentsForProject(snapshot, project)
    .filter((document) => document.contains.includes("open-questions"));
}

export function commentedDocumentsForProject(
  snapshot: ProjectCatalogSnapshot,
  project: string,
): ProjectDocumentSummary[] {
  return documentsForProject(snapshot, project)
    .filter((document) => document.unresolvedCommentCount > 0);
}

/** Whether overview/manifest projections lag an unsaved editor buffer. */
export function projectProjectionIsDirty(
  snapshot: ProjectCatalogSnapshot,
  project: string,
): boolean {
  const sourceIds = new Set<string>();
  const overview = snapshot.overviewByProject.get(project);
  if (overview) sourceIds.add(overview.documentId);
  for (const manifest of snapshot.dependencyCatalog.manifests) {
    if (manifest.project === project) sourceIds.add(manifest.documentId);
  }
  return snapshot.documents.some((document) => sourceIds.has(document.id) && document.dirty === true);
}
