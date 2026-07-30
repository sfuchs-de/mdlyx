import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as any).__editor));
});

async function selectWord(page: Page, word: string) {
  await page.locator(".ProseMirror").tap();
  await page.evaluate((value) => {
    const text = document.querySelector(".ProseMirror p")?.firstChild;
    if (!(text instanceof Text)) throw new Error("Expected paragraph text");
    const start = text.data.indexOf(value);
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + value.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, word);
}

test("touch chrome has stable sizing and no page-level horizontal overflow", async ({ page }) => {
  const file = page.getByRole("button", { name: /File/ });
  await file.tap();
  await expect(page.getByRole("menu")).toBeVisible();
  const fileBox = await file.boundingBox();
  expect(fileBox?.height).toBeGreaterThanOrEqual(43);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
  await page.keyboard.press("Escape");

  await page.evaluate(() => (window as any).__load("$$\nx^2+y^2=z^2\n$$\n"));
  const math = page.locator(".math-body");
  await expect(math).not.toHaveClass(/is-overflowing/);
  await expect(math).not.toHaveAttribute("role", "region");
  expect(await math.evaluate((element) => getComputedStyle(element).overflowY)).toBe("hidden");
});

test("phone chrome stays compact and gives the document the first screen", async ({ page }) => {
  await page.evaluate(() => (window as any).__load("# Compact title\n\nBody text.\n"));
  const toolbar = page.locator("#toolbar");
  const tabs = page.locator("#tab-bar");
  const file = page.getByRole("button", { name: /File/ });
  const search = page.getByRole("button", { name: "Search projects" });
  const host = page.locator("#editor-host");
  const paper = page.locator(".ProseMirror");

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => {
      const box = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, height: box.height };
    };
    return {
      toolbar: rect("#toolbar"),
      tabs: rect("#tab-bar"),
      file: rect("#btn-file"),
      search: rect("#btn-project-search"),
      host: rect("#editor-host"),
      paper: rect(".ProseMirror"),
    };
  });

  expect(geometry.toolbar.height).toBeLessThan(80);
  expect(geometry.tabs.height).toBeLessThan(53);
  expect(Math.abs(geometry.file.top - geometry.search.top)).toBeLessThanOrEqual(3);
  expect(geometry.paper.top - geometry.host.top).toBeLessThan(8);
  await expect(toolbar).toBeVisible();
  await expect(tabs).toBeVisible();
  await expect(file).toBeVisible();
  await expect(search).toBeVisible();
  const typography = await page.evaluate(() => {
    const input = document.createElement("input");
    document.body.append(input);
    const inputSize = Number.parseFloat(getComputedStyle(input).fontSize);
    input.remove();
    return {
      body: Number.parseFloat(getComputedStyle(document.querySelector(".ProseMirror")!).fontSize),
      heading: Number.parseFloat(getComputedStyle(document.querySelector(".ProseMirror h1")!).fontSize),
      touchAction: getComputedStyle(document.querySelector("#app")!).touchAction,
      inputSize,
    };
  });
  expect(typography.body).toBeCloseTo(13.76, 1);
  expect(typography.heading).toBeLessThanOrEqual(25);
  expect(typography.touchAction).toBe("manipulation");
  // iOS magnifies focused form fields below 16px. Keep controls safe even
  // though the document typography itself is intentionally more compact.
  expect(typography.inputSize).toBeGreaterThanOrEqual(16);

  await page.getByRole("button", { name: "New tab" }).tap();
  await expect(page.locator(".mobile-document-count")).toHaveText("2 open");
  await page.getByRole("button", { name: "View all open tabs" }).tap();
  await expect(page.getByRole("dialog", { name: "Open tabs" })).toBeVisible();
  await expect(page.locator(".tab-overview-item")).toHaveCount(2);
  await page.getByRole("button", { name: "Close open tabs menu" }).tap();
  await expect(paper).toBeVisible();
});

test("reading scroll collapses and deliberately reveals the phone toolbar", async ({ page }) => {
  const paragraphs = Array.from({ length: 40 }, (_, index) => `Paragraph ${index} gives the document enough reading depth.`);
  await page.evaluate((markdown) => (window as any).__load(markdown), paragraphs.join("\n\n"));
  const host = page.locator("#editor-host");
  await host.evaluate((element) => { element.scrollTop = 55; element.dispatchEvent(new Event("scroll")); });
  await expect(page.locator("#app")).toHaveClass(/mobile-chrome-collapsed/);
  await expect(page.locator("#toolbar")).toHaveAttribute("aria-hidden", "true");
  await page.getByRole("button", { name: "Show editing tools" }).tap();
  await expect(page.locator("#app")).not.toHaveClass(/mobile-chrome-collapsed/);
  await expect(page.locator("#toolbar")).toHaveAttribute("aria-hidden", "false");
  await host.evaluate((element) => {
    element.scrollTop += 50;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator("#app")).toHaveClass(/mobile-chrome-collapsed/);
  await host.evaluate((element) => {
    element.scrollTop -= 16;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator("#app")).not.toHaveClass(/mobile-chrome-collapsed/);
});

test("phone display equations fit near misses before exposing horizontal scroll", async ({ page }) => {
  await page.evaluate(() => (window as any).__load(String.raw`$$
\prod_{i=1}^{n}(1+x_i)+\sum_{j=1}^{m}\frac{\alpha_j\beta_j}{1+\gamma_j}
$$
`));
  const body = page.locator(".math-body");
  await page.evaluate(() => document.documentElement.style.setProperty("--display-math-size", "0.72rem"));
  await expect(body).not.toHaveClass(/is-overflowing/);
  const nearSize = await body.evaluate(async (element) => {
    for (let size = 0.75; size <= 2.5; size += 0.025) {
      document.documentElement.style.setProperty("--display-math-size", `${size}rem`);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (element.classList.contains("is-fitted") && !element.classList.contains("is-overflowing")) {
        return size;
      }
    }
    return null;
  });
  expect(nearSize).not.toBeNull();
  await expect(body).toHaveClass(/is-fitted/);
  await expect(body).not.toHaveClass(/is-overflowing/);
  await expect(body).not.toHaveAttribute("role", "region");
  expect(await body.evaluate((element) =>
    Number.parseFloat(element.style.getPropertyValue("--math-fit-factor")),
  )).toBeGreaterThanOrEqual(0.88);

  const overflowSize = await body.evaluate(async (element, fittedSize) => {
    // Font metrics differ slightly between the local and hosted Chromium
    // builds. Find the first *observed* overflow instead of assuming that a
    // fixed percentage increase must cross the fitter's 12% floor.
    const step = Math.max(0.05, fittedSize * 0.1);
    for (let size = fittedSize + step; size <= 6; size += step) {
      document.documentElement.style.setProperty("--display-math-size", `${size}rem`);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (element.classList.contains("is-overflowing")) return size;
    }
    return null;
  }, nearSize!);
  expect(overflowSize).not.toBeNull();
  await expect(body).toHaveClass(/is-overflowing/);
  await expect(body).toHaveAttribute("aria-label", "Scrollable display equation");
});

test("overview document groups keep compact type with full touch rows", async ({ page }) => {
  await page.waitForFunction(() => Boolean((window as any).__mockLibrary));
  await page.evaluate(() => (window as any).__mockLibrary());
  const project = page.locator(
    '#library .lib-group-section[data-group-key="gravity-trade"]',
  );
  const projectDisclosure = project.locator(":scope > .lib-group-head");
  if (await projectDisclosure.getAttribute("aria-expanded") !== "true") {
    await projectDisclosure.tap();
  }
  await project.locator('[data-project-action="overview"]').tap();

  const overview = page.locator("#project-overview");
  await overview.locator(".overview-document-disclosure").filter({ hasText: "Key documents" })
    .locator("summary").click();
  const link = overview.locator(".overview-document-list .overview-document-link").first();
  await expect(link).toBeVisible();
  const sizes = await overview.evaluate((root) => ({
    heading: Number.parseFloat(getComputedStyle(root.querySelector(".overview-document-group .overview-section-title")!).fontSize),
    link: Number.parseFloat(getComputedStyle(root.querySelector(".overview-document-link")!).fontSize),
  }));
  expect(sizes.link).toBeLessThan(sizes.heading);
  const box = await link.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(43);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
});

test("project view tabs are embedded and retain full touch targets", async ({ page }) => {
  await page.waitForFunction(() => Boolean((window as any).__mockLibrary));
  await page.evaluate(() => (window as any).__mockLibrary());
  const library = page.locator("#library");
  if (!(await library.isVisible())) {
    await page.getByRole("button", { name: "Library", exact: true }).tap();
  }

  const project = library.locator('.lib-group-section[data-group-key="gravity-trade"]');
  const disclosure = project.locator(":scope > .lib-group-head");
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.tap();

  const modes = project.locator(".lib-project-modes");
  await expect(modes).toBeVisible();
  await expect(modes.locator(".lib-project-mode")).toHaveText([
    "Browse",
    /Attention/,
  ]);
  await expect(modes.locator(".lib-project-workspace-action")).toHaveText([
    "Overview",
    "Graph",
  ]);
  await expect.poll(() => modes.evaluate((control) => {
    const buttons = [...control.querySelectorAll<HTMLElement>(".lib-project-mode")];
    const selected = control.querySelector<HTMLElement>('.lib-project-mode[aria-pressed="true"]');
    const controlStyle = getComputedStyle(control);
    return {
      background: controlStyle.backgroundColor,
      borderTop: controlStyle.borderTopWidth,
      borderBottom: controlStyle.borderBottomWidth,
      minButtonHeight: Math.min(...buttons.map((button) => button.getBoundingClientRect().height)),
      selectedUnderline: selected ? getComputedStyle(selected, "::after").height : "0px",
      fits: control.scrollWidth <= control.clientWidth,
    };
  })).toMatchObject({
    background: "rgba(0, 0, 0, 0)",
    borderTop: "0px",
    borderBottom: "1px",
    selectedUnderline: "2px",
    fits: true,
  });
  await expect.poll(() => modes.evaluate((control) =>
    Math.min(
      ...[...control.querySelectorAll<HTMLElement>(
        ".lib-project-mode, .lib-project-workspace-action",
      )]
        .map((button) => button.getBoundingClientRect().height),
    )
  )).toBeGreaterThanOrEqual(44);

  await expect(project.locator(".lib-project-area[open]")).toHaveCount(0);
  const derivations = project.locator('.lib-project-area[data-area="model-derivations"]');
  if (await derivations.getAttribute("open") === null) {
    await derivations.locator(":scope > summary").tap();
  }
  await expect(derivations.locator(".lib-project-subsection-sequence")).toHaveText(["09", "10"]);
  await expect(derivations.locator(".lib-project-subsection[open]")).toHaveCount(0);
  expect(await derivations.locator(".lib-project-subsection > summary").first().evaluate(
    (summary) => summary.getBoundingClientRect().height,
  )).toBeGreaterThanOrEqual(44);
  expect(await library.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("selection actions remain visible and usable with touch targets", async ({ page }) => {
  await page.evaluate(() => (window as any).__load("Relation begins at the edge of this document.\n"));
  await selectWord(page, "Relation");
  const popover = page.locator(".selection-popover");
  await expect(popover).toBeVisible();
  const swatch = popover.getByRole("button", { name: "Highlight blue" });
  const box = await swatch.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(43);
  expect(box?.height).toBeGreaterThanOrEqual(43);
  expect(await popover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const right = left + (viewport?.width ?? window.innerWidth);
    const bottom = top + (viewport?.height ?? window.innerHeight);
    return rect.left >= left + 7 && rect.right <= right - 7
      && rect.top >= top + 7 && rect.bottom <= bottom - 7;
  })).toBe(true);

  const scaleBefore = await page.evaluate(() => window.visualViewport?.scale ?? 1);
  await popover.locator(".sp-note").tap();
  const textarea = popover.locator("textarea");
  await expect(textarea).toBeFocused();
  expect(await textarea.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)))
    .toBeGreaterThanOrEqual(16);
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(scaleBefore);
  await textarea.press("Escape");
  await expect(popover.locator(".sp-composer")).toBeHidden();

  await page.getByRole("button", { name: "Library", exact: true }).tap();
  await expect(page.locator("#library")).toBeVisible();
  await expect(popover).toBeHidden();
  await page.locator("#library").getByRole("button", { name: "Close library" }).tap();
  await expect(popover).toBeVisible();
});

test("an obscured comment draft resets when document identity changes", async ({ page }) => {
  await page.evaluate(() => (window as any).__load("A source selection in the first document.\n"));
  await selectWord(page, "source selection");
  const popover = page.locator(".selection-popover");
  await popover.locator(".sp-note").tap();
  await popover.locator("textarea").fill("unfinished note");

  await page.getByRole("button", { name: "Library", exact: true }).evaluate((button) =>
    (button as HTMLButtonElement).click(),
  );
  await expect(popover).toBeHidden();
  await page.evaluate(() => (window as any).__load("A fresh selection in another document.\n"));
  await page.locator("#library").getByRole("button", { name: "Close library" }).tap();
  await expect(popover).toBeHidden();

  await selectWord(page, "fresh selection");
  await expect(popover.locator(".sp-bar")).toBeVisible();
  await expect(popover.locator(".sp-composer")).toBeHidden();
});

test("a selected internal link opens on the second touch", async ({ page }) => {
  await page.waitForFunction(() => Boolean((window as any).__mockLibrary));
  await page.evaluate(() => (window as any).__mockLibrary());
  const library = page.locator("#library");
  if (await library.isVisible()) {
    await library.getByRole("button", { name: "Close library" }).tap();
  }
  await page.evaluate(() => (window as any).__load("Read [[p2|Proposition 2]].\n"));
  const link = page.locator(".doc-link");
  await link.tap();
  await expect(link).toHaveClass(/ProseMirror-selectednode/);
  await link.tap();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("proposition-2.md");
});

test("a catalog-known result opens its owner on the second touch", async ({ page }) => {
  await page.waitForFunction(() => Boolean((window as any).__mockLibrary));
  await page.evaluate(() => (window as any).__mockLibrary());
  const library = page.locator("#library");
  if (await library.isVisible()) {
    await library.getByRole("button", { name: "Close library" }).tap();
  }
  await page.evaluate(() => (window as any).__load("The argument uses `R-OT-FLOW`.\n"));
  const result = page.locator('[data-result-id="R-OT-FLOW"]');
  await expect(result).toHaveCount(1);
  await result.tap();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).not.toHaveText("wasserstein-ot.md");
  await result.tap();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("wasserstein-ot.md");
});

test("a reference and web link each navigate once on the second touch", async ({ page }) => {
  await page.evaluate(() => {
    const state = window as any;
    state.__touchNavigations = [];
    window.open = ((...args: unknown[]) => {
      state.__touchNavigations.push(["external", ...args]);
      return null;
    }) as typeof window.open;
    Element.prototype.scrollIntoView = function scrollIntoView() {
      const id = (this as HTMLElement).id;
      if (id) state.__touchNavigations.push(["reference", id]);
    };
    state.__load([
      "# Evidence {#sec:evidence}",
      "",
      "See @sec:evidence and [the source](https://example.test/paper).",
    ].join("\n"));
  });

  const reference = page.locator(".xref");
  await reference.tap();
  await expect(reference).toHaveClass(/ProseMirror-selectednode/);
  await reference.tap();

  const external = page.locator('a[href="https://example.test/paper"]');
  await external.tap();
  await external.tap();
  await expect.poll(async () => page.evaluate(() => (window as any).__touchNavigations))
    .toEqual([
      ["reference", "sec:evidence"],
      ["external", "https://example.test/paper", "_blank", "noopener,noreferrer"],
    ]);
});
