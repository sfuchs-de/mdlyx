import { describe, expect, it } from "vitest";
import { ProjectCatalogController } from "./project-catalog-controller";

const overview = `---
library: {"id":"index","title":"Index","projects":["p"],"contains":["project-overview"]}
---

## Project summary {#project-summary}

Summary.

## Project priorities {#project-priorities}

| Task ID | Task | State | Priority | Owner | Related results | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- | --- |
`;

describe("ProjectCatalogController", () => {
  it("deduplicates loads and retains the last good snapshot after a failed refresh", async () => {
    let reads = 0;
    let fail = false;
    const controller = new ProjectCatalogController({
      overviewSources: () => [{
        path: "index.md",
        read: async () => {
          reads++;
          if (fail) throw new Error("offline");
          return overview;
        },
      }],
      dependencySources: () => [],
      documents: () => [{
        id: "index",
        title: "Index",
        path: "index.md",
        projects: ["p"],
        contains: ["project-overview"],
        unresolvedCommentCount: 0,
      }],
    });

    const [first, same] = await Promise.all([controller.load(), controller.load()]);
    expect(first.state).toBe("fresh");
    expect(same.snapshot).toBe(first.snapshot);
    expect(reads).toBe(1);

    fail = true;
    const stale = await controller.load(true);
    expect(stale.state).toBe("stale");
    expect(stale.snapshot).toBe(first.snapshot);
    expect(stale.errors[0]).toContain("offline");
  });

  it("does not let an invalidated slow build replace a newer last-good snapshot", async () => {
    let read = 0;
    let releaseSlow: (() => void) | undefined;
    let fail = false;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const sourceWithSummary = (summary: string) => overview.replace("Summary.", summary);
    const controller = new ProjectCatalogController({
      overviewSources: () => [{
        path: "index.md",
        read: async () => {
          read++;
          if (fail) throw new Error("offline");
          if (read === 2) {
            await slowGate;
            return sourceWithSummary("Old in-flight snapshot.");
          }
          return sourceWithSummary(read === 1 ? "Initial snapshot." : "Newest snapshot.");
        },
      }],
      dependencySources: () => [],
      documents: () => [{
        id: "index",
        title: "Index",
        path: "index.md",
        projects: ["p"],
        contains: ["project-overview"],
        unresolvedCommentCount: 0,
      }],
    });

    await controller.load();
    const oldLoad = controller.load(true);
    const newest = await controller.load(true);
    expect(newest.snapshot.overviewByProject.get("p")?.summary).toBe("Newest snapshot.");

    releaseSlow?.();
    const redirectedOld = await oldLoad;
    expect(redirectedOld.snapshot).toBe(newest.snapshot);

    fail = true;
    const stale = await controller.load(true);
    expect(stale.state).toBe("stale");
    expect(stale.snapshot.overviewByProject.get("p")?.summary).toBe("Newest snapshot.");
  });
});
