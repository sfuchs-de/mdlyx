// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DependencyCatalog, ResultNode } from "./dependency-graph";
import { createResultInspector } from "./result-inspector";

function result(overrides: Partial<ResultNode> = {}): ResultNode {
  return {
    id: "R-MAIN",
    title: "Main result",
    ownerId: "owner-main",
    ownerLabel: "Main owner",
    validation: "validated",
    curatedStatus: "final",
    derivationAudit: "complete",
    dependsOn: ["R-BASE"],
    evidence: "Symbolic identity and deterministic regression.",
    condition: "Exact on the positive domain.",
    claimClass: "theorem",
    headlineStatement: "The equilibrium has a unique local representation.",
    whyItMatters: "It closes the model without hiding the boundary.",
    formulaTitle: "Equilibrium identity",
    formula: "x=y",
    project: "p",
    manifestDocumentId: "claims",
    manifestPath: "claims.md",
    row: 2,
    ...overrides,
  };
}

function catalog(): DependencyCatalog {
  const results = [
    result(),
    result({ id: "R-BASE", title: "Base result", ownerId: "owner-base", ownerLabel: "Base owner", dependsOn: [] }),
    result({ id: "R-DOWN", title: "Downstream result", ownerId: "owner-down", ownerLabel: "Downstream owner", dependsOn: ["R-MAIN"] }),
  ];
  return {
    manifests: [],
    results,
    byId: new Map(results.map((item) => [item.id, item])),
    diagnostics: [],
  };
}

afterEach(() => {
  document.body.textContent = "";
  vi.restoreAllMocks();
});

describe("result inspector", () => {
  it("keeps curated, registry, and derivation states distinct and renders governed metadata", () => {
    const graph = catalog();
    const openStatement = vi.fn();
    const openDerivation = vi.fn();
    const openRelated = vi.fn();
    const inspector = createResultInspector(graph.byId.get("R-MAIN")!, graph, {
      openStatement,
      openDerivation,
      openRelated,
    });
    document.body.append(inspector);

    expect(inspector.textContent).toContain("Registry · validated");
    expect(inspector.textContent).toContain("Curated · final");
    expect(inspector.textContent).toContain("Derivation audit · complete");
    expect(inspector.textContent).toContain("Curated summary");
    expect(inspector.textContent).toContain("The equilibrium has a unique local representation.");
    expect(inspector.textContent).toContain("Scope and remaining boundary");
    expect(inspector.textContent).toContain("Local public prerequisites");
    expect(inspector.textContent).toContain("Imported and atomic proof obligations remain");
    expect(inspector.querySelector(".result-inspector-math .katex")).not.toBeNull();

    const buttons = [...inspector.querySelectorAll<HTMLButtonElement>("button")];
    buttons.find((item) => item.textContent === "Registered statement")!.click();
    buttons.find((item) => item.textContent === "Detailed derivation")!.click();
    buttons.find((item) => item.textContent?.includes("R-BASE"))!.click();
    expect(openStatement).toHaveBeenCalledWith(graph.byId.get("R-MAIN"));
    expect(openDerivation).toHaveBeenCalledWith(graph.byId.get("R-MAIN"));
    expect(openRelated).toHaveBeenCalledWith(graph.byId.get("R-BASE"));
  });

  it("copies a stable Mathdown reference and does not claim it is a URL permalink", async () => {
    const graph = catalog();
    const copyText = vi.fn(async () => undefined);
    const inspector = createResultInspector(graph.byId.get("R-MAIN")!, graph, {
      openStatement: vi.fn(),
      openDerivation: vi.fn(),
      copyText,
    });
    document.body.append(inspector);

    const copy = [...inspector.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent === "Copy Mathdown reference")!;
    copy.click();
    await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith(
      "[[owner-main#mathdown-claim:R-MAIN|R-MAIN]]",
    ));
    expect(inspector.querySelector(".result-inspector-copy-status")?.textContent).toBe("Link copied");
  });

  it("labels a blocked owner capsule as conditional rather than a completed derivation", () => {
    const graph = catalog();
    const blocked = result({ derivationAudit: "blocked", validation: "partial" });
    graph.results[0] = blocked;
    graph.byId.set(blocked.id, blocked);
    const inspector = createResultInspector(blocked, graph, {
      openStatement: vi.fn(),
      openDerivation: vi.fn(),
    });

    expect([...inspector.querySelectorAll("button")].map((button) => button.textContent))
      .toContain("Conditional derivation and open obligations");
    expect(inspector.textContent).not.toContain("Detailed derivation");
  });
});
