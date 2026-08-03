import { describe, expect, it } from "vitest";
import {
  emptyFrontmatter,
  parseFrontmatter,
  type PublicationSettings,
} from "../markdown/frontmatter";
import {
  resolveEffectivePublication,
  type ProjectPublicationConfig,
} from "./project-publication";

const settings = (
  bibliography: string[],
  citationStyle: PublicationSettings["citationStyle"] = "authoryear",
): PublicationSettings => ({
  bibliography,
  citationStyle,
  documentClass: "article",
  language: "en",
  engine: "tectonic",
});

const config = (
  project: string,
  bibliography: string[],
  citationStyle: PublicationSettings["citationStyle"] = "authoryear",
): ProjectPublicationConfig => ({
  project,
  overviewDocumentId: `${project}-index`,
  overviewPath: `projects/${project}/index.md`,
  settings: settings(bibliography, citationStyle),
});

describe("project publication inheritance", () => {
  it("inherits project settings when the document has no publication block", () => {
    const frontmatter = emptyFrontmatter();
    frontmatter.library.projects = ["sample-model"];
    const effective = resolveEffectivePublication(frontmatter, [
      config("sample-model", ["references/library.bib"]),
    ]);
    expect(effective.bibliography).toEqual(["projects/sample-model/references/library.bib"]);
    expect(effective.bibliographySources).toEqual([{
      project: "sample-model",
      path: "projects/sample-model/references/library.bib",
    }]);
    expect(effective.overriddenFields).toEqual([]);
    expect(effective.inheritedFields).toContain("citationStyle");
  });

  it("does not prefix an already repository-relative project bibliography", () => {
    const frontmatter = emptyFrontmatter();
    frontmatter.library.projects = ["sample-model"];
    const effective = resolveEffectivePublication(frontmatter, [
      config("sample-model", ["projects/sample-model/references/library.bib"]),
    ]);
    expect(effective.bibliography).toEqual(["projects/sample-model/references/library.bib"]);
  });

  it("applies explicit fields independently and treats bibliography: [] as disabling inheritance", () => {
    const parsed = parseFrontmatter(`---
library: {"id":"note","projects":["sample-model"]}
publication:
  bibliography: []
  citationStyle: numeric
---
Body
`).frontmatter;
    const effective = resolveEffectivePublication(parsed, [
      config("sample-model", ["projects/sample-model/references/library.bib"]),
    ]);
    expect(effective.bibliography).toEqual([]);
    expect(effective.citationStyle).toBe("numeric");
    expect(effective.language).toBe("en");
    expect(effective.overriddenFields).toEqual(["bibliography", "citationStyle"]);
  });

  it("combines multi-project bibliographies and reports conflicting styles until overridden", () => {
    const frontmatter = emptyFrontmatter();
    frontmatter.library.projects = ["a", "b"];
    let effective = resolveEffectivePublication(frontmatter, [
      config("a", ["projects/a/references/library.bib"], "authoryear"),
      config("b", ["projects/b/references/library.bib"], "numeric"),
    ]);
    expect(effective.bibliography).toEqual([
      "projects/a/references/library.bib",
      "projects/b/references/library.bib",
    ]);
    expect(effective.diagnostics[0]?.code).toBe("project-style-conflict");

    frontmatter.publicationOverrides.citationStyle = "authoryear";
    effective = resolveEffectivePublication(frontmatter, [
      config("a", ["projects/a/references/library.bib"], "authoryear"),
      config("b", ["projects/b/references/library.bib"], "numeric"),
    ]);
    expect(effective.citationStyle).toBe("authoryear");
    expect(effective.overriddenFields).toContain("citationStyle");
    expect(effective.diagnostics).toEqual([]);
  });
});
