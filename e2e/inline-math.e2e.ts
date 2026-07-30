import { test, expect } from "@playwright/test";

// Fluid element-by-element editing (Elements mode, the default): the equation
// stays a single real KaTeX render; only the active element gets a transparent
// input; cursor keys move between elements.
test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => d.dismiss());
  await page.addInitScript(() => { localStorage.removeItem("mdlyx:backup"); localStorage.removeItem("mdlyx:session"); });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__editor);
  await page.evaluate(() => {
    (window as any).__load("$$\n\\frac{a}{b}\n$$\n");
  });
});

const serialize = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    (window as unknown as { __serialize: () => string }).__serialize(),
  );

test("clicking an equation edits it in place as a real KaTeX render", async ({
  page,
}) => {
  await page.locator(".math-display").first().click();

  // Still a KaTeX render (design unchanged), with a transparent element input
  // and NO MathLive field.
  await expect(page.locator(".math-display.is-editing .ime-render .katex")).toBeVisible();
  await expect(page.locator(".ime-input")).toHaveAttribute("data-positioned", "true");
  expect(await page.locator("math-field").count()).toBe(0);

  // First element (numerator "a") is active.
  await expect(page.locator(".ime-input")).toHaveValue("a");
});

test("cursor keys move between elements; edits commit", async ({ page }) => {
  await page.locator(".math-display").first().click();
  const input = page.locator(".ime-input");
  await expect(input).toBeVisible();

  // Edit the numerator a → x, then arrow to the denominator.
  await input.fill("x");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".ime-input")).toHaveValue("b"); // now on denominator

  await page.keyboard.press("Escape");
  expect(await serialize(page)).toContain("\\frac{x}{b}");
});

test("display-mode overlay stays aligned to its element (after centering settles)", async ({
  page,
}) => {
  // A wider display equation so mis-centering would be obvious.
  await page.evaluate(() =>
    (window as any).__load("$$\n\\int_0^1 \\frac{x^2}{\\sqrt{n}}\\,dx = 1\n$$\n"),
  );
  await page.locator(".math-display").click();
  await expect(page.locator(".ime-input")).toBeVisible();
  await page.waitForTimeout(500); // let font load / centering settle

  const { dx, dy } = await page.evaluate(() => {
    const box = (s: string) => document.querySelector(s)?.getBoundingClientRect();
    const input = box(".ime-input")!;
    const leaf = box(".math-display .mlf-0")!;
    return { dx: Math.abs(input.left - leaf.left), dy: Math.abs(input.top - leaf.top) };
  });
  // The input overlay sits on top of its element, not off in the margin.
  expect(dx).toBeLessThan(6);
  expect(dy).toBeLessThan(6);
});

test("clicking a specific element edits only that one", async ({ page }) => {
  await page.locator(".math-display").first().click();
  await expect(page.locator(".ime-input")).toHaveAttribute("data-editor-state", "ready");
  await expect(page.locator(".ime-input")).toBeVisible();

  // Click the tagged denominator leaf directly. The editor keeps coordinate
  // hit-testing for ordinary clicks but exposes an unambiguous leaf target.
  // Dispatch to the structural target itself. A forced pointer click can land
  // on the transparent active-leaf input when the full suite is highly
  // parallel, which tests Playwright's coordinate choice rather than the
  // editor's target resolution.
  await page.locator('[data-math-leaf-index="1"]').dispatchEvent("mousedown");
  await expect(page.locator(".ime-input")).toHaveAttribute("data-active-leaf", "1");
  await expect(page.locator(".ime-input")).toHaveValue("b");
  await page.locator(".ime-input").fill("c");
  await page.keyboard.press("Escape");

  expect(await serialize(page)).toContain("\\frac{a}{c}");
});
