import { test, expect, type Page } from "@playwright/test";

// Pasting a Markdown document that carries LLM/ChatGPT-style math should be
// detected and parsed so the equations render, instead of landing as literal
// `\(…\)` / `\[…\]` text.

test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => d.dismiss());
  await page.addInitScript(() => { localStorage.removeItem("mdlyx:backup"); localStorage.removeItem("mdlyx:session"); });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__editor);
});

// Dispatch a real paste event carrying `text/plain`, the way a clipboard paste
// arrives at ProseMirror's handlePaste.
async function pasteText(page: Page, text: string) {
  await load(page, "");
  await page.locator(".ProseMirror").click();
  await page.evaluate((t) => {
    const pm = document.querySelector(".ProseMirror") as HTMLElement;
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    pm.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, text);
}

const load = (page: Page, md: string) =>
  page.evaluate((m) => (window as any).__load(m), md);

test("pasting ChatGPT-style math renders equations, not literal delimiters", async ({
  page,
}) => {
  await pasteText(
    page,
    [
      "## Proposition 2",
      "",
      "For coefficients \\(\\chi_{klm}\\), the flow satisfies",
      "",
      "\\[",
      "\\partial_t \\rho = \\nabla\\cdot\\left( \\rho\\,\\nabla \\frac{\\delta \\mathcal{F}}{\\delta \\rho} \\right)",
      "\\]",
      "",
      "which decreases the energy.",
    ].join("\n"),
  );

  await expect(page.locator(".ProseMirror h2")).toHaveText("Proposition 2");
  // math rendered (KaTeX present), with no errors and no leftover raw delimiters
  await expect(page.locator(".ProseMirror .katex").first()).toBeVisible();
  expect(await page.locator(".ProseMirror .katex-error").count()).toBe(0);
  const text = await page.locator(".ProseMirror").innerText();
  expect(text).not.toContain("\\[");
  expect(text).not.toContain("\\(");
});

test("pasting plain prose is left to the default handler", async ({ page }) => {
  await pasteText(page, "just a line\nand another line, no math here");
  // no math nodes were created
  expect(await page.locator(".ProseMirror .katex").count()).toBe(0);
  await expect(page.locator(".ProseMirror")).toContainText("and another line");
});

test("prose with dollar amounts is NOT hijacked into math", async ({ page }) => {
  await pasteText(page, "Widgets cost $5 and $10 each.\nSecond line here.");
  expect(await page.locator(".ProseMirror .katex").count()).toBe(0);
  // both prices survive intact as literal text
  await expect(page.locator(".ProseMirror")).toContainText("$5 and $10");
});
