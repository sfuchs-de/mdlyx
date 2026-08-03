import { expect, test, type Locator, type Page } from "@playwright/test";
import { revealLibraryFile } from "./library-helpers";
import { gotoApp, reloadApp } from "./navigation-helpers";

async function expectInsideViewport(locator: Locator, page: Page, gutter = 7) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(gutter);
  expect(box!.y).toBeGreaterThanOrEqual(gutter);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width - gutter);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height - gutter);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __editor?: unknown }).__editor));
});

async function reloadAtWidth(page: Page, width: number, height = 720) {
  await page.setViewportSize({ width, height });
  await gotoApp(page);
}

async function seedLegacySessionOnNextNavigation(page: Page, session: unknown) {
  // Model an actual v1→v2 upgrade: the legacy snapshot must exist before the
  // incoming application starts. Writing it into the outgoing live app races
  // that page's pagehide IndexedDB flush in WebKit and does not represent a
  // real legacy installation.
  await page.addInitScript((serialized) => {
    localStorage.setItem("mdlyx:session", serialized);
  }, JSON.stringify(session));
}

for (const [width, dismissal] of [[320, "scrim"], [480, "escape"], [760, "close"]] as const) {
  test(`Library is an accessible overlay drawer at ${width}px`, async ({ page }) => {
    await reloadAtWidth(page, width);
    const launcher = page.getByRole("button", { name: "Library", exact: true });
    const library = page.locator("#library");
    const scrim = page.getByRole("button", { name: "Close document library" });

    await expect(launcher).toHaveAttribute("aria-expanded", "false");
    await expect(library).toBeHidden();
    await launcher.click();
    await expect(launcher).toHaveAttribute("aria-expanded", "true");
    await expect(library).toBeVisible();
    await expect(library).toHaveClass(/is-drawer/);
    await expect(scrim).toBeVisible();
    await expectInsideViewport(library, page, 0);

    if (dismissal === "scrim") await scrim.click({ position: { x: width - 4, y: 20 } });
    else if (dismissal === "escape") await page.keyboard.press("Escape");
    else await library.getByRole("button", { name: "Close library" }).click();

    await expect(library).toBeHidden();
    await expect(launcher).toHaveAttribute("aria-expanded", "false");
    await expect(launcher).toBeFocused();
  });
}

test("wide Library remains an in-flow column at 920px", async ({ page }) => {
  await reloadAtWidth(page, 920);
  await expect(page.locator("#library")).toBeVisible();
  await expect(page.locator("#library")).not.toHaveClass(/is-drawer/);
  await expect(page.getByRole("button", { name: "Library", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Close document library" })).toBeHidden();
  await expect(page.getByRole("button", { name: "More tools" })).toBeHidden();
});

for (const width of [390, 430] as const) {
  test(`phone active-document bar replaces horizontal tabs at ${width}px`, async ({ page }) => {
    await reloadAtWidth(page, width, 700);
    await expect(page.locator(".mobile-document-bar")).toBeVisible();
    await expect(page.locator(".tab-scroll")).toBeHidden();
    await expect(page.getByRole("button", { name: "Show editing tools" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test("600px tablet keeps a single toolbar row and full tab strip", async ({ page }) => {
  await reloadAtWidth(page, 600, 700);
  await expect(page.locator(".mobile-document-bar")).toBeHidden();
  await expect(page.locator(".tab-scroll")).toBeVisible();
  const layout = await page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>("#toolbar")!.getBoundingClientRect();
    const file = document.querySelector<HTMLElement>("#btn-file")!.getBoundingClientRect();
    const search = document.querySelector<HTMLElement>("#btn-project-search")!.getBoundingClientRect();
    return { height: toolbar.height, fileTop: file.top, searchTop: search.top };
  });
  expect(layout.height).toBeLessThan(58);
  expect(Math.abs(layout.fileTop - layout.searchTop)).toBeLessThanOrEqual(4);
});

test("display equations use the paper width before becoming scrollable", async ({ page }) => {
  await reloadAtWidth(page, 1280, 820);
  const identities = String.raw`\gamma_2=1-\beta+\delta\sigma,\qquad
\gamma_1=1-\beta-\delta(\sigma-1),\qquad
\gamma_2-\gamma_1=\delta(2\sigma-1),\qquad
\gamma_1+\gamma_2=2+\alpha-\beta`;
  const loadEquation = async (latex: string, numbered = true) => {
    await page.evaluate(({ latex, numbered }) => {
      const suffix = numbered ? "" : " {numbered=false}";
      (window as unknown as { __load: (markdown: string) => void })
        .__load(`$$\n${latex}\n$$${suffix}\n`);
    }, { latex, numbered });
    await expect(page.locator(".math-display .katex")).toBeVisible();
  };
  const layout = () => page.locator(".math-display").evaluate((display) => {
    const body = display.querySelector<HTMLElement>(".math-body")!;
    const number = display.querySelector<HTMLElement>(".math-number");
    const paper = display.closest<HTMLElement>(".ProseMirror")!;
    const bodyRect = body.getBoundingClientRect();
    const numberRect = number?.getBoundingClientRect();
    const paperRect = paper.getBoundingClientRect();
    return {
      clientWidth: body.clientWidth,
      scrollWidth: body.scrollWidth,
      bodyRight: bodyRect.right,
      numberLeft: numberRect?.left ?? null,
      numberRight: numberRect?.right ?? null,
      paperRight: paperRect.right,
    };
  });

  // This real Sample Model identity is near the threshold: it fits the paper, but
  // the former unconditional 2.2rem number gutter produced a 2–17px scrollbar.
  await loadEquation(identities);
  await expect(page.locator(".math-body")).not.toHaveClass(/is-overflowing/);
  const numbered = await layout();
  expect(numbered.scrollWidth).toBeLessThanOrEqual(numbered.clientWidth + 1);
  expect(numbered.numberLeft).not.toBeNull();
  expect(numbered.numberLeft!).toBeGreaterThanOrEqual(numbered.bodyRight);
  expect(numbered.numberRight!).toBeLessThanOrEqual(numbered.paperRight + 1);
  await expect(page.locator(".math-body")).not.toHaveAttribute("role", "region");
  expect(await page.locator(".math-body").evaluate((body) => getComputedStyle(body).overflowY)).toBe("hidden");

  // Equation-size settings change the rendered glyph box without changing the
  // outer paper width. Overflow semantics must follow that content resize.
  await page.evaluate(() => document.documentElement.style.setProperty("--display-math-size", "2rem"));
  await expect(page.locator(".math-body")).toHaveClass(/is-overflowing/);
  await page.evaluate(() => document.documentElement.style.setProperty("--display-math-size", "1.1rem"));
  await expect(page.locator(".math-body")).not.toHaveClass(/is-overflowing/);

  // Unnumbered display math gets the same full measure rather than reserving an
  // empty number gutter.
  await loadEquation(identities, false);
  const unnumbered = await layout();
  expect(unnumbered.scrollWidth).toBeLessThanOrEqual(unnumbered.clientWidth + 1);
  await expect(page.locator(".math-number")).toHaveCount(0);

  // Genuine overflow remains scrollable, and its pinned equation number does
  // not move with the formula viewport.
  await loadEquation(`${identities}\\qquad ${identities}`);
  const longBody = page.locator(".math-body");
  await expect(longBody).toHaveClass(/is-overflowing/);
  await expect(longBody).toHaveAttribute("role", "region");
  const before = await longBody.evaluate((body) => ({
    clientWidth: body.clientWidth,
    scrollWidth: body.scrollWidth,
    numberLeft: body.parentElement!.querySelector(".math-number")!.getBoundingClientRect().left,
  }));
  expect(before.scrollWidth).toBeGreaterThan(before.clientWidth + 1);
  await longBody.evaluate((body) => { body.scrollLeft = body.scrollWidth; });
  const afterNumberLeft = await page.locator(".math-number").evaluate((number) =>
    number.getBoundingClientRect().left);
  expect(afterNumberLeft).toBeCloseTo(before.numberLeft, 1);
});

test("mobile File menu stays inside the viewport and supports menu-key navigation", async ({ page }) => {
  await reloadAtWidth(page, 320, 568);
  const trigger = page.getByRole("button", { name: /File/ });
  await trigger.focus();
  await trigger.press("ArrowDown");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem").last()).toBeFocused();
  const overflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("Library entries stay compact and reserve persistent metadata for useful state", async ({ page }) => {
  await reloadAtWidth(page, 920);
  await page.evaluate(() => (window as unknown as { __mockLibrary: () => Promise<void> }).__mockLibrary());
  const disclosure = page.locator('.lib-group-section[data-group-key="gravity-trade"] > .lib-group-head');
  await expect(disclosure).toContainText("Gravity Trade");
  await disclosure.click();

  const rows = page.locator('.lib-group-section[data-group-key="gravity-trade"] .lib-file');
  const project = page.locator('.lib-group-section[data-group-key="gravity-trade"]');
  await expect(project.locator(".lib-project-mode")).toHaveText([
    "Browse",
    /Attention/,
  ]);
  await expect(project.locator(".lib-project-area > summary")).toContainText([
    "Start here1",
    "Model derivations2",
    "Reference & validation2",
  ]);
  await expect(project.locator(".lib-project-area[open]")).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  await project.locator('.lib-project-area[data-area="model-derivations"] > summary').click();
  await expect(project.locator(".lib-project-subsection-title")).toContainText([
    "Proofs & methods1",
    "Other derivations1",
  ]);
  await expect(project.locator(".lib-project-subsection[open]")).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  const derivation = await revealLibraryFile(page, "wasserstein-ot.md");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator(".lib-file-title")).toHaveCSS("font-weight", "500");
  await expect(page.locator("#library .lib-tag")).toHaveCount(0);
  await expect(derivation).toHaveCSS("height", "36px");
  await expect(derivation.locator(".lib-file-key-results")).toHaveText("1 result");
  await expect(derivation.locator(".lib-meta")).toHaveCount(0);
  await expect(derivation).toHaveAttribute("title", /Kind: derivation/);
  await expect(derivation).toHaveAttribute("title", /Status: review/);
  expect(await rows.evaluateAll((items) => items.every((item) => item.scrollWidth <= item.clientWidth))).toBe(true);

  await rows.first().click();
  await expect(rows.first()).toHaveAttribute("aria-current", "page");
  await expect(rows.first().locator(".lib-file-title")).toHaveCSS("font-weight", "500");
});

test("Library separates synthesis and nested derivation blocks without mounting secondary material", async ({ page }) => {
  const paths = [
    "overview.md",
    "synthesis.md",
    "workbook.md",
    "setting.md",
    "demand.md",
    "equilibrium.md",
    "proof.md",
    "notes.md",
  ];
  const metadata: Record<string, Record<string, unknown>> = {
    "overview.md": { id: "h-overview", title: "Hierarchy Project", contains: ["project-overview"] },
    "synthesis.md": { id: "h-synthesis", title: "Project synthesis", contains: ["synthesis"] },
    "workbook.md": {
      id: "h-workbook",
      title: "Tutorial workbook",
      kind: "notes",
      contains: ["workbook"],
    },
    "setting.md": {
      id: "h-setting",
      title: "Setting and primitives",
      kind: "derivation",
      contains: ["key-document", "derivation-setting"],
    },
    "demand.md": {
      id: "h-demand",
      title: "Demand system",
      kind: "derivation",
      contains: [
        "key-derivation",
        "derivation-demand",
        "results",
        "verification",
      ],
    },
    "equilibrium.md": {
      id: "h-equilibrium",
      title: "Equilibrium closure",
      kind: "derivation",
      contains: ["additional-derivation", "derivation-equilibrium"],
    },
    "proof.md": { id: "h-proof", title: "Auxiliary theorem proof", kind: "proof", contains: [] },
    "notes.md": { id: "h-notes", title: "Meeting notes", kind: "notes", contains: [] },
  };
  await page.route("**/hierarchy-library/**", async (route) => {
    const filename = new URL(route.request().url()).pathname.split("/").pop() ?? "notes.md";
    await route.fulfill({
      status: 200,
      contentType: "text/markdown",
      body: [
        "---",
        `library: ${JSON.stringify({
          ...metadata[filename],
          projects: ["hierarchy"],
          tags: [],
          related: [],
        })}`,
        "---",
        "",
        `# ${filename}`,
      ].join("\n"),
    });
  });
  await page.evaluate(({ paths }) => (
    window as unknown as { __mockLibrary: (folder: string, paths: string[]) => Promise<void> }
  ).__mockLibrary("hierarchy-library", paths), { paths });

  const project = page.locator('.lib-group-section[data-group-key="hierarchy"]');
  await project.locator(":scope > .lib-group-head").click();
  await expect(project.locator(".lib-project-mode")).toHaveText(["Browse", "Attention"]);
  await expect(project.locator(".lib-project-area > summary")).toContainText([
    "Start here1",
    "Synthesis1",
    "Study1",
    "Model derivations4",
    "Supporting documents1",
  ]);
  await expect(project.locator(".lib-project-area[open]")).toHaveCount(0);
  await expect(project.locator(".lib-file")).toHaveCount(0);
  await project.locator('.lib-project-area[data-area="model-derivations"] > summary').click();
  await expect(project.locator(".lib-project-subsection-title")).toContainText([
    "Setting & primitives1",
    "Demand1",
    "Equilibrium1",
    "Proofs & methods1",
  ]);
  await expect(project.locator(".lib-project-subsection[open]")).toHaveCount(0);
  await expect(project.locator(".lib-file")).toHaveCount(0);
  await expect(project.locator(".lib-project-subsection-sequence")).toHaveText([
    "01",
    "02",
    "04",
    "09",
  ]);
  await project.locator(
    '.lib-project-subsection[data-section="setting-primitives"] > summary',
  ).click();
  await expect(project.locator(".lib-file")).toHaveCount(1);
  await project.locator(
    '.lib-project-area[data-area="model-derivations"] > summary',
  ).click();
  await project.locator(
    '.lib-project-area[data-area="model-derivations"] > summary',
  ).click();
  await expect(
    project.locator('.lib-project-subsection[data-section="setting-primitives"]'),
  ).toHaveAttribute("open", "");
  for (const section of ["demand", "equilibrium", "proofs-methods"]) {
    await project.locator(
      `.lib-project-subsection[data-section="${section}"] > summary`,
    ).click();
  }
  await expect(project.locator(".lib-file")).toHaveCount(4);
  await project.locator('.lib-project-area[data-area="start-here"] > summary').click();
  await project.locator('.lib-project-area[data-area="synthesis"] > summary').click();
  await project.locator('.lib-project-area[data-area="study"] > summary').click();
  await project.locator('.lib-project-area[data-area="supporting-documents"] > summary').click();
  await expect(project.locator(".lib-file")).toHaveCount(8);
});

test("Library honors explicit scholarly, frontier, supporting, and reference roles", async ({ page }) => {
  const paths = [
    "index.md",
    "synthesis.md",
    "canonical.md",
    "frontier.md",
    "historical.md",
    "results.md",
    "notation.md",
    "source.md",
    "audit.md",
    "other-reference.md",
    "kind-reference.md",
  ];
  const metadata: Record<string, Record<string, unknown>> = {
    "index.md": {
      id: "roles-index",
      title: "Explicit Roles",
      contains: ["project-overview"],
    },
    "synthesis.md": {
      id: "roles-synthesis",
      title: "Primary synthesis",
      kind: "derivation",
      contains: ["primary-synthesis"],
    },
    "canonical.md": {
      id: "roles-canonical",
      title: "Canonical equilibrium",
      kind: "derivation",
      contains: ["derivation-equilibrium"],
    },
    "frontier.md": {
      id: "roles-frontier",
      title: "Active frontier",
      kind: "derivation",
      contains: ["frontier-document", "open-questions", "derivation-methods"],
    },
    "historical.md": {
      id: "roles-historical",
      title: "Historical derivation",
      kind: "derivation",
      contains: ["supporting-document", "derivation-empirics"],
    },
    "results.md": {
      id: "roles-results",
      title: "Result status",
      contains: ["reference-document", "reference-results", "dependency-graph"],
    },
    "notation.md": {
      id: "roles-notation",
      title: "Notation",
      contains: ["reference-document", "reference-interface"],
    },
    "source.md": {
      id: "roles-source",
      title: "Source authority",
      contains: ["reference-document", "reference-source-map"],
    },
    "audit.md": {
      id: "roles-audit",
      title: "Evidence audit",
      contains: ["reference-document", "reference-evidence"],
    },
    "other-reference.md": {
      id: "roles-other-reference",
      title: "Other reference",
      contains: ["reference-document"],
    },
    "kind-reference.md": {
      id: "roles-kind-reference",
      title: "Reference by kind",
      kind: "reference",
      contains: [],
    },
  };
  const overviewBody = [
    "# Explicit Roles",
    "",
    "## Project summary {#project-summary}",
    "",
    "A fixture for explicit presentation roles.",
    "",
    "## Reading path {#reading-path}",
    "",
    "| Area | Section | Document | Purpose |",
    "| --- | --- | --- | --- |",
    "| Start here | Synthesis | [[roles-synthesis\\|Primary synthesis]] | Read the governing chain. |",
    "| Core model | Equilibrium | [[roles-canonical\\|Canonical equilibrium]] | Follow the proof. |",
    "",
    "## Project priorities {#project-priorities}",
    "",
    "| Task ID | Task | State | Priority | Owner | Related results | Depends on | Exit criterion |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ].join("\n");
  const claimsBody = [
    "## Result dependency manifest {#dependency-graph}",
    "",
    "| Result ID | Result | Owner | Validation | Depends on | Evidence | Remaining condition |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| `R-CANONICAL` | Conditional equilibrium | [[roles-canonical]] | partial |  | Local fixture | Close the global branch. |",
  ].join("\n");
  await page.route("**/explicit-role-library/**", async (route) => {
    const filename = new URL(route.request().url()).pathname.split("/").pop() ?? "index.md";
    const body = filename === "index.md"
      ? overviewBody
      : filename === "results.md"
        ? claimsBody
        : `# ${filename}`;
    await route.fulfill({
      status: 200,
      contentType: "text/markdown",
      body: [
        "---",
        `library: ${JSON.stringify({
          ...metadata[filename],
          projects: ["explicit-roles"],
          tags: [],
          related: [],
        })}`,
        "---",
        "",
        body,
      ].join("\n"),
    });
  });
  await page.evaluate(({ paths }) => (
    window as unknown as { __mockLibrary: (folder: string, paths: string[]) => Promise<void> }
  ).__mockLibrary("explicit-role-library", paths), { paths });

  const project = page.locator('.lib-group-section[data-group-key="explicit-roles"]');
  await project.locator(":scope > .lib-group-head").click();
  await expect(project.locator(".lib-project-area > summary")).toContainText([
    "Start here1",
    "Synthesis1",
    "Model derivations1",
    "Reference & validation6",
    "Open questions1",
    "Supporting documents1",
  ]);
  await project.locator('.lib-project-area[data-area="reference-validation"] > summary').click();
  await expect(project.locator(".lib-project-subsection-title")).toContainText([
    "Result and graph status1",
    "Notation and theorem interfaces1",
    "Provenance and source authority1",
    "Audit and evidence1",
    "Other reference2",
  ]);

  await project.getByRole("button", { name: /Attention/ }).click();
  await expect(project.locator('.lib-file[data-path="canonical.md"]')).toBeVisible();
  await expect(project.locator('.lib-file[data-path="frontier.md"]')).toBeVisible();

  await project.getByRole("button", { name: "Browse", exact: true }).click();
  const canonical = await revealLibraryFile(page, "canonical.md");
  await canonical.click();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("canonical.md");
});

test("Library exposes 20 Sample Model reader documents while retaining 37 support IDs", async ({ page }) => {
  const readerPaths = Array.from({ length: 20 }, (_, index) => `reader-${index}.md`);
  const supportPaths = Array.from({ length: 37 }, (_, index) => `support-${index}.md`);
  const paths = [...readerPaths, ...supportPaths];
  await page.route("**/visibility-library/**", async (route) => {
    const filename = new URL(route.request().url()).pathname.split("/").pop() ?? "reader-0.md";
    const isSupport = filename.startsWith("support-");
    const id = filename.replace(/\.md$/, "");
    await route.fulfill({
      status: 200,
      contentType: "text/markdown",
      body: [
        "---",
        `library: ${JSON.stringify({
          id,
          title: filename === "reader-0.md" ? "Sample Model" : id,
          visibility: isSupport ? "support" : "reader",
          projects: ["sample-model"],
          tags: [],
          contains: filename === "reader-0.md"
            ? ["project-overview"]
            : isSupport
              ? ["supporting-document"]
              : [],
          related: [],
        })}`,
        "---",
        "",
        `# ${id}`,
        "",
        isSupport ? "Historical compatibility evidence." : "Reader-facing mathematics.",
      ].join("\n"),
    });
  });
  await page.evaluate(({ paths }) => (
    window as unknown as { __mockLibrary: (folder: string, paths: string[]) => Promise<void> }
  ).__mockLibrary("visibility-library", paths), { paths });

  await expect(page.locator("#library .lib-list-summary"))
    .toHaveText("20 documents · 37 support files · 1 project");
  const project = page.locator('.lib-group-section[data-group-key="sample-model"]');
  await expect(project.locator(":scope > .lib-group-head"))
    .toHaveAttribute("aria-label", "Sample Model, 20 documents");
  await project.locator(":scope > .lib-group-head").click();
  await project.locator('.lib-project-area[data-area="supporting-documents"] > summary').click();
  await expect(project.locator(".lib-file")).toHaveCount(19);
  await expect(page.locator('[data-path="support-0.md"]')).toHaveCount(0);

  const search = page.getByRole("searchbox", { name: "Search library documents" });
  await search.fill("Historical compatibility evidence");
  await expect(page.locator("#library .lib-file")).toHaveCount(0);
  await search.fill("support-0");
  await expect(page.locator('[data-path="support-0.md"]')).toBeVisible();
  await page.locator('[data-path="support-0.md"]').click();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("support-0.md");
});

test("phone Library header presents one coherent control hierarchy", async ({ page }) => {
  await reloadAtWidth(page, 390, 844);
  await page.evaluate(() => (window as unknown as { __mockLibrary: () => Promise<void> }).__mockLibrary());
  const library = page.locator("#library");

  await expect(library).toBeFocused();
  await expect(library.locator(".lib-source-row")).toContainText("Sample · sample-library");
  await expect(library.locator(".lib-activity")).toBeHidden();
  await expect(library.locator(".lib-head-actions .lib-head-action-label")).toHaveText("More");
  await expect(library.locator('.lib-head-actions[role="group"]')).toHaveAttribute(
    "aria-label",
    "Library actions",
  );
  await library.getByLabel("More library actions").click();
  await expect(library.getByRole("menuitem")).toHaveText([
    "Refresh library",
    "New document",
  ]);
  await library.getByLabel("More library actions").click();
  await expect(library.locator(".lib-controls")).toContainText("By project");
  await expect(library.locator(".lib-project-actions")).toHaveCount(0);
  const project = library.locator(
    '.lib-group-section[data-group-key="gravity-trade"]',
  );
  await project.locator(":scope > .lib-group-head").click();
  await expect(project.locator(".lib-project-workspace-action")).toHaveText([
    "Overview",
    "Graph",
  ]);
  const geometry = await library.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    controls: element.querySelector(".lib-controls")?.getBoundingClientRect().height ?? 0,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.controls).toBeLessThan(110);
});

test("desktop Library top matter remains compact with one coherent action group", async ({ page }) => {
  await reloadAtWidth(page, 920, 720);
  await page.evaluate(() => (window as unknown as { __mockLibrary: () => Promise<void> }).__mockLibrary());
  const library = page.locator("#library");
  const list = library.locator(".lib-list");
  await expect(list).toBeVisible();

  const geometry = await library.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const listBounds = element.querySelector<HTMLElement>(".lib-list")!.getBoundingClientRect();
    const header = element.querySelector<HTMLElement>(".lib-head")!.getBoundingClientRect();
    const actions = [...element.querySelectorAll<HTMLElement>(
      ".lib-head-actions .lib-head-action",
    )].map((action) => action.getBoundingClientRect());
    return {
      topMatterHeight: listBounds.top - bounds.top,
      headerHeight: header.height,
      actionHeights: actions.map((rect) => rect.height),
      toolbarWidth: element.querySelector<HTMLElement>(".lib-head-actions")!
        .getBoundingClientRect().width,
    };
  });
  expect(geometry.topMatterHeight).toBeLessThan(140);
  expect(geometry.headerHeight).toBeLessThan(52);
  expect(new Set(geometry.actionHeights.map(Math.round)).size).toBe(1);
  expect(geometry.toolbarWidth).toBeLessThan(40);
});

test("opening a document dismisses the narrow Library and focuses the editor", async ({ page }) => {
  await reloadAtWidth(page, 480);
  await page.evaluate(() => (window as unknown as { __mockLibrary: () => Promise<void> }).__mockLibrary());
  const row = page.locator('#library .lib-group-section[data-group-key="gravity-trade"] > .lib-group-head');
  await row.click();
  const project = page.locator('#library .lib-group-section[data-group-key="gravity-trade"]');
  await expect(project.locator(".lib-project-area[open]")).toHaveCount(0);
  await page.locator(
    '#library .lib-group-section[data-group-key="gravity-trade"] .lib-project-area[data-area="model-derivations"] > summary',
  ).click();
  await expect(project.locator(".lib-project-area[open]")).toHaveCount(1);
  await (await revealLibraryFile(page, "wasserstein-ot.md")).click();
  await expect(page.locator("#library")).toBeHidden();
  await expect(page.getByRole("button", { name: "Library", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".ProseMirror")).toBeFocused();
});

test("narrow Library keeps focus in the drawer and restores the editor on a wide transition", async ({ page }) => {
  await reloadAtWidth(page, 480);
  const library = page.locator("#library");
  const editorPane = page.locator("#editor-pane");
  await page.getByRole("button", { name: "Library", exact: true }).click();

  await expect(editorPane).toHaveAttribute("inert", "");
  await expect(library).toBeFocused();
  for (let index = 0; index < 20; index += 1) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      const drawer = document.getElementById("library");
      return {
        inside: Boolean(active && drawer?.contains(active)),
        active: active instanceof HTMLElement
          ? `${active.tagName.toLowerCase()}#${active.id}.${active.className}`
          : String(active),
      };
    });
    expect(focus.inside, `Tab ${index + 1} focused ${focus.active}`).toBe(true);
  }

  await page.setViewportSize({ width: 920, height: 720 });
  await expect(editorPane).not.toHaveAttribute("inert", "");
  await expect(library).toBeVisible();
  await expect(library).not.toHaveClass(/is-drawer/);
  await expect(page.getByRole("button", { name: "Close document library" })).toBeHidden();
});

test("a narrow toolbar action dismisses the Library drawer and still opens its panel", async ({ page }) => {
  await reloadAtWidth(page, 480);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator("#library")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();

  await expect(page.locator("#library")).toBeHidden();
  await expect(page.getByRole("button", { name: "Library", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

test("Library visibility preference persists on a narrow device", async ({ page }) => {
  await reloadAtWidth(page, 760);
  const launcher = page.getByRole("button", { name: "Library", exact: true });
  await launcher.click();
  await expect(page.locator("#library")).toBeVisible();
  await reloadApp(page);
  await expect(page.locator("#library")).toBeVisible();

  await page.getByRole("button", { name: "Close library" }).click();
  await reloadApp(page);
  await expect(page.locator("#library")).toBeHidden();
});

test("200% zoom equivalent keeps the two-row toolbar usable", async ({ page }) => {
  // A 760px desktop pane exposes a 380 CSS-pixel layout viewport at 200%.
  // Exercising that effective viewport is stable in both Chromium and WebKit.
  await reloadAtWidth(page, 380, 540);
  for (const name of ["Search projects", "Outline and find", "Library", "Comment inbox, no new activity", "Comments", "Settings", "More tools"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "More tools" }).click();
  await expect(page.getByRole("menuitem", { name: "Table tools" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Document properties" })).toBeVisible();
});

test("narrow toolbar panels stay in view and restore launcher focus", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 540 });

  const searchButton = page.getByRole("button", { name: "Search projects" });
  await searchButton.click();
  const search = page.getByRole("dialog", { name: "Search project documents" });
  await expect(search).toBeVisible();
  await expectInsideViewport(search, page);
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await expect(searchButton).toBeFocused();

  const outlineButton = page.getByRole("button", { name: "Outline and find" });
  await outlineButton.click();
  const outline = page.getByRole("dialog", { name: "Document outline and find" });
  await expect(outline).toBeVisible();
  await expectInsideViewport(outline, page);
  await page.keyboard.press("Escape");
  await expect(outlineButton).toBeFocused();

  await page.getByRole("button", { name: "More tools" }).click();
  const propertiesItem = page.getByRole("menuitem", { name: "Document properties" });
  await expect(propertiesItem).toBeVisible();
  expect(await propertiesItem.evaluate((item) => {
    const rect = item.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === item || item.contains(hit);
  })).toBe(true);
  await propertiesItem.click();
  const properties = page.getByRole("dialog", { name: "Document properties" });
  await expect(properties).toBeVisible();
  await expectInsideViewport(properties, page);
  await page.keyboard.press("Escape");
  const moreButton = page.getByRole("button", { name: "More tools" });
  await expect(moreButton).toBeFocused();

  await moreButton.click();
  await page.getByRole("menuitem", { name: "Table tools" }).click();
  const tableTools = page.getByRole("dialog", { name: "Table tools" });
  await expect(tableTools).toBeVisible();
  await expectInsideViewport(tableTools, page);
  await page.keyboard.press("Escape");
  await expect(moreButton).toBeFocused();
});

test("Settings uses keyboard-accessible persisted sections", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const library = settings.getByRole("tab", { name: "Library" });
  const editor = settings.getByRole("tab", { name: "Editor" });
  await expect(library).toHaveAttribute("aria-selected", "true");
  await library.press("ArrowRight");
  await expect(editor).toHaveAttribute("aria-selected", "true");
  await expect(editor).toBeFocused();
  await settings.getByRole("button", { name: "Close Settings" }).click();

  await reloadApp(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("tab", { name: "Editor" }))
    .toHaveAttribute("aria-selected", "true");
});

test("Settings opens a stored recovery revision as a separate dirty draft", async ({ page }) => {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("mdlyx", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("state")) {
          request.result.createObjectStore("state");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("state", "readwrite");
      transaction.objectStore("state").put({
        id: "e2e-recovery",
        kind: "github-conflict",
        name: "proof.md",
        path: "derivations/proof.md",
        text: "# Recovered proof\n\nLocal conflict text.",
        createdAt: Date.now(),
        documentRevision: 7,
      }, "recovery:e2e-recovery");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });

  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Data" }).click();
  await expect(settings.getByRole("listitem")).toContainText("proof.md");
  await settings.getByRole("button", { name: "Open copy" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator("#file-status")).toHaveText("Changes pending");
  const serialized = await page.evaluate(() => (window as any).__serialize());
  expect(serialized).toContain("# Recovered proof");
  expect(serialized).toContain("Local conflict text.");
});

test("appearance supports persistent light, dark, and system themes", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Editor" }).click();

  await settings.getByRole("button", { name: "Theme: Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "dark");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#171717");
  await expect(page.locator(".ProseMirror")).toHaveCSS("background-color", "rgb(29, 29, 29)");
  await expect(page.locator("#library")).toHaveCSS("background-color", "rgb(27, 27, 27)");
  expect(await page.evaluate(() =>
    JSON.parse(localStorage.getItem("mdlyx:config") ?? "{}").theme
  )).toBe("dark");

  await reloadApp(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".ProseMirror")).toHaveCSS("color", "rgb(238, 234, 226)");

  await page.getByRole("button", { name: "Settings" }).click();
  const reopened = page.getByRole("dialog", { name: "Settings" });
  await reopened.getByRole("tab", { name: "Editor" }).click();
  await expect(reopened.getByRole("button", { name: "Theme: Dark" }))
    .toHaveAttribute("aria-pressed", "true");
  await reopened.getByRole("button", { name: "Theme: Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".ProseMirror")).toHaveCSS("background-color", "rgb(255, 255, 255)");
});

test("Writing guide is searchable, keyboard-accessible, and restores focus", async ({ page }) => {
  await reloadAtWidth(page, 920);
  const launcher = page.getByRole("button", { name: "Writing guide" });
  await launcher.click();
  const guide = page.getByRole("dialog", { name: "Writing guide" });
  await expect(guide).toBeVisible();
  await expect(launcher).toHaveAttribute("aria-expanded", "true");

  const search = guide.getByRole("searchbox", { name: "Search the writing guide" });
  await expect(search).toBeFocused();
  await search.fill("wiki anchor");
  await expect(guide.getByRole("heading", { name: "Document anchor link" })).toBeVisible();
  await expect(guide.getByRole("heading", { name: "Citation" })).toBeHidden();
  await expect(guide.getByRole("status")).toHaveText("1 topic");

  await page.keyboard.press("Escape");
  await expect(guide).toBeHidden();
  await expect(launcher).toBeFocused();

  await page.keyboard.press("F1");
  await expect(guide).toBeVisible();
  await page.keyboard.press("F1");
  await expect(guide).toBeHidden();
});

test("Writing guide uses the shared mobile sheet from More", async ({ page }) => {
  await reloadAtWidth(page, 390, 700);
  await page.getByRole("button", { name: "More tools" }).click();
  await page.getByRole("menuitem", { name: "Writing guide" }).click();
  const guide = page.getByRole("dialog", { name: "Writing guide" });
  await expect(guide).toBeVisible();
  await expect(guide).toHaveAttribute("data-panel-layout", "sheet");
  await expectInsideViewport(guide, page);
  await expect(guide.getByRole("button", { name: "Close panel" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await guide.getByRole("button", { name: "Close panel" }).click();
  await expect(guide).toBeHidden();
  await expect(page.getByRole("button", { name: "More tools" })).toBeFocused();
});

test("compact status exposes details without repeating the tab filename", async ({ page }) => {
  const status = page.locator("#file-status");
  await expect(status).toHaveText("Changes pending");
  await expect(status).toHaveAttribute("aria-label", /untitled\.md/);
  await page.locator(".ProseMirror p").first().click({ position: { x: 4, y: 8 } });
  await page.keyboard.type("changed ");
  await expect(status).toHaveText("Changes pending");
  await expect(status).toHaveAttribute("title", /untitled\.md.*changes pending/i);
});

test("tab overview searches paths and bulk-closes with one confirmation", async ({ page }) => {
  await seedLegacySessionOnNextNavigation(page, {
    tabs: [
      { name: "active.md", path: "project/active.md", text: "active\n", dirty: false },
      { name: "index.md", path: "notes/index.md", text: "dirty\n", dirty: true },
      { name: "saved.md", path: "archive/saved.md", text: "saved\n", dirty: false },
    ],
    activeIndex: 0,
  });
  await reloadApp(page);

  await page.getByRole("button", { name: "View all open tabs" }).click();
  const overview = page.getByRole("dialog", { name: "Open tabs" });
  await overview.getByRole("searchbox", { name: "Find an open tab" }).fill("notes/");
  await expect(overview.getByRole("button", { name: /Open notes\/index\.md/ })).toHaveCount(1);
  await overview.getByRole("button", { name: "Close others" }).click();
  const confirmation = page.locator(".dialog-overlay");
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("1 tab");
  await page.locator(".dialog-confirm").click();
  await expect(page.locator("#tab-bar .tab")).toHaveCount(1);
  await expect(page.locator("#tab-bar .tab.is-active")).toHaveAttribute("aria-label", "project/active.md");
});

test("18 restored tabs keep the active tab contained through Library layout changes", async ({ page }) => {
  await page.setViewportSize({ width: 920, height: 720 });
  await seedLegacySessionOnNextNavigation(page, {
    tabs: Array.from({ length: 18 }, (_, index) => ({
      name: `document-${String(index).padStart(2, "0")}-long-name.md`,
      path: `project-${index % 3}/document-${String(index).padStart(2, "0")}-long-name.md`,
      text: `Document ${index}\n`,
      dirty: false,
    })),
    activeIndex: 17,
  });
  await reloadApp(page);
  await expect(page.locator("#tab-bar .tab")).toHaveCount(18);

  const activeIsContained = () => page.locator("#tab-bar .tab.is-active").evaluate((active) => {
    const scroller = active.closest(".tab-scroll");
    if (!(scroller instanceof HTMLElement)) return false;
    const tabBox = active.getBoundingClientRect();
    const scrollBox = scroller.getBoundingClientRect();
    return tabBox.left >= scrollBox.left - 1 && tabBox.right <= scrollBox.right + 1;
  });
  await expect.poll(activeIsContained).toBe(true);

  const library = page.getByRole("button", { name: "Library", exact: true });
  await library.click();
  await expect.poll(activeIsContained).toBe(true);
  await library.click();
  await expect.poll(activeIsContained).toBe(true);

  await page.getByRole("button", { name: "View all open tabs" }).click();
  const overview = page.getByRole("dialog", { name: "Open tabs" });
  await overview.getByRole("searchbox", { name: "Find an open tab" }).fill("project-1/document-10");
  await overview.getByRole("button", { name: /Open project-1\/document-10-long-name\.md/ }).click();
  await expect(page.locator("#tab-bar .tab.is-active")).toHaveAttribute(
    "aria-label",
    "project-1/document-10-long-name.md",
  );
  await expect.poll(activeIsContained).toBe(true);
});
