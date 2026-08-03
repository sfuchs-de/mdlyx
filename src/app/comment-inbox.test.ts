// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredComment } from "../editor/comments";
import { CommentInbox } from "./comment-inbox";
import type { CommentInboxSource } from "./library-view";
import { MemoryPersistenceStore } from "./persistence-store";

function comment(overrides: Partial<StoredComment> = {}): StoredComment {
  return {
    id: "c1",
    kind: "user",
    author: "Alice",
    body: "Please check this step",
    resolved: false,
    createdAt: 1_700_000_000_000,
    replies: [],
    quote: "the selected argument",
    ...overrides,
  };
}

function source(
  digest: string,
  comments: () => StoredComment[],
): CommentInboxSource {
  return {
    path: "projects/sample-project/derivation.md",
    documentId: "sample-derivation",
    documentTitle: "Sample derivation",
    projects: ["sample-project"],
    projectLabels: ["Sample project"],
    digest,
    read: async () => comments(),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("CommentInbox", () => {
  it("baselines existing threads, then reports a new reply and opens its anchor", async () => {
    const launcher = document.createElement("button");
    launcher.disabled = true;
    document.body.append(launcher);
    let digest = "d1";
    let comments = [comment()];
    const open = vi.fn(async () => true);
    const inbox = new CommentInbox(launcher, {
      context: () => ({ providerIdentity: "github:test/library", revision: digest, principalKey: "owner:researcher" }),
      sources: () => [source(digest, () => comments)],
      open,
      refreshLibrary: async () => true,
      usesGitHub: () => true,
    }, new MemoryPersistenceStore());

    await inbox.initialize();
    expect(launcher.disabled).toBe(false);
    expect(launcher.getAttribute("aria-label")).toContain("no new activity");

    // Re-anchoring after an ordinary prose edit invalidates the source digest,
    // but is not itself new review activity.
    comments = [comment({ start: 10, end: 18 })];
    digest = "d-anchor";
    await inbox.refresh();
    expect(launcher.getAttribute("aria-label")).toContain("no new activity");

    comments = [comment({
      replies: [{
        kind: "user",
        author: "Coauthor",
        principalId: "coauthor-one",
        body: "I added a qualification",
        createdAt: 1_700_000_100_000,
      }],
    })];
    digest = "d2";
    await inbox.refresh();

    expect(launcher.getAttribute("aria-label")).toContain("1 new activity");
    launcher.click();
    const item = document.querySelector<HTMLButtonElement>(".comment-inbox-open");
    expect(item?.textContent).toContain("New reply");
    expect(item?.textContent).toContain("Coauthor");
    expect(item?.textContent).toContain("Sample derivation");
    item?.click();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(
      "projects/sample-project/derivation.md",
      "c1",
    ));
    await vi.waitFor(() => expect(launcher.getAttribute("aria-label")).toContain("no new activity"));
  });

  it("tracks resolution changes and keeps unresolved threads independently filterable", async () => {
    const launcher = document.createElement("button");
    launcher.disabled = true;
    document.body.append(launcher);
    let digest = "d1";
    let comments = [comment()];
    const inbox = new CommentInbox(launcher, {
      context: () => ({ providerIdentity: "folder:research", revision: digest, principalKey: "local" }),
      sources: () => [source(digest, () => comments)],
      open: async () => true,
      refreshLibrary: async () => true,
      usesGitHub: () => false,
    }, new MemoryPersistenceStore());

    await inbox.initialize();
    comments = [comment({ resolved: true })];
    digest = "d2";
    await inbox.refresh();
    launcher.click();
    expect(document.querySelector(".comment-inbox-open")?.textContent).toContain("Resolved");

    document.querySelector<HTMLButtonElement>('[data-filter="unresolved"]')?.click();
    expect(document.querySelector(".comment-inbox-empty")?.textContent).toBe("No unresolved comments.");
  });

  it("separates device-local read state by principal", async () => {
    const store = new MemoryPersistenceStore();
    let principalKey = "coauthor:alice";
    let digest = "d1";
    let comments = [comment()];
    const make = () => {
      const launcher = document.createElement("button");
      launcher.disabled = true;
      document.body.append(launcher);
      const inbox = new CommentInbox(launcher, {
        context: () => ({ providerIdentity: "github:test/library", revision: digest, principalKey }),
        sources: () => [source(digest, () => comments)],
        open: async () => true,
        refreshLibrary: async () => true,
        usesGitHub: () => true,
      }, store);
      return { inbox, launcher };
    };

    const alice = make();
    await alice.inbox.initialize();
    comments = [comment({ body: "Changed remotely" })];
    digest = "d2";
    await alice.inbox.refresh();
    expect(alice.launcher.getAttribute("aria-label")).toContain("1 new activity");

    principalKey = "coauthor:bob";
    const bob = make();
    await bob.inbox.initialize();
    expect(bob.launcher.getAttribute("aria-label")).toContain("no new activity");
  });

  it("remains usable when device read-state persistence is unavailable", async () => {
    const launcher = document.createElement("button");
    launcher.disabled = true;
    document.body.append(launcher);
    const store = new MemoryPersistenceStore();
    vi.spyOn(store, "get").mockRejectedValue(new Error("IndexedDB unavailable"));
    vi.spyOn(store, "set").mockRejectedValue(new Error("IndexedDB unavailable"));
    const inbox = new CommentInbox(launcher, {
      context: () => ({ providerIdentity: "folder:research", revision: "d1", principalKey: "local" }),
      sources: () => [source("d1", () => [comment()])],
      open: async () => true,
      refreshLibrary: async () => true,
      usesGitHub: () => false,
    }, store);

    await expect(inbox.initialize()).resolves.toBeUndefined();
    expect(launcher.disabled).toBe(false);
    expect(launcher.getAttribute("aria-label")).toContain("no new activity");
  });

  it("always opens with a recoverable state when initial provider context fails", async () => {
    const launcher = document.createElement("button");
    launcher.disabled = true;
    document.body.append(launcher);
    const inbox = new CommentInbox(launcher, {
      context: () => { throw new Error("provider restarting"); },
      sources: () => [],
      open: async () => false,
      refreshLibrary: async () => false,
      usesGitHub: () => true,
    }, new MemoryPersistenceStore());

    expect(launcher.disabled).toBe(false);
    launcher.click();
    expect(document.querySelector<HTMLElement>("#comment-inbox")?.hidden).toBe(false);
    expect(document.querySelector(".comment-inbox-status")?.textContent).toContain("Preparing");

    await expect(inbox.initialize()).resolves.toBeUndefined();
    expect(launcher.disabled).toBe(false);
    expect(document.querySelector(".comment-inbox-status")?.textContent).toContain("temporarily unavailable");
  });
});
