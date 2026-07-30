import { describe, expect, it, vi } from "vitest";
import { CitationCatalogCache } from "./citation-catalog-cache";
import type { EffectivePublicationSettings } from "./project-publication";

const publication = (
  bibliography = ["projects/p/references/library.bib"],
): EffectivePublicationSettings => ({
  bibliography,
  citationStyle: "authoryear",
  documentClass: "article",
  language: "en",
  engine: "tectonic",
  projects: ["p"],
  bibliographySources: bibliography.map((path) => ({ project: "p", path })),
  diagnostics: [],
  inheritedFields: ["bibliography", "citationStyle"],
  overriddenFields: [],
});

describe("CitationCatalogCache", () => {
  it("reuses an unchanged provider/revision/path/SHA catalog and invalidates explicitly", async () => {
    const cache = new CitationCatalogCache();
    const read = vi.fn(async (path: string) => ({
      asset: { path, sha: "sha-1", size: 60, mimeType: "application/x-bibtex" },
      bytes: new TextEncoder().encode("@article{x2024paper,author={X, A.},title={Paper},year={2024}}"),
    }));
    const request = {
      providerIdentity: "github:library",
      libraryRevision: "rev-1",
      publication: publication(),
      assets: [{
        path: "projects/p/references/library.bib",
        sha: "sha-1",
        size: 60,
        mimeType: "application/x-bibtex",
      }],
      read,
    };
    expect((await cache.load(request)).fromCache).toBe(false);
    expect((await cache.load(request)).fromCache).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    cache.invalidate();
    expect((await cache.load(request)).fromCache).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a catalog after its asset SHA changes", async () => {
    const cache = new CitationCatalogCache();
    const read = vi.fn(async (path: string) => ({
      asset: { path, sha: "returned", size: 60, mimeType: "application/x-bibtex" },
      bytes: new TextEncoder().encode("@article{x2024paper,author={X, A.},title={Paper},year={2024}}"),
    }));
    const base = {
      providerIdentity: "folder:project",
      libraryRevision: "rev",
      publication: publication(),
      read,
    };
    await cache.load({
      ...base,
      assets: [{ path: publication().bibliography[0], sha: "one", size: 60, mimeType: "application/x-bibtex" }],
    });
    await cache.load({
      ...base,
      assets: [{ path: publication().bibliography[0], sha: "two", size: 60, mimeType: "application/x-bibtex" }],
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares a concurrent provider read while resolving request-local usage and missing keys", async () => {
    const cache = new CitationCatalogCache();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.fn(async (path: string) => {
      await gate;
      return {
        asset: { path, sha: "sha-1", size: 60, mimeType: "application/x-bibtex" },
        bytes: new TextEncoder().encode("@article{x2024paper,author={X, A.},title={Paper},year={2024}}"),
      };
    });
    const request = {
      providerIdentity: "github:library",
      libraryRevision: "rev-1",
      publication: publication(),
      assets: [{
        path: publication().bibliography[0],
        sha: "sha-1",
        size: 60,
        mimeType: "application/x-bibtex",
      }],
      read,
    };
    const first = cache.load({ ...request, citedKeys: ["missing-one"] });
    const second = cache.load({
      ...request,
      usages: [{
        key: "x2024paper",
        documentId: "doc",
        documentPath: "doc.md",
        documentTitle: "Doc",
        occurrences: 2,
      }],
    });
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(one.snapshot.diagnostics.some((item) => item.key === "missing-one")).toBe(true);
    expect(two.snapshot.diagnostics.some((item) => item.key === "missing-one")).toBe(false);
    expect(two.snapshot.usages.get("x2024paper")?.[0].occurrences).toBe(2);
  });

  it("does not repopulate a stale cache after invalidation during a provider read", async () => {
    const cache = new CitationCatalogCache();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.fn(async (path: string) => {
      await gate;
      return {
        asset: { path, sha: "sha-1", size: 60, mimeType: "application/x-bibtex" },
        bytes: new TextEncoder().encode("@article{x2024paper,author={X, A.},title={Paper},year={2024}}"),
      };
    });
    const request = {
      providerIdentity: "folder:project",
      libraryRevision: "rev-1",
      publication: publication(),
      assets: [{
        path: publication().bibliography[0],
        sha: "sha-1",
        size: 60,
        mimeType: "application/x-bibtex",
      }],
      read,
    };
    const stale = cache.load(request);
    cache.invalidate();
    release();
    await stale;
    expect((await cache.load(request)).fromCache).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
