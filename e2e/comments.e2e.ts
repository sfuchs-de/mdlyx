import { test, expect, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => d.dismiss());
  await page.addInitScript(() => { localStorage.removeItem("mdlyx:backup"); localStorage.removeItem("mdlyx:session"); });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__editor);
  await page.evaluate(() => {
    (window as any).__load("The relation is important to the result.\n");
  });
});

// Select a word via a DOM range; ProseMirror syncs its selection from it,
// which pops the selection popover.
async function selectWord(page: Page, word: string) {
  await page.locator(".ProseMirror").click();
  await page.evaluate((w) => {
    const p = document.querySelector(".ProseMirror p") as HTMLElement;
    const t = p.firstChild as Text;
    const start = t.textContent!.indexOf(w);
    const range = document.createRange();
    range.setStart(t, start);
    range.setEnd(t, start + w.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, word);
}

async function closeMobileLibraryIfVisible(page: Page) {
  // Resizing can hide the drawer between the visibility check and the click.
  // The close control, unlike the off-canvas container, is the stable signal.
  const close = page.locator("#library").getByRole("button", { name: "Close library" });
  if (await close.isVisible()) await close.click();
}

// Open the note composer and submit a note (as user unless kind === "ai").
async function addNote(page: Page, word: string, body: string, kind: "user" | "ai" = "user") {
  await selectWord(page, word);
  const pop = page.locator(".selection-popover");
  await expect(pop).toBeVisible();
  await pop.locator(".sp-note").click();
  await pop.locator("textarea").fill(body);
  await pop.getByRole("button", { name: kind === "ai" ? "As AI" : "Comment" }).click();
}

test("click a swatch → text is highlighted instantly, no note required", async ({
  page,
}) => {
  await selectWord(page, "relation");
  const pop = page.locator(".selection-popover");
  await expect(pop).toBeVisible();
  await pop.locator(".sp-bar .sp-swatch-green").click();

  // The word is highlighted green; a bare-highlight card offers to add a note.
  await expect(page.locator(".ProseMirror .comment-color-green")).toHaveText("relation");
  await expect(page.locator(".comment-card")).toHaveCount(1);
  await expect(page.locator(".comment-card .cc-add-note")).toBeVisible();

  const stored = await page.evaluate(() =>
    (window as unknown as { __exportComments: () => { color?: string; body: string }[] }).__exportComments(),
  );
  expect(stored).toHaveLength(1);
  expect(stored[0].color).toBe("green");
  expect(stored[0].body).toBe("");
});

test("selection actions and composer stay within a phone visual viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await closeMobileLibraryIfVisible(page);
  await page.evaluate(() => (window as any).__load("Relation at the left edge and relation at the right edge.\n"));
  await selectWord(page, "Relation");
  const popover = page.locator(".selection-popover");
  await expect(popover).toBeVisible();
  const inside = async () => popover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 7 && rect.right <= window.innerWidth - 7
      && rect.top >= 7 && rect.bottom <= window.innerHeight - 7;
  });
  await expect.poll(inside).toBe(true);
  await popover.locator(".sp-note").click();
  await expect.poll(inside).toBe(true);
  await expect(popover.locator("textarea")).toBeFocused();
});

test("selection composer follows its anchor while the mobile editor scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await closeMobileLibraryIfVisible(page);
  const paragraphs = Array.from({ length: 36 }, (_, index) =>
    index === 18 ? "The moving anchor remains attached to this selection." : `Filler paragraph ${index}.`,
  );
  await page.evaluate((markdown) => (window as any).__load(markdown), paragraphs.join("\n\n"));
  const target = page.locator(".ProseMirror p").nth(18);
  await target.evaluate((element) => {
    const host = document.querySelector<HTMLElement>("#editor-host")!;
    host.scrollTop = (element as HTMLElement).offsetTop - 220;
  });
  // Mirror an actual pointer selection: focus the editor before installing the
  // DOM range. Without this, Chromium can leave the synthetic range detached
  // from ProseMirror's selection state under load, so no popover is expected.
  await target.click();
  await target.evaluate((element) => {
    const text = element.firstChild as Text;
    const start = text.textContent!.indexOf("moving anchor");
    const editor = (window as any).__editor;
    const view = editor.view;
    const from = view.posAtDOM(text, start);
    const to = view.posAtDOM(text, start + "moving anchor".length);
    const Selection = view.state.selection.constructor;
    view.focus();
    view.dispatch(view.state.tr.setSelection(Selection.create(view.state.doc, from, to)));
    // Keep the native and ProseMirror selections in lockstep. Chromium may
    // otherwise deliver a delayed selectionchange from the preceding click
    // and collapse the newly installed editor selection under parallel load.
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + "moving anchor".length);
    const native = window.getSelection()!;
    native.removeAllRanges();
    native.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });

  const popover = page.locator(".selection-popover");
  const note = popover.locator(".sp-note");
  await expect(note).toBeVisible();
  await note.click();
  const before = await popover.evaluate((element) => element.getBoundingClientRect().top);
  await page.locator("#editor-host").evaluate((element) => element.scrollBy(0, 48));
  await expect.poll(async () => popover.evaluate((element) => element.getBoundingClientRect().top)).not.toBe(before);
  await expect.poll(async () => popover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 7 && rect.right <= window.innerWidth - 7
      && rect.top >= 7 && rect.bottom <= window.innerHeight - 7;
  })).toBe(true);
});

test("phone review sheet navigates a long document with twenty comments", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await closeMobileLibraryIfVisible(page);
  const comments = Array.from({ length: 20 }, (_, index) => ({
    id: `mobile-${index}`,
    kind: "user",
    author: "owner",
    body: `Review item ${index}`,
    resolved: false,
    createdAt: index + 1,
    replies: [],
    quote: `Target ${index}`,
  }));
  const body = Array.from({ length: 20 }, (_, index) =>
    `Target ${index} appears in a sufficiently long paragraph for anchored mobile review.`,
  ).join("\n\n");
  await page.evaluate(({ comments: stored, body: markdown }) => {
    (window as any).__load(`---\ncomments: ${JSON.stringify(stored)}\n---\n\n${markdown}\n`);
  }, { comments, body });

  const sheet = page.getByRole("dialog", { name: "Comments" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".comments-review-count")).toHaveText("20 unresolved · 20 total");
  await expect(sheet.locator(".comment-card")).toHaveCount(20);
  await sheet.locator(".comment-card").nth(14).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("button", { name: /Review comments/ })).toBeVisible();
  await expect(page.locator(".ProseMirror .comment").nth(14)).toBeInViewport();
  await page.locator(".ProseMirror .comment").nth(14).click();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".comment-card.is-active")).toContainText("Review item 14");
});

test("add a note via the composer → margin card anchored to the text", async ({
  page,
}) => {
  await addNote(page, "relation", "is this the right term?");

  await expect(page.locator(".comment-card")).toHaveCount(1);
  await expect(page.locator(".comment-card .cc-body")).toHaveText("is this the right term?");
  await expect(page.locator(".ProseMirror .comment")).toHaveText("relation");

  const stored = await page.evaluate(() =>
    (window as unknown as { __exportComments: () => unknown[] }).__exportComments(),
  );
  expect(stored).toHaveLength(1);
});

test("add a note to an existing bare highlight from its card", async ({ page }) => {
  await selectWord(page, "relation");
  await page.locator(".selection-popover .sp-bar .sp-swatch-blue").click();
  const card = page.locator(".comment-card");
  await expect(card).toHaveCount(1);

  await card.getByRole("button", { name: /Add note/ }).click();
  await card.locator(".cc-note-box textarea").fill("expand on this");
  await card.locator(".cc-note-box").getByRole("button", { name: "Save" }).click();

  await expect(card.locator(".cc-body")).toHaveText("expand on this");
});

test("recolour a highlight from the card's colour dots", async ({ page }) => {
  await selectWord(page, "relation");
  await page.locator(".selection-popover .sp-bar .sp-swatch-yellow").click();
  await expect(page.locator(".ProseMirror .comment-color-yellow")).toHaveText("relation");

  await page.locator(".comment-card .cc-color-pink").click();
  await expect(page.locator(".ProseMirror .comment-color-pink")).toHaveText("relation");
  await expect(page.locator(".ProseMirror .comment-color-yellow")).toHaveCount(0);
});

test("AI note + threaded reply, distinguished from user comments", async ({
  page,
}) => {
  await addNote(page, "important", "consider hedging this", "ai");

  const card = page.locator(".comment-card-ai");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".cc-badge-ai").first()).toHaveText("AI");

  // Reply in-thread.
  await card.locator(".cc-actions").getByRole("button", { name: "Reply" }).click();
  await card.locator(".cc-reply-box textarea").fill("agreed, softening it");
  await card.locator(".cc-reply-actions").getByRole("button", { name: "Reply" }).click();
  await expect(card.locator(".cc-reply .cc-body")).toHaveText("agreed, softening it");
});

test("an agent-authored comment (quote only, no offsets) anchors on load", async ({
  page,
}) => {
  const fm = [
    "---",
    'comments: [{"id":"a1","kind":"ai","author":"AI reviewer","body":"Define this.","resolved":false,"status":"open","replies":[],"quote":"relation"}]',
    "---",
    "The relation is important to the result.",
    "",
  ].join("\n");
  await page.evaluate((doc) => (window as any).__load(doc), fm);
  // A doc with comments auto-shows the comment layer on load (no toggle needed).

  await expect(page.locator(".ProseMirror .comment-ai")).toHaveText("relation");
  await expect(page.locator(".comment-card-ai .cc-body")).toHaveText("Define this.");
});

test("AI note: set a priority and accept the verdict", async ({ page }) => {
  await addNote(page, "important", "needs a citation", "ai");

  const card = page.locator(".comment-card-ai");
  await expect(card).toHaveCount(1);

  await card.locator("select.cc-priority").selectOption("P1");
  await expect(card.locator("select.cc-priority")).toHaveValue("P1");

  await card.getByRole("button", { name: "Accept" }).click();
  await expect(page.locator(".cc-status-accepted")).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
});

test("clicking a highlight focuses its card; resolve toggles state", async ({
  page,
}) => {
  await addNote(page, "relation", "check this");
  await expect(page.locator(".comment-card")).toHaveCount(1);

  // Click the highlight → its card becomes active (scroll-sync).
  await page.locator(".ProseMirror .comment").click();
  await expect(page.locator(".comment-card.is-active")).toHaveCount(1);

  // Resolve.
  await page.locator(".comment-card .cc-actions").getByRole("button", { name: "Resolve" }).click();
  await expect(page.locator(".comment-card.is-resolved")).toHaveCount(1);
});
