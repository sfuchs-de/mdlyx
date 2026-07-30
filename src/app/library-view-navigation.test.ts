// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeMeta } from "../markdown/frontmatter";
import type { OpenedFile } from "./file-adapter";
import type { LibraryFile } from "./library";
import type { LibrarySyncController } from "./library-sync-controller";
import { LibraryView } from "./library-view";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function syncController(): LibrarySyncController {
  const snapshot = {
    status: { state: "ready" as const, authenticated: true, login: "example-owner" },
    connected: true,
    error: null,
    device: null,
  };
  return {
    snapshot: () => snapshot,
    subscribe: (listener: (value: typeof snapshot) => void) => {
      listener(snapshot);
      return () => undefined;
    },
  } as unknown as LibrarySyncController;
}

function file(): LibraryFile {
  return {
    name: "target.md",
    folder: "nested",
    handle: null,
    meta: normalizeMeta({ id: "target", title: "Target" }),
    openCommentCount: 0,
  };
}

function duplicateNativeFile(folder: string, id: string, identity: string): LibraryFile {
  return {
    name: "target.md",
    folder,
    handle: {
      kind: "native-file",
      grantId: `grant-${id}`,
      identity,
      name: "target.md",
    },
    meta: normalizeMeta({ id, title: `Target ${id}` }),
    openCommentCount: 0,
  };
}

function setup(onOpen: (opened: OpenedFile) => void | Promise<void>) {
  const host = document.createElement("aside");
  document.body.append(host);
  const navigate = vi.fn();
  const view = new LibraryView(host, { onOpen, onNavigateAnchor: navigate }, syncController());
  view.injectMock("Fixture", [file()]);
  (view as unknown as { readFile: (entry: LibraryFile) => Promise<OpenedFile> }).readFile = vi.fn(async () => ({
    name: "target.md",
    path: "nested/target.md",
    text: "# Target\n",
    handle: null,
  }));
  return { host, navigate, view };
}

afterEach(() => {
  document.body.textContent = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("LibraryView asynchronous navigation", () => {
  it("opens a repository-relative Markdown path and then navigates its anchor", async () => {
    const onOpen = vi.fn(async () => undefined);
    const { navigate, view } = setup(onOpen);

    await expect(view.openByPath("nested/target.md", "result-anchor")).resolves.toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("result-anchor");
    await expect(view.openByPath("nested/missing.md", "result-anchor")).resolves.toBe(false);
  });

  it("activates an already-open destination without another provider read", async () => {
    const host = document.createElement("aside");
    document.body.append(host);
    const onOpen = vi.fn();
    const onActivateExisting = vi.fn(async () => true);
    const navigate = vi.fn();
    const view = new LibraryView(
      host,
      { onOpen, onActivateExisting, onNavigateAnchor: navigate },
      syncController(),
    );
    view.injectMock("Fixture", [file()]);
    const readFile = vi.fn();
    (view as unknown as { readFile: typeof readFile }).readFile = readFile;

    await expect(view.openById("target", "result-anchor")).resolves.toBe(true);
    expect(onActivateExisting).toHaveBeenCalledOnce();
    expect(readFile).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("result-anchor");
  });

  it("reports a missing destination anchor after preserving the opened document", async () => {
    const onOpen = vi.fn(async () => undefined);
    const { navigate, view } = setup(onOpen);
    navigate.mockReturnValue(false);

    await expect(view.openById("target", "missing-anchor")).resolves.toBe(false);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("missing-anchor");
  });

  it("waits for tab opening before marking the path active or navigating an anchor", async () => {
    const opening = deferred<void>();
    const onOpen = vi.fn(() => opening.promise);
    const { host, navigate, view } = setup(onOpen);

    const result = view.openById("target", "result-anchor");
    await Promise.resolve();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(host.querySelector(".lib-file.is-active")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    opening.resolve();
    await expect(result).resolves.toBe(true);
    expect(host.querySelector(".lib-file.is-active")?.getAttribute("data-path"))
      .toBe("nested/target.md");
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("result-anchor");
  });

  it("keeps the previous selection and suppresses anchor navigation when tab opening fails", async () => {
    const onOpen = vi.fn(async () => {
      throw new Error("editor rejected the document");
    });
    const { host, navigate, view } = setup(onOpen);

    await expect(view.openById("target", "result-anchor"))
      .rejects.toThrow("Could not open nested/target.md");
    expect(host.querySelector(".lib-file.is-active")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(host.textContent).toContain("editor rejected the document");
  });

  it("keeps the exact native path when switching tabs with duplicate basenames", async () => {
    const alpha = duplicateNativeFile(
      "alpha",
      "alpha-target",
      "11111111-1111-4111-8111-111111111111",
    );
    const beta = duplicateNativeFile(
      "beta",
      "beta-target",
      "22222222-2222-4222-8222-222222222222",
    );
    const host = document.createElement("aside");
    document.body.append(host);
    let view!: LibraryView;
    const onOpen = vi.fn(async (opened: OpenedFile) => {
      // Mirrors main.ts: a completed tab open/load feeds the tab's retained
      // provider-relative path back into the library selection.
      view.setActive(opened.name, opened.handle, opened.path);
    });
    view = new LibraryView(host, { onOpen }, syncController());
    view.injectMock("Fixture", [alpha, beta]);
    (view as unknown as {
      readFile: (entry: LibraryFile) => Promise<OpenedFile>;
    }).readFile = vi.fn(async (entry) => ({
      name: entry.name,
      path: `${entry.folder}/${entry.name}`,
      text: `# ${entry.meta.title}\n`,
      handle: entry.handle,
    }));
    await vi.waitFor(() => expect(host.querySelectorAll(".lib-group-section")).toHaveLength(1));
    expect(host.querySelectorAll(".lib-file")).toHaveLength(0);

    await expect(view.openById("alpha-target")).resolves.toBe(true);
    expect(host.querySelector(".lib-file.is-active")?.getAttribute("data-path"))
      .toBe("alpha/target.md");

    await expect(view.openById("beta-target")).resolves.toBe(true);
    expect(host.querySelector(".lib-file.is-active")?.getAttribute("data-path"))
      .toBe("beta/target.md");

    // Switching back to an already-open native tab replays onLoad without a
    // fresh library click. The exact path must win over the first basename.
    view.setActive("target.md", alpha.handle, "alpha/target.md");
    expect(host.querySelector(".lib-file.is-active")?.getAttribute("data-path"))
      .toBe("alpha/target.md");

    view.setActive("target.md", alpha.handle, "moved/target.md");
    expect(host.querySelector(".lib-file.is-active")).toBeNull();
  });
});
