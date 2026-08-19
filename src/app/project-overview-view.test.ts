// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResultNode } from "./dependency-graph";
import type { ProjectCatalogLoadResult } from "./project-catalog-controller";
import type { ProjectCatalogSnapshot } from "./project-overview";
import { ProjectOverviewView } from "./project-overview-view";

function result(index: number): ResultNode {
  return {
    id: `R-${index}`,
    title: `Result ${index}`,
    ownerId: `owner-${index}`,
    ownerLabel: `Owner ${index}`,
    ownerAnchor: `result-${index}`,
    validation: "validated",
    dependsOn: [],
    evidence: `Evidence ${index}`,
    condition: "",
    project: "p",
    manifestDocumentId: "claims",
    manifestPath: "claims.md",
    row: index + 1,
  };
}

function fixture(): ProjectCatalogLoadResult {
  const results = Array.from({ length: 7 }, (_, index) => result(index + 1));
  const snapshot: ProjectCatalogSnapshot = {
    overviews: [],
    overviewByProject: new Map([["p", {
      project: "p",
      documentId: "index",
      title: "Project P",
      path: "p/index.md",
      summary: "A project summary.",
      keyDocumentIds: [],
      keyResults: results.map((item, index) => ({
        resultId: item.id,
        significance: `Why result ${index + 1} matters.`,
        readingDocumentId: item.ownerId,
        readingDocumentLabel: `Read result ${index + 1}`,
        project: "p",
        overviewDocumentId: "index",
        overviewPath: "p/index.md",
        row: index + 2,
        order: index,
        result: item,
      })),
      readingPath: [],
      tasks: [],
      taskAuthority: {
        mode: "external",
        system: "Task Manager",
        url: "https://example.test/tasks",
      },
    }]]),
    projects: ["p"],
    tasks: [],
    tasksByProject: new Map([["p", []]]),
    documents: results.map((item) => ({
      id: item.ownerId,
      title: item.ownerLabel,
      path: `p/${item.ownerId}.md`,
      projects: ["p"],
      contains: [],
      unresolvedCommentCount: 0,
    })),
    dependencyCatalog: {
      manifests: [{
        project: "p",
        documentId: "claims",
        title: "Claims",
        path: "claims.md",
        results,
        acknowledgedWarnings: new Map(),
      }],
      results,
      byId: new Map(results.map((item) => [item.id, item])),
      diagnostics: [],
    },
    diagnostics: [],
  };
  return { snapshot, state: "fresh", errors: [] };
}

afterEach(() => {
  document.body.textContent = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("ProjectOverviewView key results", () => {
  it("renders six headline cards, discloses the remainder, and opens owner anchors", async () => {
    const root = document.createElement("main");
    document.body.append(root);
    const openDocument = vi.fn(async () => false);
    const view = new ProjectOverviewView(root, {
      loadCatalog: async () => fixture(),
      openDocument,
      openGraph: vi.fn(),
      refreshLibrary: async () => true,
      usesGitHub: () => true,
      onModeChange: vi.fn(),
    });

    await view.open("p");

    expect(root.querySelectorAll(":scope > .overview-key-results > .overview-key-result-grid > .overview-key-result-card"))
      .toHaveLength(6);
    expect(root.querySelector(".overview-key-results-more > summary")?.textContent)
      .toBe("Show all 7 key results");
    expect(root.querySelector(".overview-key-result-state")?.textContent).toContain("validated");
    expect(root.querySelector(".overview-key-result-owner")?.textContent)
      .toContain("Read · Read result 1");

    root.querySelector<HTMLButtonElement>('[data-result-id="R-1"]')!.click();
    expect(root.querySelector(".result-inspector")?.textContent).toContain("Evidence 1");
    expect(root.querySelector('[data-result-id="R-1"]')?.getAttribute("aria-pressed")).toBe("true");

    [...root.querySelectorAll<HTMLButtonElement>(".result-inspector-action")]
      .find((item) => item.textContent === "Registered statement")!.click();
    await vi.waitFor(() => expect(openDocument).toHaveBeenCalledWith("owner-1", "result-1"));

    root.querySelector<HTMLButtonElement>('[data-result-id="R-2"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(openDocument).toHaveBeenCalledWith("owner-2", "result-2"));
  });

  it("inspects a selected cross-project prerequisite without hiding its project", async () => {
    const loaded = fixture();
    const main = loaded.snapshot.dependencyCatalog.byId.get("R-1")!;
    main.validation = "partial";
    main.dependsOn = ["R-X"];
    const external: ResultNode = {
      ...result(8),
      id: "R-X",
      title: "Imported theorem",
      ownerId: "external-owner",
      ownerLabel: "External owner",
      project: "q",
    };
    loaded.snapshot.dependencyCatalog.results.push(external);
    loaded.snapshot.dependencyCatalog.byId.set(external.id, external);
    const root = document.createElement("main");
    document.body.append(root);
    const view = new ProjectOverviewView(root, {
      loadCatalog: async () => loaded,
      openDocument: vi.fn(async () => false),
      openGraph: vi.fn(),
      refreshLibrary: async () => true,
      usesGitHub: () => true,
      onModeChange: vi.fn(),
    });

    await view.open("p");
    root.querySelector<SVGGElement>('.overview-frontier [data-result-id="R-X"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(root.querySelector(".result-inspector")?.textContent).toContain("Imported theorem");
    expect(root.querySelector(".result-inspector-metadata")?.textContent).toContain("Projectq");
  });
});
