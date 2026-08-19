// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResultNode } from "./dependency-graph";
import type { ProjectCatalogLoadResult } from "./project-catalog-controller";
import type { ProjectCatalogSnapshot } from "./project-overview";
import { ProjectGraphView } from "./project-graph-view";

function fixture(): ProjectCatalogLoadResult {
  const result: ResultNode = {
    id: "R-A",
    title: "Result A",
    ownerId: "owner-a",
    ownerLabel: "Owner A",
    validation: "validated",
    curatedStatus: "final",
    derivationAudit: "complete",
    dependsOn: [],
    evidence: "Checked.",
    condition: "Exact on the declared domain.",
    claimAnchor: "claim-R-A",
    derivationAnchor: "derivation-R-A",
    project: "p",
    manifestDocumentId: "claims",
    manifestPath: "claims.md",
    row: 2,
  };
  const snapshot: ProjectCatalogSnapshot = {
    overviews: [],
    overviewByProject: new Map(),
    projects: ["p"],
    tasks: [],
    tasksByProject: new Map(),
    documents: [{
      id: "owner-a",
      title: "Owner A",
      path: "owner-a.md",
      projects: ["p"],
      contains: [],
      unresolvedCommentCount: 0,
    }],
    dependencyCatalog: {
      manifests: [{
        project: "p",
        documentId: "claims",
        title: "Claims",
        path: "claims.md",
        results: [result],
        acknowledgedWarnings: new Map(),
      }],
      results: [result],
      byId: new Map([[result.id, result]]),
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

describe("ProjectGraphView result inspector", () => {
  it("reports a missing derivation anchor without substituting the owner top", async () => {
    const root = document.createElement("main");
    document.body.append(root);
    const openDocument = vi.fn(async (_id: string, _anchor?: string) => false);
    const view = new ProjectGraphView(root, {
      sources: () => [],
      documents: () => [{ id: "owner-a", title: "Owner A" }],
      loadCatalog: async () => fixture(),
      openDocument,
      onModeChange: vi.fn(),
    });

    await view.open("p");
    root.querySelector<SVGGElement>('[data-result-id="R-A"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    [...root.querySelectorAll<HTMLButtonElement>(".result-inspector-action")]
      .find((button) => button.textContent === "Detailed derivation")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".result-inspector-navigation-error")?.textContent)
        .toContain("owner document was not opened as a substitute");
    });
    expect(openDocument).toHaveBeenCalledWith("owner-a", "derivation-R-A");
    expect(openDocument).toHaveBeenCalledWith("owner-a", "mathdown-derivation:R-A");
    expect(openDocument.mock.calls.some((call) => call.length === 1)).toBe(false);
  });
});
