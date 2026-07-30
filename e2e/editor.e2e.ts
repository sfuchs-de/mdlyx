import { test, expect } from "@playwright/test";

// Auto-dismiss the crash-recovery / discard confirm() dialogs so runs are
// deterministic, and clear any backup before the app boots.
test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => d.dismiss());
  await page.addInitScript(() => { localStorage.removeItem("mdlyx:backup"); localStorage.removeItem("mdlyx:session"); });
  await page.goto("/");
  await expect(page.locator("#workspace")).toHaveAttribute("data-app-state", "ready");
});

test("renders the sample document with KaTeX", async ({ page }) => {
  await expect(page.locator(".katex").first()).toBeVisible();
  expect(await page.locator(".katex").count()).toBeGreaterThan(3);
});

test("numbers equations and resolves references", async ({ page }) => {
  const numbers = await page.locator(".math-number").allTextContents();
  expect(numbers).toEqual(["(1.1)", "(1.2)"]);

  const refs = await page.locator(".xref").allTextContents();
  expect(refs).toContain("Equation (1.1)");
  expect(refs).toContain("Equation (1.2)");
  // The intentionally-missing target is flagged.
  await expect(page.locator(".xref-broken")).toHaveText("Equation (??)");
});

test("MathLive mode: click activates a field and commits back to KaTeX", async ({
  page,
}) => {
  // switch Elements → MathLive (mode now lives in the Settings panel; drive it
  // via the debug hook rather than opening the panel)
  await page.evaluate(() => (window as unknown as { __setEditMode: (m: string) => void }).__setEditMode("mathlive"));
  await expect(page.locator("#file-status")).not.toHaveClass(/is-dirty/);

  const firstDisplay = page.locator(".math-display").first();
  await firstDisplay.click();
  await expect(firstDisplay.locator("math-field")).toBeVisible();

  // Click into the body text (paragraph start, not the inline equation that sits
  // mid-paragraph) to blur/commit; then the field is gone again.
  await page.locator(".ProseMirror p").first().click({ position: { x: 4, y: 8 } });
  await expect(page.locator("math-field")).toHaveCount(0);
  await expect(firstDisplay.locator(".katex")).toBeVisible();
  await expect(page.locator("#file-status")).not.toHaveClass(/is-dirty/);
});

test("serializes the document back to Markdown", async ({ page }) => {
  const md = await page.evaluate(() =>
    (window as unknown as { __serialize: () => string }).__serialize(),
  );
  expect(md).toContain("$$");
  expect(md).toContain("{#eq:integral}");
  expect(md).toContain("E = mc^2");
});

test("inserts inline math with the keyboard shortcut", async ({ page }) => {
  // Place the caret in plain text at the paragraph start (its centre sits on the
  // inline equation, which would open that editor instead of inserting a new one).
  await page.locator(".ProseMirror p").first().click({ position: { x: 4, y: 8 } });
  const before = await page.locator(".math-inline").count();
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+m`);
  // A new empty inline equation opens for editing (Elements mode → inline input).
  await expect(page.locator(".math-inline.is-editing .ime-input")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.locator(".math-inline").count()).toBe(before + 1);
});
