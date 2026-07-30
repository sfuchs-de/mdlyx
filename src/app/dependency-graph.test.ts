import { describe, expect, it } from "vitest";
import {
  buildDependencyCatalog,
  downstreamOf,
  parseDependencyManifest,
  resultOwnerAnchors,
  resultsForProject,
  upstreamOf,
} from "./dependency-graph";

function manifest(
  project: string,
  documentId: string,
  rows: string,
  extraHeader = "",
  extraDivider = "",
): string {
  return `---
library: {"id":"${documentId}","title":"${project} verification","kind":"notes","projects":["${project}"],"contains":["dependency-graph"]}
---

# Verification

## Result dependency manifest {#dependency-graph}

| Result ID | Result | Owner | Validation | Depends on | Evidence | Remaining condition |${extraHeader}
| --- | --- | --- | --- | --- | --- | --- |${extraDivider}
${rows}
`;
}

describe("dependency manifest Markdown", () => {
  it("uses the stable claim marker when a projection omits an owner anchor", () => {
    expect(resultOwnerAnchors({
      id: "R-DEMO-OVERLAP",
      title: "Overlap",
      ownerId: "sample-risk-analysis",
      ownerLabel: "Risk and resilience",
      validation: "validated",
      dependsOn: [],
      evidence: "",
      condition: "",
      project: "network-hubs",
      manifestDocumentId: "sample-claims",
      manifestPath: "claims.md",
      row: 1,
    })).toEqual([
      "mathdown-claim:R-DEMO-OVERLAP",
      "mathdown-derivation:R-DEMO-OVERLAP",
      "R-DEMO-OVERLAP",
    ]);
  });

  it("extracts result-level nodes, owner wiki links, dependencies, and evidence", () => {
    const source = manifest(
      "example-logistics",
      "example-logistics-claims",
      "| `R-A` | First result | [[doc-a\\|Owner A]] | validated |  | symbolic check | finite radius |\n" +
        "| `R-B` | Second result | [[doc-b]] | partial | `R-A`, `R-X` | residual check | open closure |",
    );
    const parsed = parseDependencyManifest(source, "verification/claims.md");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.manifest).toMatchObject({
      project: "example-logistics",
      documentId: "example-logistics-claims",
      path: "verification/claims.md",
    });
    expect(parsed.manifest?.results).toEqual([
      expect.objectContaining({
        id: "R-A",
        title: "First result",
        ownerId: "doc-a",
        ownerLabel: "Owner A",
        validation: "validated",
        dependsOn: [],
        evidence: "symbolic check",
        condition: "finite radius",
      }),
      expect.objectContaining({
        id: "R-B",
        ownerId: "doc-b",
        ownerLabel: "doc-b",
        validation: "partial",
        dependsOn: ["R-A", "R-X"],
      }),
    ]);
  });

  it("ignores extra human columns and preserves escaped pipes in evidence", () => {
    const source = manifest(
      "p",
      "claims",
      "| `R-A` | Claim | [[doc-a]] | validated |  | residual A \\| B | condition | E |",
      " Grade |",
      " --- |",
    );
    const parsed = parseDependencyManifest(source, "claims.md");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.manifest?.results[0]).toMatchObject({ evidence: "residual A | B" });
  });

  it("accepts Contract v2 column aliases and exposes typed optional fields", () => {
    const source = `---
library: {"id":"claims","title":"Claims","projects":["p"],"contains":["dependency-graph"]}
---

## Results {#dependency-graph}

| ID | Title | Owner document | Validation state | Prerequisites | Evidence | Remaining conditions | Curated status | Claim class | Model state | Branch | Joint block | Owner anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| \`R-A\` | Claim | [[doc-a]] | validated | — | checked | none | final | identity | benchmark | main | J-ONE | result-a |
`;
    const parsed = parseDependencyManifest(source, "claims.md");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.manifest?.results[0]).toMatchObject({
      id: "R-A",
      curatedStatus: "final",
      claimClass: "identity",
      modelState: "benchmark",
      branch: "main",
      jointBlock: "J-ONE",
      ownerAnchor: "result-a",
    });
  });

  it("recognizes exact acknowledged conditional-validation warnings", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    const source = `---
library: {"id":"claims","title":"Claims","projects":["p"],"contains":["dependency-graph"],"projection":{"kind":"generated-result-manifest","schema_version":"2.0","sources":["results.yaml","graph.json","exceptions.yaml"],"digest":"${digest}","read_only":true,"acknowledged_warnings":[{"result_id":"R-B","dependencies":["R-A"],"scope":"conditional-test"}]}}
---

## Results {#dependency-graph}

| Result ID | Result | Owner | Validation | Depends on | Evidence | Remaining condition |
| --- | --- | --- | --- | --- | --- | --- |
| \`R-A\` | Open premise | [[doc-a]] | partial | — | partial | open |
| \`R-B\` | Conditional identity | [[doc-b]] | validated | \`R-A\` | checked | conditional |
`;
    const parsed = parseDependencyManifest(source, "claims.md");
    const catalog = buildDependencyCatalog([parsed], [
      { id: "doc-a", title: "A" },
      { id: "doc-b", title: "B" },
    ]);
    const warning = catalog.diagnostics.find((item) => item.code === "validated-on-unresolved");
    expect(warning).toMatchObject({ acknowledged: true, scope: "conditional-test" });
  });

  it.each(["", "-", "\u2013", "\u2014", "none", "NONE", "n/a", "N/A", "`\u2014`"]) (
    "treats %j as an empty dependency cell",
    (emptyDependency) => {
      const source = manifest(
        "p",
        "claims",
        `| \`R-A\` | Claim | [[doc-a]] | validated | ${emptyDependency} | checked | none |`,
      );
      const parsed = parseDependencyManifest(source, "claims.md");
      expect(parsed.diagnostics).toEqual([]);
      expect(parsed.manifest?.results[0]?.dependsOn).toEqual([]);
    },
  );

  it("drops empty sentinels from mixed dependency lists and de-duplicates real IDs", () => {
    const source = manifest(
      "p",
      "claims",
      "| `R-A` | Claim | [[doc-a]] | partial | `R-B`, none; `R-B`; n/a; \u2014 | checked | open |",
    );
    const parsed = parseDependencyManifest(source, "claims.md");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.manifest?.results[0]?.dependsOn).toEqual(["R-B"]);
  });

  it("reports malformed project metadata, missing graph headings, columns, owners, and states", () => {
    const noProject = `---
library: {"id":"claims","projects":[],"contains":["dependency-graph"]}
---

# No graph
`;
    const badMeta = parseDependencyManifest(noProject, "bad.md");
    expect(badMeta.diagnostics.map((item) => item.code)).toEqual([
      "manifest-project",
      "manifest-heading",
    ]);

    const missingOwner = manifest(
      "p",
      "claims",
      "| `R-A` | Claim | plain owner | final |  | evidence | condition |",
    );
    const malformed = parseDependencyManifest(missingOwner, "claims.md");
    expect(malformed.diagnostics.map((item) => item.code)).toEqual([
      "missing-owner",
      "invalid-validation",
    ]);
    expect(malformed.manifest?.results).toEqual([]);
  });
});

describe("dependency catalog validation and traversal", () => {
  it("resolves cross-project prerequisites and traverses upstream/downstream", () => {
    const p1 = parseDependencyManifest(manifest(
      "p1",
      "p1-claims",
      "| `R-A` | A | [[doc-a]] | validated |  | checked | none |\n" +
        "| `R-B` | B | [[doc-b]] | validated | `R-A` | checked | none |",
    ), "p1.md");
    const p2 = parseDependencyManifest(manifest(
      "p2",
      "p2-claims",
      "| `R-C` | C | [[doc-c]] | partial | `R-B` | partial check | closure |",
    ), "p2.md");
    const catalog = buildDependencyCatalog([p1, p2], [
      { id: "doc-a", title: "A" },
      { id: "doc-b", title: "B" },
      { id: "doc-c", title: "C" },
    ]);
    expect(catalog.diagnostics).toEqual([]);
    expect([...upstreamOf(catalog, "R-C")]).toEqual(["R-B", "R-A"]);
    expect([...downstreamOf(catalog, "R-A")]).toEqual(["R-B", "R-C"]);
    expect(resultsForProject(catalog, "p2").map((result) => result.id).sort()).toEqual([
      "R-A",
      "R-B",
      "R-C",
    ]);
  });

  it("reports duplicate ids, missing owners/dependencies, cycles, and risky validation", () => {
    const first = parseDependencyManifest(manifest(
      "p1",
      "claims-1",
      "| `R-A` | A | [[missing-doc]] | validated | `R-B`, `R-MISSING` | check | none |\n" +
        "| `R-B` | B | [[doc-b]] | partial | `R-A` | partial | open |",
    ), "one.md");
    const duplicate = parseDependencyManifest(manifest(
      "p2",
      "claims-2",
      "| `R-A` | Duplicate | [[doc-b]] | unvalidated |  |  | open |",
    ), "two.md");
    const catalog = buildDependencyCatalog([first, duplicate], [{ id: "doc-b", title: "B" }]);
    const codes = catalog.diagnostics.map((item) => item.code);
    expect(codes).toContain("duplicate-result-id");
    expect(codes).toContain("missing-owner-document");
    expect(codes).toContain("missing-dependency");
    expect(codes).toContain("dependency-cycle");
    expect(codes).toContain("validated-on-unresolved");
  });

  it("requires one manifest per project", () => {
    const a = parseDependencyManifest(manifest(
      "p",
      "claims-a",
      "| `R-A` | A | [[doc-a]] | validated |  | checked | none |",
    ), "a.md");
    const b = parseDependencyManifest(manifest(
      "p",
      "claims-b",
      "| `R-B` | B | [[doc-a]] | validated |  | checked | none |",
    ), "b.md");
    const catalog = buildDependencyCatalog([a, b], [{ id: "doc-a", title: "A" }]);
    expect(catalog.diagnostics.some((item) => item.code === "duplicate-project-manifest")).toBe(true);
    expect(catalog.manifests).toEqual([]);
    expect(catalog.results).toEqual([]);
  });
});
