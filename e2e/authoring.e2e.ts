import { expect, test } from "@playwright/test";
import { revealLibraryFile } from "./library-helpers";
import { reloadApp } from "./navigation-helpers";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as unknown as { __editor?: unknown }).__editor);
});

test("scholarly Markdown renders and round-trips without external figure requests", async ({ page }) => {
  let externalRequests = 0;
  page.on("request", (request) => {
    if (request.url() === "https://tracker.invalid/figure.png") externalRequests++;
  });
  const source = [
    "# Evidence {#evidence}",
    "",
    "A result [@smith2024, p. 12] with a note[^proof].",
    "",
    "![Remote](https://tracker.invalid/figure.png){#fig:remote width=70%}",
    "",
    "[^proof]: Checked independently.",
    "",
    "```{=latex}",
    "\\clearpage",
    "```",
  ].join("\n");
  await page.evaluate((markdown) => (window as unknown as { __load: (value: string) => void }).__load(markdown), source);
  await expect(page.locator(".citation")).toHaveText("[@smith2024, p. 12]");
  await expect(page.locator(".footnote-ref")).toBeVisible();
  await expect(page.locator(".document-figure img")).toHaveCount(0);
  await expect(page.locator(".figure-asset-placeholder")).toContainText("External figure source");
  await expect(page.locator(".raw-latex")).toContainText("clearpage");
  expect(externalRequests).toBe(0);
  const serialized = await page.evaluate(() =>
    (window as unknown as { __serialize: () => string }).__serialize(),
  );
  expect(serialized).toContain("[@smith2024, p. 12]");
  expect(serialized).toContain("[^proof]: Checked independently.");
  expect(serialized).toContain("```{=latex}");
});

test("scholarly tools edit a selected figure and preserve source-only widths", async ({ page }) => {
  await page.evaluate(() => (window as any).__load(
    "![Old caption](assets/clock.png){#fig:old width=0.7\\linewidth}",
  ));
  await page.locator(".document-figure").click();
  await page.getByRole("button", { name: "References and publication" }).click();
  const tools = page.getByRole("dialog", { name: "References and publication tools" });
  await expect(tools.getByLabel("Figure asset")).toHaveValue("assets/clock.png");
  await expect(tools.getByLabel("Figure caption")).toHaveValue("Old caption");
  await expect(tools.getByLabel("Figure width")).toHaveValue("0.7\\linewidth");
  await tools.getByLabel("Figure caption").fill("Revised caption");
  await tools.getByLabel("Figure label").fill("fig:revised");
  await tools.getByLabel("Figure width").fill("65%");
  await tools.getByRole("button", { name: "Update selected figure" }).click();

  const serialized = await page.evaluate(() => (window as any).__serialize());
  expect(serialized).toBe(
    "![Revised caption](assets/clock.png){#fig:revised width=65%}\n",
  );
});

test("Markdown details render as disclosures without exposing wrapper tags", async ({ page }) => {
  const source = [
    "# Audit",
    "",
    "<details>",
    "<summary>Full derivation ledger</summary>",
    "",
    "| Result | State |",
    "| --- | --- |",
    "| `R-1` | validated |",
    "",
    "</details>",
  ].join("\n");
  await page.evaluate((markdown) => (window as any).__load(markdown), source);

  const disclosure = page.locator(".ProseMirror details.markdown-details");
  await expect(disclosure).toHaveCount(1);
  await expect(disclosure.locator(":scope > summary")).toHaveText(
    "Full derivation ledger",
  );
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(page.locator(".ProseMirror")).not.toContainText("</details>");

  await disclosure.locator(":scope > summary").click();
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(disclosure.getByRole("table")).toBeVisible();

  const serialized = await page.evaluate(() => (window as any).__serialize());
  expect(serialized).toBe(`${source}\n`);
});

test("scholarly tools resolve labelled blocks and insert references, citations, and footnotes", async ({ page }) => {
  const source = [
    "# Evidence {#sec:evidence}",
    "",
    "![Clock](assets/clock.png){#fig:clock}",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "{#tbl:values caption=\"Values\"}",
    "",
    "::: theorem {Existence} #thm:existence",
    "A solution exists.",
    ":::",
    "",
    "See @fig:clock, @tbl:values, and @thm:existence.",
  ].join("\n");
  await page.evaluate((markdown) => (window as any).__load(markdown), source);
  await expect(page.locator(".xref")).toHaveText([
    "Figure (1)",
    "Table (1)",
    "Theorem (1)",
  ]);

  await page.getByRole("button", { name: "References and publication" }).click();
  const tools = page.getByRole("dialog", { name: "References and publication tools" });
  await tools.getByLabel("Reference target").selectOption("fig:clock");
  await tools.getByRole("button", { name: "Insert reference" }).click();
  await tools.getByLabel("Citation key").fill("smith2024");
  await tools.getByLabel("Citation locator").fill("p. 12");
  await tools.getByRole("button", { name: "Insert citation" }).click();
  await tools.getByLabel("Footnote text").fill("Checked independently.");
  await tools.getByRole("button", { name: "Insert footnote" }).click();

  const serialized = await page.evaluate(() => (window as any).__serialize());
  expect(serialized).toContain("@fig:clock");
  expect(serialized).toContain("[@smith2024, p. 12]");
  expect(serialized).toContain("[^note]");
  expect(serialized).toContain("[^note]: Checked independently.");
});

test("scholarly tools create labels and insert theorem and raw-LaTeX blocks", async ({ page }) => {
  await page.evaluate(() => (window as any).__load([
    "# Main result",
    "",
    "Reference: ",
  ].join("\n")));
  await page.locator(".ProseMirror p").click();
  await page.getByRole("button", { name: "References and publication" }).click();
  const tools = page.getByRole("dialog", { name: "References and publication tools" });
  await expect(tools.getByLabel("Reference target")).toContainText("Create label");
  await tools.getByRole("button", { name: "Insert reference" }).click();
  await tools.getByLabel("Structured block type").selectOption("proposition");
  await tools.getByLabel("Structured block title").fill("Existence");
  await tools.getByLabel("Structured block label").fill("prop:existence");
  await tools.getByRole("button", { name: "Insert structured block" }).click();
  await tools.getByLabel("Raw LaTeX source").fill("\\clearpage");
  await tools.getByRole("button", { name: "Insert raw LaTeX" }).click();

  const serialized = await page.evaluate(() => (window as any).__serialize());
  expect(serialized).toContain("# Main result {#sec:main-result}");
  expect(serialized).toContain("@sec:main-result");
  expect(serialized).toContain("::: proposition {Existence} {#prop:existence}");
  expect(serialized).toContain("```{=latex}");
  expect(serialized).toContain("\\clearpage");
});

test("nested theorem and proof fences render structurally and round-trip exactly", async ({ page }) => {
  const source = [
    ":::: theorem {Existence} {#thm:existence}",
    "A solution exists.",
    "",
    "::: proof",
    "Apply the fixed-point theorem.",
    ":::",
    "",
    "The solution is locally unique.",
    "::::",
  ].join("\n");
  await page.evaluate((markdown) => (window as any).__load(markdown), source);
  const blocks = page.locator(".ProseMirror [data-theorem]");
  await expect(blocks).toHaveCount(2);
  await expect(blocks.first()).toHaveAttribute("data-theorem", "theorem");
  await expect(blocks.nth(1)).toHaveAttribute("data-theorem", "proof");
  await expect(page.locator(".ProseMirror")).not.toContainText("::::");
  const serialized = await page.evaluate(() => (window as any).__serialize());
  expect(serialized).toBe(`${source}\n`);
});

test("scholarly tools edit the selected structured block without changing its fence", async ({ page }) => {
  await page.evaluate(() => (window as any).__load(
    ":::: theorem {Old title} {#thm:old}\nStatement.\n:::::",
  ));
  await page.locator(".ProseMirror [data-theorem] p").click();
  await page.getByRole("button", { name: "References and publication" }).click();
  const tools = page.getByRole("dialog", { name: "References and publication tools" });
  await expect(tools.getByLabel("Structured block title")).toHaveValue("Old title");
  await tools.getByLabel("Structured block type").selectOption("proposition");
  await tools.getByLabel("Structured block title").fill("Revised title");
  await tools.getByLabel("Structured block label").fill("prop:revised");
  await tools.getByRole("button", { name: "Update selected block" }).click();
  const serialized = await page.evaluate(() => (window as any).__serialize());
  expect(serialized).toBe(
    ":::: proposition {Revised title} {#prop:revised}\nStatement.\n:::::\n",
  );
});

test("outline commands restructure whole sections and document numbering is configurable", async ({ page }) => {
  await page.evaluate(() => (window as any).__load([
    "# First",
    "",
    "First body.",
    "",
    "# Second",
    "",
    "## Detail",
    "",
    "$$",
    "x=1",
    "$$ {#eq:detail}",
  ].join("\n")));
  await page.getByRole("button", { name: "Outline and find" }).click();
  const outline = page.getByRole("dialog", { name: "Document outline and find" });
  await outline.getByRole("button", { name: "Second" }).click();
  await outline.getByRole("button", { name: "Move up" }).click();
  let serialized = await page.evaluate(() => (window as any).__serialize());
  expect(serialized.indexOf("# Second")).toBeLessThan(serialized.indexOf("# First"));

  await page.getByRole("button", { name: "Document properties" }).click();
  const properties = page.getByRole("dialog", { name: "Document properties" });
  await properties.getByLabel("Equation numbering").selectOption("subsection");
  await properties.getByLabel("Heading numbers").selectOption("shown");
  await expect(page.locator(".ProseMirror h1").first()).toHaveAttribute("data-heading-number", "1");
  serialized = await page.evaluate(() => (window as any).__serialize());
  expect(serialized).toContain("equations: subsection");
  expect(serialized).toContain("headings: true");
  await page.getByRole("button", { name: "References and publication" }).click();
  await expect(page.locator(".math-display .math-number")).toContainText("1.1.1");
});

test("references and authored links use explicit safe navigation gestures", async ({ page }) => {
  await page.evaluate(() => {
    const state = window as any;
    state.__openedLinks = [];
    state.__scrolledTargets = [];
    window.open = ((...args: unknown[]) => {
      state.__openedLinks.push(args);
      return null;
    }) as typeof window.open;
    Element.prototype.scrollIntoView = function scrollIntoView() {
      const id = (this as HTMLElement).id;
      if (id) state.__scrolledTargets.push(id);
    };
    state.__load([
      "# Evidence {#sec:evidence}",
      "",
      "See @sec:evidence, [the section](#sec:evidence), and [the source](https://example.test/paper).",
    ].join("\n"));
  });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const xref = page.locator(".xref");
  const fragment = page.locator('a[href="#sec:evidence"]');
  const external = page.locator('a[href="https://example.test/paper"]');

  await xref.click();
  await expect(xref).toHaveClass(/ProseMirror-selectednode/);
  await expect(xref).toHaveAttribute("role", "link");
  await expect(xref).toHaveAttribute("aria-label", /Section \(1\), reference to sec:evidence/);
  await page.keyboard.press("Enter");
  await expect.poll(async () => page.evaluate(() => (window as any).__scrolledTargets))
    .toEqual(["sec:evidence"]);
  await fragment.click();
  await external.click();
  expect(await page.evaluate(() => (window as any).__scrolledTargets)).toEqual(["sec:evidence"]);
  expect(await page.evaluate(() => (window as any).__openedLinks)).toEqual([]);
  expect(await page.evaluate(() => {
    const selection = (window as any).__editor.view.state.selection;
    return selection.$from.marks().some((mark: any) => mark.type.name === "link");
  })).toBe(true);
  await external.dblclick();
  await expect.poll(async () => page.evaluate(() => (window as any).__openedLinks))
    .toEqual([["https://example.test/paper", "_blank", "noopener,noreferrer"]]);
  await page.evaluate(() => {
    (window as any).__openedLinks = [];
  });
  // A suppressed browser click does not deterministically move a contenteditable
  // caret. Pin the test selection inside the external link, then reproduce the
  // explicit empty stored-mark state that Cmd/Ctrl-Enter must handle.
  await page.evaluate(() => {
    const view = (window as any).__editor.view;
    const link = document.querySelector<HTMLAnchorElement>(
      'a[href="https://example.test/paper"]',
    )!;
    const text = link.firstChild!;
    const position = view.posAtDOM(text, Math.min(1, text.textContent?.length ?? 0));
    const TextSelection = view.state.selection.constructor;
    view.focus();
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, position))
        .setStoredMarks([]),
    );
  });
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await expect.poll(async () => page.evaluate(() => {
    const selection = (window as any).__editor.view.state.selection;
    return selection.$from.marks().find((mark: any) => mark.type.name === "link")?.attrs.href;
  })).toBe("https://example.test/paper");
  await expect(page).toHaveURL(/\/$/);
  await page.keyboard.press(`${modifier}+Enter`);
  await expect.poll(async () => page.evaluate(() => (window as any).__openedLinks))
    .toEqual([["https://example.test/paper", "_blank", "noopener,noreferrer"]]);

  await xref.click({ modifiers: [modifier] });
  await fragment.click({ modifiers: [modifier] });
  await expect.poll(async () => page.evaluate(() => (window as any).__scrolledTargets))
    .toEqual(["sec:evidence", "sec:evidence", "sec:evidence"]);
});

test("every labelled scholarly block and Mathdown source marker is an addressable anchor", async ({ page }) => {
  await page.evaluate(() => {
    const state = window as any;
    state.__scrolledTargets = [];
    Element.prototype.scrollIntoView = function scrollIntoView() {
      const id = (this as HTMLElement).id;
      if (id) state.__scrolledTargets.push(id);
    };
    state.__load([
      "# Section {#sec:anchor}",
      "",
      "$$",
      "x = 1",
      "$$ {#eq:anchor}",
      "",
      "![Figure](https://example.test/figure.png){#fig:anchor}",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "{#tbl:anchor caption=\"Anchored table\"}",
      "",
      "::: proposition {Anchored proposition} #prop:anchor",
      "A proposition body.",
      ":::",
      "",
      "<!-- mathdown-claim:R-ANCHOR -->",
      "",
      "[section](#sec:anchor) [equation](#eq:anchor) [figure](#fig:anchor) [table](#tbl:anchor) [proposition](#prop:anchor) [result](#mathdown-claim:R-ANCHOR)",
      "",
      "See @sec:anchor, @eq:anchor, @fig:anchor, @tbl:anchor, and @prop:anchor.",
    ].join("\n"));
  });

  const ids = [
    "sec:anchor",
    "eq:anchor",
    "fig:anchor",
    "tbl:anchor",
    "prop:anchor",
    "mathdown-claim:R-ANCHOR",
  ];
  for (const id of ids) {
    await expect(page.locator(`.ProseMirror [id="${id}"]`)).toHaveCount(1);
  }
  await expect(page.locator(".ProseMirror table > caption")).toHaveText("Anchored table");

  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  for (const id of ids) {
    await page.locator(`a[href="#${id}"]`).click({ modifiers: [modifier] });
  }
  await expect.poll(async () => page.evaluate(() => (window as any).__scrolledTargets))
    .toEqual(ids);

  const numberedIds = ids.slice(0, 5);
  const references = page.locator(".xref");
  await expect(references).toHaveCount(numberedIds.length);
  for (let index = 0; index < numberedIds.length; index++) {
    await references.nth(index).click({ modifiers: [modifier] });
  }
  await expect.poll(async () => page.evaluate(() => (window as any).__scrolledTargets))
    .toEqual([...ids, ...numberedIds]);
});

test("HTML comments stay hidden and table breaks render instead of leaking source tags", async ({ page }) => {
  const source = [
    "# Derivation audit",
    "",
    "<!-- Rows follow paths.derivation_audit; mathematical ownership remains in the linked notes. -->",
    "",
    "| Document | Results |",
    "| --- | --- |",
    "| Queueing | `R-DEMO-RBM-EXP`<br>`R-DEMO-LAPLACE` |",
    "| Sourcing | conditional shares<br>expected reliability<br>country-route decomposition |",
    "",
  ].join("\n");
  await page.evaluate((markdown) => (window as any).__load(markdown), source);

  const editor = page.locator(".ProseMirror");
  await expect(editor).not.toContainText("Rows follow paths.derivation_audit");
  await expect(editor).not.toContainText("<br>");
  await expect(editor.locator(".html-comment-source")).toHaveCount(1);
  await expect(editor.locator("table br")).toHaveCount(3);
  await expect(editor.locator("table").getByText("R-DEMO-RBM-EXP")).toBeVisible();
  await expect(editor.locator("table").getByText("R-DEMO-LAPLACE")).toBeVisible();

  expect(await page.evaluate(() => (window as any).__serialize())).toBe(source);
});

test("an unresolved live reference reports its exact target without navigating", async ({ page }) => {
  await page.evaluate(() => (window as any).__load("See @fig:missing.\n"));
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.locator(".xref").click({ modifiers: [modifier] });
  await expect(page.locator("#file-status")).toHaveText("Sync failed");
  await expect(page.locator("#file-status")).toHaveAttribute(
    "title",
    /Reference .fig:missing. was not found in the current document/,
  );
});

test("a duplicate label stays visibly ambiguous and never chooses a target", async ({ page }) => {
  await page.evaluate(() => (window as any).__load([
    "# First {#sec:duplicate}",
    "",
    "# Second {#sec:duplicate}",
    "",
    "See @sec:duplicate.",
  ].join("\n")));
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await expect(page.locator(".xref")).toHaveClass(/xref-broken/);
  await page.locator(".xref").click({ modifiers: [modifier] });
  await expect(page.locator("#file-status")).toHaveText("Sync failed");
  await expect(page.locator("#file-status")).toHaveAttribute(
    "title",
    /Reference .sec:duplicate. is ambiguous because its label is defined more than once/,
  );
});

test("outline navigation and active-document replace use derived document state", async ({ page }) => {
  await page.evaluate(() => (window as unknown as { __load: (value: string) => void }).__load(
    "# First {#first}\n\nAlpha text.\n\n## Second {#second}\n\nAlpha again.\n",
  ));
  await page.getByRole("button", { name: "Outline and find" }).click();
  const dialog = page.getByRole("dialog", { name: "Document outline and find" });
  await expect(dialog.getByRole("button", { name: "First" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Second" })).toBeVisible();
  await dialog.getByRole("searchbox", { name: "Find in document" }).fill("Alpha");
  await expect(dialog.getByRole("status")).toHaveText("1 of 2");
  await dialog.getByRole("textbox", { name: "Replacement text" }).fill("Beta");
  await dialog.getByRole("button", { name: "All", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("No matches");
  const serialized = await page.evaluate(() =>
    (window as unknown as { __serialize: () => string }).__serialize(),
  );
  expect(serialized.match(/Beta/g)).toHaveLength(2);
});

test("find and replace refreshes stale positions after an intervening edit", async ({ page }) => {
  await page.evaluate(() => (window as unknown as { __load: (value: string) => void }).__load(
    "Alpha first. Alpha second.\n",
  ));
  await page.getByRole("button", { name: "Outline and find" }).click();
  const dialog = page.getByRole("dialog", { name: "Document outline and find" });
  await dialog.getByRole("searchbox", { name: "Find in document" }).fill("Alpha");
  await expect(dialog.getByRole("status")).toHaveText("1 of 2");
  await page.evaluate(() => {
    const editor = (window as unknown as {
      __editor: { view: { state: { tr: { insertText: (text: string, pos: number) => unknown } }; dispatch: (tr: unknown) => void } };
    }).__editor;
    editor.view.dispatch(editor.view.state.tr.insertText("Prefix ", 1));
  });
  await dialog.getByRole("textbox", { name: "Replacement text" }).fill("Beta");
  await dialog.getByRole("button", { name: "All", exact: true }).click();
  const serialized = await page.evaluate(() =>
    (window as unknown as { __serialize: () => string }).__serialize(),
  );
  expect(serialized).toContain("Prefix Beta first. Beta second.");
});

test("document publication settings persist in source-preserving frontmatter", async ({ page }) => {
  await page.evaluate(() => (window as unknown as { __load: (value: string) => void }).__load(`---
# retained by another tool
customExport: true
---

# Paper
`));
  await page.getByRole("button", { name: "Document properties" }).click();
  const dialog = page.getByRole("dialog", { name: "Document properties" });
  await dialog.getByLabel("Bibliography").fill("references/library.bib");
  await dialog.getByLabel("Bibliography").press("Tab");
  await dialog.getByLabel("Document class").selectOption("amsart");
  await dialog.getByLabel("Citation style").selectOption("numeric");
  const serialized = await page.evaluate(() =>
    (window as unknown as { __serialize: () => string }).__serialize(),
  );
  expect(serialized).toContain("customExport: true");
  expect(serialized).toContain("bibliography:");
  expect(serialized).toContain("references/library.bib");
  expect(serialized).toContain("documentClass: amsart");
  expect(serialized).toContain("citationStyle: numeric");
});

test("table tools edit structure, alignment, caption, and label", async ({ page }) => {
  await page.evaluate(() => (window as unknown as { __load: (value: string) => void }).__load(
    "| Result | State |\n| --- | --- |\n| R-1 | partial |\n",
  ));
  await page.locator(".ProseMirror td").first().click();
  await page.getByRole("button", { name: "Table tools" }).click();
  const dialog = page.getByRole("dialog", { name: "Table tools" });
  await dialog.getByRole("group", { name: "Rows" }).getByRole("button", { name: "After" }).click();
  await dialog.getByRole("group", { name: "Align" }).getByRole("button", { name: "Center" }).click();
  await dialog.getByLabel("Table caption").fill("Verification status");
  await dialog.getByLabel("Table label").fill("tbl:verification");
  await dialog.getByLabel("Table label").press("Tab");
  await expect(page.locator(".ProseMirror table")).toHaveAttribute("id", "tbl:verification");
  await expect(page.locator(".ProseMirror table > caption")).toHaveText("Verification status");

  const serialized = await page.evaluate(() =>
    (window as unknown as { __serialize: () => string }).__serialize(),
  );
  expect(serialized).toContain("| :---: | --- |");
  expect(serialized).toContain("{#tbl:verification caption=\"Verification status\"}");
  expect(serialized.split("\n").filter((line) => /^\|/.test(line))).toHaveLength(4);
});

test("Settings controls native prose spellcheck and language", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Editor" }).click();
  await settings.getByText("Spellcheck").locator("..").getByRole("button", { name: "Off" }).click();
  await settings.getByLabel("Document spellcheck language").fill("de-DE");
  await settings.getByLabel("Document spellcheck language").press("Tab");
  await expect(page.locator(".ProseMirror")).toHaveAttribute("spellcheck", "false");
  await expect(page.locator(".ProseMirror")).toHaveAttribute("lang", "de-DE");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("mdlyx:config") ?? "{}"));
  expect(saved).toMatchObject({ spellcheck: false, language: "de-DE" });
});

test("legacy default typography migrates to the compact document scale", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("mdlyx:config", JSON.stringify({
    bodySize: 1,
    displaySize: 1.1,
    spellcheck: false,
    language: "de-DE",
  })));
  await reloadApp(page);

  const sizes = await page.evaluate(() => ({
    body: getComputedStyle(document.documentElement).getPropertyValue("--body-size").trim(),
    display: getComputedStyle(document.documentElement).getPropertyValue("--display-math-size").trim(),
    saved: JSON.parse(localStorage.getItem("mdlyx:config") ?? "{}"),
  }));
  expect(sizes.body).toBe("0.86rem");
  expect(sizes.display).toBe("0.95rem");
  expect(sizes.saved).toMatchObject({
    bodySize: 0.86,
    displaySize: 0.95,
    spellcheck: false,
    language: "de-DE",
    typographyDefaultsVersion: 2,
  });
});

test("project-wide search indexes local sources in a worker and opens a result", async ({ page }) => {
  await page.waitForFunction(() => !!(window as unknown as { __mockLibrary?: unknown }).__mockLibrary);
  await page.evaluate(() => (window as unknown as { __mockLibrary: () => Promise<void> }).__mockLibrary());
  await expect(await revealLibraryFile(page, "wasserstein-ot.md")).toBeVisible();
  await page.getByRole("button", { name: "Search projects" }).click();
  const search = page.getByRole("dialog", { name: "Search project documents" });
  await expect(search.getByRole("status")).toContainText("documents indexed");
  await search.getByRole("searchbox", { name: "Project search query" }).fill("flow satisfies");
  await expect(search.getByRole("status")).toHaveText("1 match");
  await search.getByRole("button", { name: /Wasserstein OT gradient flow · line/ }).click();
  await expect(page.locator(".ProseMirror h1")).toHaveText("Wasserstein OT gradient flow");
});

test("real tabs preserve the active local-library path for duplicate basenames", async ({ page }) => {
  const documents = new Map([
    ["/duplicate-library/alpha/target.md", [
      "---",
      'library: {"id":"alpha-target","title":"Alpha target","projects":["Alpha"]}',
      "---",
      "",
      "# Alpha body",
      "",
    ].join("\n")],
    ["/duplicate-library/beta/target.md", [
      "---",
      'library: {"id":"beta-target","title":"Beta target","projects":["Beta"]}',
      "---",
      "",
      "# Beta body",
      "",
    ].join("\n")],
  ]);
  await page.route("**/duplicate-library/**", async (route) => {
    const source = documents.get(new URL(route.request().url()).pathname);
    if (source == null) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: "text/markdown", body: source });
  });
  await page.evaluate(() => (
    window as unknown as {
      __mockLibrary: (folder: string, paths: string[]) => Promise<void>;
    }
  ).__mockLibrary("duplicate-library", ["alpha/target.md", "beta/target.md"]));

  const alphaRow = await revealLibraryFile(page, "alpha/target.md");
  const betaRow = await revealLibraryFile(page, "beta/target.md");
  await expect(alphaRow).toBeVisible();
  await expect(betaRow).toBeVisible();
  await alphaRow.click();
  await expect(page.locator('.lib-file.is-active[data-path="alpha/target.md"]')).toHaveCount(1);
  await expect(page.locator('.tab[aria-label="alpha/target.md"]')).toHaveCount(1);

  await betaRow.click();
  await expect(page.locator('.lib-file.is-active[data-path="beta/target.md"]')).toHaveCount(1);
  await expect(page.locator('.tab[aria-label="beta/target.md"]')).toHaveCount(1);
  await expect(page.locator(".ProseMirror h1")).toHaveText("Beta body");

  // Switch through the real TabBar, not the library row. The retained local
  // provider path must select Alpha rather than the first basename.
  await page.locator('.tab[aria-label="alpha/target.md"]').click();
  const activeAlpha = page.locator('.lib-file.is-active[data-path="alpha/target.md"]');
  await expect(activeAlpha).toHaveCount(1);
  await expect(activeAlpha).toHaveAttribute("title", /alpha\/target\.md[\s\S]*Project: Alpha/);
  await expect(page.locator('.lib-file.is-active[data-path="beta/target.md"]')).toHaveCount(0);
  await expect(page.locator(".ProseMirror h1")).toHaveText("Alpha body");
});

test("project-wide search falls back when the worker cannot start", async ({ page }) => {
  await page.goto("about:blank");
  await page.addInitScript(() => {
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: class BrokenWorker {
        constructor() { throw new Error("worker unavailable"); }
      },
    });
  });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as unknown as { __mockLibrary?: unknown }).__mockLibrary);
  await page.evaluate(() => (window as unknown as { __mockLibrary: () => Promise<void> }).__mockLibrary());
  await page.getByRole("button", { name: "Search projects" }).click();
  const search = page.getByRole("dialog", { name: "Search project documents" });
  await expect(search.getByRole("status")).toContainText("documents indexed");
  await search.getByRole("searchbox", { name: "Project search query" }).fill("flow satisfies");
  await expect(search.getByRole("status")).toHaveText("1 match");
});
