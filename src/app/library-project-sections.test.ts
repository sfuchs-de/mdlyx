import { describe, expect, it } from "vitest";
import { normalizeMeta } from "../markdown/frontmatter";
import type { ResultNode } from "./dependency-graph";
import type { LibraryFile } from "./library";
import { projectLibraryProjection } from "./library-project-sections";
import type {
  ProjectCatalogSnapshot,
  ProjectDocumentSummary,
  ProjectReadingPathEntry,
} from "./project-overview";

function file(
  id: string,
  contains: string[] = [],
  options: {
    comments?: number;
    kind?: string;
    tags?: string[];
    title?: string;
    visibility?: "reader" | "support";
  } = {},
): LibraryFile {
  return {
    name: `${id}.md`,
    folder: "project",
    handle: null,
    meta: normalizeMeta({
      id,
      title: options.title ?? id,
      kind: options.kind,
      visibility: options.visibility,
      tags: options.tags ?? [],
      projects: ["p"],
      contains,
      related: [],
    }),
    openCommentCount: options.comments ?? 0,
  };
}

function result(
  id: string,
  ownerId: string,
  validation: ResultNode["validation"],
): ResultNode {
  return {
    id,
    title: id,
    ownerId,
    ownerLabel: ownerId,
    validation,
    dependsOn: [],
    evidence: "checked",
    condition: validation === "validated" ? "" : "open",
    project: "p",
    manifestDocumentId: "claims",
    manifestPath: "claims.md",
    row: 1,
  };
}

function snapshot(
  files: LibraryFile[],
  reading: Array<{ area: string; section?: string; id: string; purpose?: string }> = [],
): ProjectCatalogSnapshot {
  const keyResult = result("R-KEY", "demand", "validated");
  const frontier = result("R-FRONTIER", "frontier", "partial");
  const documents: ProjectDocumentSummary[] = files.map((item) => ({
    id: item.meta.id ?? "",
    title: item.meta.title ?? item.name,
    path: `project/${item.name}`,
    projects: ["p"],
    contains: item.meta.contains,
    visibility: item.meta.visibility,
    unresolvedCommentCount: item.openCommentCount,
  }));
  const byId = new Map(documents.map((document) => [document.id, document]));
  const readingPath: ProjectReadingPathEntry[] = reading.map((item, order) => ({
    area: item.area,
    section: item.section ?? "",
    documentId: item.id,
    documentLabel: item.id,
    purpose: item.purpose ?? `${item.id} purpose`,
    project: "p",
    overviewDocumentId: "index",
    overviewPath: "project/index.md",
    row: order + 2,
    order,
    document: byId.get(item.id),
  }));
  return {
    overviews: [],
    overviewByProject: new Map([["p", {
      project: "p",
      documentId: "index",
      title: "Project",
      path: "project/index.md",
      summary: "Summary",
      keyDocumentIds: [],
      keyResults: [{
        resultId: keyResult.id,
        significance: "Headline",
        project: "p",
        overviewDocumentId: "index",
        overviewPath: "project/index.md",
        row: 2,
        order: 0,
        result: keyResult,
      }],
      readingPath,
      tasks: [],
    }]]),
    projects: ["p"],
    tasks: [{
      id: "T-A",
      title: "Active",
      state: "in-progress",
      priority: "high",
      ownerId: "task-owner",
      ownerLabel: "Task owner",
      relatedResultIds: [],
      dependsOn: [],
      exitCriterion: "Done",
      project: "p",
      overviewDocumentId: "index",
      overviewPath: "project/index.md",
      row: 1,
      order: 0,
    }],
    tasksByProject: new Map([["p", [{
      id: "T-A",
      title: "Active",
      state: "in-progress",
      priority: "high",
      ownerId: "task-owner",
      ownerLabel: "Task owner",
      relatedResultIds: [],
      dependsOn: [],
      exitCriterion: "Done",
      project: "p",
      overviewDocumentId: "index",
      overviewPath: "project/index.md",
      row: 1,
      order: 0,
    }]]]),
    documents,
    dependencyCatalog: {
      manifests: [],
      results: [keyResult, frontier],
      byId: new Map([[keyResult.id, keyResult], [frontier.id, frontier]]),
      diagnostics: [],
    },
    diagnostics: [],
  };
}

function ids(documents: Array<{ file: LibraryFile }>): string[] {
  return documents.map((item) => item.file.meta.id ?? "");
}

describe("stable project Library projection", () => {
  it("reports only the number of certified results owned by a document", () => {
    const files = [file("index", ["project-overview"]), file("demand", [], { kind: "derivation" })];
    const catalog = snapshot(files);
    catalog.certificateCatalog = {
      byResult: new Map(),
      byOwner: new Map([["demand", [{ resultId: "R-A" }, { resultId: "R-B" }] as never]]),
      diagnostics: [],
      buildState: "passed",
    };

    const projection = projectLibraryProjection(files, "p", catalog, null);
    expect(projection.documents.find((item) => item.file.meta.id === "demand")?.leanCertificateCount).toBe(2);
    expect(projection.documents.find((item) => item.file.meta.id === "index")?.leanCertificateCount).toBe(0);
  });

  it("uses the authored reading path for Focus and preserves its authored order", () => {
    const files = [
      file("index", ["project-overview"]),
      file("synthesis", ["synthesis"]),
      file("demand", ["derivation-demand"], { kind: "derivation" }),
      file("claims", ["dependency-graph", "verification"]),
      file("ordinary"),
    ];
    const projection = projectLibraryProjection(
      files,
      "p",
      snapshot(files, [
        { area: "Start here", id: "synthesis" },
        { area: "Core model", section: "Demand", id: "demand" },
        { area: "Reference & validation", section: "Verification", id: "claims" },
      ]),
      null,
    );

    expect(projection.usedFallback).toBe(false);
    expect(projection.focusGroups.map((group) => group.label)).toEqual([
      "Start here",
      "Core model",
      "Reference & validation",
    ]);
    expect(ids(projection.focusGroups[0].documents)).toEqual(["index", "synthesis"]);
    expect(ids(projection.focusGroups[1].sections[0].documents)).toEqual(["demand"]);
    expect(ids(projection.focusGroups[2].sections[0].documents)).toEqual(["claims"]);
    expect(ids(projection.unlistedDocuments)).toEqual(["ordinary"]);
  });

  it("keeps structural placement stable when workflow attention changes", () => {
    const files = [
      file("index", ["project-overview"]),
      file("demand", ["derivation-demand", "open-questions"], {
        kind: "derivation",
        comments: 2,
      }),
    ];
    const catalog = snapshot(files, [
      { area: "Core model", section: "Demand", id: "demand" },
    ]);
    const calm = projectLibraryProjection(files, "p", catalog, null);
    const active = projectLibraryProjection(
      files,
      "p",
      catalog,
      "project/demand.md",
      (id) => id === "demand",
      (path) => path === "project/demand.md",
    );

    expect(active.documents[1].focusPlacement).toEqual(calm.documents[1].focusPlacement);
    expect(active.documents[1].browsePlacement).toEqual(calm.documents[1].browsePlacement);
    expect(active.documents[1].browsePlacement.area).toBe("Open questions");
    expect(active.documents[1].attention).toEqual([
      "active",
      "dirty",
      "save-failed",
      "comments",
      "open-questions",
    ]);
    expect(ids(active.attentionDocuments)).toEqual(["demand"]);
  });

  it("falls back to inferred curation without hiding supporting documents", () => {
    const files = [
      file("index", ["project-overview"]),
      file("synthesis", ["synthesis"]),
      file("demand", ["derivation-demand"], { kind: "derivation" }),
      file("claims", ["dependency-graph", "verification"]),
      file("ordinary"),
    ];
    const projection = projectLibraryProjection(files, "p", snapshot(files), null);

    expect(projection.usedFallback).toBe(true);
    expect(projection.focusGroups.map((group) => group.label)).toEqual([
      "Start here",
      "Core model",
      "Reference & validation",
    ]);
    expect(ids(projection.unlistedDocuments)).toEqual(["ordinary"]);
    expect(projection.browseGroups.map((group) => group.label)).toEqual([
      "Start here",
      "Synthesis",
      "Model derivations",
      "Reference & validation",
      "Supporting documents",
    ]);
  });

  it("orders Browse areas and model stages semantically while preserving document order", () => {
    const files = [
      file("ordinary"),
      file("proof", [], { kind: "proof" }),
      file("equilibrium", ["derivation-equilibrium"], { kind: "derivation" }),
      file("supply-first", ["derivation-supply"], { kind: "derivation" }),
      file("demand", ["derivation-demand"], { kind: "derivation" }),
      file("supply-second", ["derivation-supply"], { kind: "derivation" }),
      file("setting", ["derivation-setting"], { kind: "derivation" }),
      file("claims", ["dependency-graph", "verification"]),
      file("index", ["project-overview"]),
    ];
    const projection = projectLibraryProjection(files, "p", snapshot(files), null);

    expect(projection.browseGroups.map((group) => group.label)).toEqual([
      "Start here",
      "Model derivations",
      "Reference & validation",
      "Supporting documents",
    ]);
    const derivations = projection.browseGroups[1];
    expect(derivations.sections.map((section) => section.label)).toEqual([
      "Setting & primitives",
      "Demand",
      "Supply",
      "Equilibrium",
      "Proofs & methods",
    ]);
    expect(derivations.sections.map((section) => section.sequence)).toEqual([1, 2, 3, 4, 9]);
    expect(ids(derivations.sections[2].documents)).toEqual(["supply-first", "supply-second"]);
  });

  it("places authored workbooks in a dedicated Study area and preserves their course section", () => {
    const files = [
      file("index", ["project-overview"]),
      file("synthesis", ["synthesis"]),
      file("workbook", ["workbook"], { kind: "notes" }),
      file("demand", ["derivation-demand"], { kind: "derivation" }),
    ];
    const projection = projectLibraryProjection(
      files,
      "p",
      snapshot(files, [
        { area: "Start here", id: "synthesis" },
        { area: "Study", section: "Week 1", id: "workbook" },
      ]),
      null,
    );

    expect(projection.browseGroups.map((group) => group.label)).toEqual([
      "Start here",
      "Synthesis",
      "Study",
      "Model derivations",
    ]);
    const study = projection.browseGroups[2];
    expect(study.sections.map((section) => section.label)).toEqual(["Week 1"]);
    expect(ids(study.sections[0].documents)).toEqual(["workbook"]);
    expect(projection.documents.find((document) => document.file.meta.id === "workbook")?.roles)
      .toContain("study-document");
  });

  it("honors explicit presentation roles before derivation and folder inference", () => {
    const redirectInSynthesisFolder = file("redirect", ["supporting-document"], {
      kind: "redirect",
    });
    redirectInSynthesisFolder.folder = "project/synthesis";
    const files = [
      file("index", ["project-overview"]),
      file("primary", ["primary-synthesis"], { kind: "derivation" }),
      redirectInSynthesisFolder,
      file("historical", ["supporting-document", "derivation-empirics"], {
        kind: "derivation",
      }),
      file("frontier-note", ["frontier-document", "open-questions", "derivation-methods"], {
        kind: "derivation",
      }),
      file("supply", ["derivation-supply"], {
        kind: "derivation",
        title: "A welfare-looking title in an empirics folder",
      }),
      file("results", ["reference-document", "reference-results"]),
      file("notation", ["reference-document", "reference-interface"]),
      file("source", ["reference-document", "reference-source-map"]),
      file("audit", ["reference-document", "reference-evidence"]),
      file("other-reference", ["reference-document"]),
      file("kind-reference", [], { kind: "reference" }),
    ];
    const projection = projectLibraryProjection(files, "p", snapshot(files), null);
    const byId = new Map(projection.documents.map((document) => [
      document.file.meta.id,
      document,
    ]));

    expect(byId.get("primary")?.browsePlacement.area).toBe("Synthesis");
    expect(byId.get("primary")?.roles).toContain("primary-synthesis");
    expect(byId.get("redirect")?.roles).toContain("synthesis");
    expect(byId.get("redirect")?.browsePlacement.area).toBe("Supporting documents");
    expect(byId.get("historical")?.browsePlacement.area).toBe("Supporting documents");
    expect(byId.get("frontier-note")?.browsePlacement.area).toBe("Open questions");
    expect(byId.get("supply")?.derivationCategory).toBe("supply");
    expect(byId.get("supply")?.browsePlacement.section).toBe("Supply");
    expect(byId.get("kind-reference")?.browsePlacement.area).toBe("Reference & validation");
    expect(byId.get("kind-reference")?.browsePlacement.section).toBe("Other reference");
    expect(projection.browseGroups.find((group) => group.key === "reference-validation")
      ?.sections.map((section) => section.label)).toEqual([
      "Result and graph status",
      "Notation and theorem interfaces",
      "Provenance and source authority",
      "Audit and evidence",
      "Other reference",
    ]);
  });

  it("excludes support-only documents from Browse, Attention, and authored reading routes", () => {
    const files = [
      file("index", ["project-overview"]),
      file("owner", ["derivation-equilibrium"], { kind: "derivation" }),
      file("reader-supporting", ["supporting-document"]),
      file("archive", ["supporting-document", "open-questions"], {
        comments: 2,
        visibility: "support",
      }),
    ];
    const projection = projectLibraryProjection(
      files,
      "p",
      snapshot(files, [
        { area: "Core model", id: "owner" },
        { area: "Archive", id: "archive" },
      ]),
      null,
    );

    expect(ids(projection.documents)).toEqual(["index", "owner", "reader-supporting"]);
    expect(ids(projection.attentionDocuments)).not.toContain("archive");
    expect(projection.browseGroups.flatMap((group) => [
      ...group.documents,
      ...group.sections.flatMap((section) => section.documents),
    ]).map((document) => document.file.meta.id)).not.toContain("archive");
    expect(projection.focusGroups.flatMap((group) => [
      ...group.documents,
      ...group.sections.flatMap((section) => section.documents),
    ]).map((document) => document.file.meta.id)).not.toContain("archive");
    expect(projection.browseGroups.find((group) => group.key === "supporting-documents")
      ?.documents.map((document) => document.file.meta.id)).toEqual(["reader-supporting"]);
  });

  it("keeps unresolved canonical owners in their scholarly section while surfacing Attention", () => {
    const files = [
      file("index", ["project-overview"]),
      file("frontier", ["derivation-equilibrium"], {
        comments: 1,
        kind: "derivation",
      }),
    ];
    const projection = projectLibraryProjection(files, "p", snapshot(files), null);
    const owner = projection.documents[1];

    expect(owner.browsePlacement.area).toBe("Model derivations");
    expect(owner.browsePlacement.section).toBe("Equilibrium");
    expect(owner.attention).toEqual(["comments", "validation-frontier"]);
    expect(ids(projection.attentionDocuments)).toEqual(["frontier"]);
  });

  it("deduplicates and prioritizes the Attention view independently of repository order", () => {
    const files = [
      file("index", ["project-overview"]),
      file("question", ["open-questions"]),
      file("commented", [], { comments: 1 }),
      file("failed"),
      file("task-owner"),
      file("frontier"),
    ];
    const projection = projectLibraryProjection(
      files,
      "p",
      snapshot(files),
      "project/failed.md",
      () => false,
      (path) => path === "project/failed.md",
    );

    expect(ids(projection.attentionDocuments)).toEqual([
      "failed",
      "commented",
      "question",
      "task-owner",
      "frontier",
    ]);
    expect(projection.attentionCount).toBe(5);
  });

  it("retains explicit-override and derivation-category diagnostics", () => {
    const files = [
      file(
        "conflict",
        [
          "key-document",
          "supporting-document",
          "key-derivation",
          "additional-derivation",
          "derivation-demand",
          "derivation-supply",
        ],
        { kind: "derivation" },
      ),
    ];
    const projection = projectLibraryProjection(files, "p", snapshot(files), null);

    expect(projection.documents[0].derivationCategory).toBe("demand");
    expect(projection.diagnostics).toHaveLength(3);
  });
});
