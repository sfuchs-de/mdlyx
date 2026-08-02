import { createHash, webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  leanCertificateBadgeText,
  loadLeanCertificateCatalog,
} from "./lean-certificates";

const encoder = new TextEncoder();
const lean = encoder.encode("namespace Mathdown\ntheorem exact_result : True := by trivial\nend Mathdown\n");
const manifest = encoder.encode('{"packages":[{"name":"mathlib"}]}\n');

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assets(options: {
  digest?: string;
  build?: string;
  buildCommand?: string;
  manifestPath?: string;
  owner?: string;
  coverage?: string;
  sourcePath?: string;
} = {}) {
  const manifestPath = options.manifestPath ?? "formal/lake-manifest.json";
  const sourcePath = options.sourcePath ?? "formal/Mathdown/Proof.lean";
  const map = encoder.encode(`schema_version: 1
environment:
  lean: "4.30.0"
  mathlib: "4.30.0"
  build_command: "${options.buildCommand ?? "lake build --wfail"}"
  root_module: Mathdown
integrity:
  build_state: ${options.build ?? "passed"}
  manifest:
    path: ${manifestPath}
    digest: ${digest(manifest)}
  sources:
    - path: ${sourcePath}
      digest: ${options.digest ?? digest(lean)}
certificates:
  - result_id: R-A
    project: p
    owner: ${options.owner ?? "projects/p/owner.md"}
    coverage: ${options.coverage ?? "partial"}
    status: kernel-checked
    source: ${sourcePath}
    declarations: [Mathdown.exact_result]
    certified_scope: [exact finite identity]
    assumptions: [finite inputs]
    excluded_scope: [economic admissibility]
`);
  return new Map<string, Uint8Array>([
    ["formal/certificate-map.yaml", map],
    [manifestPath, manifest],
    [sourcePath, lean],
  ]);
}

const results = [{ id: "R-A", title: "Exact result", project: "p", ownerId: "owner" }];
const documents = [{ id: "owner", path: "projects/p/owner.md", projects: ["p"] }];

describe("governed Lean certificate catalog", () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
  });

  it("exposes a partial badge only after digests, result, owner, and declaration validate", async () => {
    const values = assets();
    const catalog = await loadLeanCertificateCatalog(
      { read: async (path) => values.get(path)! },
      results,
      documents,
    );
    const evidence = catalog.byResult.get("R-A")!;
    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.buildState).toBe("passed");
    expect(leanCertificateBadgeText(evidence)).toBe("L◐");
    expect(evidence.excludedScope).toEqual(["economic admissibility"]);
    expect(catalog.byOwner.get("owner")).toEqual([evidence]);
  });

  it("suppresses every badge when a source digest is stale", async () => {
    const values = assets({ digest: `sha256:${"0".repeat(64)}` });
    const catalog = await loadLeanCertificateCatalog(
      { read: async (path) => values.get(path)! },
      results,
      documents,
    );
    expect(catalog.byResult.size).toBe(0);
    expect(catalog.diagnostics.join(" ")).toContain("stale certificate digest");
  });

  it("suppresses invalid owner mappings and non-passing builds", async () => {
    const wrongOwner = assets({ owner: "projects/p/other.md" });
    const ownerCatalog = await loadLeanCertificateCatalog(
      { read: async (path) => wrongOwner.get(path)! },
      results,
      documents,
    );
    expect(ownerCatalog.byResult.size).toBe(0);
    expect(ownerCatalog.diagnostics.join(" ")).toContain("owner mapping");

    const failed = assets({ build: "failed" });
    const failedCatalog = await loadLeanCertificateCatalog(
      { read: async (path) => failed.get(path)! },
      results,
      documents,
    );
    expect(failedCatalog.buildState).toBe("failed");
    expect(failedCatalog.byResult.size).toBe(0);
  });

  it("rejects noncanonical build inputs before reading certificate evidence", async () => {
    for (const values of [
      assets({ buildCommand: "lake build" }),
      assets({ manifestPath: "formal/other-manifest.json" }),
      assets({ sourcePath: "formal/Mathdown/Proof.txt" }),
    ]) {
      const catalog = await loadLeanCertificateCatalog(
        { read: async (path) => values.get(path)! },
        results,
        documents,
      );
      expect(catalog.byResult.size).toBe(0);
      expect(catalog.buildState).toBe("invalid");
      expect(catalog.diagnostics).toHaveLength(1);
    }
  });
});
