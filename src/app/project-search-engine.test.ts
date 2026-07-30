import { describe, expect, it } from "vitest";
import { searchProjectDocuments, type SearchDocument } from "./project-search-engine";

const documents: SearchDocument[] = [
  { id: "a", title: "Alpha", path: "a.md", projects: ["one"], text: "# Alpha\nUnique frontier result\n" },
  { id: "b", title: "Beta", path: "nested/b.md", projects: ["two"], text: "# Beta\nFrontier condition\n" },
  {
    id: "legacy-proof",
    title: "Legacy proof",
    path: "archive/legacy-proof.md",
    projects: ["one"],
    visibility: "support",
    text: "A hidden frontier phrase should not enter ordinary search.",
  },
];

describe("project-wide search", () => {
  it("returns stable document, path, line, and excerpt data", () => {
    expect(searchProjectDocuments(documents, "frontier")).toMatchObject([
      { id: "a", path: "a.md", line: 2, excerpt: "Unique frontier result" },
      { id: "b", path: "nested/b.md", line: 2, excerpt: "Frontier condition" },
    ]);
  });

  it("filters by project and bounds results", () => {
    expect(searchProjectDocuments(documents, "frontier", "two", 1)).toMatchObject([
      { id: "b", project: "two" },
    ]);
    expect(searchProjectDocuments(documents, "", "two")).toEqual([]);
  });

  it("keeps support contents out of ordinary search but resolves exact IDs and paths", () => {
    expect(searchProjectDocuments(documents, "hidden frontier")).toEqual([]);
    expect(searchProjectDocuments(documents, "legacy-proof")).toMatchObject([
      {
        id: "legacy-proof",
        path: "archive/legacy-proof.md",
        excerpt: "Retained archive or compatibility document.",
      },
    ]);
    expect(searchProjectDocuments(documents, "archive/legacy-proof.md")).toHaveLength(1);
  });

  it("searches a synthetic 1,000-document project inside the two-second budget", () => {
    const large = Array.from({ length: 1_000 }, (_, index): SearchDocument => ({
      id: `doc-${index}`,
      title: `Document ${index}`,
      path: `nested/${index}.md`,
      projects: ["large"],
      text: `# Document ${index}\n${"ordinary research text ".repeat(200)}`,
    }));
    const started = performance.now();
    expect(searchProjectDocuments(large, "absent-needle", "large")).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
