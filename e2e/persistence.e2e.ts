import { test, expect, type Page } from "@playwright/test";

// Adversarial-review persistence regressions.
test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => d.dismiss());
  await page.addInitScript(() => {
    localStorage.removeItem("mdlyx:backup");
    localStorage.removeItem("mdlyx:session");
  });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__editor);
});

const isDirty = (page: Page) =>
  page.evaluate(() => document.getElementById("file-status")!.classList.contains("is-dirty"));

// #I26 — comment-thread edits (resolve/reply/priority/status) are metadata-only
// transactions with no doc change; they must still mark the document dirty so
// review work is persisted and backed up rather than silently lost.
test("a comment metadata edit marks the document dirty (#I26)", async ({ page }) => {
  const doc = `---
comments: [{"id":"c1","kind":"user","author":"me","body":"","resolved":false,"createdAt":0,"replies":[],"quote":"target"}]
---

This has a target word here.
`;
  await page.evaluate((m) => (window as any).__load(m), doc);
  expect(await page.locator(".comment").count()).toBe(1); // anchored on load
  expect(await isDirty(page)).toBe(false); // a fresh load is clean

  await page.evaluate(() => (window as any).__editor.resolveComment("c1", true));
  await page.waitForTimeout(50);
  expect(await isDirty(page)).toBe(true); // metadata edit dirtied it
});

// #I31 — a debounced serialize/autosave scheduled for the previous document
// must not fire after a new document is loaded (it would clobber the backup).
test("loading a new document cancels a pending autosave (#I31)", async ({ page }) => {
  await page.evaluate(() => (window as any).__load("first document body\n"));
  // dirty the first doc (schedules serialize + autosave), then immediately load a
  // second doc — the pending timers for the first must be cancelled.
  await page.locator(".ProseMirror p").first().click({ position: { x: 4, y: 8 } });
  await page.keyboard.type("X");
  await page.evaluate(() => (window as any).__load("second document body\n"));
  await page.waitForTimeout(700); // past the 500ms serialize debounce
  // The freshly loaded doc is intact and clean (no stale write reintroduced "X").
  expect(await isDirty(page)).toBe(false);
  expect(await page.evaluate(() => (window as any).__serialize())).toContain("second document body");
  expect(await page.evaluate(() => (window as any).__serialize())).not.toContain("Xfirst");
});

// #I10 — session restore. The set of open tabs (their content + dirty state) is
// persisted to localStorage and reopened on relaunch, recovering unsaved work
// without a modal (this supersedes the old single-doc crash-recovery banner).
const SESSION_KEY = "mdlyx:session";
async function seedSessionAndReload(page: Page, session: unknown) {
  await page.addInitScript(
    ([key, s]) => localStorage.setItem(key as string, JSON.stringify(s)),
    [SESSION_KEY, session] as const,
  );
  // WebKit can abort `reload()` internally after a long serial test run while
  // its previous document is flushing IndexedDB during pagehide. A fresh,
  // cache-busted same-origin navigation exercises the identical startup and
  // migration path without relying on WebKit's fragile reload fast path.
  await page.goto(`/?session-fixture=${Date.now()}-${Math.random()}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!(window as any).__editor);
}

test("session restore: reopens the previous session's tabs (#I10)", async ({ page }) => {
  await seedSessionAndReload(page, {
    tabs: [
      { name: "one.md", text: "first tab body\n", dirty: false },
      { name: "two.md", text: "second tab body\n", dirty: false },
    ],
    activeIndex: 1,
  });
  // Both tabs reopened; the persisted active tab is showing.
  await expect(page.locator("#tab-bar .tab")).toHaveCount(2);
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("two.md");
  expect(await page.evaluate(() => (window as any).__serialize())).toContain("second tab body");
});

test("document tabs use compact typography", async ({ page }) => {
  const tab = page.locator("#tab-bar .tab").first();
  const close = page.locator("#tab-bar .tab-close").first();
  await expect(tab).toBeVisible();
  const metrics = await tab.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fontSize: Number.parseFloat(style.fontSize),
      height: element.getBoundingClientRect().height,
    };
  });
  const closeBox = await close.boundingBox();
  const strip = await page.locator("#tab-bar").evaluate((element) => {
    const scroller = element.querySelector<HTMLElement>(".tab-scroll")!;
    const active = element.querySelector<HTMLElement>(".tab-item.is-active")!;
    return {
      height: element.getBoundingClientRect().height,
      scrollbarWidth: getComputedStyle(scroller).scrollbarWidth,
      scrollerClientHeight: scroller.clientHeight,
      scrollerOffsetHeight: scroller.offsetHeight,
      activeRadius: Number.parseFloat(getComputedStyle(active).borderRadius),
    };
  });
  expect(metrics.fontSize).toBeLessThanOrEqual(13);
  expect(metrics.height).toBeLessThanOrEqual(27);
  expect(closeBox?.width).toBeGreaterThanOrEqual(24);
  expect(closeBox?.height).toBeGreaterThanOrEqual(24);
  expect(strip.height).toBeLessThanOrEqual(36);
  expect(strip.scrollbarWidth).toBe("none");
  expect(strip.scrollerOffsetHeight).toBe(strip.scrollerClientHeight);
  expect(strip.activeRadius).toBeGreaterThanOrEqual(5);
  expect(await page.locator("#tab-bar .tab-scroll .tab-new").count()).toBe(0);
  await expect(page.locator("#tab-bar > .tab-actions > .tab-new")).toHaveCount(1);
  await expect(page.locator("#tab-bar > .tab-actions > .tab-overview-toggle")).toHaveCount(1);
});

test("session restore: a dirty tab comes back marked dirty (#I10)", async ({ page }) => {
  await seedSessionAndReload(page, {
    tabs: [{ name: "wip.md", text: "unsaved work\n", dirty: true }],
    activeIndex: 0,
  });
  await expect(page.locator("#tab-bar .tab.is-dirty")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__serialize())).toContain("unsaved work");
  expect(await isDirty(page)).toBe(true);
});

test("pagehide preserves MathLive editing and flushes its newest recovery value", async ({ page }) => {
  await page.evaluate(() => (window as any).__setEditMode("mathlive"));
  await page.evaluate(() => (window as any).__load("recovery $x$ target\n"));
  await page.locator(".math-inline").click();
  await expect(page.locator(".math-inline")).toHaveClass(/is-editing/);
  const field = page.locator("math-field");
  await expect(field).toHaveCount(1);
  await field.evaluate((element) => {
    const math = element as HTMLElement & { value: string };
    math.value = "y";
    math.dispatchEvent(new InputEvent("input", { bubbles: true, data: "y", inputType: "insertText" }));
  });
  // The live editor owns this value until the non-closing pagehide checkpoint.
  await expect(page.locator("#file-status")).not.toHaveClass(/is-dirty/);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await expect(page.locator(".math-inline")).toHaveClass(/is-editing/);
  await expect(field).toHaveCount(1);
  expect(await field.evaluate((element) => (element as HTMLElement & { value: string }).value)).toBe("y");
  await expect.poll(() => page.evaluate(async () => {
    const request = indexedDB.open("mdlyx", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("state", "readonly");
    const value = await new Promise<any>((resolve, reject) => {
      const get = transaction.objectStore("state").get("session:v2");
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    database.close();
    return value?.tabs?.[value.activeIndex ?? 0]?.text ?? "";
  })).toContain("recovery $y$ target");
});

test("clearing local recovery cannot be undone by the following pagehide", async ({ page }) => {
  await page.evaluate(() => (window as any).__load("clear this recovery\n"));
  await page.locator(".ProseMirror p").click();
  await page.keyboard.type("dirty ");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await page.evaluate(() => localStorage.setItem("mdlyx:session", JSON.stringify({
    tabs: [{ name: "legacy.md", text: "must stay cleared", dirty: true }],
    activeIndex: 0,
  })));
  await page.evaluate(() => (window as any).__clearLocalData());
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => localStorage.getItem("mdlyx:session"))).toBeNull();
  expect(await page.evaluate(async () => {
    const request = indexedDB.open("mdlyx", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("state", "readonly");
    const value = await new Promise<unknown>((resolve, reject) => {
      const get = transaction.objectStore("state").get("session:v2");
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    database.close();
    return value;
  })).toBeUndefined();
});

test("malformed restored tabs fall back to a valid initial document", async ({ page }) => {
  await seedSessionAndReload(page, { tabs: [null], activeIndex: 0 });
  await expect(page.locator("#tab-bar .tab")).toHaveCount(1);
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("untitled.md");
  await expect(page.locator(".ProseMirror")).toContainText("Introduction");
});

// Closing a dirty tab is gated by the in-DOM confirm dialog — window.confirm()
// always returns false in the desktop WebView, which made dirty tabs unclosable
// there (review s45). Cancel keeps the tab; Discard closes it.
test("closing a dirty tab confirms via the DOM dialog", async ({ page }) => {
  await seedSessionAndReload(page, {
    tabs: [
      { name: "keep.md", text: "keep me\n", dirty: false },
      { name: "wip.md", text: "unsaved work\n", dirty: true },
    ],
    activeIndex: 1,
  });
  await expect(page.locator("#tab-bar .tab")).toHaveCount(2);

  // A real double-click sequence must not let its second press flash-cancel the
  // freshly mounted backdrop. Cancel afterward: the dirty tab stays open.
  const dirtyClose = page.locator("#tab-bar .tab-item.is-dirty .tab-close");
  const closeBox = await dirtyClose.boundingBox();
  expect(closeBox).not.toBeNull();
  await page.mouse.dblclick(
    closeBox!.x + closeBox!.width / 2,
    closeBox!.y + closeBox!.height / 2,
    { delay: 40 },
  );
  await expect(page.locator(".dialog-overlay")).toBeVisible();
  await expect(page.locator(".dialog-message")).toContainText("wip.md");
  await expect(page.locator(".dialog-confirm.is-danger")).toHaveCSS(
    "background-color",
    "rgb(211, 47, 47)",
  );
  await page.locator(".dialog-cancel").click();
  await expect(page.locator(".dialog-overlay")).toHaveCount(0);
  await expect(page.locator("#tab-bar .tab")).toHaveCount(2);

  // Discard: the tab closes and the neighbour becomes active.
  await page.locator("#tab-bar .tab-item.is-dirty .tab-close").click();
  await page.locator(".dialog-confirm").click();
  await expect(page.locator("#tab-bar .tab")).toHaveCount(1);
  await expect(page.locator("#tab-bar .tab.is-active .tab-label")).toHaveText("keep.md");
  expect(await page.evaluate(() => (window as any).__serialize())).toContain("keep me");
});
