import { test, expect, type Page } from "@playwright/test";

// Multi-dimensional functional audit of the LyX-style math editing.
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

test("inline: click an element, edit it, commit", async ({ page }) => {
  await load(page, "before $x^2$ after\n");
  await page.locator(".math-inline").click();
  const input = page.locator(".ime-input");
  await expect(input).toHaveAttribute("data-editor-state", "ready");
  await expect(input).toBeVisible();
  await input.fill("y");
  await page.keyboard.press("Escape");
  expect(await serialize(page)).toContain("$y^2$");
});

test("display: nested fraction — edit numerator and denominator separately", async ({
  page,
}) => {
  await load(page, "$$\n\\frac{a}{b}\n$$\n");
  await page.locator(".math-display").click();
  await expect(page.locator(".ime-input")).toBeVisible();
  // numerator (leaf 0) then denominator (leaf 1)
  await page.locator(".mlf-0").dispatchEvent("mousedown");
  await page.locator(".ime-input").fill("p");
  await page.locator(".mlf-1").dispatchEvent("mousedown");
  await page.locator(".ime-input").fill("q");
  await page.keyboard.press("Escape");
  expect(await serialize(page)).toContain("\\frac{p}{q}");
});

test("display: an untagged alignment equation edits as a grid (#I14)", async ({
  page,
}) => {
  // No `{env=align}` tag — but the bare `&`/`\\` make it an alignment grid, so it
  // must both render cleanly and edit cell-by-cell (not desync into a flat body).
  await load(page, "$$\nx &= a + b \\\\\ny &= c + d\n$$\n");
  const display = page.locator(".math-display");
  await expect(display.locator(".katex")).toBeVisible();
  await expect(display.locator(".math-error")).toHaveCount(0);
  await display.click();
  await expect(page.locator(".ime-input")).toBeVisible();
  // A grid exposes multiple editable cells (flat parsing would give one run).
  await expect(page.locator(".mlf-1")).toBeVisible();
  await page.locator(".mlf-0").click({ force: true }); // first cell ("x")
  await page.locator(".ime-input").fill("z");
  await page.keyboard.press("Escape");
  const out = await serialize(page);
  expect(out).toContain("z"); // the edit committed
  expect(out).toContain("\\\\"); // row break preserved
  expect(out).not.toContain("env=align"); // stays untagged (byte-honest)
});

test("create structure by typing: a leaf becomes a real fraction", async ({ page }) => {
  await load(page, "$x$\n");
  await page.locator(".math-inline").click();
  await page.locator(".ime-input").fill("\\frac{a}{b}");
  await page.keyboard.press("Escape");
  expect(await serialize(page)).toContain("$\\frac{a}{b}$");
  // Reopen: it's now a structured fraction (2 editable leaves).
  await page.locator(".math-inline").click();
  await expect(page.locator(".mlf-0")).toBeVisible();
  await expect(page.locator(".mlf-1")).toBeVisible();
});

test("scripts: base and exponent are separate elements", async ({ page }) => {
  await load(page, "$m c^2$\n");
  await page.locator(".math-inline").click();
  // leaves: "m" , "c" (base), "2" (exponent) — edit the exponent
  const count = await page.locator(".mlf").count();
  expect(count).toBeGreaterThanOrEqual(3);
});

test("arrow keys move between structural elements", async ({ page }) => {
  await load(page, "$\\frac{a}{b}z$\n");
  await page.locator(".math-inline").click();
  await expect(page.locator(".ime-input")).toHaveValue("a"); // numerator
  await page.keyboard.press("ArrowRight"); // collapse selection to end
  await page.keyboard.press("ArrowRight"); // → next element (denominator)
  await expect(page.locator(".ime-input")).toHaveValue("b");
});

test("MathLive mode: full-field editing works", async ({ page }) => {
  await page.evaluate(() => (window as unknown as { __setEditMode: (m: string) => void }).__setEditMode("mathlive")); // → MathLive
  await load(page, "$$\nE = mc^2\n$$\n");
  await page.locator(".math-display").click();
  await expect(page.locator("math-field")).toHaveCount(1);
  // Click empty page margin (top padding) to blur/commit — not the equation itself.
  await page.locator(".ProseMirror").click({ position: { x: 10, y: 8 } });
  await expect(page.locator("math-field")).toHaveCount(0);
});

test("Cmd/Ctrl-M inserts an empty inline equation, editable", async ({ page }) => {
  await load(page, "type here \n");
  await page.locator(".ProseMirror p").first().click();
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+m`);
  await expect(page.locator(".math-inline.is-editing .ime-input")).toBeVisible();
  await page.locator(".ime-input").fill("\\pi");
  await page.keyboard.press("Escape");
  expect(await serialize(page)).toContain("$\\pi$");
});

test("typing assist: \\frac+space expands to an editable fraction", async ({
  page,
}) => {
  await load(page, "type here \n");
  await page.locator(".ProseMirror p").first().click();
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+m`); // empty inline equation, editing
  await expect(page.locator(".ime-input")).toBeVisible();
  await page.keyboard.type("\\frac"); // then space → skeleton splits into slots
  await page.keyboard.press(" ");
  // #I50: the skeleton now splits live — the active element is the empty numerator
  // (a navigable slot), not one opaque `\frac{}{}` leaf.
  await expect(page.locator(".ime-input")).toHaveValue("");
  await page.keyboard.type("a"); // caret is in the numerator slot
  await page.keyboard.press("Escape");
  expect(await serialize(page)).toContain("$\\frac{a}{}$");
});

test("typing assist: ^ inserts script braces with caret inside", async ({ page }) => {
  await load(page, "$x$\n");
  await page.locator(".math-inline").click();
  const input = page.locator(".ime-input");
  await expect(input).toHaveAttribute("data-editor-state", "ready");
  await expect(input).toBeVisible();
  await input.focus();
  await input.press("End");
  await input.pressSequentially("^");
  // #I50: the script skeleton splits live — the active element is now the empty
  // exponent slot (not one `x^{}` leaf), so the input shows "" and typing fills it.
  await expect(input).toHaveValue("");
  await input.pressSequentially("2");
  await page.keyboard.press("Escape");
  expect(await serialize(page)).toContain("$x^{2}$");
});

test("environment: a matrix is editable per-cell", async ({ page }) => {
  await load(page, "$\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}$\n");
  await page.locator(".math-inline").click();
  await expect(page.locator(".ime-input")).toBeVisible();
  // Four cells → four editable elements.
  expect(await page.locator(".mlf").count()).toBe(4);
  await page.locator(".ime-input").fill("z"); // first cell (a)
  await page.keyboard.press("Escape");
  expect(await serialize(page)).toContain("\\begin{pmatrix}z & b");
});

test("environment: an env=align display equation renders and edits per-cell", async ({
  page,
}) => {
  await load(page, "$$\na &= b \\\\ c &= d\n$$ {#eq:sys env=align}\n");
  await page.locator(".math-display").click();
  await expect(page.locator(".ime-input")).toBeVisible();
  // Renders as a real aligned KaTeX grid (not a bare-& error) with editable cells.
  await expect(page.locator(".math-display .katex").first()).toBeVisible();
  expect(await page.locator(".math-error").count()).toBe(0);
  expect(await page.locator(".mlf").count()).toBeGreaterThanOrEqual(4);
  await page.locator(".ime-input").fill("x"); // first cell
  await page.keyboard.press("Escape");
  const md = await serialize(page);
  expect(md).toContain("env=align");
  expect(md).toContain("x"); // edit landed
  expect(md).not.toContain("\\begin{aligned}"); // stored body-only
});

// The active element shows its source (`\int`, `\alpha`), which is wider than
// the rendered glyph. The equation must reserve that width so the overlay input
// never covers the following element (bug: input ballooned over its neighbours).
test("command element: overlay reflows, does not overflow its neighbour", async ({
  page,
}) => {
  await load(page, "$$\n\\int_0^1 x\\,dx = 1\n$$\n");
  await page.locator(".math-display").click();
  await expect(page.locator(".ime-input")).toBeVisible();
  const gap = await page.evaluate(() => {
    const input = document.querySelector(".ime-input")!.getBoundingClientRect();
    // leaf 1 is the subscript "0" that sits just right of the \int operator.
    const next = document.querySelector(".math-display .mlf-1")!.getBoundingClientRect();
    return next.left - input.right; // ≥ 0 ⇒ the source box made room, no overlap
  });
  expect(gap).toBeGreaterThanOrEqual(0);
});

test("multi-line align: first cell's source reflows the row (no overlap)", async ({
  page,
}) => {
  await load(page, "$$\n\\alpha &= \\beta \\\\ \\gamma &= \\delta\n$$ {env=align}\n");
  await page.locator(".math-display").click();
  await expect(page.locator(".ime-input")).toBeVisible();
  const gap = await page.evaluate(() => {
    const input = document.querySelector(".ime-input")!.getBoundingClientRect();
    // The "=" (leaf right of the active \alpha cell) must clear the input.
    const rects = [...document.querySelectorAll(".math-display .mlf")].map((e) =>
      e.getBoundingClientRect(),
    );
    const rightOfInput = rects
      .filter((r) => Math.abs(r.top - input.top) < 8 && r.left >= input.left + 2)
      .sort((a, b) => a.left - b.left)[0];
    return rightOfInput ? rightOfInput.left - input.right : 999;
  });
  expect(gap).toBeGreaterThanOrEqual(0);
});

// While editing, a complete command renders as its live glyph (LyX-style) rather
// than showing its LaTeX source; an incomplete command shows source safely.
test("active element renders its glyph live (\\int → ∫), not source", async ({
  page,
}) => {
  await load(page, "$\\alpha + x$\n");
  await page.locator(".math-inline").click();
  await expect(page.locator(".ime-input")).toHaveAttribute("data-render-mode", "glyph");
  const state = await page.evaluate(() => {
    const el = document.querySelector(".mlf-0")!;
    const input = document.querySelector(".ime-input")! as HTMLInputElement;
    return {
      leafShowsSymbol: /α/.test(el.textContent || ""), // the rendered glyph
      leafVisible: getComputedStyle(el).visibility === "visible",
      inputTransparent: getComputedStyle(input).color === "rgba(0, 0, 0, 0)",
      inputValue: input.value, // source is still there to edit
    };
  });
  expect(state.leafShowsSymbol).toBe(true);
  expect(state.leafVisible).toBe(true);
  expect(state.inputTransparent).toBe(true); // caret overlay, source hidden
  expect(state.inputValue).toBe("\\alpha");
});

test("typing an incomplete command shows source without erroring the equation", async ({
  page,
}) => {
  await load(page, "type \n");
  await page.locator(".ProseMirror p").first().click();
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+m`);
  await expect(page.locator(".ime-input")).toHaveAttribute("data-positioned", "true");
  await page.keyboard.type("\\alp"); // not yet a valid command
  await expect(page.locator(".ime-input")).toHaveAttribute("data-render-mode", "source");
  const mid = await page.evaluate(() => ({
    errored: !!document.querySelector(".math-inline .katex-error, .math-inline .math-error"),
    inputVisible: getComputedStyle(document.querySelector(".ime-input")!).color !== "rgba(0, 0, 0, 0)",
  }));
  expect(mid.errored).toBe(false); // incomplete source must not break the render
  expect(mid.inputVisible).toBe(true); // and the source is shown so you can finish it
  await page.keyboard.type("ha"); // → \alpha
  await page.keyboard.press("Escape");
  expect(await serialize(page)).toContain("$\\alpha$");
});

test("invalid LaTeX renders an error, does not crash the editor", async ({ page }) => {
  await load(page, "bad $\\frac{$ ok\n");
  await expect(page.locator(".math-error, .katex-error").first()).toBeVisible();
  // editor still responds
  await page.locator(".ProseMirror p").first().click();
  await page.keyboard.type("X");
  expect(await serialize(page)).toContain("X");
});

test("undo reverts a committed math edit", async ({ page }) => {
  await load(page, "$x$\n");
  await page.locator(".math-inline").click();
  await page.locator(".ime-input").fill("y");
  await page.keyboard.press("Escape");
  expect(await serialize(page)).toContain("$y$");
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.locator(".ProseMirror").click();
  await page.keyboard.press(`${mod}+z`);
  expect(await serialize(page)).toContain("$x$");
});
