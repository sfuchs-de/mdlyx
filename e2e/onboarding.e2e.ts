import { expect, test } from "@playwright/test";
import { revealLibraryFile } from "./library-helpers";

const PATHS = [
  "projects/generated-project/index.md",
  "projects/generated-project/derivations/01-foundations.md",
  "projects/generated-project/synthesis/full-chain.md",
  "projects/generated-project/verification/dependencies.md",
  "projects/generated-project/references/notation.md",
  "projects/generated-project/references/provenance.md",
];

test("a freshly initialized library opens with overview, graph, and stable links", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__editor);
  const mounted = await page.evaluate(({ paths }) => (
    window as unknown as {
      __mockLibrary: (folder: string, files: string[]) => Promise<string>;
    }
  ).__mockLibrary("test-generated-library", paths), { paths: PATHS });
  expect(mounted).toBe("mounted 6 files");

  const library = page.locator("#library");
  await expect(library.locator(".lib-source")).toContainText(
    "Sample · test-generated-library",
  );
  const project = library.locator(
    '.lib-group-section[data-group-key="generated-project"]',
  );
  await expect(project.locator(":scope > .lib-group-head")).toContainText(
    "Generated Research Project",
  );
  await project.locator(":scope > .lib-group-head").click();

  await project.locator('[data-project-action="overview"]').click();
  await expect(page.locator("#project-overview")).toBeVisible();
  await expect(page.locator(".overview-title")).toHaveText("Generated Research Project");
  await expect(page.locator(".overview-status")).toContainText("0 results");
  await expect(page.getByRole("button", { name: "Bibliography" })).toBeVisible();
  await page.getByRole("button", { name: "Back to document" }).click();

  await project.locator('[data-project-action="graph"]').click();
  await expect(page.locator("#project-graph")).toBeVisible();
  await expect(page.locator(".graph-summary")).toContainText("0 results");
  await page.getByRole("button", { name: "Back to document" }).click();

  await (await revealLibraryFile(
    page,
    "projects/generated-project/synthesis/full-chain.md",
  )).click();
  const link = page.locator('.ProseMirror .doc-link[data-target="generated-project-foundations"]');
  await expect(link).toBeVisible();
  await link.dblclick();
  await expect(page.locator(".ProseMirror h1")).toHaveText("Foundations");
});
