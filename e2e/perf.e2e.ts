import { test, expect } from "@playwright/test";

// Builds a 500-inline-equation document in-page.
const BIG_DOC = `(() => {
  const lines = ['# Perf', ''];
  for (let i = 0; i < 500; i++) lines.push('Line ' + i + ': $x_{' + i + '} = \\\\frac{a}{b}$ text.', '');
  return lines.join('\\n');
})()`;

test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => d.dismiss());
  await page.addInitScript(() => { localStorage.removeItem("mdlyx:backup"); localStorage.removeItem("mdlyx:session"); });
  await page.goto("/");
  // Wait for the debug hooks the perf assertions rely on.
  await page.waitForFunction(() => !!(window as any).__load && !!(window as any).__perf);
});

test("editors stay lazy: 500 static equations, exactly one active on edit", async ({
  page,
}) => {
  const t0 = Date.now();
  await page.evaluate((expr) => {
    (window as any).__perf.reset();
    (window as any).__load(eval(expr));
  }, BIG_DOC);
  await expect(page.locator(".math-inline .katex").first()).toBeVisible();
  const loadMs = Date.now() - t0;
  console.log(`load + render 500 inline equations: ${loadMs}ms`);

  // All 500 render as static KaTeX; no heavy editor exists (no MathLive field,
  // no element input, zero active editors tracked).
  expect(await page.locator(".math-inline").count()).toBe(500);
  expect(await page.locator("math-field").count()).toBe(0);
  expect(await page.locator(".ime-input").count()).toBe(0);
  expect(await page.evaluate(() => (window as any).__perf.state.activeMathFields)).toBe(0);

  // Editing one equation creates exactly one active editor (Elements mode → an
  // inline element input; the equation stays a KaTeX render).
  await page.locator(".math-inline").first().click();
  await expect(page.locator(".ime-input")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__perf.state.activeMathFields)).toBe(1);

  // Leaving it tears the editor down again.
  await page.locator("h1").first().click();
  await expect(page.locator(".ime-input")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__perf.state.activeMathFields)).toBe(0);
});

test("typing never reparses the document", async ({ page }) => {
  await page.evaluate((expr) => {
    (window as any).__load(eval(expr));
    (window as any).__perf.reset();
  }, BIG_DOC);

  await page.locator(".ProseMirror p").first().click();
  await page.keyboard.type("hello world");

  // parse must never run on keystrokes (the hard Phase-10 rule).
  expect(await page.evaluate(() => (window as any).__perf.state.parseCount)).toBe(0);
});
