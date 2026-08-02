import {
  buildDependencyCatalog,
  parseDependencyManifest,
  type DependencyManifestSource,
} from "./dependency-graph";
import {
  buildProjectCatalog,
  parseProjectOverview,
  type ProjectCatalogSnapshot,
  type ProjectDocumentSummary,
} from "./project-overview";
import {
  loadLeanCertificateCatalog,
  type LeanCertificateAssetSource,
} from "./lean-certificates";

export interface ProjectOverviewSource {
  path: string;
  read(): Promise<string>;
}

export interface ProjectCatalogInputs {
  overviewSources(): ProjectOverviewSource[];
  dependencySources(): DependencyManifestSource[];
  documents(): ProjectDocumentSummary[];
}

export interface LeanCertificateLibrary {
  listAssets(): Promise<readonly { path: string }[]>;
  readAsset(path: string): Promise<{ bytes: Uint8Array }>;
}

export async function certificateSource(
  library: LeanCertificateLibrary,
): Promise<LeanCertificateAssetSource | null> {
  let assets;
  try {
    assets = await library.listAssets();
  } catch {
    // External and one-release-old providers may not expose asset indexes.
    return null;
  }
  if (!assets.some((asset) => asset.path === "formal/certificate-map.yaml")) return null;
  return { read: async (path) => (await library.readAsset(path)).bytes };
}

export type ProjectCatalogLoadState = "fresh" | "stale" | "incomplete";

export interface ProjectCatalogLoadResult {
  snapshot: ProjectCatalogSnapshot;
  state: ProjectCatalogLoadState;
  errors: string[];
}

/**
 * One promise-deduplicated project snapshot shared by Overview and Graph. A
 * failed refresh preserves the last complete snapshot instead of replacing it
 * with a misleading partial catalog.
 */
export class ProjectCatalogController {
  private generation = 0;
  private cached: { generation: number; promise: Promise<ProjectCatalogLoadResult> } | null = null;
  private lastGood: ProjectCatalogSnapshot | null = null;

  constructor(
    private readonly inputs: ProjectCatalogInputs,
    private readonly certificateLibrary?: LeanCertificateLibrary,
  ) {}

  invalidate(): void {
    this.generation++;
    this.cached = null;
  }

  load(force = false): Promise<ProjectCatalogLoadResult> {
    if (force) this.invalidate();
    if (this.cached?.generation === this.generation) return this.cached.promise;
    const generation = this.generation;
    const promise = this.build(generation);
    this.cached = { generation, promise };
    return promise;
  }

  private async build(generation: number): Promise<ProjectCatalogLoadResult> {
    const overviewSources = this.inputs.overviewSources();
    const dependencySources = this.inputs.dependencySources();
    const documents = this.inputs.documents();
    const errors: string[] = [];

    const overviewResults = await Promise.all(overviewSources.map(async (source) => {
      try {
        return parseProjectOverview(await source.read(), source.path);
      } catch (error) {
        errors.push(`${source.path}: ${messageOf(error)}`);
        return null;
      }
    }));
    const dependencyResults = await Promise.all(dependencySources.map(async (source) => {
      try {
        return parseDependencyManifest(await source.read(), source.path);
      } catch (error) {
        errors.push(`${source.path}: ${messageOf(error)}`);
        return null;
      }
    }));

    const dependencyCatalog = buildDependencyCatalog(
      dependencyResults.flatMap((parsed) => parsed ? [parsed] : []),
      documents.map(({ id, title }) => ({ id, title })),
    );
    const snapshot = buildProjectCatalog(
      overviewResults.flatMap((parsed) => parsed ? [parsed] : []),
      dependencyCatalog,
      documents,
    );
    try {
      const source = this.certificateLibrary
        ? await certificateSource(this.certificateLibrary)
        : null;
      const certificates = await loadLeanCertificateCatalog(
        source,
        snapshot.dependencyCatalog.results,
        documents,
      );
      snapshot.certificateCatalog = certificates;
      for (const result of snapshot.dependencyCatalog.results) {
        result.certificate = certificates.byResult.get(result.id);
      }
    } catch (error) {
      // Formal evidence is optional. A malformed or unavailable support asset
      // suppresses badges without making the scholarly catalog unusable.
      snapshot.certificateCatalog = {
        byResult: new Map(),
        byOwner: new Map(),
        diagnostics: [`Lean certificates: ${messageOf(error)}`],
        buildState: "invalid",
      };
    }

    // Invalidation can happen while provider reads are in flight. Never let an
    // older generation publish over a newer snapshot (or become its fallback).
    // Resolve old callers with the current generation so every observer sees a
    // coherent catalog after a save/Pull race.
    if (generation !== this.generation) return this.load();

    if (errors.length && this.lastGood) {
      return { snapshot: this.lastGood, state: "stale", errors };
    }
    if (!errors.length) {
      this.lastGood = snapshot;
      return { snapshot, state: "fresh", errors: [] };
    }
    return { snapshot, state: "incomplete", errors };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Could not read project source";
}
