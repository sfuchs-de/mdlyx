import { readFileSync } from "node:fs";
import { test, expect, type Page, type Route } from "@playwright/test";
import { parseFrontmatter } from "../src/markdown/frontmatter";
import { revealLibraryFile } from "./library-helpers";

const APP_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version as string;
const API = "https://github.test";
const PATH = "drafts/intro.md";
const SOURCE = "---\nlibrary: {\"id\":\"remote-1\",\"title\":\"Remote intro\",\"tags\":[\"sync\"]}\n---\n\nRemote note.\n";
const REMOTE = "---\nlibrary: {\"id\":\"remote-1\",\"title\":\"Remote intro\",\"tags\":[\"sync\"]}\n---\n\nChanged on GitHub.\n";

interface RemoteDocument {
  path: string;
  text: string;
  sha: string;
}

interface WriteRequest {
  path: string;
  expectedSha?: string;
  text: string;
}

async function runLibraryAction(page: Page, label: string) {
  const more = page.getByLabel("More library actions");
  if (await more.getAttribute("aria-expanded") !== "true") await more.click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
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

async function configureGitHubMock(
  page: Page,
  conflict = false,
  initialDocuments: RemoteDocument[] = [{ path: PATH, text: SOURCE, sha: "sha-1" }],
  holdWrites = false,
  failWrites = 0,
) {
  const writeRequests: WriteRequest[] = [];
  const pendingWriteReleases: Array<() => void> = [];
  let indexReads = 0;
  let remotes = initialDocuments.map((document) => ({ ...document }));
  await page.addInitScript((api) => {
    localStorage.clear();
    localStorage.setItem("mdlyx:github-api-url", api);
  }, API);
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/health") {
      await json(route, { ok: true, configured: true });
      return;
    }
    if (url.pathname === "/auth/session") {
      await json(route, { authenticated: true, login: "example-owner" });
      return;
    }
    if (url.pathname === "/v1/library" && request.method() === "GET") {
      indexReads += 1;
      await json(route, { entries: remotes.map(({ path, sha, text }) => ({ path, sha, text })) });
      return;
    }
    if (url.pathname === "/v1/library/documents" && request.method() === "GET") {
      const remote = remotes.find((document) => document.path === url.searchParams.get("path"));
      if (!remote) {
        await json(route, { error: "not found" }, 404);
        return;
      }
      await json(route, remote);
      return;
    }
    if (url.pathname === "/v1/library/documents" && request.method() === "PUT") {
      const body = request.postDataJSON() as { expectedSha?: string; text?: string };
      const path = url.searchParams.get("path") ?? "";
      const remote = remotes.find((document) => document.path === path);
      writeRequests.push({ path, expectedSha: body.expectedSha, text: body.text ?? "" });
      if (failWrites > 0) {
        failWrites--;
        await json(route, { error: "temporary outage" }, 503);
        return;
      }
      if (holdWrites) {
        await new Promise<void>((resolve) => pendingWriteReleases.push(resolve));
      }
      if (conflict && remote) {
        await json(route, { code: "REMOTE_CONFLICT", remote: { path, sha: "sha-2", text: REMOTE } }, 409);
      } else {
        const saved = { path, text: body.text ?? "", sha: `sha-${writeRequests.length + 1}` };
        remotes = remote
          ? remotes.map((document) => document.path === path ? saved : document)
          : [...remotes, saved];
        await json(route, saved);
      }
      return;
    }
    await json(route, { error: "not found" }, 404);
  });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__editor);
  return {
    writes: () => writeRequests.length,
    indexReads: () => indexReads,
    writeRequests: () => writeRequests.slice(),
    setRemote: (text: string, sha = "sha-2", path = PATH) => {
      remotes = remotes.map((document) => document.path === path
        ? { path, text, sha }
        : document);
    },
    releaseNextWrite: () => pendingWriteReleases.shift()?.(),
  };
}

async function openRemoteDoc(page: Page, path = PATH) {
  await expect(page.locator("#library .lib-title")).toHaveText("Library");
  await expect(page.locator("#library .lib-source")).toHaveText("Configured GitHub library");
  await expect(page.locator("#library .lib-sync")).toHaveText("Connected");
  await expect(page.locator("#library .lib-source-row .lib-sync")).toHaveCount(1);
  await expect(page.locator("#library .lib-title-row .lib-sync")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New document" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pull latest from GitHub" })).toHaveCount(0);
  const more = page.getByLabel("More library actions");
  await expect(more).toHaveCount(1);
  await expect(more).toContainText("More");
  await more.click();
  await expect(page.getByRole("menuitem", { name: "Pull latest from GitHub" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "New document" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "New other note" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Manage GitHub sync" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Use a local folder" })).toBeVisible();
  await more.click();
  await (await revealLibraryFile(page, path)).click();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText(path.split("/").pop()!);
}

async function selectWord(page: Page, word: string) {
  await page.locator(".ProseMirror").click();
  await page.evaluate((selected) => {
    const text = document.querySelector(".ProseMirror p")?.firstChild;
    if (!(text instanceof Text)) throw new Error("expected a text paragraph");
    const start = text.data.indexOf(selected);
    if (start < 0) throw new Error(`could not find ${selected}`);
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + selected.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, word);
}

async function recoveryDrafts(page: Page): Promise<Array<{ text?: string }>> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("mdlyx", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<Array<{ text?: string }>>((resolve, reject) => {
      const values: Array<{ text?: string }> = [];
      const request = database.transaction("state", "readonly").objectStore("state").openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(values);
        if (typeof cursor.key === "string" && cursor.key.startsWith("recovery:")) {
          values.push(cursor.value as { text?: string });
        }
        cursor.continue();
      };
    });
  });
}

test("library defaults to compact keyboard-accessible project disclosures", async ({ page }) => {
  await configureGitHubMock(page, false, [
    {
      path: "alpha/note.md",
      sha: "alpha-sha",
      text: '---\nlibrary: {"id":"alpha-note","title":"Alpha note","projects":["Alpha"]}\n---\n\nAlpha body.\n',
    },
    {
      path: "beta/note.md",
      sha: "beta-sha",
      text: '---\nlibrary: {"id":"beta-note","title":"Beta note","projects":["Beta"]}\n---\n\nBeta body.\n',
    },
    {
      path: "shared/note.md",
      sha: "shared-sha",
      text: '---\nlibrary: {"id":"shared-note","title":"Shared note","projects":["Alpha","Beta"]}\n---\n\nShared body.\n',
    },
  ]);

  await expect(page.getByLabel("Group library documents")).toHaveValue("project");
  const alpha = page.locator('.lib-group-section[data-group-key="Alpha"] > .lib-group-head');
  const beta = page.locator('.lib-group-section[data-group-key="Beta"] > .lib-group-head');
  await expect(alpha).toHaveAttribute("aria-label", "Alpha, 2 documents");
  await expect(beta).toHaveAttribute("aria-label", "Beta, 2 documents");
  await expect(alpha).toHaveAttribute("aria-expanded", "false");
  await expect(beta).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-path="alpha/note.md"]')).toHaveCount(0);
  await expect(page.locator('[data-path="beta/note.md"]')).toHaveCount(0);

  await alpha.press("Enter");
  await expect(alpha).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-path="alpha/note.md"]')).toHaveCount(0);
  await page.locator(
    '.lib-group-section[data-group-key="Alpha"] .lib-project-area[data-area="supporting-documents"] > summary',
  ).click();
  await expect(page.locator('[data-path="alpha/note.md"]')).toBeVisible();
  await alpha.press("Space");
  await expect(alpha).toHaveAttribute("aria-expanded", "false");

  // A multi-project document is indexed in each containing disclosure without
  // constructing either row until one disclosure is expanded.
  const sharedGroups = await page.locator("#library .lib-group-section").evaluateAll((groups) => groups.filter((group) => {
    try {
      return JSON.parse((group as HTMLElement).dataset.paths ?? "[]").includes("shared/note.md");
    } catch {
      return false;
    }
  }).length);
  expect(sharedGroups).toBe(2);
  await expect(page.locator('[data-path="shared/note.md"]')).toHaveCount(0);
  await expect(await revealLibraryFile(page, "shared/note.md")).toBeVisible();
  await alpha.press("Space");
  await expect(alpha).toHaveAttribute("aria-expanded", "false");

  const search = page.getByRole("searchbox", { name: "Search library documents" });
  await search.fill("Beta note");
  await expect(page.locator("#library .lib-group-section")).toHaveCount(0);
  const betaResult = page.locator('[data-path="beta/note.md"]');
  await expect(betaResult).toHaveCount(1);
  await expect(betaResult).toBeVisible();
  await expect(betaResult.locator(".lib-file-context")).toContainText("Beta");
  await search.fill("");
  await expect(beta).toHaveAttribute("aria-expanded", "false");
});

test("closing and reopening Library reuses the cached GitHub index", async ({ page }) => {
  const api = await configureGitHubMock(page);
  await expect(page.locator("#library .lib-source")).toHaveText("Configured GitHub library");
  // The Library shell renders before its intentionally asynchronous index
  // request finishes. Observe the request itself rather than relying on the
  // source label's earlier paint as an index-settled signal.
  await expect.poll(api.indexReads).toBe(1);

  const launcher = page.getByRole("button", { name: "Library", exact: true });
  await launcher.click();
  await expect(page.locator("#library")).toBeHidden();
  await launcher.click();
  await expect(page.locator("#library")).toBeVisible();
  await expect.poll(api.indexReads).toBe(1);
});

test("GitHub library opens a remote document and autosaves it", async ({ page }) => {
  const api = await configureGitHubMock(page);
  await openRemoteDoc(page);
  await page.locator(".ProseMirror p").click({ position: { x: 20, y: 8 } });
  await page.keyboard.type("!");
  await expect.poll(api.writes, { timeout: 5_000 }).toBe(1);
  expect(api.writeRequests()[0].text).toContain("!");
  await expect(page.locator("#file-status")).not.toHaveClass(/is-dirty/);
});

test("switching tabs flushes the outgoing GitHub revision and preserves full paths", async ({ page }) => {
  const secondPath = "research/intro.md";
  const api = await configureGitHubMock(page, false, [
    { path: PATH, text: SOURCE, sha: "sha-1" },
    { path: secondPath, text: "Second note.\n", sha: "sha-2" },
  ]);
  await openRemoteDoc(page);
  await expect(page.locator("#tab-bar .tab.is-active")).toHaveAttribute("title", /drafts\/intro\.md/);
  await page.locator(".ProseMirror p").click({ position: { x: 20, y: 8 } });
  await page.keyboard.type(" switched");
  await (await revealLibraryFile(page, secondPath)).click();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("intro.md");
  await expect(page.locator("#tab-bar .tab.is-active")).toHaveAttribute("title", /research\/intro\.md/);
  await expect.poll(api.writes, { timeout: 5_000 }).toBe(1);
  expect(api.writeRequests()[0].path).toBe(PATH);
  expect(api.writeRequests()[0].text).toContain("switched");
});

test("switching during an in-flight GitHub save does not queue a duplicate commit", async ({ page }) => {
  const secondPath = "research/second.md";
  const api = await configureGitHubMock(page, false, [
    { path: PATH, text: SOURCE, sha: "sha-1" },
    { path: secondPath, text: "Second note.\n", sha: "sha-2" },
  ], true);
  await openRemoteDoc(page);
  await page.locator(".ProseMirror p").click({ position: { x: 20, y: 8 } });
  await page.keyboard.type(" one-save");
  await expect.poll(api.writes, { timeout: 5_000 }).toBe(1);
  await (await revealLibraryFile(page, secondPath)).click();
  api.releaseNextWrite();
  await page.waitForTimeout(2_800);
  expect(api.writes()).toBe(1);
});

test("backgrounding preserves equation editing and flushes one GitHub revision", async ({ page }) => {
  const api = await configureGitHubMock(page, false, [{
    path: PATH,
    text: "---\nlibrary: {\"id\":\"remote-1\",\"title\":\"Remote intro\"}\n---\n\nRemote $x$ note.\n",
    sha: "sha-1",
  }]);
  await openRemoteDoc(page);
  await page.locator(".math-inline").click();
  await expect(page.locator(".math-inline")).toHaveClass(/is-editing/);
  await expect(page.locator(".ime-input")).toHaveAttribute("data-editor-state", "ready");

  // Activation alone is not a document edit and must not create a commit.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".math-inline")).toHaveClass(/is-editing/);
  await expect(page.locator("#file-status")).not.toHaveClass(/is-dirty/);
  expect(api.writes()).toBe(0);

  // A real live-math edit is checkpointed into PM and the provider body without
  // closing the inline editor when another lifecycle boundary arrives.
  await page.locator(".ime-input").fill("y");
  await expect(page.locator("#file-status")).not.toHaveClass(/is-dirty/);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(".math-inline")).toHaveClass(/is-editing/);
  await expect(page.locator(".ime-input")).toHaveValue("y");
  await expect.poll(api.writes, { timeout: 5_000 }).toBe(1);
  expect(api.writeRequests()[0].text).toContain("$y$");
  // The ordinary autosave timer remains armed, but recognizes that this exact
  // revision is already saving/saved and must not create a second commit.
  await page.waitForTimeout(2_700);
  expect(api.writes()).toBe(1);
});

test("returning visible retries a failed background GitHub flush", async ({ page }) => {
  const api = await configureGitHubMock(page, false, undefined, false, 1);
  await openRemoteDoc(page);
  await page.locator(".ProseMirror p").click({ position: { x: 20, y: 8 } });
  await page.keyboard.type(" retry-visible");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(api.writes, { timeout: 5_000 }).toBe(1);
  await expect(page.locator("#file-status")).toHaveText("Sync failed");

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(api.writes, { timeout: 5_000 }).toBe(2);
  expect(api.writeRequests()[1].text).toContain("retry-visible");
  await expect(page.locator("#file-status")).toHaveText("Saved");
});

test("creates and filters a note in the physical Other notes collection", async ({ page }) => {
  const api = await configureGitHubMock(page);
  // New-note naming now uses the in-DOM prompt dialog (window.prompt is dead in
  // the desktop WebView), so it is driven like any other DOM.
  await page.getByLabel("More library actions").click();
  await page.getByRole("menuitem", { name: "New other note" }).click();
  const nameInput = page.locator(".dialog-input");
  await expect(nameInput).toHaveValue("untitled.md");
  await nameInput.fill("field-note");
  await page.locator(".dialog-confirm").click();

  await expect.poll(api.writes).toBe(1);
  expect(api.writeRequests()[0]).toEqual({
    path: "other-notes/field-note.md",
    expectedSha: undefined,
    text: "",
  });
  await expect(page.locator('[data-path="other-notes/field-note.md"]')).toHaveCount(1);
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("field-note.md");

  await page.locator("#library select.lib-group-select").selectOption("project");
  const collection = page.locator("#library .lib-group-section").filter({
    has: page.locator(".lib-group-head.lib-group-collection", { hasText: "Other notes" }),
  });
  await expect(collection.locator('[data-path="other-notes/field-note.md"]')).toHaveCount(1);

  const filterButton = page.getByRole("button", { name: "Filter", exact: true });
  await expect(filterButton).toHaveAttribute("aria-expanded", "false");
  await filterButton.click();
  await expect(filterButton).toHaveAttribute("aria-expanded", "true");
  const otherNotesFilter = page.getByRole("button", { name: "Apply collection filter: Other notes" });
  await expect(otherNotesFilter).toHaveAttribute("aria-pressed", "false");
  await otherNotesFilter.click();
  await expect(page.getByRole("button", { name: "Remove collection filter: Other notes" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#library .lib-file")).toHaveCount(1);
  await expect(page.locator('[data-path="other-notes/field-note.md"]')).toBeVisible();

  await runLibraryAction(page, "Pull latest from GitHub");
  await expect(page.locator('[data-path="other-notes/field-note.md"]')).toBeVisible();
});

test("reports invalid Other notes paths without creating a remote document", async ({ page }) => {
  const api = await configureGitHubMock(page);
  for (const invalid of ["other-notes", "reading\\smith"]) {
    await page.getByLabel("More library actions").click();
    await page.getByRole("menuitem", { name: "New other note" }).click();
    await page.locator(".dialog-input").fill(invalid);
    await page.locator(".dialog-confirm").click();
    await expect(page.locator("#library .lib-action-notice")).toContainText(
      "Enter a valid note path using forward slashes",
    );
  }
  expect(api.writes()).toBe(0);
});

test("manual save cancels the identical pending autosave", async ({ page }) => {
  const api = await configureGitHubMock(page);
  await openRemoteDoc(page);
  await page.locator(".ProseMirror p").click({ position: { x: 20, y: 8 } });
  await page.keyboard.type(" manual");
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+s`);
  await expect.poll(api.writes).toBe(1);
  await page.waitForTimeout(2_700);
  expect(api.writes()).toBe(1);
});

test("continuous edits serialize delayed GitHub autosaves and advance the SHA", async ({ page }) => {
  const api = await configureGitHubMock(page, false, undefined, true);
  await openRemoteDoc(page);
  const paragraph = page.locator(".ProseMirror p");
  await paragraph.click({ position: { x: 20, y: 8 } });
  await page.keyboard.type(" first");

  await expect.poll(api.writes, { timeout: 5_000 }).toBe(1);
  expect(api.writeRequests()[0]).toMatchObject({ expectedSha: "sha-1" });
  await page.keyboard.type(" second");
  await expect(page.locator("#file-status")).toHaveClass(/is-dirty/);

  // Let the second autosave debounce elapse while the first network request is
  // deliberately held. It must queue locally rather than reuse sha-1.
  await page.waitForTimeout(2_700);
  expect(api.writes()).toBe(1);
  api.releaseNextWrite();

  await expect.poll(api.writes, { timeout: 5_000 }).toBe(2);
  expect(api.writeRequests()[1]).toMatchObject({ expectedSha: "sha-2" });
  expect(api.writeRequests()[0].text).toContain("first");
  expect(api.writeRequests()[0].text).not.toContain("second");
  expect(api.writeRequests()[1].text).toContain("first second");
  // Completing the older revision advanced the SHA but did not clear the newer
  // editor revision while its queued write remains in flight.
  await expect(page.locator("#file-status")).toHaveClass(/is-dirty/);

  api.releaseNextWrite();
  await expect(page.locator("#file-status")).not.toHaveClass(/is-dirty/);
});

test("dirty-tab close quiesces provider writes before Discard and resumes after Cancel", async ({ page }) => {
  const api = await configureGitHubMock(page, false, undefined, true);
  await openRemoteDoc(page);
  const paragraph = page.locator(".ProseMirror p");
  const modifier = process.platform === "darwin" ? "Meta" : "Control";

  await paragraph.click({ position: { x: 20, y: 8 } });
  await page.keyboard.type(" first");
  await page.keyboard.press(`${modifier}+s`);
  await expect.poll(api.writes).toBe(1);

  // Queue a newer revision behind the deliberately held provider request.
  // Closing must await the first request, cancel the queued one, and only then
  // expose the asynchronous Discard dialog.
  await page.keyboard.type(" second");
  await page.keyboard.press(`${modifier}+s`);
  await page.locator('.tab[aria-label="untitled.md"]').click();
  await expect(page.locator('.tab[aria-label="untitled.md"]')).toHaveAttribute("aria-current", "page");
  await page.locator('.tab-close[aria-label^="Close drafts/intro.md"]').click();
  await page.waitForTimeout(100);
  await expect(page.locator(".dialog-overlay")).toHaveCount(0);
  expect(api.writes()).toBe(1);

  api.releaseNextWrite();
  await expect(page.locator(".dialog-overlay")).toBeVisible();
  expect(api.writes()).toBe(1);
  await page.waitForTimeout(300);
  expect(api.writes()).toBe(1);

  // Cancel unfreezes the parked tab and directly rearms its newest stored
  // revision; parked tabs have no active-document autosave timer.
  await page.locator(".dialog-cancel").click();
  await expect(page.locator(".dialog-overlay")).toHaveCount(0);
  await expect.poll(api.writes, { timeout: 5_000 }).toBe(2);
  expect(api.writeRequests()[1].text).toContain("first second");
  api.releaseNextWrite();
  await page.locator('.tab[aria-label="drafts/intro.md"]').click();
  await expect(page.locator("#file-status")).not.toHaveClass(/is-dirty/);

  // A subsequent Discard closes the tab without letting its pending autosave
  // start under the dialog or after the tab has gone away.
  await paragraph.click({ position: { x: 20, y: 8 } });
  await page.keyboard.type(" discarded");
  await page.locator('.tab-close[aria-label^="Close drafts/intro.md"]').click();
  await expect(page.locator(".dialog-overlay")).toBeVisible();
  expect(api.writes()).toBe(2);
  await page.locator(".dialog-confirm").click();
  await expect(page.locator('.tab[aria-label="drafts/intro.md"]')).toHaveCount(0);
  await page.waitForTimeout(2_800);
  expect(api.writes()).toBe(2);
});

test("GitHub conflict keeps a local recovery draft and restores remote content", async ({ page }) => {
  const api = await configureGitHubMock(page, true);
  await openRemoteDoc(page);
  await page.locator(".ProseMirror p").click({ position: { x: 20, y: 8 } });
  await page.keyboard.type("!");
  await expect.poll(api.writes, { timeout: 5_000 }).toBe(1);
  await expect(page.locator("#file-status")).toHaveText("Sync failed");
  await expect(page.locator("#file-status")).toHaveAttribute("title", /remote version restored/i);
  await expect.poll(async () => (await recoveryDrafts(page)).length).toBe(1);
  expect(await page.evaluate(() => (window as any).__serialize())).toContain("Changed on GitHub.");
});

test("a delayed conflict preserves typing newer than the attempted save", async ({ page }) => {
  const api = await configureGitHubMock(page, true, undefined, true);
  await openRemoteDoc(page);
  await page.locator(".ProseMirror p").click({ position: { x: 20, y: 8 } });
  await page.keyboard.type(" first");
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+s`);
  await expect.poll(api.writes).toBe(1);
  await page.keyboard.type(" second");
  api.releaseNextWrite();

  await expect(page.locator("#file-status")).toHaveText("Sync failed");
  await expect(page.locator("#file-status")).toHaveAttribute("title", /remote version restored/i);
  await expect.poll(async () => (await recoveryDrafts(page)).length).toBe(1);
  const [recovery] = await recoveryDrafts(page);
  expect(recovery.text).toContain("first second");
});

test("Pull refreshes the opened tab from GitHub", async ({ page }) => {
  const api = await configureGitHubMock(page);
  await openRemoteDoc(page);
  api.setRemote(REMOTE);
  await runLibraryAction(page, "Pull latest from GitHub");
  await expect.poll(async () => page.evaluate(() => (window as any).__serialize())).toContain("Changed on GitHub.");
});

test("comment inbox reports a remote reply and opens its anchored thread", async ({ page }) => {
  const stored = {
    id: "inbox-thread",
    kind: "user",
    author: "Researcher",
    body: "Please review this statement",
    resolved: false,
    createdAt: 1_700_000_000_000,
    replies: [] as Array<Record<string, unknown>>,
    quote: "Remote",
  };
  const source = (comment: typeof stored) => [
    "---",
    'library: {"id":"remote-1","title":"Remote intro","projects":["sample-project"]}',
    `comments: ${JSON.stringify([comment])}`,
    "---",
    "",
    "Remote note.",
    "",
  ].join("\n");
  const api = await configureGitHubMock(page, false, [{ path: PATH, text: source(stored), sha: "sha-1" }]);
  await expect(page.getByRole("button", { name: /Comment inbox, no new activity/ })).toBeEnabled();

  stored.replies = [{
    kind: "user",
    author: "Coauthor",
    principalId: "coauthor-one",
    body: "I added a qualification",
    createdAt: 1_700_000_100_000,
  }];
  api.setRemote(source(stored), "sha-2");
  await runLibraryAction(page, "Pull latest from GitHub");

  await page.setViewportSize({ width: 390, height: 720 });
  const closeLibrary = page.locator("#library").getByRole("button", { name: "Close library" });
  if (await closeLibrary.isVisible()) await closeLibrary.click();
  const launcher = page.getByRole("button", { name: /Comment inbox, 1 new activity/ });
  await expect(launcher).toBeVisible();
  await launcher.click();
  const inbox = page.getByRole("dialog", { name: "Comment inbox" });
  await expect(inbox).toHaveAttribute("data-panel-layout", "sheet");
  await expect(inbox).toContainText("New reply");
  await expect(inbox).toContainText("Coauthor");
  await expect(inbox).toContainText("Remote intro");
  await inbox.locator(".comment-inbox-open").click();
  await expect(page.locator(".ProseMirror .comment")).toHaveText("Remote");
  await expect(page.locator(".comment-card.is-active")).toContainText("I added a qualification");
  await expect(page.getByRole("button", { name: /Comment inbox, no new activity/ })).toBeVisible();
});

test("GitHub comments commit serialized metadata and advance the document SHA", async ({ page }) => {
  const api = await configureGitHubMock(page);
  await openRemoteDoc(page);

  await selectWord(page, "Remote");
  const popover = page.locator(".selection-popover");
  await expect(popover).toBeVisible();
  await popover.locator(".sp-note").click();
  await popover.locator("textarea").fill("sync proof");
  await popover.getByRole("button", { name: "Comment" }).click();

  await expect.poll(api.writes, { timeout: 5_000 }).toBe(1);
  const firstSave = api.writeRequests()[0];
  expect(firstSave).toMatchObject({ path: PATH, expectedSha: "sha-1" });
  expect(firstSave.text).toContain("comments: [");
  expect(parseFrontmatter(firstSave.text).frontmatter.comments[0]).toMatchObject({
    body: "sync proof",
    quote: "Remote",
  });

  await page.getByRole("button", { name: "Resolve" }).click();
  await expect.poll(api.writes, { timeout: 5_000 }).toBe(2);
  expect(api.writeRequests()[1]).toMatchObject({ path: PATH, expectedSha: "sha-2" });
  await expect(page.locator("#file-status")).not.toHaveClass(/is-dirty/);
});

test("Cmd/Ctrl-click opens a stable-id wiki link at its owner anchor", async ({ page }) => {
  const source: RemoteDocument = {
    path: "projects/source.md",
    sha: "source-sha",
    text: "---\nlibrary: {\"id\":\"source\",\"title\":\"Source\"}\n---\n\nRead [[target#result-anchor|the nested result]].\n",
  };
  const target: RemoteDocument = {
    path: "projects/nested/target.md",
    sha: "target-sha",
    text: "---\nlibrary: {\"id\":\"target\",\"title\":\"Nested target\"}\n---\n\n# Target {#result-anchor}\n\nTarget body.\n",
  };
  await configureGitHubMock(page, false, [source, target]);
  await openRemoteDoc(page, source.path);
  await expect(page.locator(".doc-link")).toHaveText("the nested result");

  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.locator(".doc-link").click();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("source.md");
  await page.locator(".doc-link").click({ modifiers: [modifier] });
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("target.md");
  await expect(page.locator(".ProseMirror")).toContainText("Target body.");
  await expect(page.locator('#editor-host [id="result-anchor"]')).toBeInViewport();
});

test("table-safe and soft-wrapped cross-project wiki links retain their source and open", async ({ page }) => {
  const authored = "[[sample-interface-crosswalk\\|cross-project\ninterface crosswalk]]";
  const source: RemoteDocument = {
    path: "projects/network-hubs/index.md",
    sha: "source-sha",
    text: [
      "---",
      'library: {"id":"sample-network-index","title":"Network Hubs","projects":["network-hubs"]}',
      "---",
      "",
      `Read the ${authored}.`,
      "",
    ].join("\n"),
  };
  const target: RemoteDocument = {
    path: "projects/transport-bottlenecks/references/network-hubs-interface-crosswalk.md",
    sha: "target-sha",
    text: [
      "---",
      'library: {"id":"sample-interface-crosswalk","title":"Network Hubs and Trade Bottlenecks Interface Crosswalk","projects":["transport-bottlenecks"]}',
      "---",
      "",
      "# Cross-project interface",
      "",
      "Shared theorem families.",
      "",
    ].join("\n"),
  };
  await configureGitHubMock(page, false, [source, target]);
  await openRemoteDoc(page, source.path);
  const link = page.locator(".doc-link");
  await expect(link).toHaveText("cross-project interface crosswalk");
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await link.click({ modifiers: [modifier] });
  await expect(page.locator("#tab-bar .tab.is-active .tab-label"))
    .toHaveText("network-hubs-interface-crosswalk.md");
  await page.locator("#tab-bar .tab").filter({ hasText: "index.md" }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__serialize()))
    .toContain(authored);
});

test("catalog-known formal result IDs open their declared owner claim anchor", async ({ page }) => {
  const source: RemoteDocument = {
    path: "project/source.md",
    sha: "source-sha",
    text: [
      "---",
      'library: {"id":"source","title":"Source","projects":["project-one"]}',
      "---",
      "",
      "The resilience argument uses `R-DEMO-OVERLAP`.",
      "",
    ].join("\n"),
  };
  const owner: RemoteDocument = {
    path: "project/owner.md",
    sha: "owner-sha",
    text: [
      "---",
      'library: {"id":"sample-risk-analysis","title":"Risk and resilience","projects":["project-one"]}',
      "---",
      "",
      "# Risk and resilience",
      "",
      "<!-- mathdown-claim:R-DEMO-OVERLAP -->",
      "",
      "Pairwise overlap result.",
      "",
    ].join("\n"),
  };
  const manifest: RemoteDocument = {
    path: "project/verification/results.md",
    sha: "manifest-sha",
    text: [
      "---",
      'library: {"id":"project-results","title":"Results","projects":["project-one"],"contains":["dependency-graph"]}',
      "---",
      "",
      "## Result dependency manifest {#dependency-graph}",
      "",
      "| Result ID | Result | Owner | Validation | Depends on | Evidence | Remaining condition |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| `R-DEMO-OVERLAP` | Pairwise overlap | [[sample-risk-analysis\\|Risk and resilience]] | validated |  | Checked | None |",
      "",
    ].join("\n"),
  };

  await configureGitHubMock(page, false, [source, owner, manifest]);
  await openRemoteDoc(page, source.path);
  const result = page.locator('[data-result-id="R-DEMO-OVERLAP"]');
  await expect(result).toHaveCount(1);
  await expect(result).toHaveAttribute("role", "link");
  await expect(result).toHaveAttribute("aria-label", /Pairwise overlap.*Risk and resilience/i);

  // An ordinary editing click keeps its caret behavior. The established
  // keyboard and modifier gestures follow the derived result reference.
  await result.click();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("source.md");
  await result.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("owner.md");
  await expect(
    page.locator('#editor-host [id="mathdown-claim:R-DEMO-OVERLAP"]'),
  ).toBeInViewport();

  await page.locator("#tab-bar .tab").filter({ hasText: "source.md" }).click();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await result.click({ modifiers: [modifier] });
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("owner.md");
  await expect(
    page.locator('#editor-host [id="mathdown-claim:R-DEMO-OVERLAP"]'),
  ).toBeInViewport();
});

test("Cmd/Ctrl-click resolves a relative Markdown link and owner anchor through the library", async ({ page }) => {
  const source: RemoteDocument = {
    path: "projects/source.md",
    sha: "source-sha",
    text: "---\nlibrary: {\"id\":\"source\",\"title\":\"Source\"}\n---\n\nRead [the nested result](nested/target.md#result-anchor).\n",
  };
  const target: RemoteDocument = {
    path: "projects/nested/target.md",
    sha: "target-sha",
    text: "---\nlibrary: {\"id\":\"target\",\"title\":\"Nested target\"}\n---\n\n# Target {#result-anchor}\n\nTarget body.\n",
  };
  await configureGitHubMock(page, false, [source, target]);
  await openRemoteDoc(page, source.path);
  const link = page.locator('a[href="nested/target.md#result-anchor"]');
  const modifier = process.platform === "darwin" ? "Meta" : "Control";

  await link.click();
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("source.md");
  await link.click({ modifiers: [modifier] });
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("target.md");
  await expect(page.locator('#editor-host [id="result-anchor"]')).toBeInViewport();
});

test("a missing wiki target leaves the document open and reports the problem", async ({ page }) => {
  const source: RemoteDocument = {
    path: "projects/source.md",
    sha: "source-sha",
    text: "---\nlibrary: {\"id\":\"source\",\"title\":\"Source\"}\n---\n\nRead [[missing]].\n",
  };
  await configureGitHubMock(page, false, [source]);
  await openRemoteDoc(page, source.path);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.locator(".doc-link").click({ modifiers: [modifier] });
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("source.md");
  await expect(page.locator("#file-status")).toHaveText("Sync failed");
  await expect(page.locator("#file-status")).toHaveAttribute("title", /Document .missing. was not found/i);
});

test("a missing stable-id anchor opens the owner and reports the broken fragment", async ({ page }) => {
  const source: RemoteDocument = {
    path: "projects/source.md",
    sha: "source-sha",
    text: "---\nlibrary: {\"id\":\"source\",\"title\":\"Source\"}\n---\n\nRead [[target#missing-anchor|the missing result]].\n",
  };
  const target: RemoteDocument = {
    path: "projects/target.md",
    sha: "target-sha",
    text: "---\nlibrary: {\"id\":\"target\",\"title\":\"Target\"}\n---\n\n# Target\n",
  };
  await configureGitHubMock(page, false, [source, target]);
  await openRemoteDoc(page, source.path);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.locator(".doc-link").click({ modifiers: [modifier] });
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("target.md");
  await expect(page.locator("#file-status")).toHaveText("Sync failed");
  await expect(page.locator("#file-status")).toHaveAttribute(
    "title",
    /Anchor .missing-anchor. was not found in document .target./i,
  );
});

test("local-folder wiki links use the same stable-id lookup", async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__mockLibrary);
  await page.evaluate(() => (window as any).__mockLibrary());
  // All project-mode disclosures, including the unprojected group, start
  // collapsed and therefore mount no file rows.
  await expect(page.locator("#library .lib-file")).toHaveCount(0);
  await expect(page.locator('.lib-group-section[data-group-key="gravity-trade"] > .lib-group-body .lib-file')).toHaveCount(0);
  await expect(page.locator("#library .lib-title")).toHaveText("Library");
  await expect(page.locator("#library .lib-source")).toHaveText("Sample · sample-library");
  const more = page.getByLabel("More library actions");
  await more.click();
  await expect(page.getByRole("menuitem", { name: "New document" })).toBeVisible();
  await more.click();
  await page.evaluate(() => (window as any).__load(
    "Read [[p2\\|Proposition\n2]].\n",
  ));
  await expect(page.locator(".doc-link")).toHaveText("Proposition 2");

  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.locator(".doc-link").click({ modifiers: [modifier] });
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("proposition-2.md");
  await expect(page.locator(".ProseMirror")).toContainText("Proposition 2");
});

test("setup-pending sync does not expose a broken Connect button", async ({ page }) => {
  await page.addInitScript((api) => {
    localStorage.clear();
    localStorage.setItem("mdlyx:github-api-url", api);
  }, API);
  await page.route(`${API}/**`, async (route) => {
    if (new URL(route.request().url()).pathname === "/health") {
      await json(route, { ok: true, configured: false });
      return;
    }
    await json(route, { error: "not found" }, 404);
  });
  await page.goto("/");
  await expect(page.locator("#library")).toContainText("GitHub sync setup is still in progress");
  await expect(page.getByRole("button", { name: "Connect GitHub…" })).toHaveCount(0);
});

test("sign-in-needed sync starts the GitHub device flow", async ({ page }) => {
  await page.addInitScript((api) => {
    localStorage.clear();
    localStorage.setItem("mdlyx:github-api-url", api);
  }, API);
  await page.route(`${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/health") return json(route, { ok: true, configured: true });
    if (path === "/auth/session") return json(route, { authenticated: false });
    if (path === "/auth/device/start") {
      return json(route, {
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        expiresIn: 900,
        interval: 5,
      });
    }
    if (path === "/auth/device/poll") return json(route, { state: "pending" });
    return json(route, { error: "not found" }, 404);
  });
  await page.goto("/");
  const connect = page.getByRole("button", { name: "Connect GitHub…" });
  await expect(connect).toHaveCount(1);
  await connect.click();
  await expect(page.locator("#library")).toContainText("Enter this one-time code: WDJB-MJHT");
  await expect(page.getByRole("button", { name: "Open GitHub verification" })).toHaveCount(1);
  await expect(page.locator("#library")).toContainText("Code expires in 15:00");

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("#config-library-sync")).toContainText("Library & GitHub Sync");
  await expect(page.locator("#config-library-sync")).toContainText("Code: WDJB-MJHT");
  const copyLink = page.locator("#config-library-sync").getByRole("button", { name: "Copy link" });
  await expect(copyLink).toHaveCount(1);
  await copyLink.evaluate((element) => element.setAttribute("data-stability", "keep"));
  await page.waitForTimeout(1_200);
  await expect(copyLink).toHaveAttribute("data-stability", "keep");
  await expect(page.locator("#config-panel")).toBeVisible();
});

test("GitHub's SPA OAuth return exchanges its code without exposing an API callback URL", async ({ page }) => {
  await page.addInitScript((api) => {
    localStorage.clear();
    localStorage.setItem("mdlyx:github-api-url", api);
  }, API);
  let completeBody: unknown;
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/auth/complete") {
      completeBody = request.postDataJSON();
      return json(route, { authenticated: true, login: "example-owner" });
    }
    if (path === "/health") return json(route, { ok: true, configured: true });
    if (path === "/auth/session") return json(route, { authenticated: true, login: "example-owner" });
    if (path === "/v1/library") return json(route, { entries: [] });
    return json(route, { error: "not found" }, 404);
  });
  await page.goto("/github-link?code=github-code&state=signed-state");
  await expect.poll(() => completeBody).toEqual({ code: "github-code", state: "signed-state" });
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#library .lib-sync")).toHaveAttribute("aria-label", "Connected to GitHub");
});

test("Settings manages an active GitHub session, Pull, and sign out", async ({ page }) => {
  await page.addInitScript((api) => {
    localStorage.clear();
    localStorage.setItem("mdlyx:github-api-url", api);
  }, API);
  let authenticated = true;
  let healthChecks = 0;
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/health") {
      healthChecks += 1;
      return json(route, {
        ok: true,
        configured: true,
        version: "0.3.1",
        revision: "abcdef123456",
      });
    }
    if (path === "/auth/session") return json(route, authenticated
      ? { authenticated: true, login: "example-owner" }
      : { authenticated: false });
    if (path === "/auth/logout") {
      authenticated = false;
      return json(route, { authenticated: false });
    }
    if (path === "/v1/library") return json(route, { entries: [] });
    return json(route, { error: "not found" }, 404);
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Software" }).click();
  const software = page.locator("#config-software");
  await expect(software).toContainText("Software & Updates");
  await expect(software.locator(".config-version")).toHaveText(APP_VERSION);
  await expect(software).toContainText("BuildHosted web");
  await expect(software).toContainText("DistributionDevelopment build");
  await expect(software).toContainText("ChannelStable · semantic versioning");
  await expect(software).toContainText("Library serviceOnline and configured");
  await expect(software).toContainText("Service build0.3.1 · abcdef123456");
  await expect(software).toContainText("App updatesAutomatic hosted deployment");
  const checksBefore = healthChecks;
  await software.getByRole("button", { name: "Check software status" }).click();
  await expect.poll(() => healthChecks).toBeGreaterThan(checksBefore);
  await expect(software).toContainText("Last checked");
  await settings.getByRole("tab", { name: "Library" }).click();
  const sync = page.locator("#config-library-sync");
  await expect(sync).toContainText("Connected as @example-owner");
  await expect(sync).toBeVisible();
  await expect(software).toBeHidden();
  await sync.getByRole("button", { name: "Pull latest" }).click();
  await expect(sync).toContainText("Pulled");
  await sync.getByRole("button", { name: "Sign out" }).click();
  await expect(sync).toContainText("GitHub sign-in or invitation needed");
  await expect(sync.getByRole("button", { name: "Connect GitHub" })).toHaveCount(1);
});

async function configureSharedAccessMock(
  page: Page,
  role: "reader" | "commenter" | "editor",
  beginAuthenticated = false,
) {
  const path = "projects/sample-model/shared.md";
  const source = `---
library: {"id":"shared-sample-model","title":"Shared sample-model note","projects":["sample-model"]}
comments: []
---

Shared research body.

See [[sample-interface-crosswalk\\|cross-project
interface crosswalk]].

[Public source](https://example.test/shared-source).
`;
  const writes: WriteRequest[] = [];
  let authenticated = beginAuthenticated;
  let redeemed = false;
  await page.addInitScript((api) => {
    localStorage.clear();
    localStorage.setItem("mdlyx:github-api-url", api);
  }, API);
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const session = authenticated ? {
      authenticated: true,
      principal: { id: "alice", displayName: "Alice Smith", kind: "coauthor" },
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1_000,
      grants: [{ project: "sample-model", role }],
      capabilities: { canShare: false, canUseUpdater: false },
    } : { authenticated: false };
    if (url.pathname === "/health") return json(route, { ok: true, configured: true });
    if (url.pathname === "/auth/session") return json(route, session);
    if (url.pathname === "/auth/invite/redeem") {
      const body = request.postDataJSON() as { token?: string };
      if (redeemed || body.token !== "A".repeat(43)) {
        return json(route, { error: "This invitation is invalid, expired, or already used" }, 410);
      }
      redeemed = true;
      authenticated = true;
      return json(route, { ...session, authenticated: true });
    }
    if (url.pathname === "/auth/logout") {
      authenticated = false;
      return json(route, { authenticated: false });
    }
    if (url.pathname === "/v2/library/index") {
      return json(route, {
        revision: "shared-tree",
        entries: [{
          path,
          sha: "shared-sha",
          meta: { id: "shared-sample-model", title: "Shared sample-model note", projects: ["sample-model"] },
          openCommentCount: 0,
        }],
      });
    }
    if (url.pathname === "/v1/library/documents" && request.method() === "GET") {
      return json(route, { path, sha: "shared-sha", text: source });
    }
    if (url.pathname === "/v1/library/documents" && request.method() === "PUT") {
      const body = request.postDataJSON() as { expectedSha?: string; text?: string };
      writes.push({ path, expectedSha: body.expectedSha, text: body.text ?? "" });
      return json(route, { path, sha: `shared-sha-${writes.length + 1}`, text: body.text ?? "" });
    }
    return json(route, { error: "not found" }, 404);
  });
  return { path, writes, authenticated: () => authenticated };
}

test("one-time invitation opens a commenter-only shared library", async ({ page }) => {
  const shared = await configureSharedAccessMock(page, "commenter");
  await page.goto(`/invite#token=${"A".repeat(43)}`);
  await expect(page.getByRole("heading", { name: "Shared MdLyx library" })).toBeVisible();
  await expect(page.getByText("sample-model")).toHaveCount(0);
  expect(shared.authenticated()).toBe(false);
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await page.waitForFunction(() => !!(window as any).__editor);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#library .lib-source")).toHaveText("Shared library");
  await expect(page.locator("#library .lib-sync")).toHaveText("Shared");
  await page.getByLabel("More library actions").click();
  await expect(page.getByRole("menuitem", { name: "New document" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Pull latest shared changes" })).toBeVisible();
  await page.getByLabel("More library actions").click();

  await (await revealLibraryFile(page, shared.path)).click();
  await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
  await selectWord(page, "Shared");
  const popover = page.locator(".selection-popover");
  await expect(popover).toBeVisible();
  await popover.locator(".sp-note").click();
  await popover.locator("textarea").fill("Coauthor note");
  await popover.getByRole("button", { name: "Comment" }).click();
  await expect.poll(() => shared.writes.length).toBe(1);
  expect(parseFrontmatter(shared.writes[0].text).frontmatter.comments[0]).toMatchObject({
    body: "Coauthor note",
    principalId: "alice",
  });

  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByRole("tab", { name: "Sharing" })).toBeHidden();
  await expect(settings).toContainText("Alice Smith");
  await expect(settings).toContainText("sample-model · commenter");
  await expect(settings).not.toContainText("GitHub device");
  await settings.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#tab-bar .tab")).toHaveCount(1);
  expect(shared.authenticated()).toBe(false);
});

test("reader and editor shared sessions expose different document capabilities", async ({ page }) => {
  const shared = await configureSharedAccessMock(page, "reader", true);
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__editor);
  await expect(page.locator("#library .lib-list-summary")).toContainText("1 documents");
  await (await revealLibraryFile(page, shared.path)).click();
  await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
  await page.evaluate(() => {
    const state = window as any;
    state.__openedLinks = [];
    window.open = ((...args: unknown[]) => {
      state.__openedLinks.push(args);
      return null;
    }) as typeof window.open;
  });
  await page.getByRole("link", { name: "Public source" }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__openedLinks))
    .toEqual([["https://example.test/shared-source", "_blank", "noopener,noreferrer"]]);
  const hiddenCrossProjectLink = page.getByText("cross-project interface crosswalk");
  await hiddenCrossProjectLink.click();
  await expect(page.locator("#file-status")).toHaveAttribute(
    "title",
    /Document .sample-interface-crosswalk. was not found in the current library/i,
  );
  await selectWord(page, "Shared");
  await expect(page.locator(".selection-popover")).toBeHidden();
  await expect(page.locator("#btn-save")).toBeDisabled();
});

test("editor shared sessions can edit existing project documents", async ({ page }) => {
  const shared = await configureSharedAccessMock(page, "editor", true);
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__editor);
  await expect(page.locator("#library .lib-list-summary")).toContainText("1 documents");
  await (await revealLibraryFile(page, shared.path)).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__serialize())).toContain("Shared research body.");
  await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "true");
  await page.locator(".ProseMirror p", { hasText: "Shared research body." }).click();
  await page.keyboard.type(" Edited");
  await expect.poll(() => shared.writes.length).toBe(1);
  expect(shared.writes[0].text).toContain("Edited");
});
