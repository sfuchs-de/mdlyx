import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeLibrary } from "./library-init";
import { validateLibrary } from "./library-validator";

const roots: string[] = [];

async function library(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "mdlyx-library-validation-"));
  roots.push(parent);
  const root = path.join(parent, "library");
  await initializeLibrary({
    target: root,
    projectKey: "validation-project",
    title: "Validation Project",
  });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("general library validation", () => {
  it("reports duplicate IDs and missing document and anchor targets", async () => {
    const root = await library();
    const foundationsPath = path.join(
      root,
      "projects/validation-project/derivations/01-foundations.md",
    );
    const synthesisPath = path.join(
      root,
      "projects/validation-project/synthesis/full-chain.md",
    );
    const foundations = await readFile(foundationsPath, "utf8");
    const synthesis = await readFile(synthesisPath, "utf8");
    await writeFile(
      synthesisPath,
      synthesis
        .replace('"id":"validation-project-synthesis"', '"id":"validation-project-foundations"')
        .replace(
          "# Project synthesis",
          "# Project synthesis\n\n[[missing-document]]\n\n[[validation-project-foundations#missing-anchor]]",
        ),
      "utf8",
    );
    await writeFile(foundationsPath, foundations.replace("# Foundations", "# Foundations {#foundations}"), "utf8");

    const report = await validateLibrary(root);
    expect(report.valid).toBe(false);
    expect(report.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "duplicate-document-id",
      "missing-document-link",
      "missing-document-anchor",
    ]));
  });

  it("reports task, result, and project-workspace contract errors", async () => {
    const root = await library();
    const overviewPath = path.join(root, "projects/validation-project/index.md");
    const manifestPath = path.join(root, "projects/validation-project/verification/dependencies.md");
    await writeFile(
      overviewPath,
      (await readFile(overviewPath, "utf8")).replace(
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |\n"
          + "| `T-BAD` | Broken task | active | urgent | [[missing-owner]] | `R-MISSING` | `T-NOPE` |  |",
      ),
      "utf8",
    );
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, "utf8")).replace(
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| --- | --- | --- | --- | --- | --- | --- |\n"
          + "| `R-BAD` | Broken result | [[missing-owner]] | certain | `R-NOPE` |  |  |",
      ),
      "utf8",
    );
    const report = await validateLibrary(root);
    expect(report.valid).toBe(false);
    expect(report.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "invalid-task-state",
      "invalid-task-priority",
      "missing-exit-criterion",
      "invalid-validation",
      "missing-document-link",
    ]));
  });

  it("validates effective bibliographies, citation keys, and portable asset paths", async () => {
    const root = await library();
    const overviewPath = path.join(root, "projects/validation-project/index.md");
    const foundationsPath = path.join(
      root,
      "projects/validation-project/derivations/01-foundations.md",
    );
    const bibliographyPath = path.join(
      root,
      "projects/validation-project/references/library.bib",
    );
    await writeFile(
      bibliographyPath,
      "@article{known2026, author={Doe, Jane}, title={Known}, year={2026}}\n",
      "utf8",
    );
    await writeFile(
      foundationsPath,
      `${await readFile(foundationsPath, "utf8")}\n\nKnown [@known2026]. Missing [@unknown2026].\n`,
      "utf8",
    );

    const missing = await validateLibrary(root);
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({
      severity: "error",
      code: "missing-citation-key",
      path: "projects/validation-project/derivations/01-foundations.md",
    }));

    await writeFile(
      overviewPath,
      (await readFile(overviewPath, "utf8"))
        .replace('"bibliography":["references/library.bib"]', '"bibliography":["../../../outside.bib"]'),
      "utf8",
    );
    const unsafe = await validateLibrary(root);
    expect(unsafe.diagnostics).toContainEqual(expect.objectContaining({
      severity: "error",
      code: "unsafe-asset-path",
    }));
  });
});
