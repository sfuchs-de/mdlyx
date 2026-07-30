import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { initializeLibrary } from "./library-init";
import { validateLibrary } from "./library-validator";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "mdlyx-library-init-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("research-library initializer", () => {
  it("creates a neutral, linked library that passes general validation", async () => {
    const parent = await temporaryRoot();
    const target = path.join(parent, "research-library");
    const result = await initializeLibrary({
      target,
      projectKey: "network-model",
      title: "Network Model",
    });

    expect(result.authority).toBe("mdlyx");
    expect(result.gitInitialized).toBe(false);
    expect(result.files).toContain("projects/network-model/index.md");
    expect(result.files).toContain("projects/network-model/references/library.bib");
    const overview = await readFile(path.join(target, "projects/network-model/index.md"), "utf8");
    expect(overview).toContain('"id":"network-model-overview"');
    expect(overview).toContain("[[network-model-synthesis\\|Project synthesis]]");
    expect(overview).not.toContain("__PROJECT_");

    const report = await validateLibrary(target);
    expect(report.valid, report.diagnostics.map((item) => item.message).join("\n")).toBe(true);
    expect(report.summary).toMatchObject({
      documents: 6,
      projects: 1,
      results: 0,
      errors: 0,
      warnings: 0,
      bibliographies: 1,
    });
  });

  it("supports every authority mode without inventing a remote", async () => {
    for (const authority of ["mdlyx", "external", "split"] as const) {
      const parent = await temporaryRoot();
      const target = path.join(parent, authority);
      await initializeLibrary({
        target,
        projectKey: "sample-project",
        title: "Sample Project",
        authority,
      });
      const provenance = await readFile(
        path.join(target, "projects/sample-project/references/provenance.md"),
        "utf8",
      );
      expect(provenance).toContain(`authority mode is **${authority}**`);
      await expect(execFileAsync("git", ["remote"], { cwd: target })).rejects.toThrow();
    }
  });

  it("escapes an authored project title in JSON metadata", async () => {
    const parent = await temporaryRoot();
    const target = path.join(parent, "quoted-title");
    await initializeLibrary({
      target,
      projectKey: "quoted-project",
      title: String.raw`A "Quoted" Model`,
    });
    const overview = await readFile(path.join(target, "projects/quoted-project/index.md"), "utf8");
    expect(overview).toContain(String.raw`"title":"A \"Quoted\" Model"`);
    expect((await validateLibrary(target)).valid).toBe(true);
  });

  it("refuses unsafe keys, filesystem roots, symlinks, and nonempty targets", async () => {
    const parent = await temporaryRoot();
    await expect(initializeLibrary({
      target: path.join(parent, "bad-key"),
      projectKey: "../private",
      title: "Bad key",
    })).rejects.toThrow(/Project keys/);
    await expect(initializeLibrary({
      target: path.parse(parent).root,
      projectKey: "safe-project",
      title: "Bad root",
    })).rejects.toThrow(/filesystem root/);

    const nonempty = path.join(parent, "nonempty");
    await mkdir(nonempty);
    await writeFile(path.join(nonempty, "keep.md"), "keep", "utf8");
    await expect(initializeLibrary({
      target: nonempty,
      projectKey: "safe-project",
      title: "Safe Project",
    })).rejects.toThrow(/must be empty/);
    expect(await readFile(path.join(nonempty, "keep.md"), "utf8")).toBe("keep");
  });

  it("optionally initializes a local main-branch repository with no remote or commit", async () => {
    const parent = await temporaryRoot();
    const target = path.join(parent, "git-library");
    const result = await initializeLibrary({
      target,
      projectKey: "git-project",
      title: "Git Project",
      git: true,
    });
    expect(result.gitInitialized).toBe(true);
    expect((await execFileAsync("git", ["branch", "--show-current"], { cwd: target })).stdout.trim())
      .toBe("main");
    expect((await execFileAsync("git", ["remote"], { cwd: target })).stdout.trim()).toBe("");
    await expect(execFileAsync("git", ["rev-parse", "HEAD"], { cwd: target })).rejects.toThrow();
  });
});
