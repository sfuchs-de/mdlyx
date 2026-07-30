import { test, expect, type Page } from "@playwright/test";

// Comprehensive "does entering math feel natural?" suite. These lock in the fixes
// for the reported "\int doesn't feel natural" problems:
//   1. no accidental-prefix glyph flicker while typing a command (`\in` → ∈);
//   2. the editor must not close itself on the autosave/serialize timer;
//   3. clicking away commits + closes the editor;
//   4. an existing command element shows its glyph, not source, when opened.

test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => d.dismiss());
  await page.addInitScript(() => { localStorage.removeItem("mdlyx:backup"); localStorage.removeItem("mdlyx:session"); });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__editor);
});

const load = (page: Page, md: string) =>
  page.evaluate((m) => (window as any).__load(m), md);
const serialize = (page: Page) =>
  page.evaluate(() => (window as unknown as { __serialize: () => string }).__serialize());

// Open a fresh empty inline equation and guarantee the caret is in its input
// (clicking the input avoids the sub-frame focus race a real user never hits).
async function openEmptyInline(page: Page) {
  await load(page, "prose text here\n");
  await page.locator(".ProseMirror p").first().click({ position: { x: 4, y: 8 } });
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+m`);
  await page.locator(".ime-input").waitFor();
  await page.locator(".ime-input").click();
}

const inputState = (page: Page) =>
  page.evaluate(() => {
    const i = document.querySelector(".ime-input") as HTMLInputElement | null;
    return {
      present: !!i,
      value: i?.value,
      // transparent text ⇒ the live glyph is showing beneath the caret overlay
      glyph: i ? getComputedStyle(i).color === "rgba(0, 0, 0, 0)" : null,
      errored: !!document.querySelector(".math-inline .katex-error, .math-inline .math-error"),
    };
  });

test("no prefix flicker: typing \\int shows source through \\in, then settles to ∫", async ({
  page,
}) => {
  await openEmptyInline(page);
  await page.keyboard.type("\\i");
  await page.waitForTimeout(80);
  expect((await inputState(page)).glyph).toBe(false); // source, not a glyph
  await page.keyboard.type("n"); // "\in" IS a valid symbol (∈) — must NOT flash it
  await page.waitForTimeout(80);
  expect((await inputState(page)).glyph).toBe(false);
  await page.keyboard.type("t"); // "\int"
  await page.waitForTimeout(80);
  expect((await inputState(page)).glyph).toBe(false); // still source right after typing
  await page.waitForTimeout(600); // pause → resolve to the glyph
  expect((await inputState(page)).glyph).toBe(true);
});

test("a terminator resolves a command to its glyph immediately (no wait)", async ({
  page,
}) => {
  await openEmptyInline(page);
  await page.keyboard.type("\\alpha"); // still source (ends in a bare command)
  expect((await inputState(page)).glyph).toBe(false);
  await page.keyboard.type("+"); // terminator → resolve at once, well under the settle delay
  await page.waitForTimeout(90);
  const s = await inputState(page);
  expect(s.glyph).toBe(true);
  expect(s.errored).toBe(false);
});

test("an incomplete command shows source and never errors the equation", async ({
  page,
}) => {
  await openEmptyInline(page);
  await page.keyboard.type("\\alp");
  await page.waitForTimeout(600); // even after the settle window
  const s = await inputState(page);
  expect(s.present).toBe(true);
  expect(s.glyph).toBe(false); // can't render → keep showing source
  expect(s.errored).toBe(false);
});

test("the editor stays open while idle (autosave/serialize must not close it)", async ({
  page,
}) => {
  await openEmptyInline(page);
  await page.keyboard.type("x");
  // Past the 500ms serialize debounce — the regression was the editor committing
  // and vanishing here.
  await page.waitForTimeout(900);
  const s = await inputState(page);
  expect(s.present).toBe(true);
  expect(s.value).toBe("x");
});

test("clicking outside the equation commits and closes it", async ({ page }) => {
  await load(page, "first paragraph\n\nsecond paragraph\n");
  await page.locator(".ProseMirror p").first().click({ position: { x: 4, y: 8 } });
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+m`);
  await page.locator(".ime-input").waitFor();
  await page.locator(".ime-input").click();
  await page.keyboard.type("\\alpha");
  // Mouse down in the other paragraph — clearly outside the active equation.
  await page.locator(".ProseMirror p").nth(1).click({ position: { x: 30, y: 8 } });
  await expect(page.locator(".ime-input")).toHaveCount(0);
  expect(await serialize(page)).toContain("$\\alpha$");
});

test("opening an existing command element shows its glyph, not its source", async ({
  page,
}) => {
  await load(page, "$\\int x$\n");
  await page.locator(".math-inline").click();
  await expect(page.locator(".ime-input")).toHaveAttribute("data-render-mode", "glyph");
  const s = await page.evaluate(() => {
    const el = document.querySelector(".mlf-0")!;
    const i = document.querySelector(".ime-input") as HTMLInputElement;
    return {
      showsIntegral: /∫/.test(el.textContent || ""),
      glyph: getComputedStyle(i).color === "rgba(0, 0, 0, 0)",
      value: i.value,
    };
  });
  expect(s.showsIntegral).toBe(true);
  expect(s.glyph).toBe(true);
  expect(s.value).toBe("\\int");
});
