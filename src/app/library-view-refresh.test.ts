// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeMeta } from "../markdown/frontmatter";
import type { OpenedFile } from "./file-adapter";
import type { LibraryFile } from "./library";
import type { LibrarySyncController } from "./library-sync-controller";
import { LibraryView } from "./library-view";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
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

function file(
  index: number,
  project = "project",
  options: {
    overview?: boolean;
    graph?: boolean;
    title?: string;
    visibility?: "reader" | "support";
  } = {},
): LibraryFile {
  return {
    name: `note-${index}.md`,
    folder: project,
    handle: null,
    meta: normalizeMeta({
      id: `note-${index}`,
      title: options.title ?? `Note ${index}`,
      projects: [project],
      visibility: options.visibility,
      contains: [
        ...(options.overview ? ["project-overview"] : []),
        ...(options.graph ? ["dependency-graph"] : []),
      ],
      kind: "notes",
      status: "draft",
      tags: ["test"],
    }),
    openCommentCount: 0,
  };
}

function mount(files: LibraryFile[], onVisibilityChange = vi.fn()) {
  const host = document.createElement("aside");
  document.body.append(host);
  const view = new LibraryView(host, { onOpen: vi.fn(), onVisibilityChange }, syncController());
  view.injectMock("Fixture", files);
  return { host, view, onVisibilityChange };
}

afterEach(() => {
  document.body.textContent = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("LibraryView cached refresh", () => {
  it("keeps a pointer-activated More action alive through WebKit-style focusout", async () => {
    const { view } = mount([file(1)]);
    const action = vi.fn();
    const more = (view as unknown as {
      moreMenu: (items: Array<{ label: string; run: () => void }>) => HTMLElement;
    }).moreMenu([{ label: "New other note", run: action }]) as HTMLDetailsElement;
    const outside = document.createElement("button");
    document.body.append(more, outside);
    more.open = true;
    const summary = more.querySelector<HTMLElement>("summary")!;
    const item = more.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    summary.focus();

    // WebKit can move focus outside the <details> between mousedown and click
    // without focusing the menu button itself. The details must remain open
    // until the pointer activation is allowed to dispatch its click.
    item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    outside.focus();
    await Promise.resolve();
    expect(more.open).toBe(true);

    item.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    item.click();
    expect(action).toHaveBeenCalledOnce();
    expect(more.open).toBe(false);
  });

  it("reopens from its snapshot without rescanning the provider", async () => {
    const { host, view } = mount([file(1)]);
    await vi.waitFor(() => expect(host.querySelector(".lib-search")).not.toBeNull());
    const list = host.querySelector(".lib-list");
    const liveCount = host.querySelector(".lib-list-summary");
    const listEntries = vi.fn(async () => [file(2)]);
    (view as unknown as { listEntries: () => Promise<LibraryFile[]> }).listEntries = listEntries;

    await view.toggle();
    await view.toggle();

    expect(listEntries).not.toHaveBeenCalled();
    expect(view.snapshot?.entries[0].meta.id).toBe("note-1");
    expect(host.querySelector(".lib-list")).toBe(list);
    expect(host.querySelector(".lib-list-summary")).toBe(liveCount);
  });

  it("shares concurrent refreshes and retains a last-good snapshot on failure", async () => {
    const { host, view } = mount([file(1)]);
    const list = host.querySelector(".lib-list");
    const liveCount = host.querySelector(".lib-list-summary");
    const pending = deferred<LibraryFile[]>();
    const listEntries = vi.fn(() => pending.promise);
    (view as unknown as { listEntries: () => Promise<LibraryFile[]> }).listEntries = listEntries;

    const first = view.refresh("explicit");
    const second = view.refresh("pull");
    expect(host.getAttribute("aria-busy")).toBe("true");
    expect(listEntries).toHaveBeenCalledOnce();
    pending.resolve([file(2)]);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(view.snapshot?.entries[0].meta.id).toBe("note-2");
    expect(host.querySelector(".lib-list")).toBe(list);
    expect(host.querySelector(".lib-list-summary")).toBe(liveCount);

    listEntries.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(view.refresh("pull")).resolves.toBe(false);
    expect(view.state).toBe("stale");
    expect(view.snapshot?.entries[0].meta.id).toBe("note-2");
    expect(host.textContent).toContain("Showing the previous library index");
  });

  it("suppresses a stale refresh result after the provider identity changes", async () => {
    const { view } = mount([file(1, "old")]);
    const pending = deferred<LibraryFile[]>();
    (view as unknown as { listEntries: () => Promise<LibraryFile[]> }).listEntries = vi.fn(() => pending.promise);
    const oldRefresh = view.refresh("pull");

    view.injectMock("Replacement", [file(2, "new")]);
    pending.resolve([file(3, "old")]);

    await expect(oldRefresh).resolves.toBe(false);
    expect(view.snapshot?.providerIdentity).toBe("mock:Replacement");
    expect(view.snapshot?.entries[0].meta.id).toBe("note-2");
  });

  it("invalidates the catalog signature when a projection source digest changes", () => {
    const projected = file(1);
    projected.meta = normalizeMeta({
      ...projected.meta,
      projection: {
        kind: "generated-result-manifest",
        schema_version: "2.0",
        sources: ["results.yaml", "graph.json"],
        digest: `sha256:${"a".repeat(64)}`,
        read_only: true,
        acknowledged_warnings: [],
      },
    });
    const { view } = mount([projected]);
    const before = view.snapshot?.signature;
    const updated = { ...projected, meta: normalizeMeta({
      ...projected.meta,
      projection: {
        ...projected.meta.projection,
        digest: `sha256:${"b".repeat(64)}`,
      },
    }) };
    view.injectMock("Fixture", [updated]);
    expect(view.snapshot?.signature).not.toBe(before);
  });

  it("uses generated result manifests but not generated graph readers as graph sources", () => {
    const resultManifest = file(1);
    resultManifest.meta = normalizeMeta({
      ...resultManifest.meta,
      contains: ["claims", "results"],
      projection: {
        kind: "generated-result-manifest",
        schema_version: "2.0",
        sources: ["results.yaml", "graph.json"],
        digest: `sha256:${"a".repeat(64)}`,
        read_only: true,
        acknowledged_warnings: [],
      },
    });
    const graphReader = file(2);
    graphReader.meta = normalizeMeta({
      ...graphReader.meta,
      contains: ["dependency-graph", "node-ledger", "edge-ledger"],
      projection: {
        kind: "generated-dependency-reader",
        schema_version: "2.0",
        sources: ["graph.json", "results.yaml"],
        digest: `sha256:${"b".repeat(64)}`,
        read_only: true,
      },
    });
    const legacyReader = file(3);
    legacyReader.meta = normalizeMeta({
      ...legacyReader.meta,
      contains: ["dependency-graph", "nodes", "edges", "modules"],
    });
    const { view } = mount([resultManifest, graphReader, legacyReader]);

    expect(view.dependencyManifestSources().map((source) => source.documentId)).toEqual(["note-1"]);
  });

  it("does not reuse or commit a slow open after the provider is replaced", async () => {
    const host = document.createElement("aside");
    document.body.append(host);
    const onOpen = vi.fn();
    const view = new LibraryView(host, { onOpen }, syncController());
    view.injectMock("Old provider", [file(1)]);
    await vi.waitFor(() => expect(host.querySelector(".lib-group-section")).not.toBeNull());

    const oldRead = deferred<OpenedFile>();
    let readCount = 0;
    const readFile = vi.fn(async (): Promise<OpenedFile> => {
      readCount += 1;
      if (readCount === 1) return oldRead.promise;
      return {
        name: "note-1.md",
        path: "project/note-1.md",
        text: "new provider\n",
        handle: null,
      };
    });
    (view as unknown as { readFile: (entry: LibraryFile) => Promise<OpenedFile> }).readFile = readFile;

    const oldOpen = view.openByPath("project/note-1.md");
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
    view.injectMock("Replacement provider", [file(1)]);
    const replacementOpen = view.openByPath("project/note-1.md");

    await expect(replacementOpen).resolves.toBe(true);
    oldRead.resolve({
      name: "note-1.md",
      path: "project/note-1.md",
      text: "old provider\n",
      handle: null,
    });
    await expect(oldOpen).resolves.toBe(false);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen.mock.calls[0][0].text).toBe("new provider\n");
  });

  it("reopens an already-active relative path after the provider is replaced", async () => {
    const host = document.createElement("aside");
    document.body.append(host);
    const onOpen = vi.fn();
    const view = new LibraryView(host, { onOpen }, syncController());
    const readFile = vi.fn(async (): Promise<OpenedFile> => ({
      name: "note-1.md",
      path: "project/note-1.md",
      text: `provider ${readFile.mock.calls.length}\n`,
      handle: null,
    }));
    (view as unknown as { readFile: (entry: LibraryFile) => Promise<OpenedFile> }).readFile = readFile;

    view.injectMock("Old provider", [file(1)]);
    await expect(view.openByPath("project/note-1.md")).resolves.toBe(true);
    expect(host.querySelector('[data-path="project/note-1.md"]')?.getAttribute("aria-current"))
      .toBe("page");

    view.injectMock("Replacement provider", [file(1)]);
    await vi.waitFor(() => expect(host.textContent).toContain("Replacement provider"));
    expect(host.querySelector('[aria-current="page"]')).toBeNull();
    host.querySelector<HTMLButtonElement>(".lib-group-head")!.click();
    host.querySelector<HTMLElement>(
      '.lib-project-area[data-area="supporting-documents"] > summary',
    )!.click();
    await vi.waitFor(() => expect(host.querySelector('[data-path="project/note-1.md"]')).not.toBeNull());
    expect(host.querySelector('[data-path="project/note-1.md"]')?.hasAttribute("aria-current"))
      .toBe(false);
    await expect(view.openByPath("project/note-1.md")).resolves.toBe(true);

    expect(readFile).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen.mock.calls[1][0].text).toBe("provider 2\n");
  });
});

describe("LibraryView bounded projections", () => {
  it("counts and navigates reader documents while retaining exact support lookups", async () => {
    const readers = Array.from({ length: 20 }, (_, index) =>
      file(index, "sample-model", {
        overview: index === 0,
        title: index === 0 ? "Sample Model" : `Reader ${index}`,
      })
    );
    const support = Array.from({ length: 37 }, (_, index) =>
      file(100 + index, "sample-model", {
        title: `Historical ${index}`,
        visibility: "support",
      })
    );
    const { host, view } = mount([...readers, ...support]);
    (view as unknown as {
      readFile: (entry: LibraryFile) => Promise<OpenedFile>;
    }).readFile = vi.fn(async (entry) => ({
      name: entry.name,
      path: `${entry.folder}/${entry.name}`,
      text: `# ${entry.meta.title}`,
      handle: entry.handle,
    }));
    await vi.waitFor(() =>
      expect(host.querySelector(".lib-list-summary")?.textContent)
        .toBe("20 documents · 37 support files · 1 project")
    );
    expect(host.querySelector<HTMLButtonElement>(".lib-group-head")?.getAttribute("aria-label"))
      .toBe("Sample Model, 20 documents");
    expect(view.allDocs()).toHaveLength(57);
    expect(view.knownLabels().projects).toEqual(["sample-model"]);

    const search = host.querySelector<HTMLInputElement>(".lib-search")!;
    search.value = "Historical";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(host.querySelectorAll(".lib-file")).toHaveLength(0);

    search.value = "note-100";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(host.querySelector('[data-path="sample-model/note-100.md"]')).not.toBeNull()
    );

    await expect(view.openById("note-100")).resolves.toBe(true);
  });

  it("keeps a 1,000-document project under budget without rescanning on reopen", async () => {
    const files = Array.from({ length: 1_000 }, (_, index) => file(index, "large-project"));
    const host = document.createElement("aside");
    document.body.append(host);
    const catalogChange = vi.fn();
    const view = new LibraryView(
      host,
      { onOpen: vi.fn(), onCatalogChange: catalogChange },
      syncController(),
    );
    const listEntries = vi.fn(async () => files);
    (view as unknown as { listEntries: () => Promise<LibraryFile[]> }).listEntries = listEntries;

    const started = performance.now();
    view.injectMock("Large", files);
    await vi.waitFor(() => expect(host.querySelector(".lib-group-section")).not.toBeNull());
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(host.querySelectorAll(".lib-file")).toHaveLength(0);

    host.querySelector<HTMLButtonElement>(".lib-group-head")!.click();
    expect(host.querySelectorAll(".lib-file")).toHaveLength(0);
    expect(host.querySelectorAll(".lib-project-area[open]")).toHaveLength(0);
    host.querySelector<HTMLElement>(
      '.lib-project-area[data-area="supporting-documents"] > summary',
    )!.click();
    expect(host.querySelectorAll(".lib-file").length).toBeLessThanOrEqual(120);
    const invalidations = catalogChange.mock.calls.length;
    for (let iteration = 0; iteration < 4; iteration++) {
      await view.toggle();
      await view.toggle();
    }
    expect(listEntries).not.toHaveBeenCalled();
    expect(catalogChange).toHaveBeenCalledTimes(invalidations);
  });

  it("mounts no collapsed rows and at most 120 rows for a large expanded project", async () => {
    const files = Array.from({ length: 260 }, (_, index) => file(index));
    const { host, view } = mount(files);
    await vi.waitFor(() => expect(host.querySelector(".lib-group-section")).not.toBeNull());
    expect(host.querySelectorAll(".lib-file")).toHaveLength(0);

    host.querySelector<HTMLButtonElement>(".lib-group-head")!.click();
    expect(host.querySelectorAll(".lib-file")).toHaveLength(0);
    expect(host.querySelectorAll(".lib-project-area[open]")).toHaveLength(0);
    host.querySelector<HTMLElement>(
      '.lib-project-area[data-area="supporting-documents"] > summary',
    )!.click();
    await vi.waitFor(() => expect(host.querySelectorAll(".lib-file")).toHaveLength(120));
    expect(host.querySelectorAll(".lib-window-controls")).toHaveLength(2);
    expect(host.querySelector(".lib-file .lib-sr-only")?.textContent)
      .toContain("Document 1 of 260");

    view.setActive("note-259.md", null, "project/note-259.md");
    expect(host.querySelectorAll(".lib-file").length).toBeLessThanOrEqual(150);
    expect(host.querySelector('[data-path="project/note-259.md"]')).not.toBeNull();
  });

  it("uses a unique overview title as the friendly project label", async () => {
    const overview = file(0, "sample-model", { overview: true, title: "Sample Theory" });
    const { host } = mount([overview, file(1, "sample-model")]);
    await vi.waitFor(() => expect(host.querySelector(".lib-group-label")).not.toBeNull());

    expect(host.querySelector(".lib-group-label")?.textContent).toBe("Sample Theory");
    expect(host.querySelector(".lib-project-select")).toBeNull();
  });

  it("falls back to a humanized project id when the overview title is generic", async () => {
    const overview = file(0, "gravity-trade", { overview: true, title: "Project Overview" });
    const { host } = mount([overview, file(1, "gravity-trade")]);
    await vi.waitFor(() => expect(host.querySelector(".lib-group-label")).not.toBeNull());

    expect(host.querySelector(".lib-group-label")?.textContent).toBe("Gravity Trade");
    expect(host.querySelector(".lib-project-select")).toBeNull();
  });

  it("keeps document rows minimal while exposing comments, tags, and dirty state", async () => {
    const entry = file(1);
    entry.openCommentCount = 2;
    entry.meta.tags = ["alpha", "beta", "gamma"];
    const host = document.createElement("aside");
    document.body.append(host);
    const view = new LibraryView(host, {
      onOpen: vi.fn(),
      isDocumentDirty: (id) => id === entry.meta.id,
    }, syncController());
    view.injectMock("Fixture", [entry]);
    await vi.waitFor(() => expect(host.querySelector(".lib-group-head")).not.toBeNull());
    host.querySelector<HTMLButtonElement>(".lib-group-head")!.click();
    host.querySelector<HTMLElement>(
      '.lib-project-area[data-area="supporting-documents"] > summary',
    )!.click();
    await vi.waitFor(() => expect(host.querySelector(".lib-file")).not.toBeNull());

    const row = host.querySelector<HTMLButtonElement>(".lib-file")!;
    expect(row.querySelector(".lib-file-title")?.textContent).toBe("Note 1");
    expect(row.querySelector(".lib-meta")?.textContent).toBe("Changes pending");
    expect(row.querySelector(".lib-meta")?.textContent).not.toContain("notes");
    expect(row.querySelector(".lib-meta")?.textContent).not.toContain("draft");
    expect(row.querySelector(".lib-file-comments")?.textContent).toBe("2");
    expect(row.querySelector(".lib-tag")).toBeNull();
    expect(row.title).toContain("Tags: alpha, beta, gamma");
    expect(row.querySelector(".lib-sr-only")?.textContent).toContain("2 unresolved comments");
    expect(row.querySelector(".lib-sr-only")?.textContent).toContain("Unsaved changes");
  });

  it("defaults to collapsed Browse and persists deduplicated Attention without rescanning", async () => {
    const overview = file(0, "p", { overview: true, title: "Project P" });
    const graph = file(2, "p", { graph: true });
    const commented = file(1, "p");
    commented.openCommentCount = 2;
    const { host } = mount([overview, commented, graph]);
    await vi.waitFor(() => expect(host.querySelector(".lib-group-head")).not.toBeNull());
    host.querySelector<HTMLButtonElement>(".lib-group-head")!.click();

    const buttons = () => [...host.querySelectorAll<HTMLButtonElement>(".lib-project-mode")];
    expect(buttons().map((button) => button.textContent)).toEqual([
      "Browse",
      "Attention 1",
    ]);
    expect(buttons()[0].getAttribute("aria-pressed")).toBe("true");
    expect(buttons()[1].getAttribute("aria-label")).toBe("Attention, 1 document");
    expect(buttons()[1].querySelector(".lib-project-mode-count")?.textContent).toBe("1");
    expect([
      ...host.querySelectorAll<HTMLButtonElement>(".lib-project-workspace-action"),
    ].map((button) => button.textContent)).toEqual(["Overview", "Graph"]);
    expect([
      ...host.querySelectorAll<HTMLButtonElement>(".lib-project-workspace-action"),
    ].every((button) => !button.disabled)).toBe(true);
    expect(host.querySelector(".lib-project-actions")).toBeNull();
    expect(host.querySelectorAll(".lib-project-area[open]")).toHaveLength(0);
    expect(host.querySelector(".lib-project-area")?.textContent).toContain("Start here");

    buttons()[1].click();
    expect(buttons()[1].getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelectorAll(".lib-project-attention-list .lib-file")).toHaveLength(1);
    expect(host.querySelector(".lib-project-attention-list .lib-file-title")?.textContent)
      .toBe("Note 1");
    expect(localStorage.getItem("mdlyx:lib-project-mode:v1")).toContain("attention");
  });

  it("launches each expanded project's own overview and graph without a global selector", async () => {
    const host = document.createElement("aside");
    document.body.append(host);
    const onOpenOverview = vi.fn();
    const onOpenGraph = vi.fn();
    const view = new LibraryView(host, {
      onOpen: vi.fn(),
      onOpenOverview,
      onOpenGraph,
    }, syncController());
    view.injectMock("Fixture", [
      file(0, "sample-model", { overview: true, title: "Sample Theory" }),
      file(1, "sample-model", { graph: true }),
    ]);
    await vi.waitFor(() => expect(host.querySelector(".lib-group-head")).not.toBeNull());
    host.querySelector<HTMLButtonElement>(".lib-group-head")!.click();

    const overview = host.querySelector<HTMLButtonElement>(
      '[data-project-action="overview"]',
    )!;
    const graph = host.querySelector<HTMLButtonElement>(
      '[data-project-action="graph"]',
    )!;
    overview.click();
    graph.click();

    expect(onOpenOverview).toHaveBeenCalledWith("sample-model", expect.any(Function));
    expect(onOpenGraph).toHaveBeenCalledWith("sample-model", expect.any(Function));
    expect(onOpenOverview.mock.calls[0][1]()).toBe(overview);
    expect(onOpenGraph.mock.calls[0][1]()).toBe(graph);
    expect(host.querySelector(".lib-project-select")).toBeNull();
  });

  it("keeps a malformed multi-project graph reachable for contract diagnostics", async () => {
    const malformed = file(1, "sample-model", { graph: true });
    malformed.meta.projects = ["sample-model", "other-project"];
    const host = document.createElement("aside");
    document.body.append(host);
    const onOpenGraph = vi.fn();
    const view = new LibraryView(host, {
      onOpen: vi.fn(),
      onOpenGraph,
    }, syncController());
    view.injectMock("Fixture", [malformed]);
    await vi.waitFor(() => expect(host.querySelector(".lib-group-head")).not.toBeNull());
    host.querySelector<HTMLButtonElement>(
      '.lib-group-section[data-group-key="sample-model"] > .lib-group-head',
    )!.click();

    const graph = host.querySelector<HTMLButtonElement>(
      '.lib-group-section[data-group-key="sample-model"] [data-project-action="graph"]',
    )!;
    expect(graph.disabled).toBe(false);
    expect(graph.title).toBe("Review dependency graph configuration");
    graph.click();

    expect(onOpenGraph).toHaveBeenCalledWith(undefined, expect.any(Function));
    expect(onOpenGraph.mock.calls[0][1]()).toBe(graph);
  });

  it("persists explicit visibility and exposes a drawer-close hook", async () => {
    const { host, view, onVisibilityChange } = mount([file(1)]);
    await vi.waitFor(() => expect(host.querySelector(".lib-drawer-close")).not.toBeNull());
    host.querySelector<HTMLButtonElement>(".lib-drawer-close")!.click();

    expect(view.isVisible).toBe(false);
    expect(localStorage.getItem("mdlyx:lib-visible:v1")).toBe("false");
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  });

  it("separates GitHub connection state from active-document save activity", async () => {
    const { host, view } = mount([file(1)]);
    await vi.waitFor(() => expect(host.querySelector(".lib-activity")).not.toBeNull());

    view.setActivity({
      path: "project/note-1.md",
      name: "note-1.md",
      provider: "github",
      saveState: "dirty",
      dirty: true,
    });

    const syncBadge = (view as unknown as { syncBadge: () => HTMLElement }).syncBadge();
    expect(syncBadge.textContent).toBe("Connected");
    expect(host.querySelector(".lib-activity")?.textContent).toBe("Changes pending");
    expect(host.querySelector<HTMLElement>(".lib-activity")?.title).toContain("project/note-1.md");
    expect(host.querySelector<HTMLElement>(".lib-activity")?.title).toContain("Destination: github");
  });
});
