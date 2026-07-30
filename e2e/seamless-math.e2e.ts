import { test, expect, type Page } from "@playwright/test";

// Seamless, click-free traversal: arrowing the caret into an inline equation
// opens the editor at the entering edge; arrowing back out returns to text.
test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => d.dismiss());
  await page.addInitScript(() => { localStorage.removeItem("mdlyx:backup"); localStorage.removeItem("mdlyx:session"); });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__editor);
  await page.evaluate(() => {
    (window as any).__load("before $x^2$ after\n");
  });
});

// Place the DOM caret right before the inline equation, so the next ArrowRight
// is the keystroke that steps onto it. Avoids headless Home/arrow drift.
async function caretBeforeEquation(page: Page) {
  await page.locator(".ProseMirror").click();
  await page.evaluate(() => {
    const p = document.querySelector(".ProseMirror p") as HTMLElement;
    const textNode = p.firstChild as Text; // the "before " text node
    const range = document.createRange();
    range.setStart(textNode, textNode.length); // just before the equation
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.querySelector(".ProseMirror")!.dispatchEvent(
      new Event("selectionchange", { bubbles: true }),
    );
  });
}

test("arrowing into an inline equation opens the element editor without a click", async ({
  page,
}) => {
  await caretBeforeEquation(page);
  expect(await page.locator(".ime-input").count()).toBe(0);

  await page.keyboard.press("ArrowRight");

  // Elements mode (default): the equation stays a real KaTeX render and a
  // transparent element input appears — no MathLive field, no design swap.
  await expect(page.locator(".math-inline.is-editing .ime-render .katex")).toBeVisible();
  await expect(page.locator(".ime-input")).toBeVisible();
  expect(await page.locator("math-field").count()).toBe(0);
});

test("the active element input is borderless (imperceptible swap)", async ({
  page,
}) => {
  await caretBeforeEquation(page);
  await page.keyboard.press("ArrowRight");
  const input = page.locator(".ime-input");
  await expect(input).toBeVisible();
  const border = await input.evaluate(
    (el) => getComputedStyle(el).borderTopWidth,
  );
  expect(border).toBe("0px");
});
