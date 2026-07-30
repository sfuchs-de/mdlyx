import { describe, expect, it } from "vitest";
import {
  buildDependencyCatalog,
  parseDependencyManifest,
  type DependencyCatalog,
} from "./dependency-graph";
import {
  buildProjectCatalog,
  commentedDocumentsForProject,
  graphDiagnosticsForProject,
  keyDocumentsForProject,
  nextActionsForProject,
  openQuestionDocumentsForProject,
  parseProjectOverview,
  projectProjectionIsDirty,
  projectStatusCounts,
  resultsNeedingAttention,
  type ProjectDocumentSummary,
} from "./project-overview";

const TASK_HEADER = "| Task ID | Task | State | Priority | Owner | Related results | Depends on | Exit criterion |";
const TASK_DIVIDER = "| --- | --- | --- | --- | --- | --- | --- | --- |";

function overview(
  project: string,
  documentId: string,
  rows: string,
  options: {
    summary?: string;
    contains?: string[];
    related?: Array<{ id: string; rel: string }>;
    taskAuthority?: { mode: "external"; system: string; url: string };
    omitTaskTable?: boolean;
    keyResults?: string;
    readingPath?: string;
    extraHeader?: string;
    extraDivider?: string;
  } = {},
): string {
  const meta = {
    id: documentId,
    title: `${project} overview`,
    kind: "notes",
    projects: [project],
    contains: options.contains ?? ["project-overview"],
    related: options.related ?? [],
    ...(options.taskAuthority ? { task_authority: options.taskAuthority } : {}),
  };
  const summary = options.summary === undefined ? "A concise project summary." : options.summary;
  return `---
library: ${JSON.stringify(meta)}
---

# ${project}

## Project summary {#project-summary}

${summary}

${options.keyResults === undefined ? "" : `## Key results {#key-results}

| Result ID | Why it matters | Notes |
| --- | --- | --- |
${options.keyResults}
`}

${options.readingPath === undefined ? "" : `## Reading path {#reading-path}

| Area | Section | Document | Purpose | Notes |
| --- | --- | --- | --- | --- |
${options.readingPath}
`}

${options.omitTaskTable ? "" : `## Project priorities {#project-priorities}

${TASK_HEADER.slice(0, -1)}${options.extraHeader ?? ""}|
${TASK_DIVIDER.slice(0, -1)}${options.extraDivider ?? ""}|
${rows}`}
`;
}

function graphManifest(project: string, id: string, rows: string): string {
  return `---
library: {"id":"${id}","title":"${project} claims","projects":["${project}"],"contains":["dependency-graph"]}
---

## Results {#dependency-graph}

| Result ID | Result | Owner | Validation | Depends on | Evidence | Remaining condition |
| --- | --- | --- | --- | --- | --- | --- |
${rows}
`;
}

function documents(...items: Array<Partial<ProjectDocumentSummary> & { id: string }>): ProjectDocumentSummary[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title ?? item.id,
    path: item.path ?? `${item.id}.md`,
    projects: item.projects ?? ["p"],
    contains: item.contains ?? [],
    visibility: item.visibility ?? "reader",
    unresolvedCommentCount: item.unresolvedCommentCount ?? 0,
    dirty: item.dirty,
  }));
}

function dependencyCatalog(
  manifests: Array<{ project: string; id: string; rows: string }>,
  docs: ProjectDocumentSummary[],
): DependencyCatalog {
  return buildDependencyCatalog(
    manifests.map((item) => parseDependencyManifest(
      graphManifest(item.project, item.id, item.rows),
      `${item.project}-claims.md`,
    )),
    docs.map((item) => ({ id: item.id, title: item.title })),
  );
}

describe("project overview Markdown", () => {
  it("parses the summary and normalized task rows while ignoring extra columns", () => {
    const source = overview(
      "example-logistics",
      "example-logistics-index",
      "| `T-A` | Validate attack access | IN PROGRESS | HIGH | [[attack\\|Attack supply]] | `R-A`, `R-B`; `R-A` | — | Timing A \\| B is verified | primary |\n" +
        "| `T-B` | Close defense | next | Medium | [[defense]] | `R-C` | `T-A`; `T-A` | Derivative complete | secondary |",
      {
        summary: "The project links **routing** to the Atlantic Clock.",
        extraHeader: "| Evidence class ",
        extraDivider: "| --- ",
      },
    );
    const parsed = parseProjectOverview(source, "projects/example-logistics/index.md");

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.overview).toMatchObject({
      project: "example-logistics",
      documentId: "example-logistics-index",
      summary: "The project links routing to the Atlantic Clock.",
    });
    expect(parsed.overview?.tasks).toEqual([
      expect.objectContaining({
        id: "T-A",
        state: "in-progress",
        priority: "high",
        ownerId: "attack",
        ownerLabel: "Attack supply",
        relatedResultIds: ["R-A", "R-B"],
        dependsOn: [],
        exitCriterion: "Timing A | B is verified",
        order: 0,
      }),
      expect.objectContaining({
        id: "T-B",
        priority: "medium",
        ownerId: "defense",
        ownerLabel: "defense",
        dependsOn: ["T-A"],
        order: 1,
      }),
    ]);
  });

  it("warns for a missing summary but retains the overview and tasks", () => {
    const source = overview(
      "p",
      "index",
      "| `T-A` | Task A | next | low | [[doc-a]] |  |  | Done when checked |",
      { summary: "" },
    );
    const parsed = parseProjectOverview(source, "index.md");
    expect(parsed.overview?.tasks).toHaveLength(1);
    expect(parsed.diagnostics.map((item) => item.code)).toEqual(["summary-paragraph"]);
    expect(parsed.diagnostics[0].severity).toBe("warning");
  });

  it("keeps valid rows when neighboring rows are malformed", () => {
    const source = overview(
      "p",
      "index",
      "| `T-GOOD` | Good task | BLOCKED | low | [[doc-a]] |  |  | A check passes |\n" +
        "| `T-BAD` |  | someday | urgent | plain text |  |  |  |",
    );
    const parsed = parseProjectOverview(source, "index.md");
    expect(parsed.overview?.tasks.map((task) => task.id)).toEqual(["T-GOOD"]);
    expect(parsed.diagnostics.map((item) => item.code)).toEqual([
      "missing-task-title",
      "invalid-task-state",
      "invalid-task-priority",
      "missing-task-owner",
      "missing-exit-criterion",
    ]);
  });

  it("requires the marker, one project, stable id, headings, table, and every required column", () => {
    const malformed = `---
library: {"projects":["p","q"],"contains":[]}
---

# No contract
`;
    const parsed = parseProjectOverview(malformed, "bad.md");
    expect(parsed.overview).toBeNull();
    expect(parsed.diagnostics.map((item) => item.code)).toEqual([
      "overview-marker",
      "overview-project",
      "overview-document-id",
      "summary-heading",
      "priorities-heading",
    ]);

    const missingColumn = overview("p", "index", "").replace("| Exit criterion ", "");
    const columnResult = parseProjectOverview(missingColumn, "index.md");
    expect(columnResult.overview?.tasks).toEqual([]);
    expect(columnResult.diagnostics.some((item) => item.code === "missing-column")).toBe(true);
  });

  it("preserves curated key-document order from overview relations", () => {
    const parsed = parseProjectOverview(overview(
      "p",
      "index",
      "| `T-A` | A | next | high | [[doc-a]] |  |  | Complete A |",
      { related: [{ id: "doc-b", rel: "see-also" }, { id: "doc-a", rel: "derived-from" }] },
    ), "index.md");
    expect(parsed.overview?.keyDocumentIds).toEqual(["doc-b", "doc-a"]);
  });

  it("parses an ordered authored reading path and ignores extra columns", () => {
    const parsed = parseProjectOverview(overview("p", "index", "", {
      readingPath:
        "| Start here | Synthesis | [[synthesis\\|Full synthesis]] | Unified statement. | primary |\n" +
        "| Core model | Equilibrium | [[equilibrium]] | Establishes equilibrium. | core |",
    }), "index.md");

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.overview?.readingPath).toEqual([
      expect.objectContaining({
        area: "Start here",
        section: "Synthesis",
        documentId: "synthesis",
        documentLabel: "Full synthesis",
        purpose: "Unified statement.",
        order: 0,
      }),
      expect.objectContaining({
        area: "Core model",
        section: "Equilibrium",
        documentId: "equilibrium",
        documentLabel: "equilibrium",
        purpose: "Establishes equilibrium.",
        order: 1,
      }),
    ]);
  });

  it("parses a generated multi-section reading path and headline cards", () => {
    const source = overview("p", "index", "", {
      omitTaskTable: true,
      taskAuthority: {
        mode: "external",
        system: "Task Manager",
        url: "https://example.test/projects/p",
      },
    }) + `
## Reading path {#reading-path}

### Core derivation

| Area | Section | Document | Purpose |
| --- | --- | --- | --- |
| Core | Foundations | [[owner-a\\|Owner A]] | Establishes A. |

### Companion

| Role | Section | Document | Purpose |
| --- | --- | --- | --- |
| Companion | Extension | [[owner-b\\|Owner B]] | Extends A. |

## Main results {#key-results}

<!-- mathdown:overview-headlines-v2:start -->

### Result A (\`R-A\`)

- **Why it matters:** Establishes the governing result.

### Result B (\`R-B\`)

- **Why it matters:** Exposes the companion result.

<!-- mathdown:overview-headlines-v2:end -->
`;
    const parsed = parseProjectOverview(source, "index.md");

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.overview?.readingPath).toEqual([
      expect.objectContaining({ area: "Core", documentId: "owner-a", order: 0 }),
      expect.objectContaining({ area: "Companion", documentId: "owner-b", order: 1 }),
    ]);
    expect(parsed.overview?.keyResults).toEqual([
      expect.objectContaining({
        resultId: "R-A",
        significance: "Establishes the governing result.",
        order: 0,
      }),
      expect.objectContaining({
        resultId: "R-B",
        significance: "Exposes the companion result.",
        order: 1,
      }),
    ]);
  });

  it("keeps valid reading-path rows while diagnosing malformed, duplicate, and self links", () => {
    const parsed = parseProjectOverview(overview("p", "index", "", {
      readingPath:
        "| Core model | Demand | plain text | No link. | bad |\n" +
        "| Core model | Demand | [[demand]] | Valid demand. | good |\n" +
        "| Core model | Demand | [[demand]] | Duplicate. | bad |\n" +
        "| Start here | Overview | [[index]] | Self. | bad |\n" +
        "|  | Supply | [[supply]] |  | bad |",
    }), "index.md");

    expect(parsed.overview?.readingPath.map((entry) => entry.documentId)).toEqual(["demand"]);
    expect(parsed.diagnostics.map((item) => item.code)).toEqual([
      "invalid-reading-path-document",
      "duplicate-reading-path-document",
      "self-reading-path-document",
      "missing-reading-path-area",
      "blank-reading-path-purpose",
    ]);
  });

  it("validates reading-path documents against the project catalog", () => {
    const parsed = parseProjectOverview(overview("p", "index", "", {
      readingPath:
        "| Core model | Demand | [[missing]] | Missing target. | bad |\n" +
        "| Core model | Supply | [[other-project]] | Wrong project. | bad |\n" +
        "| Core model | Equilibrium | [[equilibrium]] | Valid target. | good |",
    }), "index.md");
    const docs = documents(
      { id: "index" },
      { id: "other-project", projects: ["q"] },
      { id: "equilibrium" },
    );
    const catalog = buildProjectCatalog(
      [parsed],
      dependencyCatalog([], docs),
      docs,
    );

    expect(catalog.diagnostics.map((item) => item.code)).toContain("missing-reading-path-document");
    expect(catalog.diagnostics.map((item) => item.code)).toContain("cross-project-reading-path-document");
    expect(catalog.overviewByProject.get("p")?.readingPath.find((entry) =>
      entry.documentId === "equilibrium"
    )?.document?.id).toBe("equilibrium");
  });

  it("rejects support-only documents from an authored reading path", () => {
    const parsed = parseProjectOverview(overview("p", "index", "", {
      readingPath:
        "| Core model | Equilibrium | [[owner]] | Valid owner. | good |\n" +
        "| Archive | History | [[historical]] | Compatibility path. | bad |",
    }), "index.md");
    const docs = documents(
      { id: "index" },
      { id: "owner" },
      { id: "historical", visibility: "support" },
    );
    const catalog = buildProjectCatalog([parsed], dependencyCatalog([], docs), docs);

    expect(catalog.diagnostics).toContainEqual(expect.objectContaining({
      code: "support-reading-path-document",
    }));
    expect(catalog.overviewByProject.get("p")?.readingPath.find((entry) =>
      entry.documentId === "owner"
    )?.document?.id).toBe("owner");
    expect(catalog.overviewByProject.get("p")?.readingPath.find((entry) =>
      entry.documentId === "historical"
    )?.document).toBeUndefined();
  });

  it("parses ordered key results, escaped prose, and extra columns", () => {
    const parsed = parseProjectOverview(overview("p", "index", "", {
      keyResults:
        "| `R-B` | Connects owner B to A \\| C. | secondary |\n" +
        "| `R-A` | Establishes the governing result. | primary |",
    }), "index.md");

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.overview?.keyResults).toEqual([
      expect.objectContaining({
        resultId: "R-B",
        significance: "Connects owner B to A | C.",
        order: 0,
      }),
      expect.objectContaining({
        resultId: "R-A",
        significance: "Establishes the governing result.",
        order: 1,
      }),
    ]);
  });

  it("parses an authored reading link without duplicating result metadata", () => {
    const source = overview("p", "index", "", {
      keyResults: "| `R-A` | Establishes the governing result. | [[doc-a\\|Core derivation]] |",
    }).replace(
      "| Result ID | Why it matters | Notes |",
      "| Result ID | Why it matters | Read |",
    );
    const parsed = parseProjectOverview(source, "index.md");

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.overview?.keyResults).toEqual([
      expect.objectContaining({
        resultId: "R-A",
        significance: "Establishes the governing result.",
        readingDocumentId: "doc-a",
        readingDocumentLabel: "Core derivation",
      }),
    ]);
  });

  it("rejects a non-wiki reading target while retaining the key result", () => {
    const source = overview("p", "index", "", {
      keyResults: "| `R-A` | Establishes the governing result. | doc-a.md |",
    }).replace(
      "| Result ID | Why it matters | Notes |",
      "| Result ID | Why it matters | Derivation |",
    );
    const parsed = parseProjectOverview(source, "index.md");

    expect(parsed.overview?.keyResults).toHaveLength(1);
    expect(parsed.overview?.keyResults[0].readingDocumentId).toBeUndefined();
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({
      code: "invalid-key-result-document",
      severity: "error",
    }));
  });

  it("diagnoses malformed key-result declarations while retaining valid rows", () => {
    const source = overview("p", "index", "", {
      keyResults:
        "| `R-A` | Valid significance. | primary |\n" +
        "| `R-A` | Duplicate. | duplicate |\n" +
        "|  | Missing ID. | invalid |\n" +
        "| `R-B` |  | warning |",
    });
    const parsed = parseProjectOverview(source, "index.md");

    expect(parsed.overview?.keyResults.map((item) => item.resultId)).toEqual(["R-A", "R-B"]);
    expect(parsed.diagnostics.map((item) => item.code)).toEqual([
      "duplicate-key-result",
      "missing-key-result-id",
      "blank-key-result-significance",
    ]);
  });

  it("accepts an external task authority without a local task table", () => {
    const parsed = parseProjectOverview(overview("p", "index", "", {
      omitTaskTable: true,
      taskAuthority: {
        mode: "external",
        system: "Task Manager",
        url: "https://example.test/projects/p",
      },
    }), "index.md");

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.overview?.tasks).toEqual([]);
    expect(parsed.overview?.taskAuthority).toEqual({
      mode: "external",
      system: "Task Manager",
      url: "https://example.test/projects/p",
    });
  });

  it("rejects a local task table when external task authority is declared", () => {
    const parsed = parseProjectOverview(overview(
      "p",
      "index",
      "| `T-A` | A | next | high | [[doc-a]] |  |  | Complete A |",
      {
        taskAuthority: {
          mode: "external",
          system: "Task Manager",
          url: "https://example.test/projects/p",
        },
      },
    ), "index.md");
    expect(parsed.overview?.tasks).toEqual([]);
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ code: "external-task-table" }));
  });
});

describe("project catalog validation", () => {
  it("resolves owners and result IDs library-wide but task dependencies only within a project", () => {
    const docs = documents(
      { id: "p-owner", projects: ["p"] },
      { id: "q-owner", projects: ["q"] },
      { id: "p-index", projects: ["p"] },
      { id: "q-index", projects: ["q"] },
    );
    const deps = dependencyCatalog([
      { project: "p", id: "p-claims", rows: "| `R-P` | P | [[p-owner]] | partial |  | partial | open |" },
      { project: "q", id: "q-claims", rows: "| `R-Q` | Q | [[q-owner]] | validated |  | checked | none |" },
    ], docs);
    const parsed = [
      parseProjectOverview(overview(
        "p",
        "p-index",
        "| `T-SHARED` | P base | done | high | [[p-owner]] | `R-Q` |  | P complete |\n" +
          "| `T-P` | P child | next | high | [[p-owner]] | `R-P` | `T-SHARED` | Child complete |",
      ), "p-index.md"),
      parseProjectOverview(overview(
        "q",
        "q-index",
        "| `T-SHARED` | Q base | done | medium | [[q-owner]] | `R-P` |  | Q complete |\n" +
          "| `T-Q` | Q child | next | low | [[q-owner]] | `R-Q` | `T-SHARED` | Child complete |",
      ), "q-index.md"),
    ];
    const catalog = buildProjectCatalog(parsed, deps, docs);

    expect(catalog.projects).toEqual(["p", "q"]);
    expect(catalog.tasks).toHaveLength(4);
    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.tasksByProject.get("p")?.map((task) => task.id)).toEqual(["T-SHARED", "T-P"]);
    expect(catalog.tasksByProject.get("q")?.map((task) => task.id)).toEqual(["T-SHARED", "T-Q"]);
  });

  it("rejects an authored reading link that disagrees with the canonical result owner", () => {
    const docs = documents(
      { id: "doc-a", projects: ["p"] },
      { id: "doc-b", projects: ["p"] },
      { id: "index", projects: ["p"] },
    );
    const deps = dependencyCatalog([
      { project: "p", id: "claims", rows: "| `R-A` | A | [[doc-a]] | validated |  | checked | none |" },
    ], docs);
    const source = overview("p", "index", "", {
      keyResults: "| `R-A` | Governing result. | [[doc-b\\|Wrong note]] |",
    }).replace(
      "| Result ID | Why it matters | Notes |",
      "| Result ID | Why it matters | Document |",
    );
    const catalog = buildProjectCatalog(
      [parseProjectOverview(source, "index.md")],
      deps,
      docs,
    );

    expect(catalog.diagnostics).toContainEqual(expect.objectContaining({
      code: "key-result-document-mismatch",
      severity: "error",
      project: "p",
    }));
    expect(catalog.overviewByProject.get("p")?.keyResults[0]).toMatchObject({
      result: expect.objectContaining({ id: "R-A", ownerId: "doc-a" }),
      readingDocumentId: undefined,
      readingDocumentLabel: undefined,
    });
  });

  it("does not choose or merge duplicate project overviews", () => {
    const docs = documents({ id: "doc-a" }, { id: "one" }, { id: "two" });
    const deps = dependencyCatalog([
      { project: "p", id: "claims", rows: "| `R-A` | A | [[doc-a]] | validated |  | checked | none |" },
    ], docs);
    const row = "| `T-A` | A | next | high | [[doc-a]] | `R-A` |  | Complete A |";
    const parsed = [
      parseProjectOverview(overview("p", "one", row), "one.md"),
      parseProjectOverview(overview("p", "two", row), "two.md"),
    ];
    const catalog = buildProjectCatalog(parsed, deps, docs);

    expect(catalog.overviews).toHaveLength(2);
    expect(catalog.projects).toEqual([]);
    expect(catalog.overviewByProject.has("p")).toBe(false);
    expect(catalog.tasks).toEqual([]);
    expect(catalog.diagnostics.map((item) => item.code)).toContain("duplicate-project-overview");
  });

  it("retains a missing-id source diagnostic beside a valid overview for the same project", () => {
    const valid = parseProjectOverview(overview("p", "valid", ""), "valid.md");
    const missingId = parseProjectOverview(
      overview("p", "invalid", "").replace('"id":"invalid",', ""),
      "missing-id.md",
    );
    const catalog = buildProjectCatalog(
      [valid, missingId],
      buildDependencyCatalog([], []),
      documents({ id: "valid" }),
    );

    expect(catalog.projects).toEqual(["p"]);
    expect(catalog.overviewByProject.get("p")?.documentId).toBe("valid");
    expect(catalog.diagnostics).toContainEqual(expect.objectContaining({
      code: "overview-document-id",
      project: "p",
      path: "missing-id.md",
    }));
  });

  it("can include malformed dependency diagnostics with no selectable project", () => {
    const valid = parseDependencyManifest(
      graphManifest("p", "claims", "| `R-A` | A | [[doc-a]] | partial |  | pending | open |"),
      "claims.md",
    );
    const malformed = parseDependencyManifest(`---
library: {"id":"orphan-claims","projects":[],"contains":["dependency-graph"]}
---

## Results {#dependency-graph}

| Result ID | Result | Owner | Validation | Depends on | Evidence | Remaining condition |
| --- | --- | --- | --- | --- | --- | --- |
`, "orphan-claims.md");
    const catalog = buildDependencyCatalog([valid, malformed], [{ id: "doc-a", title: "A" }]);

    expect(graphDiagnosticsForProject(catalog, "p")).not.toContainEqual(
      expect.objectContaining({ code: "manifest-project" }),
    );
    expect(graphDiagnosticsForProject(catalog, "p", ["p"])).toContainEqual(
      expect.objectContaining({ code: "manifest-project", path: "orphan-claims.md" }),
    );
  });

  it("reports duplicate tasks, missing references, missing graphs, cycles, and unfinished prerequisites", () => {
    const docs = documents({ id: "index" }, { id: "doc-a" });
    const emptyDeps = buildDependencyCatalog([], docs);
    const parsed = parseProjectOverview(overview(
      "p",
      "index",
      "| `T-A` | A | done | high | [[doc-a]] | `R-MISSING` | `T-B` | A complete |\n" +
        "| `T-B` | B | in-progress | medium | [[missing-owner]] |  | `T-A`, `T-GONE` | B complete |\n" +
        "| `T-A` | Duplicate | next | low | [[doc-a]] |  |  | duplicate complete |",
    ), "index.md");
    const catalog = buildProjectCatalog([parsed], emptyDeps, docs);
    const codes = catalog.diagnostics.map((item) => item.code);

    expect(codes).toContain("missing-dependency-manifest");
    expect(codes).toContain("duplicate-task-id");
    expect(codes).toContain("missing-related-result");
    expect(codes).toContain("missing-owner-document");
    expect(codes).toContain("missing-task-dependency");
    expect(codes).toContain("task-cycle");
    expect(codes.filter((code) => code === "unfinished-task-prerequisite")).toHaveLength(1);
    expect(catalog.tasks.map((task) => task.id)).toEqual(["T-A", "T-B"]);
  });

  it("resolves key results only within their declaring project", () => {
    const docs = documents(
      { id: "index", projects: ["p"] },
      { id: "p-owner", projects: ["p"] },
      { id: "q-owner", projects: ["q"] },
    );
    const deps = dependencyCatalog([
      { project: "p", id: "p-claims", rows: "| `R-P` | P result | [[p-owner]] | validated |  | checked | none |" },
      { project: "q", id: "q-claims", rows: "| `R-Q` | Q result | [[q-owner]] | partial |  | pending | open |" },
    ], docs);
    const parsed = parseProjectOverview(overview("p", "index", "", {
      keyResults:
        "| `R-P` | The local headline. | |\n" +
        "| `R-Q` | A foreign result. | |\n" +
        "| `R-MISSING` | Missing. | |",
    }), "index.md");
    const catalog = buildProjectCatalog([parsed], deps, docs);

    expect(catalog.overviewByProject.get("p")?.keyResults[0].result).toMatchObject({ id: "R-P" });
    expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ code: "cross-project-key-result" }));
    expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ code: "missing-key-result" }));
  });
});

describe("project overview projections", () => {
  function projectionFixture(): {
    snapshot: ReturnType<typeof buildProjectCatalog>;
    docs: ProjectDocumentSummary[];
  } {
    const docs = documents(
      { id: "index", title: "Index", projects: ["p"], dirty: true },
      { id: "claims", title: "Claims", projects: ["p"], contains: ["dependency-graph"] },
      { id: "doc-a", title: "A", projects: ["p"], contains: ["open-questions"], unresolvedCommentCount: 2 },
      { id: "doc-b", title: "B", projects: ["p"], unresolvedCommentCount: 1 },
      { id: "doc-c", title: "C", projects: ["p"] },
      {
        id: "archive",
        title: "Historical audit",
        projects: ["p"],
        contains: ["open-questions"],
        visibility: "support",
        unresolvedCommentCount: 7,
      },
      { id: "foreign", title: "Foreign", projects: ["q"], unresolvedCommentCount: 8 },
    );
    const deps = dependencyCatalog([
      {
        project: "p",
        id: "claims",
        rows: "| `R-A` | A | [[doc-a]] | unvalidated |  | none | open |\n" +
          "| `R-B` | B | [[doc-b]] | partial | `R-A` | partial | open |\n" +
          "| `R-C` | C | [[doc-c]] | disputed | `R-B` | disputed | resolve |\n" +
          "| `R-D` | D | [[doc-c]] | validated |  | checked | none |",
      },
    ], docs);
    const parsed = parseProjectOverview(overview(
      "p",
      "index",
      "| `T-NEXT-LOW` | Next low | next | low | [[doc-a]] | `R-C` |  | low complete |\n" +
        "| `T-RUN` | Running | in-progress | medium | [[doc-b]] | `R-B` |  | run complete |\n" +
        "| `T-BLOCK-LOW` | Blocked low | blocked | low | [[doc-a]] | `R-A` |  | block complete |\n" +
        "| `T-BLOCK-HIGH` | Blocked high | blocked | high | [[doc-a]] |  |  | high complete |\n" +
        "| `T-LATER` | Later | later | high | [[doc-c]] |  |  | later complete |\n" +
        "| `T-DONE` | Done | done | high | [[doc-c]] |  |  | done complete |",
      { related: [{ id: "doc-b", rel: "see-also" }, { id: "doc-a", rel: "see-also" }] },
    ), "index.md");
    return { snapshot: buildProjectCatalog([parsed], deps, docs), docs };
  }

  it("orders next actions by state, priority, and Markdown row", () => {
    const { snapshot } = projectionFixture();
    expect(nextActionsForProject(snapshot, "p").map((task) => task.id)).toEqual([
      "T-BLOCK-HIGH",
      "T-BLOCK-LOW",
      "T-RUN",
      "T-NEXT-LOW",
    ]);
  });

  it("orders unresolved results by global downstream exposure then severity", () => {
    const { snapshot } = projectionFixture();
    expect(resultsNeedingAttention(snapshot, "p").map((item) => [
      item.result.id,
      item.downstreamExposure,
    ])).toEqual([
      ["R-A", 2],
      ["R-B", 1],
      ["R-C", 0],
    ]);
  });

  it("computes exact result, task, document, graph, and comment counts", () => {
    const { snapshot } = projectionFixture();
    expect(projectStatusCounts(snapshot, "p")).toEqual({
      results: { validated: 1, partial: 1, unvalidated: 1, disputed: 1 },
      graphErrors: 0,
      graphWarnings: 0,
      activeTasks: 4,
      blockedTasks: 2,
      laterTasks: 1,
      doneTasks: 1,
      documents: 5,
      unresolvedComments: 3,
    });
  });

  it("projects curated, open-question, commented, and dirty source documents", () => {
    const { snapshot } = projectionFixture();
    expect(keyDocumentsForProject(snapshot, "p").map((document) => document.id)).toEqual(["doc-b", "doc-a"]);
    expect(openQuestionDocumentsForProject(snapshot, "p").map((document) => document.id)).toEqual(["doc-a"]);
    expect(commentedDocumentsForProject(snapshot, "p").map((document) => document.id)).toEqual(["doc-a", "doc-b"]);
    expect(projectProjectionIsDirty(snapshot, "p")).toBe(true);
  });

  it("counts diagnostics on cross-project boundary results visible to the project", () => {
    const docs = documents(
      { id: "p-index", projects: ["p"] },
      { id: "p-owner", projects: ["p"] },
      { id: "q-owner", projects: ["q"] },
    );
    const deps = dependencyCatalog([
      {
        project: "q",
        id: "q-claims",
        rows: "| `R-Q` | Boundary | [[q-owner]] | partial | `R-MISSING` | partial | open |",
      },
      {
        project: "p",
        id: "p-claims",
        rows: "| `R-P` | Project result | [[p-owner]] | partial | `R-Q` | partial | open |",
      },
    ], docs);
    const parsed = parseProjectOverview(overview(
      "p",
      "p-index",
      "| `T-P` | Project task | next | high | [[p-owner]] | `R-P` |  | Complete P |",
    ), "p-index.md");
    const snapshot = buildProjectCatalog([parsed], deps, docs);
    expect(projectStatusCounts(snapshot, "p").graphErrors).toBe(1);
  });

  it("builds and projects a 1,000-document, 500-result, 500-task snapshot within two seconds", () => {
    const docs = Array.from({ length: 1_000 }, (_, index): ProjectDocumentSummary => ({
      id: `doc-${index}`,
      title: `Document ${index}`,
      path: `nested/doc-${index}.md`,
      projects: ["large"],
      contains: index % 25 === 0 ? ["open-questions"] : [],
      unresolvedCommentCount: index % 100 === 0 ? 1 : 0,
    }));
    const rows = Array.from({ length: 500 }, (_, index) =>
      `| \`T-${index}\` | Task ${index} | ${index % 5 === 0 ? "done" : "next"} | medium | [[doc-${index}]] |  | ${index ? `\`T-${index - 1}\`` : ""} | Check ${index} |`
    ).join("\n");
    const resultRows = Array.from({ length: 500 }, (_, index) =>
      `| \`R-${index}\` | Result ${index} | [[doc-${index}]] | partial | ${index ? `\`R-${index - 1}\`` : ""} | Evidence ${index} | Condition ${index} |`
    ).join("\n");
    const started = performance.now();
    const parsed = parseProjectOverview(overview("large", "doc-999", rows), "large/index.md");
    const dependencies = dependencyCatalog([
      { project: "large", id: "large-results", rows: resultRows },
    ], docs);
    const snapshot = buildProjectCatalog([parsed], dependencies, docs);
    const attention = resultsNeedingAttention(snapshot, "large");
    const elapsed = performance.now() - started;

    expect(snapshot.tasks).toHaveLength(500);
    expect(snapshot.dependencyCatalog.results).toHaveLength(500);
    expect(attention).toHaveLength(500);
    expect(attention[0]).toMatchObject({
      result: { id: "R-0" },
      downstreamExposure: 499,
    });
    expect(snapshot.documents).toHaveLength(1_000);
    expect(elapsed).toBeLessThan(2_000);
  });
});
