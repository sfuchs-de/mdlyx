import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { revealLibraryFile } from "./library-helpers";

async function seriousViolations(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter((violation) =>
    violation.impact === "critical" || violation.impact === "serious"
  ).map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  }));
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await page.waitForFunction(() => !!(window as unknown as { __editor?: unknown }).__editor);
});

test("document editor has no serious automated accessibility violations", async ({ page }) => {
  expect(await seriousViolations(page)).toEqual([]);
});

test("settings remains accessible at narrow reflow", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 720 });
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});

test("project overview evidence groups have no serious accessibility violations", async ({ page }) => {
  await page.waitForFunction(() => Boolean((window as unknown as { __mockLibrary?: unknown }).__mockLibrary));
  await page.evaluate(() => (
    window as unknown as { __mockLibrary: () => Promise<void> }
  ).__mockLibrary());
  const project = page.locator('.lib-group-section[data-group-key="gravity-trade"]');
  await project.locator(":scope > .lib-group-head").click();
  await project.locator('[data-project-action="overview"]').click();
  await expect(page.locator(".overview-evidence")).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});

test("browse project areas have no serious accessibility violations", async ({ page }) => {
  await page.waitForFunction(() => Boolean((window as unknown as { __mockLibrary?: unknown }).__mockLibrary));
  await page.evaluate(() => (
    window as unknown as { __mockLibrary: () => Promise<void> }
  ).__mockLibrary());
  const project = page.locator('.lib-group-section[data-group-key="gravity-trade"]');
  await project.locator(":scope > .lib-group-head").click();
  await project.locator('.lib-project-area[data-area="model-derivations"] > summary').click();
  await expect(project.locator(".lib-project-subsection").first()).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});

test("populated, virtualized project Library has no serious accessibility violations", async ({ page }) => {
  const paths = Array.from({ length: 205 }, (_, index) => `notes/note-${String(index).padStart(3, "0")}.md`);
  await page.route("**/axe-library/**", async (route) => {
    const filename = new URL(route.request().url()).pathname.split("/").pop() ?? "note.md";
    const index = Number(filename.match(/\d+/)?.[0] ?? 0);
    const overview = index === 0;
    await route.fulfill({
      status: 200,
      contentType: "text/markdown",
      body: [
        "---",
        `library: {"id":"axe-${index}","title":"${overview ? "Accessible Project" : "Repeated note"}","projects":["axe-project"],"tags":["accessibility"],"status":"draft","contains":${overview ? '["project-overview"]' : "[]"}}`,
        "---",
        "",
        `# Note ${index}`,
        "",
      ].join("\n"),
    });
  });
  await page.evaluate(({ paths }) => (
    window as unknown as { __mockLibrary: (folder: string, paths: string[]) => Promise<void> }
  ).__mockLibrary("axe-library", paths), { paths });

  const disclosure = page.locator('.lib-group-section[data-group-key="axe-project"] > .lib-group-head');
  await expect(disclosure).toHaveAttribute("aria-label", "Accessible Project, 205 documents");
  await expect(page.locator("#library .lib-file")).toHaveCount(0);
  await disclosure.click();
  await expect(page.locator("#library .lib-file")).toHaveCount(0);
  await page.locator('#library .lib-project-area[data-area="start-here"] > summary').click();
  await page.locator('#library .lib-project-area[data-area="supporting-documents"] > summary').click();
  await expect(page.locator("#library .lib-file")).toHaveCount(121);
  await expect(page.locator("#library .lib-file-context")).toHaveCount(120);
  await expect(page.locator("#library .lib-file").nth(1))
    .toHaveAccessibleName("Repeated note, notes/note-001.md");
  await expect(page.locator(
    '#library .lib-project-area[data-area="supporting-documents"] .lib-file',
  ).first().locator(".lib-sr-only"))
    .toContainText("Document 1 of 204");
  await expect(page.locator(
    '#library .lib-project-area[data-area="supporting-documents"] .lib-file',
  ).last().locator(".lib-sr-only"))
    .toContainText("Document 120 of 204");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.locator("#library-filters")).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  const last = await revealLibraryFile(page, paths.at(-1)!);
  await expect(last.locator(".lib-sr-only")).toContainText("Document 204 of 204");
  expect(await page.locator("#library .lib-file").count()).toBeLessThanOrEqual(150);
});
