import { expect, test, type Page, type Route } from "@playwright/test";

const API = "https://graph.test";

interface RemoteDocument {
  path: string;
  text: string;
  sha: string;
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    json: body,
    headers: {
      "access-control-allow-origin": "http://localhost:5173",
      "access-control-allow-credentials": "true",
    },
  });
}

async function configure(page: Page, documents: RemoteDocument[]) {
  await page.addInitScript((api) => {
    localStorage.clear();
    localStorage.setItem("mdlyx:github-api-url", api);
  }, API);
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/health") return json(route, { ok: true, configured: true });
    if (url.pathname === "/auth/session") return json(route, { authenticated: true, login: "example-owner" });
    if (url.pathname === "/v1/library" && request.method() === "GET") {
      return json(route, { entries: documents.map(({ path, text, sha }) => ({ path, text, sha })) });
    }
    if (url.pathname === "/v1/library/documents" && request.method() === "GET") {
      const document = documents.find((item) => item.path === url.searchParams.get("path"));
      return document ? json(route, document) : json(route, { error: "not found" }, 404);
    }
    return json(route, { error: "not found" }, 404);
  });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__editor);
  await expect(page.locator("#library .lib-title")).toHaveText("Library");
  await expect(page.locator("#library .lib-source")).toHaveText("Configured GitHub library");
}

async function graphLauncher(
  page: Page,
  project = "project-one",
) {
  const group = page.locator(
    `.lib-group-section[data-group-key=${JSON.stringify(project)}]`,
  );
  const disclosure = group.locator(":scope > .lib-group-head");
  await expect(disclosure).toBeVisible();
  if (await disclosure.getAttribute("aria-expanded") !== "true") {
    await disclosure.click();
  }
  const launcher = group.locator('[data-project-action="graph"]');
  await expect(launcher).toBeVisible();
  await expect(launcher).toBeEnabled();
  return launcher;
}

async function openDependencyGraph(
  page: Page,
  project = "project-one",
) {
  await (await graphLauncher(page, project)).click();
}

const ownerA: RemoteDocument = {
  path: "project/a.md",
  sha: "a-sha",
  text: "---\nlibrary: {\"id\":\"doc-a\",\"title\":\"Owner A\",\"projects\":[\"project-one\"]}\n---\n\n# Owner A {#R-A}\n\n<!-- mathdown-claim:R-A -->\n\nFirst result.\n",
};
const ownerB: RemoteDocument = {
  path: "project/b.md",
  sha: "b-sha",
  text: "---\nlibrary: {\"id\":\"doc-b\",\"title\":\"Owner B\",\"projects\":[\"project-one\"]}\n---\n\n# Owner B {#R-B}\n\nSecond result.\n",
};
const graphManifest: RemoteDocument = {
  path: "project/verification/claims.md",
  sha: "graph-sha",
  text: `---
library: {"id":"project-claims","title":"Project claims","projects":["project-one"],"contains":["dependency-graph"]}
---

# Claims

## Result dependency manifest {#dependency-graph}

| Result ID | Result | Owner | Validation | Depends on | Evidence | Remaining condition | Owner anchor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| \`R-A\` | First result | [[doc-a]] | validated |  | Symbolic equality check | Finite primitives | mathdown-claim:R-A |
| \`R-B\` | Second result | [[doc-b]] | partial | \`R-A\` | Residual checked | Complete uniqueness proof | R-B |
`,
};

test("GitHub project graph filters paths and opens an anchored owner document", async ({ page }) => {
  await configure(page, [ownerA, ownerB, graphManifest]);
  await openDependencyGraph(page);
  await expect(page.locator("#project-graph")).toBeVisible();
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue("project-one");
  await expect(page.locator(".graph-summary")).toHaveText("2 results · 1 validated · 1 partial · 0 unvalidated · 0 disputed");
  await expect(page.locator(".graph-node")).toHaveCount(2);

  const graph = page.locator(".graph-svg");
  const fitted = await graph.getAttribute("viewBox");
  const box = await graph.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -300);
  await expect.poll(() => graph.getAttribute("viewBox")).not.toBe(fitted);
  await page.getByRole("button", { name: "Fit" }).click();
  await expect(graph).toHaveAttribute("viewBox", fitted!);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 40, box!.y + box!.height / 2 + 20);
  await page.mouse.up();
  await expect.poll(() => graph.getAttribute("viewBox")).not.toBe(fitted);
  await page.getByRole("button", { name: "Fit" }).click();

  await page.locator('[data-result-id="R-B"]').click();
  await expect(page.locator(".graph-details")).toContainText("Residual checked");
  await expect(page.locator(".graph-details")).toContainText("Complete uniqueness proof");
  await page.getByLabel("Upstream").check();
  await expect(page.locator(".graph-node")).toHaveCount(2);

  await page.evaluate(() => {
    (window as any).__anchorScrolls = [];
    Element.prototype.scrollIntoView = function scrollIntoView() {
      const id = (this as HTMLElement).id;
      if (id) (window as any).__anchorScrolls.push(id);
    };
  });
  await page.locator('[data-result-id="R-A"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#project-graph")).toBeHidden();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("a.md");
  await expect.poll(async () => page.evaluate(() => (window as any).__anchorScrolls))
    .toContain("mathdown-claim:R-A");
  const sourceMarker = page.locator('[data-mathdown-source-marker="mathdown-claim:R-A"]');
  await expect(sourceMarker).toHaveCount(1);
  await expect(sourceMarker).toBeHidden();
  await expect(page.locator(".ProseMirror")).not.toContainText("mathdown-claim:R-A");
  const markdown = await page.evaluate(() =>
    (window as unknown as { __serialize: () => string }).__serialize(),
  );
  expect(markdown).toContain("<!-- mathdown-claim:R-A -->");
});

test("Contract v2 projections expose reviewed metadata and remain read-only", async ({ page }) => {
  const owner = {
    ...ownerB,
    text: ownerB.text.replace("{#R-B}", "{#owner-b-anchor}"),
  };
  const digest = `sha256:${"a".repeat(64)}`;
  const projection: RemoteDocument = {
    path: "project/verification/generated-results.md",
    sha: "projection-sha",
    text: `---
library: {"id":"project-v2-results","title":"Generated results","projects":["project-one"],"contains":["dependency-graph"],"projection":{"kind":"generated-result-manifest","schema_version":"2.0","sources":["verification/results.yaml","dependency-graph.json","verification/review-exceptions.yaml"],"digest":"${digest}","read_only":true,"acknowledged_warnings":[{"result_id":"R-B","dependencies":["R-A"],"scope":"conditional-on-base-result"}]}}
---

## Result dependency manifest {#dependency-graph}

| ID | Title | Owner document | Validation state | Prerequisites | Evidence | Remaining conditions | Curated status | Claim class | Model state | Owner anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| \`R-A\` | First result | [[doc-a]] | partial | — | Symbolic equality check | Close the base case | review | lemma | baseline | R-A |
| \`R-B\` | Second result | [[doc-b]] | validated | \`R-A\` | Conditional proof checked | Conditional on R-A | final | proposition | counterfactual | owner-b-anchor |
`,
  };
  await configure(page, [ownerA, owner, projection]);
  await openDependencyGraph(page);
  await expect(page.locator(".graph-summary")).toHaveText(
    "2 results · 1 validated · 1 partial · 0 unvalidated · 0 disputed",
  );
  await page.locator('[data-result-id="R-B"]').click();
  await expect(page.locator(".graph-details")).toContainText("Curated · final");
  await expect(page.locator(".graph-details")).toContainText("final");
  await expect(page.locator(".graph-details")).toContainText("proposition");
  await expect(page.locator(".graph-details")).toContainText("counterfactual");
  await expect(page.locator(".graph-diagnostic-disclosure summary")).toContainText("1 warning");
  await page.locator(".graph-diagnostic-disclosure summary").click();
  await expect(page.locator(".graph-diagnostic-list")).toContainText(
    "acknowledged scope: conditional-on-base-result",
  );

  await page.getByRole("button", { name: "Open manifest" }).click();
  await expect(page.locator("#file-status")).toHaveText("Read-only projection");
  await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
  await page.locator("#btn-file").click();
  await expect(page.locator("#btn-save")).toBeDisabled();
  await expect(page.locator("#btn-save-as")).toBeDisabled();
  await page.keyboard.press("Escape");
  // Generated manifests stay immutable, but their catalog-known result IDs
  // remain useful navigation links. Reader mode follows one ordinary click.
  await page.locator('.ProseMirror [data-result-id="R-B"]').click();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("b.md");
  await expect(page.locator('#editor-host [id="owner-b-anchor"]')).toBeInViewport();

  await openDependencyGraph(page);
  const graph = page.locator("#project-graph");
  await expect(graph).toBeVisible();
  await expect(graph.locator(".graph-node")).toHaveCount(2);
  const result = graph.locator('[data-result-id="R-B"]');
  await result.focus();
  await expect(result).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(graph).toBeHidden();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("b.md");
  await expect(page.locator('#editor-host [id="owner-b-anchor"]')).toBeInViewport();
});

test("phone graph keeps controls, canvas, and result details reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await configure(page, [ownerA, ownerB, graphManifest]);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await openDependencyGraph(page);

  const root = page.locator("#project-graph");
  await expect(page.locator("#library")).toBeHidden();
  await expect(root).toBeVisible();
  await expect(root.locator(".graph-title")).toBeFocused();
  await page.getByRole("button", { name: "Filters" }).click();
  const search = page.getByRole("searchbox", { name: "Search dependency graph" });
  const searchBox = await search.boundingBox();
  expect(searchBox?.width).toBeGreaterThan(280);
  await page.getByRole("button", { name: "Close graph filters" }).click();
  const graph = root.locator(".graph-svg");
  await expect(graph).toHaveAttribute("data-direction", "TB");
  const fitted = await graph.getAttribute("viewBox");
  await graph.evaluate((svg) => {
    const fire = (type: string, pointerId: number, clientX: number, clientY: number) => {
      svg.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: "touch",
        clientX,
        clientY,
      }));
    };
    fire("pointerdown", 1, 100, 250);
    fire("pointerdown", 2, 220, 250);
    fire("pointermove", 1, 70, 250);
    fire("pointermove", 2, 250, 250);
    fire("pointerup", 1, 70, 250);
    fire("pointerup", 2, 250, 250);
  });
  await expect.poll(() => graph.getAttribute("viewBox")).not.toBe(fitted);
  await page.getByRole("button", { name: "Fit" }).click();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(() => graph.getAttribute("viewBox")).not.toBe(fitted);
  await page.getByRole("button", { name: "Close graph actions" }).click();
  await page.getByRole("button", { name: "Fit" }).click();
  await root.locator('[data-result-id="R-B"]').click();
  const details = page.getByRole("dialog", { name: "Result details" });
  await expect(details).toBeVisible();
  await expect(details.getByRole("button", { name: "Registered statement" })).toBeInViewport();
  expect(await root.locator(".graph-canvas").evaluate((element) => element.clientHeight > 250)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

  await page.setViewportSize({ width: 700, height: 568 });
  await expect(root.locator(".graph-svg")).toHaveAttribute("data-direction", "LR");
  await expect(root.locator('[data-result-id="R-B"]')).toHaveClass(/is-selected/);
});

test("graph diagnostics expose invalid prerequisites without hiding valid rows", async ({ page }) => {
  const invalid = {
    ...graphManifest,
    text: graphManifest.text.replace("| \`R-A\` |", "| \`R-A\` |")
      .replace("|  | Symbolic", "| \`R-MISSING\` | Symbolic"),
  };
  await configure(page, [ownerA, ownerB, invalid]);
  await openDependencyGraph(page);
  await expect(page.locator(".graph-node")).toHaveCount(2);
  await expect(page.locator(".graph-diagnostic-disclosure summary")).toContainText("graph error");
  await page.locator(".graph-diagnostic-disclosure summary").click();
  await expect(page.locator(".graph-diagnostic-list")).toContainText("R-MISSING");
});

test("keyboard project selection preserves focus after the graph rerenders", async ({ page }) => {
  const ownerC: RemoteDocument = {
    path: "second/c.md",
    sha: "c-sha",
    text: "---\nlibrary: {\"id\":\"doc-c\",\"title\":\"Owner C\",\"projects\":[\"project-two\"]}\n---\n\n# Owner C {#R-C}\n",
  };
  const secondManifest: RemoteDocument = {
    path: "second/claims.md",
    sha: "second-graph-sha",
    text: `---
library: {"id":"second-claims","title":"Second claims","projects":["project-two"],"contains":["dependency-graph"]}
---

## Results {#dependency-graph}

| Result ID | Result | Owner | Validation | Depends on | Evidence | Remaining condition |
| --- | --- | --- | --- | --- | --- | --- |
| R-C | Third result | [[doc-c]] | unvalidated |  | Pending | Prove the claim |
`,
  };
  await configure(page, [ownerA, ownerB, graphManifest, ownerC, secondManifest]);
  await openDependencyGraph(page);

  const project = page.getByLabel("Project", { exact: true });
  await project.focus();
  await project.selectOption("project-two");
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue("project-two");
  await expect(page.getByLabel("Project", { exact: true })).toBeFocused();
  await expect(page.locator('[data-result-id="R-C"]')).toBeVisible();
});

test("local-folder mock exposes the same graph and editable manifest route", async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__mockLibrary);
  await page.evaluate(() => (window as any).__mockLibrary());
  await openDependencyGraph(page, "gravity-trade");
  await expect(page.locator(".graph-summary")).toHaveText("3 results · 1 validated · 1 partial · 1 unvalidated · 0 disputed");
  await page.locator('[data-result-id="R-PROP-2"]').click();
  await expect(page.locator(".graph-details")).toContainText("Complete the proof and boundary cases");
  await page.getByRole("button", { name: "Open manifest" }).click();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("dependencies.md");
  await expect(page.locator(".ProseMirror")).toContainText("Result dependency manifest");
});

test("malformed manifest declarations remain discoverable and explain the error", async ({ page }) => {
  const malformed = {
    ...graphManifest,
    text: graphManifest.text.replace('"projects":["project-one"]', '"projects":["project-one","other-project"]'),
  };
  await configure(page, [ownerA, ownerB, malformed]);
  await openDependencyGraph(page);
  await expect(page.locator(".graph-empty")).toContainText("No dependency manifest in this library");
  await expect(page.locator(".graph-empty")).toContainText("exactly one project");
});
