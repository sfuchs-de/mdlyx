import { describe, expect, it } from "vitest";
import {
  CitationCatalog,
  addBibTeXEntry,
  createCitationKey,
  deleteBibTeXEntry,
  formatCitationCluster,
  parseBibTeXDocument,
  updateBibTeXEntry,
} from "./citation-catalog";

describe("CitationCatalog", () => {
  it("parses nested BibTeX fields and previews citations", () => {
    const catalog = new CitationCatalog();
    catalog.addBibTeX("references/library.bib", `
@article{smith2024,
  author = {Smith, Jane and Doe, John},
  title = {Trade with {Nested} Braces},
  year = {2024}
}`);
    const snapshot = catalog.resolve(["smith2024"]);
    expect(snapshot.entries.get("smith2024")?.fields.title).toBe("Trade with {Nested} Braces");
    expect(catalog.preview("smith2024", "authoryear")).toBe("(Smith and Doe 2024)");
    expect(catalog.preview("smith2024", "numeric")).toBe("[1]");
  });

  it("diagnoses duplicate and missing keys", () => {
    const catalog = new CitationCatalog();
    catalog.addBibTeX("a.bib", "@article{x, year={2020}}");
    catalog.addBibTeX("b.bib", "@book{x, year={2021}}");
    const codes = catalog.resolve(["x", "missing"]).diagnostics.map((item) => item.code);
    expect(codes).toContain("conflicting-key");
    expect(codes).toContain("missing-key");
  });

  it("accepts the same stable key when normalized metadata agrees across projects", () => {
    const catalog = new CitationCatalog();
    catalog.addBibTeX("projects/a/references/library.bib", `
@article{allen2014trade, author={Allen, Treb and Arkolakis, Costas}, title={Trade and the Topography of the Spatial Economy}, year={2014}}
`);
    catalog.addBibTeX("projects/b/references/library.bib", `
@article{allen2014trade,
  year = {2014},
  title = {{Trade} and the Topography of the Spatial Economy},
  author = {Allen, Treb and Arkolakis, Costas}
}`);
    expect(catalog.resolve([]).diagnostics).toHaveLength(0);
  });

  it("formats author-year and numeric clusters, locators, prefixes, and suppress-author items", () => {
    const catalog = new CitationCatalog();
    catalog.addBibTeX("references/library.bib", `
@article{allen2014trade, author={Allen, Treb and Arkolakis, Costas}, title={Trade}, year={2014}}
@article{redding2017quantitative, author={Redding, Stephen and Rossi-Hansberg, Esteban}, title={Quantitative Spatial Economics}, year={2017}}
`);
    const snapshot = catalog.resolve([]);
    expect(formatCitationCluster(
      "@allen2014trade, p. 12; see also -@redding2017quantitative",
      snapshot,
      "authoryear",
    ).text).toBe("(Allen and Arkolakis 2014, p. 12; see also 2017)");
    expect(formatCitationCluster(
      "@allen2014trade; @redding2017quantitative, sec. 2",
      snapshot,
      "numeric",
    ).text).toBe("[1; 2, sec. 2]");
  });

  it("keeps raw syntax visible and accessible when any cluster key is missing", () => {
    const snapshot = new CitationCatalog().resolve([]);
    const formatted = formatCitationCluster("@missing2024, p. 3", snapshot, "authoryear");
    expect(formatted.text).toBe("[@missing2024, p. 3]");
    expect(formatted.missingKeys).toEqual(["missing2024"]);
    expect(formatted.ariaLabel).toContain("Unresolved citation");
  });
});

describe("source-preserving BibTeX edits", () => {
  const source = `% Curated sources
@string{jue = "Journal of Urban Economics"}

@article{allen2014trade,
 author = {Allen, Treb and Arkolakis, Costas},
 TITLE={Trade and {the} Topography},
 year = 2014,
 journal = jue,
 unknown_field = {keep me}
}

@comment{The next entry uses deliberately different spacing.}
@book{other2020,author={Other, A.},title={Other Book},year={2020}}
`;

  it("preserves comments, declarations, order, unknown fields, and untouched entry bytes", () => {
    const parsed = parseBibTeXDocument("library.bib", source);
    const updated = updateBibTeXEntry(parsed, "allen2014trade", {
      type: "article",
      fields: {
        ...parsed.entries[0].fields,
        title: "Trade and the Topography of the Spatial Economy",
      },
    });
    expect(updated).toContain('@string{jue = "Journal of Urban Economics"}');
    expect(updated).toContain("@comment{The next entry uses deliberately different spacing.}");
    expect(updated).toContain("@book{other2020,author={Other, A.},title={Other Book},year={2020}}");
    expect(updated).toContain(" author = {Allen, Treb and Arkolakis, Costas},");
    expect(updated).toContain(" journal = jue,");
    expect(updated).toContain(" year = 2014,");
    expect(updated).toContain("unknown_field = {keep me}");
    expect(updated).toContain("TITLE={Trade and the Topography of the Spatial Economy}");
  });

  it("can add and clear selected fields without rewriting retained raw expressions", () => {
    const parsed = parseBibTeXDocument("library.bib", source);
    const updated = updateBibTeXEntry(parsed, "allen2014trade", {
      type: "article",
      fields: {
        ...parsed.entries[0].fields,
        doi: "10.1093/qje/qju016",
        unknown_field: "",
      },
    });
    expect(updated).toContain("journal = jue,");
    expect(updated).not.toContain("unknown_field");
    expect(updated).toContain("doi = {10.1093/qje/qju016},");
    expect(parseBibTeXDocument("library.bib", updated).diagnostics).toHaveLength(0);
  });

  it("adds and deletes one entry without reformatting the remaining source", () => {
    const parsed = parseBibTeXDocument("library.bib", source);
    const added = addBibTeXEntry(parsed, "smith2024paper", {
      type: "article",
      fields: { author: "Smith, Jane", title: "Paper", year: "2024" },
    });
    expect(added.startsWith(source.trimEnd())).toBe(true);
    const reparsed = parseBibTeXDocument("library.bib", added);
    const deleted = deleteBibTeXEntry(reparsed, "smith2024paper");
    expect(deleted.trimEnd()).toBe(source.trimEnd());
  });

  it("generates readable immutable keys with deterministic collision suffixes", () => {
    const input = {
      type: "article",
      fields: {
        author: "Allen, Treb and Arkolakis, Costas",
        title: "Trade and the Topography of the Spatial Economy",
        year: "2014",
      },
    };
    expect(createCitationKey(input)).toBe("allen2014trade");
    expect(createCitationKey(input, ["allen2014trade"])).toBe("allen2014tradea");
    expect(createCitationKey(input, ["allen2014trade", "allen2014tradea"])).toBe("allen2014tradeb");
  });

  it("reports an unclosed hostile entry instead of looping", () => {
    const catalog = new CitationCatalog();
    catalog.addBibTeX("bad.bib", "@article{broken, title={never closes}");
    expect(catalog.resolve([]).diagnostics[0]?.code).toBe("malformed-entry");
  });
});
