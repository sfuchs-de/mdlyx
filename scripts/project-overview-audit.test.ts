import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAuditCli } from "./audit-project-overview";
import {
  auditProjectOverviews,
  loadLibraryReviewConfig,
  type AcceptedDiagnostic,
} from "./project-overview-audit";

const PROJECTS = [
  "network-hubs",
  "sample-model",
  "network-resilience",
  "choice-substitution",
  "scenario-allocation",
  "transport-bottlenecks",
  "network-welfare",
  "example-logistics",
] as const;

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function overview(project: string): string {
  return `---
library:
  id: ${project}-overview
  title: ${project} overview
  projects: [${project}]
  contains: [project-overview]
  task_authority:
    mode: external
    system: Task Manager
    url: https://tasks.example.test/${project}
---

# ${project}

Source revision: source-revision-${project}

## Project summary {#project-summary}

Summary for ${project}.
`;
}

function manifest(project: string, emptyDependency: string, conditional: boolean): string {
  const rows = conditional
    ? `| \`R-${project}-BASE\` | Base | [[${project}-overview]] | partial | ${emptyDependency} | checked | open |
| \`R-${project}-RESULT\` | Result | [[${project}-overview]] | validated | \`R-${project}-BASE\` | conditional check | conditional on base |`
    : `| \`R-${project}-RESULT\` | Result | [[${project}-overview]] | validated | ${emptyDependency} | checked | none |`;
  return `---
library:
  id: ${project}-manifest
  title: ${project} manifest
  projects: [${project}]
  contains: [dependency-graph]
---

## Result dependency manifest {#dependency-graph}

| Result ID | Result | Owner | Validation | Depends on | Evidence | Remaining condition |
| --- | --- | --- | --- | --- | --- | --- |
${rows}
`;
}

function acceptedDiagnostic(): AcceptedDiagnostic {
  return {
    code: "validated-on-unresolved",
    project: "sample-model",
    resultId: "R-sample-model-RESULT",
    dependencies: ["R-sample-model-BASE"],
    scope: "conditional-validation",
    reason: "The result is valid conditional on the explicitly unresolved base result.",
    reviewedAt: "2026-07-19",
    reviewExpires: "2027-07-19",
  };
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function reviewYaml(options: {
  wrongDocumentsFor?: string;
  acceptConditional?: boolean;
  contractFailures?: boolean;
  staleAcceptance?: boolean;
} = {}): string {
  const accepted = acceptedDiagnostic();
  if (options.staleAcceptance) accepted.dependencies = ["R-OLD-BASE"];
  const projects = PROJECTS.map((project) => {
    const isConditional = project === "sample-model";
    const resultCounts = isConditional
      ? { validated: 1, partial: 1, unvalidated: 0, disputed: 0 }
      : { validated: 1, partial: 0, unvalidated: 0, disputed: 0 };
    const documents = options.wrongDocumentsFor === project ? 3 : 2;
    const contractFailure = options.contractFailures && project === "network-hubs";
    return `  ${project}:
    status: active
    root: ${contractFailure ? "projects/not-network-hubs" : `projects/${project}`}
    overview_id: ${contractFailure ? "wrong-overview" : `${project}-overview`}
    manifest_id: ${contractFailure ? "wrong-manifest" : `${project}-manifest`}
    task_authority: ${contractFailure ? "local" : "external"}
    source_pins:
      - path: projects/${project}/index.md
        value: source-revision-${project}
    expected:
      documents: ${documents}
      open_questions: 0
      unresolved_comments: 0
      results:
        validated: ${resultCounts.validated}
        partial: ${resultCounts.partial}
        unvalidated: ${resultCounts.unvalidated}
        disputed: ${resultCounts.disputed}
      tasks:
        next: 0
        in-progress: 0
        blocked: 0
        later: 0
        done: 0`;
  }).join("\n");
  const acceptedSection = options.acceptConditional === false ? "[]" : `
  - code: ${accepted.code}
    project: ${accepted.project}
    result_id: ${accepted.resultId}
    dependencies: [${accepted.dependencies.join(", ")}]
    scope: ${accepted.scope}
    reason: ${yamlString(accepted.reason)}
    reviewed_at: ${accepted.reviewedAt}
    review_expires: ${accepted.reviewExpires}`;
  return `schema_version: "1.0"
reviewed_at: 2026-07-19
projects:
${projects}
draft_projects: {}
support_files:
  - path: projects/sample-model/support/README.md
    reason: External tool setup pointer, not a Mathdown document.
accepted_diagnostics: ${acceptedSection}
future_extension:
  deliberately: ignored
`;
}

async function fixture(options: {
  wrongDocumentsFor?: string;
  acceptConditional?: boolean;
  addLibraryDiagnostic?: boolean;
  contractFailures?: boolean;
  addUnregisteredProject?: boolean;
  staleAcceptance?: boolean;
} = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathdown-overview-audit-"));
  temporaryRoots.push(root);
  const emptyTokens = ["", "-", "—", "none", "n/a", "–", "`—`", "`-`"];
  await Promise.all(PROJECTS.map(async (project, index) => {
    const directory = path.join(root, "projects", project);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(path.join(directory, "index.md"), overview(project), "utf8"),
      writeFile(
        path.join(directory, "manifest.md"),
        manifest(project, emptyTokens[index], project === "sample-model"),
        "utf8",
      ),
    ]);
  }));
  const supportDirectory = path.join(root, "projects", "sample-model", "support");
  await mkdir(supportDirectory, { recursive: true });
  // Deliberately project-tagged: the review allowlist must exclude this support
  // pointer before metadata and unregistered-project diagnostics are built.
  await writeFile(path.join(supportDirectory, "README.md"), `---
library: {id: support-pointer, projects: [support-only]}
---

External setup pointer.
`, "utf8");
  await writeFile(path.join(root, "library-review.yaml"), reviewYaml(options), "utf8");
  if (options.addLibraryDiagnostic) {
    const directory = path.join(root, "testing");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "bad-manifest.md"), `---
library: {id: bad, projects: [], contains: [dependency-graph]}
---

No graph heading.
`, "utf8");
  }
  if (options.addUnregisteredProject) {
    const directory = path.join(root, "loose");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "loose.md"), `---
library: {id: loose, projects: [loose-project]}
---

Loose project document.
`, "utf8");
  }
  return root;
}

async function v2Fixture(): Promise<string> {
  const root = await fixture();
  const conditional = acceptedDiagnostic();
  const lockProjects: Record<string, unknown> = {};
  await Promise.all(PROJECTS.map(async (project) => {
    const directory = path.join(root, "projects", project);
    await writeFile(path.join(directory, "project.yaml"), `schema_version: "2.0"
project:
  key: ${project}
  title: ${project}
  lifecycle: active
paths:
  overview: index.md
  projection: manifest.md
  exceptions: review-exceptions.yaml
authority:
  tasks: external
`, "utf8");
    const exceptions = project === "sample-model" ? `
  - code: ${conditional.code}
    result_id: ${conditional.resultId}
    dependencies: [${conditional.dependencies.join(", ")}]
    scope: ${conditional.scope}
    reason: ${yamlString(conditional.reason)}
    reviewed_at: ${conditional.reviewedAt}
    review_expires: ${conditional.reviewExpires}` : " []";
    await writeFile(path.join(directory, "review-exceptions.yaml"), `schema_version: "2.0"
project_key: ${project}
exceptions:${exceptions}
`, "utf8");
    const isConditional = project === "sample-model";
    lockProjects[project] = {
      document_count: 2,
      open_question_count: 0,
      unresolved_comment_count: 0,
      task_counts: { next: 0, "in-progress": 0, blocked: 0, later: 0, done: 0 },
      result_count: isConditional ? 2 : 1,
      validation_counts: isConditional
        ? { validated: 1, partial: 1, unvalidated: 0, disputed: 0 }
        : { validated: 1, partial: 0, unvalidated: 0, disputed: 0 },
    };
  }));
  await writeFile(path.join(root, "library-review.yaml"), `schema_version: "2.0"
reviewed_at: 2026-07-19
active_projects:
${PROJECTS.map((project) => `  - ${project}`).join("\n")}
draft_projects: []
shared_collections: []
support_files:
  - path: projects/sample-model/support/README.md
    reason: External tool setup pointer, not a Mathdown document.
internal_fixtures: []
privacy:
  repository: private
`, "utf8");
  await writeFile(path.join(root, "library-review.lock.json"), `${JSON.stringify({
    schema_version: "2.0",
    document_count: PROJECTS.length * 2,
    formal_result_count: PROJECTS.length + 1,
    projects: lockProjects,
  }, null, 2)}\n`, "utf8");
  return root;
}

describe("library review configuration", () => {
  it("loads the versioned schema and tolerates additive fields", async () => {
    const root = await fixture();
    const review = await loadLibraryReviewConfig(root);
    expect(review.schemaVersion).toBe("1.0");
    expect(review.projects.size).toBe(8);
    expect(review.projects.get("sample-model")?.expected.results).toEqual({
      validated: 1,
      partial: 1,
      unvalidated: 0,
      disputed: 0,
    });
    expect(review.projects.get("sample-model")?.sourcePins).toEqual([{
      path: "projects/sample-model/index.md",
      value: "source-revision-sample-model",
    }]);
    expect(review.supportFiles).toEqual([{
      path: "projects/sample-model/support/README.md",
      reason: "External tool setup pointer, not a Mathdown document.",
    }]);
  });

  it("discovers v2 project contracts and reads exact counts from the deterministic lock", async () => {
    const root = await v2Fixture();
    const review = await loadLibraryReviewConfig(root);
    expect(review.schemaVersion).toBe("2.0");
    expect(review.projects.size).toBe(8);
    expect(review.expectedDocumentCount).toBe(16);
    expect(review.projects.get("sample-model")?.expected.results).toEqual({
      validated: 1,
      partial: 1,
      unvalidated: 0,
      disputed: 0,
    });
    expect(review.acceptedDiagnostics).toEqual([
      expect.objectContaining({ resultId: "R-sample-model-RESULT" }),
    ]);
  });

  it("normalizes paths before rejecting root escapes and rejects impossible dates", async () => {
    const root = await fixture();
    const configPath = path.join(root, "library-review.yaml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      original.replace("root: projects/network-hubs", "root: safe/../../outside"),
      "utf8",
    );
    await expect(loadLibraryReviewConfig(root)).rejects.toThrow("stay within the library root");
    await writeFile(
      configPath,
      original.replace("reviewed_at: 2026-07-19", "reviewed_at: 2026-02-31"),
      "utf8",
    );
    await expect(loadLibraryReviewConfig(root)).rejects.toThrow("real ISO calendar date");
  });
});

describe("project overview audit", () => {
  it("audits v2 projections against the lock and rejects global baseline drift", async () => {
    const root = await v2Fixture();
    const clean = await auditProjectOverviews(root, {
      now: new Date("2026-07-19T12:00:00Z"),
    });
    expect(clean.summary).toEqual({
      errors: 0,
      warnings: 1,
      acceptedWarnings: 1,
      countMismatches: 0,
      strictPassed: true,
    });

    const lockPath = path.join(root, "library-review.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.document_count += 1;
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    const drifted = await auditProjectOverviews(root, {
      now: new Date("2026-07-19T12:00:00Z"),
    });
    expect(drifted.libraryDiagnostics).toContainEqual(expect.objectContaining({
      code: "library-document-count-mismatch",
      severity: "error",
    }));
    expect(drifted.summary.strictPassed).toBe(false);
  });

  it("accepts all eight app contracts, exact counts, owner navigation, and reviewed warnings", async () => {
    const root = await fixture();
    const report = await auditProjectOverviews(root, {
      now: new Date("2026-07-19T12:00:00Z"),
    });
    expect(Object.keys(report.projects)).toEqual([...PROJECTS].sort());
    expect(report.summary).toEqual({
      errors: 0,
      warnings: 1,
      acceptedWarnings: 1,
      countMismatches: 0,
      strictPassed: true,
    });
    expect(report.libraryDiagnostics).toEqual([]);
    for (const project of PROJECTS) {
      expect(report.projects[project].counts.documents).toBe(2);
      expect(report.projects[project].countMismatches).toEqual([]);
      expect(report.projects[project].diagnostics.some((item) =>
        item.code === "missing-owner-document" || item.code === "missing-dependency"
      )).toBe(false);
    }
    expect(report.projects["sample-model"].diagnostics).toEqual([
      expect.objectContaining({
        scope: "project",
        code: "validated-on-unresolved",
        resultId: "R-sample-model-RESULT",
        dependencies: ["R-sample-model-BASE"],
        acceptance: expect.objectContaining({ scope: "conditional-validation" }),
      }),
    ]);
  });

  it("keeps library-wide diagnostics separate from project diagnostics", async () => {
    const root = await fixture({ addLibraryDiagnostic: true });
    const report = await auditProjectOverviews(root, {
      now: new Date("2026-07-19T12:00:00Z"),
    });
    expect(report.libraryDiagnostics.map((item) => item.code)).toEqual([
      "manifest-project",
      "manifest-heading",
    ]);
    expect(Object.values(report.projects).flatMap((item) => item.diagnostics)).not.toContainEqual(
      expect.objectContaining({ code: "manifest-project" }),
    );
  });

  it("checks canonical source IDs, project roots, task authority, and unregistered projects", async () => {
    const root = await fixture({ contractFailures: true, addUnregisteredProject: true });
    const report = await auditProjectOverviews(root, {
      now: new Date("2026-07-19T12:00:00Z"),
    });
    expect(report.projects["network-hubs"].diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "overview-id-mismatch",
        "manifest-id-mismatch",
        "task-authority-mismatch",
        "project-root-mismatch",
      ]),
    );
    expect(report.libraryDiagnostics).toContainEqual(expect.objectContaining({
      code: "unregistered-project",
      path: "loose/loose.md",
      scope: "library",
    }));
    expect(report.summary.strictPassed).toBe(false);
  });

  it("expires warning acknowledgements instead of silently suppressing them", async () => {
    const root = await fixture();
    const report = await auditProjectOverviews(root, {
      now: new Date("2028-01-01T12:00:00Z"),
    });
    expect(report.projects["sample-model"].diagnostics).toContainEqual(
      expect.objectContaining({ code: "expired-accepted-diagnostic", severity: "error" }),
    );
    const warning = report.projects["sample-model"].diagnostics.find(
      (item) => item.code === "validated-on-unresolved",
    );
    expect(warning).not.toHaveProperty("acceptance");
    expect(report.summary.strictPassed).toBe(false);
  });

  it("rejects stale acknowledgements when the unresolved dependency set changes", async () => {
    const root = await fixture({ staleAcceptance: true });
    const report = await auditProjectOverviews(root, {
      now: new Date("2026-07-19T12:00:00Z"),
    });
    expect(report.projects["sample-model"].diagnostics).toContainEqual(
      expect.objectContaining({ code: "stale-accepted-diagnostic", severity: "error" }),
    );
    expect(report.summary.strictPassed).toBe(false);
  });

  it("fails strict mode for count drift and unaccepted warnings while non-strict remains inspectable", async () => {
    const root = await fixture({
      wrongDocumentsFor: "example-logistics",
      acceptConditional: false,
    });
    const strict = await auditProjectOverviews(root, {
      now: new Date("2026-07-19T12:00:00Z"),
    });
    expect(strict.summary.strictPassed).toBe(false);
    expect(strict.summary.countMismatches).toBe(1);
    expect(strict.projects["example-logistics"].diagnostics).toContainEqual(
      expect.objectContaining({ code: "acceptance-count-mismatch", severity: "error" }),
    );
    const unaccepted = strict.projects["sample-model"].diagnostics.find(
      (item) => item.code === "validated-on-unresolved",
    );
    expect(unaccepted).toBeDefined();
    expect(unaccepted).not.toHaveProperty("acceptance");

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runAuditCli(["node", "audit", root])).resolves.toBe(0);
    await expect(runAuditCli(["node", "audit", root, "--strict"])).resolves.toBe(1);
    await expect(runAuditCli(["node", "audit", root, "--strcit"])).resolves.toBe(1);
  });

  it("rejects unindexed Markdown and duplicate stable document IDs", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "UNINDEXED.md"), "# Unindexed\n", "utf8");
    await writeFile(path.join(root, "DUPLICATE.md"), `---
library: {"id":"network-hubs-overview","projects":[],"contains":[]}
---

# Duplicate
`, "utf8");
    const report = await auditProjectOverviews(root, {
      now: new Date("2026-07-19T12:00:00Z"),
    });
    expect(report.libraryDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unindexed-markdown", path: "UNINDEXED.md" }),
      expect.objectContaining({ code: "duplicate-document-id" }),
    ]));
    expect(report.summary.strictPassed).toBe(false);
  });

  it("ignores installed dependency documentation", async () => {
    const root = await fixture();
    const dependency = path.join(root, "node_modules", "package");
    await mkdir(dependency, { recursive: true });
    await writeFile(path.join(dependency, "README.md"), "# Package documentation\n", "utf8");
    const report = await auditProjectOverviews(root, {
      now: new Date("2026-07-19T12:00:00Z"),
    });
    expect(report.libraryDiagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unindexed-markdown", path: "node_modules/package/README.md" }),
    ]));
    expect(report.summary.strictPassed).toBe(true);
  });

  it("scopes missing metadata to its project while keeping strict status global", async () => {
    const root = await fixture({ wrongDocumentsFor: "example-logistics" });
    await writeFile(
      path.join(root, "projects", "network-hubs", "UNINDEXED.md"),
      "# Unindexed project note\n",
      "utf8",
    );
    const report = await auditProjectOverviews(root, {
      project: "network-hubs",
      now: new Date("2026-07-19T12:00:00Z"),
    });
    expect(Object.keys(report.projects)).toEqual(["network-hubs"]);
    expect(report.projects["network-hubs"].diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unindexed-markdown",
        scope: "project",
        project: "network-hubs",
      }),
    );
    expect(report.summary.countMismatches).toBeGreaterThan(0);
    expect(report.summary.strictPassed).toBe(false);
  });

  it("checks source pins and future review claims", async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, "projects", "network-hubs", "index.md"),
      overview("network-hubs").replace("source-revision-network-hubs", "changed-revision"),
      "utf8",
    );
    const configPath = path.join(root, "library-review.yaml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config
        .replace("reviewed_at: 2026-07-19", "reviewed_at: 2027-01-01")
        .replace("reviewed_at: 2026-07-19\n    review_expires: 2027-07-19", "reviewed_at: 2027-01-01\n    review_expires: 2027-07-19"),
      "utf8",
    );
    const report = await auditProjectOverviews(root, {
      now: new Date("2026-07-19T12:00:00Z"),
    });
    expect(report.libraryDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "future-baseline-review" }),
      expect.objectContaining({ code: "future-accepted-diagnostic" }),
    ]));
    expect(report.projects["network-hubs"].diagnostics).toContainEqual(
      expect.objectContaining({ code: "source-pin-drift" }),
    );
  });

  it("rejects source pins that resolve through a symlink outside the library", async () => {
    const root = await fixture();
    const external = await mkdtemp(path.join(os.tmpdir(), "mathdown-pin-outside-"));
    temporaryRoots.push(external);
    const externalFile = path.join(external, "revision.txt");
    await writeFile(externalFile, "source-revision-network-hubs\n", "utf8");
    const linked = path.join(root, "projects", "network-hubs", "revision-link.txt");
    await symlink(externalFile, linked);
    const configPath = path.join(root, "library-review.yaml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "path: projects/network-hubs/index.md\n        value: source-revision-network-hubs",
        "path: projects/network-hubs/revision-link.txt\n        value: source-revision-network-hubs",
      ),
      "utf8",
    );
    const report = await auditProjectOverviews(root, {
      now: new Date("2026-07-19T12:00:00Z"),
    });
    expect(report.projects["network-hubs"].diagnostics).toContainEqual(
      expect.objectContaining({ code: "source-pin-missing" }),
    );
    expect(report.summary.strictPassed).toBe(false);
  });

  it("rejects accepted diagnostics with unregistered project references", async () => {
    const root = await fixture();
    const configPath = path.join(root, "library-review.yaml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace("project: sample-model\n    result_id:", "project: misspelled-project\n    result_id:"),
      "utf8",
    );
    const report = await auditProjectOverviews(root, {
      project: "network-hubs",
      now: new Date("2026-07-19T12:00:00Z"),
    });
    expect(report.libraryDiagnostics).toContainEqual(
      expect.objectContaining({ code: "accepted-diagnostic-project" }),
    );
    expect(report.summary.strictPassed).toBe(false);
  });

  it("writes both JSON and human-readable Markdown audit artifacts", async () => {
    const root = await fixture();
    const jsonOut = path.join(root, "reports", "audit.json");
    const markdownOut = path.join(root, "reports", "audit.md");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(runAuditCli([
      "node",
      "audit",
      root,
      "--strict",
      "--json-out",
      jsonOut,
      "--markdown-out",
      markdownOut,
    ])).resolves.toBe(0);
    expect(JSON.parse(await readFile(jsonOut, "utf8")).summary.strictPassed).toBe(true);
    expect(await readFile(markdownOut, "utf8")).toContain("# MdLyx project-workspace audit");
  });
});
