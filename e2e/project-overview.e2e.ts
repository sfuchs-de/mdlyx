import { expect, test, type Page, type Route } from "@playwright/test";
import { parseFrontmatter } from "../src/markdown/frontmatter";
import { revealLibraryFile } from "./library-helpers";

const API = "https://overview.test";

interface RemoteDocument {
  path: string;
  text: string;
  sha: string;
}

interface MockState {
  failList: boolean;
  failDocuments?: boolean;
  listDelayMs?: number;
  onListStart?: () => void;
  writes?: Array<{ path: string; text: string; expectedSha?: string }>;
  documentReads?: string[];
  conflict?: RemoteDocument;
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

function fixture(): RemoteDocument[] {
  return [
    {
      path: "project/a.md",
      sha: "a-sha",
      text: `---
library: {"id":"doc-a","title":"Owner A","projects":["project-one"],"contains":["open-questions"]}
comments: [{"id":"c1","kind":"user","author":"owner","body":"Check","resolved":false,"createdAt":1,"replies":[],"quote":"First"}]
---

# Owner A {#R-A}

First result.
`,
    },
    {
      path: "project/b.md",
      sha: "b-sha",
      text: `---
library: {"id":"doc-b","title":"Owner B","projects":["project-one"],"contains":[]}
---

# Owner B {#R-B}

Second result.
`,
    },
    {
      path: "project/index.md",
      sha: "overview-sha",
      text: `---
library: {"id":"project-index","title":"Project One","projects":["project-one"],"contains":["project-overview"],"related":[{"id":"doc-a","rel":"see-also"},{"id":"project-claims","rel":"see-also"}]}
---

# Project One

## Project summary {#project-summary}

An evidence-first test project with one unresolved result.

## Key results {#key-results}

| Result ID | Why it matters | Read |
| --- | --- | --- |
| \`R-A\` | Supplies the validated prerequisite for the project chain. | [[doc-a\\|Owner A]] |
| \`R-B\` | Records the unresolved headline result that remains to be closed. | [[doc-b\\|Owner B]] |

## Project priorities {#project-priorities}

| Task ID | Task | State | Priority | Owner | Related results | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- | --- |
| \`T-A\` | Validate result B | in-progress | high | [[doc-b\\|Owner B]] | \`R-B\` |  | Complete the remaining proof |
| \`T-LATER\` | Extend result A | later | medium | [[doc-a]] | \`R-A\` | \`T-A\` | Record a new extension |
`,
    },
    {
      path: "project/verification/claims.md",
      sha: "claims-sha",
      text: `---
library: {"id":"project-claims","title":"Project claims","projects":["project-one"],"contains":["dependency-graph"]}
---

## Result dependency manifest {#dependency-graph}

| Result ID | Result | Owner | Validation | Depends on | Evidence | Remaining condition |
| --- | --- | --- | --- | --- | --- | --- |
| \`R-A\` | First result | [[doc-a]] | validated |  | Symbolic equality | Assumptions stated |
| \`R-B\` | Second result | [[doc-b]] | partial | \`R-A\` | Residual checked | Complete uniqueness proof |
`,
    },
  ];
}

async function overviewLauncher(
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
  const launcher = group.locator('[data-project-action="overview"]');
  await expect(launcher).toBeVisible();
  return launcher;
}

async function openProjectOverview(
  page: Page,
  project = "project-one",
) {
  await (await overviewLauncher(page, project)).click();
}

async function configure(
  page: Page,
  documents: RemoteDocument[],
  state: MockState,
  waitForOverview = true,
) {
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
      state.onListStart?.();
      if (state.listDelayMs) await new Promise((resolve) => setTimeout(resolve, state.listDelayMs));
      if (state.failList) return json(route, { error: "temporary outage" }, 503);
      return json(route, { entries: documents });
    }
    if (url.pathname === "/v1/library/documents" && request.method() === "GET") {
      if (state.failDocuments) return json(route, { error: "document service unavailable" }, 503);
      state.documentReads?.push(url.searchParams.get("path") ?? "");
      const document = documents.find((item) => item.path === url.searchParams.get("path"));
      return document ? json(route, document) : json(route, { error: "not found" }, 404);
    }
    if (url.pathname === "/v1/library/documents" && request.method() === "PUT") {
      const path = url.searchParams.get("path") ?? "";
      const body = request.postDataJSON() as { text: string; expectedSha?: string };
      const document = documents.find((item) => item.path === path);
      if (!document) return json(route, { error: "not found" }, 404);
      if (state.conflict?.path === path) {
        const remote = state.conflict;
        state.conflict = undefined;
        Object.assign(document, remote);
        return json(route, { code: "REMOTE_CONFLICT", remote }, 409);
      }
      state.writes?.push({ path, text: body.text, expectedSha: body.expectedSha });
      document.text = body.text;
      document.sha = `saved-${state.writes?.length ?? 1}`;
      return json(route, document);
    }
    return json(route, { error: "not found" }, 404);
  });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__editor);
  await expect(page.locator("#file-status")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("#file-status")).toHaveAttribute("aria-atomic", "true");
  if (waitForOverview) {
    await overviewLauncher(page);
  }
}

test("project overview exposes exact evidence and preserves project navigation", async ({ page }) => {
  const documents = fixture();
  const state: MockState = { failList: false, documentReads: [] };
  await configure(page, documents, state);
  await openProjectOverview(page);

  await expect(page.locator("#project-overview")).toBeVisible();
  await expect(page.locator(".overview-subtitle")).toContainText("evidence-first test project");
  await expect(page.locator(".overview-status")).toContainText("2 results · 1 validated · 1 partial · 0 unvalidated · 0 disputed");
  await expect(page.locator(".overview-status")).toContainText("1 active task · 0 blocked · 1 later · 0 done");
  await expect(page.locator(".overview-status")).toContainText("4 project documents · 1 unresolved comment");
  await expect(page.locator(".overview-validation-segment")).toHaveCount(2);
  await expect(page.locator(".overview-key-result-card")).toHaveCount(2);
  await expect(page.locator('.overview-key-result-title[data-result-id="R-A"]'))
    .toContainText("First result");
  await expect(page.locator('.overview-key-result-card').filter({ hasText: "R-B" }))
    .toContainText("partial");
  await expect(page.locator('.overview-key-result-card').filter({ hasText: "R-A" }))
    .toContainText("Read · Owner A");
  await expect(page.locator(".overview-task-list")).toContainText("T-A");
  await expect(page.locator(".overview-task-list")).toContainText("Validate result B");
  await expect(page.locator(".overview-task-list")).not.toContainText("T-LATER");
  await expect(page.locator(".overview-results-table")).toContainText("R-B · Second result");
  await expect(page.locator(".overview-evidence")).toContainText("Owner A");
  await expect(page.locator(".overview-evidence")).toContainText("1");
  const documentTypography = await page.locator(".overview-evidence").evaluate((evidence) => {
    const groups = [...evidence.querySelectorAll<HTMLElement>(".overview-document-group")];
    return {
      headings: groups.map((group) => Number.parseFloat(
        getComputedStyle(group.querySelector(".overview-section-title")!).fontSize,
      )),
      links: groups.map((group) => Number.parseFloat(
        getComputedStyle(group.querySelector(".overview-document-link")!).fontSize,
      )),
      count: Number.parseFloat(getComputedStyle(
        evidence.querySelector(".overview-document-count")!,
      ).fontSize),
    };
  });
  expect(new Set(documentTypography.headings).size).toBe(1);
  expect(new Set(documentTypography.links).size).toBe(1);
  expect(documentTypography.links[0]).toBeLessThan(documentTypography.headings[0]);
  expect(documentTypography.count).toBeLessThan(documentTypography.links[0]);
  await expect(
    page.locator(".overview-document-group").filter({ hasText: "Key documents" })
      .getByRole("button", { name: "Owner A", exact: true }),
  ).toHaveAttribute("title", "project/a.md");
  await expect(page.locator(".overview-document-count")).toHaveAttribute(
    "aria-label",
    "1 unresolved comment",
  );
  await expect(page.locator(".overview-frontier .overview-panel-caption")).toHaveText(
    "Showing 1 highest-exposure unresolved result and 1 direct prerequisite; no unresolved results are hidden.",
  );
  expect(state.documentReads).toEqual([]);

  const attentionResult = page.locator('.overview-results-table [data-result-id="R-B"]');
  await attentionResult.scrollIntoViewIfNeeded();
  const beforeSelectionScroll = await page.locator("#project-overview").evaluate((element) => element.scrollTop);
  expect(beforeSelectionScroll).toBeGreaterThan(0);
  await attentionResult.focus();
  await page.keyboard.press("Enter");
  await expect(attentionResult).toBeFocused();
  await expect(attentionResult).toBeInViewport();
  await expect.poll(async () => Math.abs(
    (await page.locator("#project-overview").evaluate((element) => element.scrollTop)) - beforeSelectionScroll,
  )).toBeLessThanOrEqual(1);

  const frontierResult = page.locator('.overview-frontier [data-result-id="R-B"]');
  await frontierResult.focus();
  await page.keyboard.press("Space");
  await expect(frontierResult).toBeFocused();
  await page.keyboard.press("Space");
  await expect(frontierResult).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#project-overview")).toBeHidden();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("b.md");
  await expect(page.locator('.ProseMirror [id="R-B"]')).toBeInViewport();

  await openProjectOverview(page);
  await page.getByRole("button", { name: "Full graph" }).click();
  await expect(page.locator("#project-graph")).toBeVisible();
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue("project-one");
});

test("phone navigation dismisses the Library drawer and exposes a scrollable overview", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const documents = fixture();
  const state: MockState = { failList: false, documentReads: [] };
  await configure(page, documents, state, false);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const launch = await overviewLauncher(page);
  await launch.click();

  const overview = page.locator("#project-overview");
  await expect(page.locator("#library")).toBeHidden();
  await expect(page.locator("#library-scrim")).toBeHidden();
  await expect(page.locator("#editor-pane")).not.toHaveAttribute("inert", "");
  await expect(overview).toBeVisible();
  await expect(overview.locator(".overview-title")).toBeFocused();
  await expect(overview.locator(".overview-status")).toBeVisible();
  await expect(overview.locator(".overview-key-result-grid")).toBeVisible();
  await expect(overview.locator(".overview-key-result-card")).toHaveCount(2);
  await expect(overview.locator(".overview-actions")).toBeVisible();
  const frontier = overview.locator(".overview-mobile-disclosure")
    .filter({ hasText: "Validation frontier" }).first();
  await expect(frontier).not.toHaveAttribute("open", "");
  await frontier.locator("summary").click();
  await expect(overview.locator(".graph-svg-compact")).toHaveCSS("touch-action", "pan-y");
  const attention = overview.locator(".overview-mobile-disclosure")
    .filter({ hasText: "Results needing attention" }).first();
  await attention.locator("summary").click();
  await expect(attention.locator(".overview-result-card")).toBeVisible();
  await expect(attention.locator(".overview-results-table")).toBeHidden();
  const keyDocuments = overview.locator(".overview-document-disclosure")
    .filter({ hasText: "Key documents" });
  await keyDocuments.locator("summary").click();
  const documentLink = overview.locator(".overview-document-list .overview-document-link").first();
  const documentLinkBox = await documentLink.boundingBox();
  expect(documentLinkBox?.height).toBeGreaterThanOrEqual(27);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("frontier includes every direct prerequisite and reports exact hidden results", async ({ page }) => {
  const documents = fixture();
  const claims = documents.find((item) => item.path === "project/verification/claims.md")!;
  const rows: string[] = [];
  for (let index = 1; index <= 6; index++) {
    const dependencies = [`R-P${index}A`, `R-P${index}B`, `R-P${index}C`];
    rows.push(`| \`R-U${index}\` | Unresolved ${index} | [[doc-b]] | partial | ${dependencies.map((id) => `\`${id}\``).join(", ")} | Pending evidence | Pending condition |`);
    for (const dependency of dependencies) {
      rows.push(`| \`${dependency}\` | Prerequisite ${dependency} | [[doc-a]] | validated |  | Checked | None |`);
    }
  }
  rows.push("| `R-U7` | Unresolved 7 | [[doc-b]] | partial |  | Pending evidence | Pending condition |");
  claims.text = `---
library: {"id":"project-claims","title":"Project claims","projects":["project-one"],"contains":["dependency-graph"]}
---

## Result dependency manifest {#dependency-graph}

| Result ID | Result | Owner | Validation | Depends on | Evidence | Remaining condition |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
  await configure(page, documents, { failList: false });
  await openProjectOverview(page);

  await expect(page.locator(".overview-panel-caption")).toHaveText(
    "Showing 6 highest-exposure unresolved results and 18 direct prerequisites; 1 other unresolved result is hidden. Open Full graph to view it.",
  );
  await expect(page.locator(".overview-frontier [data-result-id]")).toHaveCount(24);
});

test("unselectable and duplicate overview diagnostics remain visible", async ({ page }) => {
  const documents = fixture();
  const overviewBody = `
# Overview

## Project summary {#project-summary}

Summary.

## Project priorities {#project-priorities}

| Task ID | Task | State | Priority | Owner | Related results | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- | --- |
`;
  documents.push(
    {
      path: "invalid/orphan.md",
      sha: "orphan-sha",
      text: `---
library: {"id":"orphan","title":"Orphan","projects":[],"contains":["project-overview"]}
---
${overviewBody}`,
    },
    ...["a", "b"].map((suffix) => ({
      path: `ambiguous/${suffix}.md`,
      sha: `ambiguous-${suffix}-sha`,
      text: `---
library: {"id":"ambiguous-${suffix}","title":"Ambiguous ${suffix}","projects":["ambiguous-project"],"contains":["project-overview"]}
---
${overviewBody}`,
    })),
    {
      path: "project/missing-id.md",
      sha: "missing-id-sha",
      text: `---
library: {"title":"Missing ID","projects":["project-one"],"contains":["project-overview"]}
---
${overviewBody}`,
    },
    {
      path: "invalid/orphan-claims.md",
      sha: "orphan-claims-sha",
      text: `---
library: {"id":"orphan-claims","title":"Orphan claims","projects":[],"contains":["dependency-graph"]}
---

## Results {#dependency-graph}

| Result ID | Result | Owner | Validation | Depends on | Evidence | Remaining condition |
| --- | --- | --- | --- | --- | --- | --- |
`,
    },
  );
  await configure(page, documents, { failList: false });
  await openProjectOverview(page);

  await expect(page.getByLabel("Overview project")).toHaveValue("project-one");
  const disclosure = page.locator(".overview-diagnostic-disclosure");
  await expect(disclosure.locator("summary")).toHaveText("4 project errors · 0 warnings");
  await disclosure.locator("summary").click();
  await expect(disclosure).toContainText("must belong to exactly one project");
  await expect(disclosure).toContainText("has more than one project overview; none was selected");
  await expect(disclosure).toContainText("needs a stable document id");
  await expect(disclosure).toContainText("dependency manifest must belong to exactly one project");
});

test("keyboard project selection preserves focus after the overview rerenders", async ({ page }) => {
  const documents = fixture();
  documents.push({
    path: "second/index.md",
    sha: "second-overview-sha",
    text: `---
library: {"id":"second-index","title":"Second Project","projects":["project-two"],"contains":["project-overview"]}
---

## Project summary {#project-summary}

A second selectable project.

## Project priorities {#project-priorities}

| Task ID | Task | State | Priority | Owner | Related results | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- | --- |
`,
  });
  await configure(page, documents, { failList: false });
  await openProjectOverview(page);

  const project = page.getByLabel("Overview project");
  await project.focus();
  await project.selectOption("project-two");
  await expect(page.getByLabel("Overview project")).toHaveValue("project-two");
  await expect(page.getByLabel("Overview project")).toBeFocused();
  await expect(page.locator(".overview-title")).toHaveText("Second Project");
});

test("Pull refreshes tasks and comment counts while failures retain the snapshot", async ({ page }) => {
  const documents = fixture();
  const state = { failList: false };
  await configure(page, documents, state);
  await openProjectOverview(page);
  await expect(page.locator(".overview-status")).toContainText("1 unresolved comment");

  const overview = documents.find((item) => item.path === "project/index.md")!;
  overview.text = overview.text.replace("| in-progress |", "| done |");
  overview.sha = "overview-sha-2";
  const owner = documents.find((item) => item.path === "project/a.md")!;
  owner.text = owner.text.replace('"resolved":false', '"resolved":true');
  owner.sha = "a-sha-2";
  await page.getByRole("button", { name: "Pull & refresh" }).click();
  await expect(page.locator(".overview-status")).toContainText("0 active tasks · 0 blocked · 1 later · 1 done");
  await expect(page.locator(".overview-status")).toContainText("0 unresolved comments");

  state.failList = true;
  await page.getByRole("button", { name: "Pull & refresh" }).click();
  await expect(page.locator(".overview-notice")).toContainText("showing the previous snapshot");
  await expect(page.locator(".overview-status")).toContainText("0 unresolved comments");
  await expect(page.locator(".lib-stale-notice")).toHaveAttribute("role", "status");
  await expect(page.locator(".lib-stale-notice")).toHaveAttribute("aria-atomic", "true");

  await page.getByRole("button", { name: "Back to document" }).click();
  await expect(await overviewLauncher(page)).toBeFocused();
  await openProjectOverview(page);

  const keyDocuments = page.locator(".overview-document-group").filter({ hasText: "Key documents" });
  await keyDocuments.getByRole("button", { name: "Owner A", exact: true }).click();
  await expect(page.locator("#project-overview")).toBeHidden();
  await expect(page.locator(".ProseMirror h1")).toContainText("Owner A");
});

test("cached owner navigation survives a complete stale-index document outage", async ({ page }) => {
  const documents = fixture();
  const state: MockState = { failList: false, documentReads: [] };
  await configure(page, documents, state);
  await openProjectOverview(page);
  const documentReadCount = state.documentReads!.length;

  state.failList = true;
  state.failDocuments = true;
  await page.getByRole("button", { name: "Pull & refresh" }).click();
  const keyDocuments = page.locator(".overview-document-group").filter({ hasText: "Key documents" });
  await keyDocuments.getByRole("button", { name: "Owner A", exact: true }).click();

  await expect(page.locator("#project-overview")).toBeHidden();
  await expect(page.locator(".ProseMirror h1")).toContainText("Owner A");
  expect(state.documentReads).toHaveLength(documentReadCount);
});

test("a slow GitHub index cannot overwrite a newer local-library render", async ({ page }) => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const state: MockState = {
    failList: false,
    listDelayMs: 700,
    onListStart: markStarted,
  };
  await configure(page, fixture(), state, false);
  await started;
  await page.evaluate(() => (window as any).__mockLibrary());

  await expect(page.locator(".lib-source")).toContainText("Sample · sample-library");
  await expect(await revealLibraryFile(page, "overview.md")).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.locator(".lib-source")).toContainText("Sample · sample-library");
  await expect(page.locator('[data-path="project/index.md"]')).toHaveCount(0);
});

test("switching providers reloads an open overview from the new catalog", async ({ page }) => {
  await configure(page, fixture(), { failList: false });
  await openProjectOverview(page);
  await expect(page.locator(".overview-title")).toHaveText("Project One");

  await page.evaluate(() => (window as any).__mockLibrary());
  await expect(page.locator(".overview-title")).toHaveText("Project Overview");
  await expect(page.getByLabel("Overview project")).toHaveValue("gravity-trade");
  await expect(page.locator(".overview-status")).toContainText("3 results");
});

test("dirty project sources are labelled as last-saved projections", async ({ page }) => {
  const documents = fixture();
  await configure(page, documents, { failList: false });
  await (await revealLibraryFile(page, "project/index.md")).click();
  await page.locator('.ProseMirror [id="project-summary"] + p').click();
  await page.keyboard.type(" Local draft");
  await expect(page.locator("#file-status")).toHaveClass(/is-dirty/);

  await openProjectOverview(page);
  await expect(page.locator(".overview-notice")).toContainText("last saved overview and dependency manifest");
  await expect(page.locator(".overview-subtitle")).not.toContainText("Local draft");
});

test("a SHA-guarded comment save updates the indexed overview count", async ({ page }) => {
  const documents = fixture();
  const state: MockState = { failList: false, writes: [] };
  await configure(page, documents, state);
  await openProjectOverview(page);
  const comments = page.locator(".overview-document-group").filter({ hasText: "Unresolved comments" });
  await comments.getByRole("button", { name: "Owner A" }).click();
  await page.getByRole("button", { name: "Resolve" }).click();
  await expect.poll(() => state.writes?.length ?? 0, { timeout: 5_000 }).toBe(1);
  expect(state.writes?.[0]).toMatchObject({ path: "project/a.md", expectedSha: "a-sha" });
  expect(parseFrontmatter(state.writes?.[0].text ?? "").frontmatter.comments[0]?.resolved).toBe(true);

  await openProjectOverview(page);
  await expect(page.locator(".overview-status")).toContainText("0 unresolved comments");
});

test("a remote-wins conflict updates the replaced tab's overview index", async ({ page }) => {
  const documents = fixture();
  const remote: RemoteDocument = {
    path: "project/a.md",
    sha: "remote-conflict-sha",
    text: documents[0].text.replace(
      "]\n---",
      `,{"id":"c2","kind":"user","author":"remote","body":"Second check","resolved":false,"createdAt":2,"replies":[],"quote":"First"}]\n---`,
    ),
  };
  const state: MockState = { failList: false, writes: [], conflict: remote };
  await configure(page, documents, state);
  await openProjectOverview(page);
  const comments = page.locator(".overview-document-group").filter({ hasText: "Unresolved comments" });
  await comments.getByRole("button", { name: "Owner A" }).click();
  await page.getByRole("button", { name: "Resolve" }).click();
  await expect(page.locator("#file-status")).toHaveText("Sync failed", { timeout: 5_000 });
  await expect(page.locator("#file-status")).toHaveAttribute("title", /remote version restored/i);

  await openProjectOverview(page);
  await expect(page.locator(".overview-status")).toContainText("2 unresolved comments");
  await expect(page.locator(".overview-document-group").filter({ hasText: "Unresolved comments" })).toContainText("2");
});

test("local sample overview is responsive and edits the canonical Markdown", async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__mockLibrary);
  await page.evaluate(() => (window as any).__mockLibrary());
  await openProjectOverview(page, "gravity-trade");
  await expect(page.locator(".overview-status")).toContainText("3 results · 1 validated · 1 partial · 1 unvalidated");
  await expect(page.locator(".overview-task-list")).toContainText("T-PROP-2");

  await page.setViewportSize({ width: 760, height: 800 });
  await expect(page.locator("#library")).toHaveClass(/is-drawer/);
  await page.getByRole("button", { name: "Close library" }).click();
  const primary = page.locator(".overview-primary");
  const frontier = page.locator(".overview-frontier");
  const actions = page.locator(".overview-actions");
  await expect.poll(async () => {
    const [a, b, p] = await Promise.all([frontier.boundingBox(), actions.boundingBox(), primary.boundingBox()]);
    return !!a && !!b && !!p && b.y >= a.y + a.height - 2 && a.width <= p.width + 1;
  }).toBe(true);

  const resultsRegion = page.getByRole("region", { name: "Results needing attention table" });
  await expect(resultsRegion).toHaveAttribute("tabindex", "0");
  await expect.poll(() => resultsRegion.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await resultsRegion.focus();
  await expect(resultsRegion).toBeFocused();

  await page.getByRole("button", { name: "Edit overview" }).click();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("overview.md");
  await expect(page.locator('.ProseMirror [id="project-priorities"]')).toBeInViewport();
});
