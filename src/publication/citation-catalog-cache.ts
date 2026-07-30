import type { EffectivePublicationSettings } from "./project-publication";
import {
  CitationCatalog,
  type CitationCatalogSnapshot,
  type CitationDiagnostic,
  type CitationUsage,
} from "./citation-catalog";
import type { LibraryAsset } from "../app/library-assets";

export interface CitationCatalogLoadRequest {
  providerIdentity: string;
  libraryRevision: string;
  publication: EffectivePublicationSettings;
  assets: readonly LibraryAsset[];
  read(path: string): Promise<{ asset: LibraryAsset; bytes: Uint8Array }>;
  usages?: readonly CitationUsage[];
  citedKeys?: readonly string[];
}

export interface CitationCatalogLoadResult {
  snapshot: CitationCatalogSnapshot;
  cacheKey: string;
  fromCache: boolean;
}

interface CachedCatalog {
  snapshot: CitationCatalogSnapshot;
}

const MAX_CACHED_CATALOGS = 12;

/**
 * Provider/revision/SHA-aware catalog cache shared by live rendering and the
 * bibliography workspace. Asset bodies are fetched only when this identity
 * changes; a successful save explicitly invalidates the affected key.
 */
export class CitationCatalogCache {
  private readonly cache = new Map<string, CachedCatalog>();
  private readonly inFlight = new Map<string, {
    generation: number;
    promise: Promise<CachedCatalog>;
  }>();
  private generation = 0;

  invalidate(): void {
    this.generation++;
    this.cache.clear();
    this.inFlight.clear();
  }

  async load(request: CitationCatalogLoadRequest): Promise<CitationCatalogLoadResult> {
    const assetByPath = new Map(request.assets.map((asset) => [asset.path, asset]));
    const bibliographyIdentity = request.publication.bibliography.map((path) => {
      const asset = assetByPath.get(path);
      return `${path}:${asset?.sha ?? `size-${asset?.size ?? "missing"}`}`;
    });
    const cacheKey = JSON.stringify([
      request.providerIdentity,
      request.libraryRevision,
      request.publication.citationStyle,
      bibliographyIdentity,
    ]);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.touch(cacheKey, cached);
      const snapshot = resolveRequest(cached.snapshot, request);
      return {
        snapshot,
        cacheKey,
        fromCache: true,
      };
    }

    const shared = this.inFlight.get(cacheKey);
    if (shared && shared.generation === this.generation) {
      const entry = await shared.promise;
      return {
        snapshot: resolveRequest(entry.snapshot, request),
        cacheKey,
        fromCache: true,
      };
    }

    const generation = this.generation;
    const promise = this.loadUncached(request);
    this.inFlight.set(cacheKey, { generation, promise });
    try {
      const entry = await promise;
      if (generation === this.generation) {
        this.touch(cacheKey, entry);
        while (this.cache.size > MAX_CACHED_CATALOGS) {
          const oldest = this.cache.keys().next().value as string | undefined;
          if (!oldest) break;
          this.cache.delete(oldest);
        }
      }
      return {
        snapshot: resolveRequest(entry.snapshot, request),
        cacheKey,
        fromCache: false,
      };
    } finally {
      const current = this.inFlight.get(cacheKey);
      if (current?.promise === promise) this.inFlight.delete(cacheKey);
    }
  }

  private async loadUncached(request: CitationCatalogLoadRequest): Promise<CachedCatalog> {
    const catalog = new CitationCatalog();
    const diagnostics: CitationDiagnostic[] = [];
    for (const path of request.publication.bibliography) {
      try {
        const source = await request.read(path);
        catalog.addBibTeX(path, new TextDecoder().decode(source.bytes));
      } catch (error) {
        diagnostics.push({
          severity: "error",
          code: "malformed-entry",
          sourcePath: path,
          message: error instanceof Error ? error.message : `Could not read ${path}`,
        });
      }
    }
    const resolved = catalog.resolve([]);
    return {
      snapshot: diagnostics.length
        ? { ...resolved, diagnostics: [...diagnostics, ...resolved.diagnostics] }
        : resolved,
    };
  }

  private touch(key: string, entry: CachedCatalog): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }
}

function resolveRequest(
  snapshot: CitationCatalogSnapshot,
  request: Pick<CitationCatalogLoadRequest, "citedKeys" | "usages">,
): CitationCatalogSnapshot {
  const resolved = resolveCached(snapshot, request.citedKeys ?? []);
  return request.usages ? withUsages(resolved, request.usages) : resolved;
}

function resolveCached(
  snapshot: CitationCatalogSnapshot,
  citedKeys: readonly string[],
): CitationCatalogSnapshot {
  const diagnostics = [...snapshot.diagnostics];
  const knownMissing = new Set(diagnostics
    .filter((item) => item.code === "missing-key")
    .map((item) => item.key));
  for (const key of citedKeys) {
    if (!snapshot.entries.has(key) && !knownMissing.has(key)) {
      diagnostics.push({
        severity: "warning",
        code: "missing-key",
        key,
        message: `Citation key “${key}” is not present in the project bibliography`,
      });
    }
  }
  return { ...snapshot, diagnostics };
}

function withUsages(
  snapshot: CitationCatalogSnapshot,
  usages: readonly CitationUsage[],
): CitationCatalogSnapshot {
  const grouped = new Map<string, CitationUsage[]>();
  for (const usage of usages) {
    const values = grouped.get(usage.key) ?? [];
    values.push(usage);
    grouped.set(usage.key, values);
  }
  return { ...snapshot, usages: new Map(grouped) };
}
