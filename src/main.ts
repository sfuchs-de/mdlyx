import "katex/dist/katex.min.css";
import "prosemirror-tables/style/tables.css";
import "./styles.css";
import { initApp, type DocumentActivitySnapshot } from "./app/app";
import { TabBar } from "./app/tab-bar";
import type { LibraryView } from "./app/library-view";
import { DocInspector } from "./app/doc-inspector";
import { exportLatex } from "./tex/export-latex";
import { initConfig, applySavedConfig } from "./app/config";
import { countUnresolvedComments, parseFrontmatter } from "./markdown/frontmatter";
import type { LibraryFile } from "./app/library";
import { downloadText, type FileHandle } from "./app/file-adapter";
import { githubLibrary } from "./app/github-library";
import { LibrarySyncController } from "./app/library-sync-controller";
import type { SettingsHandle } from "./app/config";
import type { ProjectGraphView } from "./app/project-graph-view";
import type { ProjectOverviewView } from "./app/project-overview-view";
import type { ProjectCatalogController } from "./app/project-catalog-controller";
import { ProjectWorkspaceController } from "./app/project-workspace";
import { diagnosticsStore } from "./app/diagnostics";
import { DocumentNavigator } from "./app/document-navigator";
import { TableTools } from "./app/table-tools";
import { ProjectSearch } from "./app/project-search";
import { softwareUpdater } from "./app/software-updater";
import { installDesktopCloseGuard } from "./app/desktop-close-guard";
import { isTauriRuntime, openExternalUrl } from "./app/tauri-bridge";
import { resolveMarkdownLink } from "./app/link-navigation";
import { ToolbarOverflow } from "./app/toolbar-overflow";
import { ResponsiveLibraryShell } from "./app/responsive-library-shell";
import { MobileChromeController, installVisualViewportTrace } from "./app/mobile-chrome";
import type { ScholarlyTools, ScholarlyToolsHandlers } from "./app/scholarly-tools";
import {
  resolveEffectivePublication,
  type EffectivePublicationSettings,
} from "./publication/project-publication";
import { renderInvitation } from "./app/invitation";
import type { WritingGuide } from "./app/writing-guide";

diagnosticsStore.install();
installVisualViewportTrace();

const hostedAppOrigin = import.meta.env.VITE_APP_ORIGIN?.trim().replace(/\/$/, "");
if (hostedAppOrigin && window.location.origin !== hostedAppOrigin) {
  window.location.replace(`${hostedAppOrigin}${window.location.pathname}${window.location.search}${window.location.hash}`);
} else if (window.location.pathname === "/invite") {
  applySavedConfig();
  await renderInvitation(githubLibrary, githubLibrary.invitationToken());
} else {
  // Apply saved type-size preferences before the editor renders (no flash).
  applySavedConfig();

const SAMPLE = `---
macros:
  RR: "\\mathbb{R}"
  dd: "\\,\\mathrm{d}"
numbering:
  equations: section
---
# Introduction

The mass-energy relation is $E = mc^2$, and it is *famous*.

$$
\\int_0^1 x^2\\dd x = \\frac{1}{3}
$$ {#eq:integral}

## A system

$$
a &= b + c \\\\
d &= e + f
$$ {#eq:system env=align}

See @eq:integral and @eq:system, both over $\\RR$. Here is some \`inline code\`
and a [link](https://prosemirror.net). A broken ref: @eq:missing.

- first item
- second item with math $\\sqrt{2}$

> A blockquote with $\\pi \\approx 3.14$.
`;

const host = document.getElementById("editor-host");
const status = document.getElementById("file-status");
const workspace = document.getElementById("workspace");
const tabBarEl = document.getElementById("tab-bar");
const appEl = document.getElementById("app");
const toolbarEl = document.getElementById("toolbar");
if (!host || !status || !workspace || !tabBarEl || !appEl || !toolbarEl) {
  throw new Error("missing app DOM");
}

const button = (id: string) => {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing #${id}`);
  return el;
};

const {
  editor,
  start,
  load,
  open,
  activateExisting,
  refreshRemote,
  relayout,
  setSelectionUiObscured,
  setRemoteAccess,
  purgeRemoteData,
  getEditMode,
  setEditMode,
  getMeta,
  updateMeta,
  getPublication,
  getPublicationOverrides,
  getNumbering,
  updateNumbering,
  updatePublication,
  isReadOnly,
  serialize,
  getTabs,
  getDirtyDocumentIds,
  selectTab,
  closeTab,
  closeTabs,
  newTab,
  reorderTab,
  setOnTabs,
  setOnActivity,
  setOnLoad,
  setOnMeta,
  setOnPersisted,
  setOnDocumentLinkOpen,
  setOnResultLinkOpen,
  setResultReferences,
  setOnMarkdownLinkOpen,
  setOnLibraryAssetRead,
  setPublicationResolver,
  prepareForRelaunch,
  exportRecoveryBundle,
  listRecoveryRevisions,
  openRecoveryRevision,
  deleteRecoveryRevision,
  clearLocalData,
} = initApp(host, {
  status,
  workspace,
  authorName: "owner",
  buttons: {
    new: button("btn-new"),
    open: button("btn-open"),
    save: button("btn-save"),
    saveAs: button("btn-save-as"),
    exportTex: button("btn-export-tex"),
    comments: button("btn-comments"),
  },
});

softwareUpdater.setPrepareForRelaunch(prepareForRelaunch);
const mobileChrome = new MobileChromeController(appEl, toolbarEl, host);

new DocumentNavigator(button("btn-outline"), editor.view);
new TableTools(button("btn-table"), editor.view);
const writingGuideButton = button("btn-guide");
let writingGuide: WritingGuide | null = null;
let loadingWritingGuide: Promise<WritingGuide> | null = null;
const ensureWritingGuide = (): Promise<WritingGuide> => {
  if (writingGuide) return Promise.resolve(writingGuide);
  if (loadingWritingGuide) return loadingWritingGuide;
  loadingWritingGuide = import("./app/writing-guide")
    .then(({ WritingGuide: WritingGuideController }) => {
      writingGuideButton.removeEventListener("click", openWritingGuide);
      window.removeEventListener("keydown", openWritingGuideFromKeyboard, true);
      writingGuide = new WritingGuideController(writingGuideButton);
      return writingGuide;
    })
    .finally(() => {
      loadingWritingGuide = null;
    });
  return loadingWritingGuide;
};
const openWritingGuide = () => {
  void ensureWritingGuide().then((guide) => guide.open());
};
const openWritingGuideFromKeyboard = (event: KeyboardEvent) => {
  if (event.key !== "F1" || event.defaultPrevented) return;
  event.preventDefault();
  openWritingGuide();
};
writingGuideButton.addEventListener("click", openWritingGuide);
window.addEventListener("keydown", openWritingGuideFromKeyboard, true);

// --- GitHub-backed and local-folder library --------------------------------
const librarySync = new LibrarySyncController();
let lastSharedPrincipalId: string | null = null;
librarySync.subscribe((snapshot) => {
  const principal = snapshot.status.authenticated ? snapshot.status.principal : undefined;
  setRemoteAccess(
    (meta, path) => githubLibrary.documentCapabilities(
      meta.projects,
      meta.projection?.read_only === true,
      path,
    ),
    principal?.kind === "coauthor"
      ? { displayName: principal.displayName, principalId: principal.id }
      : undefined,
  );
  const nextShared = principal?.kind === "coauthor" ? principal.id : null;
  if (
    lastSharedPrincipalId
    && snapshot.status.state === "ready"
    && nextShared !== lastSharedPrincipalId
  ) {
    void purgeRemoteData();
  }
  lastSharedPrincipalId = nextShared;
});
let libraryView: LibraryView | null = null;
let libraryShell: ResponsiveLibraryShell | null = null;
let tabBar: TabBar | null = null;
let projectGraph: ProjectGraphView | null = null;
let projectOverview: ProjectOverviewView | null = null;
let projectCatalog: ProjectCatalogController | null = null;
let projectWorkspace: ProjectWorkspaceController | null = null;
let projectCatalogRefreshQueued = false;
let settingsHandle: SettingsHandle | null = null;
let projectSearch: ProjectSearch | null = null;
let scholarlyTools: ScholarlyTools | null = null;
let scholarlyToolsLoad: Promise<ScholarlyTools> | null = null;
let latestActivity: DocumentActivitySnapshot | null = null;
let currentName = "untitled.md";
let ensureProjectCatalog: () => Promise<void> = async () => undefined;
let ensureProjectViews: () => Promise<void> = async () => undefined;
let refreshingResultReferences: Promise<void> | null = null;
async function effectivePublicationFor(
  projects?: readonly string[],
): Promise<EffectivePublicationSettings> {
  await libraryReady;
  await ensureProjectCatalog();
  const loaded = await projectCatalog?.load();
  const configs = [...(loaded?.snapshot.overviewByProject.values() ?? [])]
    .flatMap((overview) => overview.publication ? [overview.publication] : []);
  const meta = getMeta();
  return resolveEffectivePublication(
    {
      library: projects ? { ...meta, projects: [...projects] } : meta,
      publication: getPublication(),
      publicationOverrides: projects ? {} : getPublicationOverrides(),
    },
    configs,
  );
}
const navigateEditorAnchor = (anchor: string): Promise<boolean> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => {
      if (!anchor) {
        resolve(true);
        requestAnimationFrame(() => {
          host.scrollTop = 0;
          editor.view.focus();
        });
        return;
      }
      const targets = editor.view.dom.querySelectorAll<HTMLElement>(
        `[id="${CSS.escape(anchor)}"]`,
      );
      const target = targets.length === 1 ? targets[0] : null;
      resolve(Boolean(target));
      if (!target) return;
      // Overview and graph handlers close their workspace after the successful
      // result resolves. Scroll on the following frame, once the destination
      // editor is visible; scrolling a hidden container is a browser no-op.
      requestAnimationFrame(() => {
        if (target.isConnected) target.scrollIntoView({ block: "center" });
        editor.view.focus();
      });
    });
  });
function scheduleProjectCatalogRefresh(): void {
  if (projectCatalogRefreshQueued) return;
  projectCatalogRefreshQueued = true;
  queueMicrotask(() => {
    projectCatalogRefreshQueued = false;
    projectCatalog?.invalidate();
    libraryView?.invalidateProjectCatalog();
    void refreshCatalogResultReferences();
    if (projectWorkspace?.current === "overview") void projectOverview?.reload();
    else if (projectWorkspace?.current === "graph") void projectGraph?.reload();
  });
}

function refreshCatalogResultReferences(): Promise<void> {
  if (refreshingResultReferences) return refreshingResultReferences;
  refreshingResultReferences = ensureProjectCatalog()
    .then(async () => {
      const loaded = await projectCatalog?.load();
      const results = loaded?.snapshot.dependencyCatalog.results ?? [];
      await setResultReferences(results);
    })
    .catch((error: unknown) => {
      // Keep the last known decorations during a transient provider failure.
      // The shared catalog already retains its last good snapshot.
      diagnosticsStore.record("application", error);
      console.warn("[result references] catalog refresh failed", error);
    })
    .finally(() => {
      refreshingResultReferences = null;
    });
  return refreshingResultReferences;
}
const libraryEl = document.getElementById("library");
const libraryBtn = document.getElementById("btn-library");
const initializeLibrary = async (): Promise<void> => {
  if (libraryEl && libraryBtn instanceof HTMLButtonElement) {
  // The Library owns indexing, filtering, grouping, and virtualization. Keep
  // that substantial workspace out of the initial editor entry chunk; wide
  // layouts still request it immediately, while the editor can parse/paint in
  // parallel with the module fetch.
  const { LibraryView } = await import("./app/library-view");
  const library = new LibraryView(libraryEl, {
    onActivateExisting: (f, context) =>
      activateExisting(f.name, f.handle, context.isCurrent),
    onOpen: async (f, context) => {
      await open(f.text, f.name, f.handle, f.path, context?.isCurrent);
      if (context && !context.isCurrent()) return;
      // On narrow screens LibraryView removes the editor pane's inert state
      // only after this handler succeeds. Focus on the next frame so document
      // navigation lands in the editor after the drawer has closed.
      requestAnimationFrame(() => editor.view.focus());
    },
    onRefresh: (f) => refreshRemote(f.text, f.name, f.handle),
    onManageSync: () => settingsHandle?.open("library-sync"),
    onOpenGraph: async (project, launcher) => {
      await ensureProjectViews();
      projectWorkspace?.show("graph", libraryShell?.narrow ? libraryBtn : launcher);
      await projectGraph?.open(project);
      if (libraryShell?.narrow) {
        library.setVisible(false, { persist: false, restoreLauncherFocus: false });
      }
    },
    onOpenOverview: async (project, launcher) => {
      await ensureProjectViews();
      projectWorkspace?.show("overview", libraryShell?.narrow ? libraryBtn : launcher);
      await projectOverview?.open(project);
      if (libraryShell?.narrow) {
        library.setVisible(false, { persist: false, restoreLauncherFocus: false });
      }
    },
    onCatalogChange: () => {
      scheduleProjectCatalogRefresh();
      projectSearch?.invalidate();
      editor.refreshFigureAssets();
      scholarlyTools?.invalidateCatalog();
      void scholarlyTools?.refreshCatalog();
    },
    loadProjectCatalog: async () => {
      await ensureProjectCatalog();
      if (!projectCatalog) throw new Error("Project catalog is unavailable");
      return projectCatalog.load();
    },
    onVisibilityChange: (visible) => {
      libraryShell?.sync(visible);
      tabBar?.revealActive();
      // The sidebar changes the editor pane width without resizing the window.
      // Re-place comment cards and connector lines against the new layout.
      relayout();
    },
    isDocumentDirty: (id) => getDirtyDocumentIds().has(id),
    shouldRevealDeviceFlow: () => !(settingsHandle?.isOpen ?? false),
    onNavigateAnchor: navigateEditorAnchor,
  }, librarySync);
  libraryView = library;
  if (latestActivity) library.setActivity(latestActivity);
  const libraryScrim = document.getElementById("library-scrim");
  if (libraryScrim instanceof HTMLButtonElement) {
    libraryShell = new ResponsiveLibraryShell(
      workspace,
      libraryEl,
      libraryBtn,
      libraryScrim,
      {
        requestClose: (restoreLauncherFocus = true) => library.setVisible(
          false,
          { restoreLauncherFocus },
        ),
        onLayoutChange: (drawerOpen) => setSelectionUiObscured(
          drawerOpen || (projectWorkspace?.current ?? "document") !== "document",
        ),
      },
    );
    libraryShell.sync(library.isVisible);
  }
  projectSearch = new ProjectSearch(button("btn-project-search"), {
    revision: () => library.projectSearchRevision(),
    index: () => library.projectSearchIndex(),
    openPath: (path) => library.openByPath(path),
  });
  const graphEl = document.getElementById("project-graph");
  const overviewEl = document.getElementById("project-overview");
  const editorPane = document.getElementById("editor-pane");
  if (graphEl && overviewEl && editorPane) {
    projectWorkspace = new ProjectWorkspaceController(
      editorPane,
      tabBarEl,
      host,
      overviewEl,
      graphEl,
      (mode) => setSelectionUiObscured(
        mode !== "document" || Boolean(libraryShell?.narrow && library.isVisible),
      ),
    );
    let loadingProjectCatalog: Promise<void> | null = null;
    ensureProjectCatalog = () => {
      if (projectCatalog) return Promise.resolve();
      if (loadingProjectCatalog) return loadingProjectCatalog;
      loadingProjectCatalog = import("./app/project-catalog-controller")
        .then((catalogModule) => {
          projectCatalog ??= new catalogModule.ProjectCatalogController({
            overviewSources: () => library.projectOverviewSources(),
            dependencySources: () => library.dependencyManifestSources(),
            documents: () => library.projectDocuments(),
          }, library);
        })
        .finally(() => {
          loadingProjectCatalog = null;
        });
      return loadingProjectCatalog;
    };
    let loadingProjectViews: Promise<void> | null = null;
    ensureProjectViews = () => {
      if (projectGraph && projectOverview) return Promise.resolve();
      if (loadingProjectViews) return loadingProjectViews;
      loadingProjectViews = Promise.all([
        ensureProjectCatalog(),
        import("./app/project-graph-view"),
        import("./app/project-overview-view"),
      ]).then(([, graphModule, overviewModule]) => {
        projectGraph = new graphModule.ProjectGraphView(graphEl, {
          sources: () => library.dependencyManifestSources(),
          documents: () => library.catalogDocuments(),
          loadCatalog: (force) => projectCatalog!.load(force),
          openDocument: (id, anchor) => library.openById(id, anchor),
          onModeChange: (open_, restoreLauncherFocus = true) => {
            if (open_) projectWorkspace?.show("graph");
            else if (restoreLauncherFocus) projectWorkspace?.backToDocument();
            else projectWorkspace?.show("document");
            tabBar?.revealActive();
          },
        });
        projectOverview = new overviewModule.ProjectOverviewView(overviewEl, {
          loadCatalog: (force) => projectCatalog!.load(force),
          openDocument: (id, anchor) => library.openById(id, anchor),
          openGraph: async (project) => {
            await ensureProjectViews();
            projectWorkspace?.show("graph");
            await projectGraph?.open(project);
          },
          openBibliography: (project) => {
            void ensureScholarlyTools().then((tools) => tools.openBibliography(project));
          },
          refreshLibrary: () => library.pull(),
          usesGitHub: () => library.usesGitHub,
          onModeChange: (open_, restoreLauncherFocus = true) => {
            if (open_) projectWorkspace?.show("overview");
            else if (restoreLauncherFocus) projectWorkspace?.backToDocument();
            else projectWorkspace?.show("document");
            tabBar?.revealActive();
          },
        });
      }).finally(() => {
        loadingProjectViews = null;
      });
      return loadingProjectViews;
    };
  }
  libraryBtn.onclick = () => {
    void library.toggle();
  };
    const oauthReturn = await githubLibrary.completeBrowserOAuth();
    library.setGitHubConnectError(oauthReturn.error);
    await library.init();
    libraryShell?.sync(library.isVisible);
    await refreshCatalogResultReferences();
  }
};

// Fetch and initialize the substantial Library workspace independently of the
// editor startup path. A slow or cold Library chunk must not leave the document
// canvas empty, while callers that need the Library can await the same promise.
const libraryReady = initializeLibrary().catch((error: unknown) => {
  diagnosticsStore.record("application", error);
  console.error("[library] workspace initialization failed", error);
});
if (libraryBtn instanceof HTMLButtonElement) {
  // The editor becomes interactive before the lazy Library chunk. Preserve a
  // click made during that short boundary and route it through the shared load.
  libraryBtn.onclick = () => void libraryReady.then(() => libraryView?.toggle());
}

// The Library shows provider connection state separately from the active
// document's save activity. Keep it current even while the drawer is closed.
setOnActivity((snapshot) => {
  latestActivity = snapshot;
  libraryView?.setActivity(snapshot);
  tabBar?.setActivity(snapshot);
});

// Wiki links resolve through the current library's metadata index, never a
// repository path, so they work equally in GitHub and local-folder modes.
setOnDocumentLinkOpen(async (id, anchor) => {
  await libraryReady;
  return libraryView?.openById(id, anchor) ?? false;
});

setOnResultLinkOpen(async (id) => {
  await libraryReady;
  await ensureProjectCatalog();
  const loaded = await projectCatalog?.load();
  const result = loaded?.snapshot.dependencyCatalog.byId.get(id);
  if (!result || !libraryView) return false;

  // Contract-v2 owner notes expose both claim and derivation source markers.
  // Prefer the explicit authored owner anchor when present, then the stable
  // claim/derivation markers, and finally preserve the useful fallback of
  // opening the owner document at its top for an external library.
  const anchors = result.ownerAnchor
    ? [result.ownerAnchor]
    : [`mathdown-claim:${result.id}`, `mathdown-derivation:${result.id}`, result.id];
  for (const anchor of anchors) {
    if (await libraryView.openById(result.ownerId, anchor)) return true;
  }
  return libraryView.openById(result.ownerId);
});

setOnMarkdownLinkOpen(async (href, sourcePath) => {
  const target = resolveMarkdownLink(href, sourcePath);
  if (target.kind === "external") {
    await openExternalUrl(target.url);
    return true;
  }
  if (target.kind === "anchor") {
    return navigateEditorAnchor(target.anchor);
  }
  if (target.kind !== "document") return false;
  if (target.path === sourcePath) {
    return navigateEditorAnchor(target.anchor ?? "");
  }
  await libraryReady;
  return libraryView?.openByPath(target.path, target.anchor) ?? false;
});

setOnLibraryAssetRead(async (path) => {
  await libraryReady;
  if (!libraryView) return null;
  const result = await libraryView.readAsset(path);
  return { bytes: result.bytes, mimeType: result.asset.mimeType };
});

const scholarlyLauncher = button("btn-scholarly");
const scholarlyToolsHandlers: ScholarlyToolsHandlers = {
  getPublication: (projects) => effectivePublicationFor(projects),
  getNumbering,
  isReadOnly,
  catalogIdentity: () => libraryView?.catalogIdentity() ?? {
    providerIdentity: "standalone",
    revision: currentName,
  },
  citationUsages: async (projects) => {
    await libraryReady;
    return libraryView?.citationUsages(projects) ?? [];
  },
  canEditBibliography: (projects) => libraryView?.canEditProjectAssets(projects) ?? false,
  onCitationCatalog: (snapshot, publication) => {
    editor.setCitationCatalog(snapshot, publication.citationStyle);
  },
  listAssets: async () => {
    await libraryReady;
    if (!libraryView) throw new Error("Open a GitHub or local-folder library to use project assets.");
    return libraryView.listAssets();
  },
  readAsset: async (path) => {
    await libraryReady;
    if (!libraryView) throw new Error("Open a GitHub or local-folder library to use project assets.");
    return libraryView.readAsset(path);
  },
  writeAsset: async (input) => {
    await libraryReady;
    if (!libraryView) throw new Error("Open a GitHub or local-folder library to use project assets.");
    return libraryView.writeAsset(input);
  },
};

function ensureScholarlyTools(): Promise<ScholarlyTools> {
  if (scholarlyTools) return Promise.resolve(scholarlyTools);
  scholarlyToolsLoad ??= import("./app/scholarly-tools").then(({ ScholarlyTools }) => {
    const tools = new ScholarlyTools(scholarlyLauncher, editor.view, scholarlyToolsHandlers);
    scholarlyTools = tools;
    return tools;
  }).finally(() => {
    scholarlyToolsLoad = null;
  });
  return scholarlyToolsLoad;
}

scholarlyLauncher.addEventListener("click", () => {
  if (scholarlyTools) return;
  void ensureScholarlyTools().then((tools) => tools.open());
});

// Keep citation rendering live after the library is ready while retaining the
// bibliography/editor tooling as a separate startup chunk.
void libraryReady.then(async () => {
  const tools = await ensureScholarlyTools();
  await tools.refreshCatalog();
});

setPublicationResolver(async () => {
  const effective = await effectivePublicationFor();
  return {
    bibliography: effective.bibliography,
    documentClass: effective.documentClass,
    citationStyle: effective.citationStyle,
    language: effective.language,
    engine: effective.engine,
  };
});

// --- document properties inspector -----------------------------------------
const inspector = new DocInspector(button("btn-info"), {
  getMeta,
  updateMeta,
  getPublication,
  updatePublication: (patch) => {
    updatePublication(patch);
    scholarlyTools?.invalidateCatalog();
    void scholarlyTools?.refreshCatalog();
  },
  getNumbering,
  updateNumbering,
  isReadOnly,
  getFilename: () => currentName,
  getKnown: () => libraryView?.knownLabels() ?? { projects: [], tags: [] },
  getDocs: () => libraryView?.allDocs() ?? [],
  getBacklinks: (id) => libraryView?.backlinksFor(id) ?? [],
  openDoc: (id) => void libraryView?.openById(id),
});

const toolsMoreHost = document.querySelector<HTMLElement>(".tb-tools-more");
const toolsMoreMenu = document.getElementById("tools-more-menu");
if (toolsMoreHost && toolsMoreMenu) {
  new ToolbarOverflow(
    button("btn-tools-more"),
    toolsMoreHost,
    toolsMoreMenu,
    [
      { button: button("btn-scholarly"), label: "References & publication" },
      { button: button("btn-table"), label: "Table tools" },
      { button: button("btn-info"), label: "Document properties" },
      { button: button("btn-guide"), label: "Writing guide" },
    ],
  );
}

// Single load handler fans out to the library (highlight active) and tracks the
// current filename for the inspector's title placeholder.
setOnLoad((name, handle, displayPath) => {
  currentName = name;
  libraryView?.setActive(name, handle, displayPath);
  editor.setCitationCatalog(null, getPublication().citationStyle);
  void scholarlyTools?.refreshCatalog();
});
// Metadata changes (a load, or an inspector edit) refresh the inspector fields
// and let the library update the active doc's badges live.
setOnMeta((meta) => {
  inspector.onExternalMeta(meta);
  libraryView?.setActiveMeta(meta);
  scholarlyTools?.invalidateCatalog();
  void scholarlyTools?.refreshCatalog();
});
setOnPersisted((documentId, unresolvedCommentCount, meta, handle) => {
  libraryView?.setDocumentCommentCount(documentId, unresolvedCommentCount, meta, handle);
  projectSearch?.invalidate();
  scholarlyTools?.invalidateCatalog();
});

// File ▾ dropdown: the New/Open/Save/Save As/Export buttons live inside it (still
// wired by id in initApp). Toggle open, close on outside-click / Escape / after
// any item is chosen.
function attachMenu(trigger: HTMLButtonElement, menu: HTMLElement) {
  trigger.setAttribute("aria-controls", menu.id);
  trigger.setAttribute("aria-expanded", "false");
  const items = () => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])')];
  const close = (restoreFocus = false) => {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.classList.remove("active");
    trigger.setAttribute("aria-expanded", "false");
    // Both global listeners are scoped to the open state (added on open, removed
    // here) so the menu never leaves an app-wide handler running while closed.
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    if (restoreFocus) trigger.focus({ preventScroll: true });
  };
  const onOutside = (e: MouseEvent) => {
    const t = e.target as Node;
    if (!menu.contains(t) && t !== trigger && !trigger.contains(t)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    }
  };
  const open = (focusFirst = false) => {
    menu.hidden = false;
    trigger.classList.add("active");
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    if (focusFirst) items()[0]?.focus({ preventScroll: true });
  };
  trigger.addEventListener("click", (event) => {
    if (menu.hidden) {
      open(event.detail === 0);
    } else {
      close(true);
    }
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (menu.hidden) open(false);
    const available = items();
    available[event.key === "ArrowUp" ? available.length - 1 : 0]?.focus({ preventScroll: true });
  });
  menu.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const available = items();
    if (!available.length) return;
    event.preventDefault();
    const current = available.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? available.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length;
    available[next]?.focus({ preventScroll: true });
  });
  menu.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) close(); // ran the action → dismiss
  });
}
const fileMenu = document.getElementById("file-menu");
if (fileMenu) attachMenu(button("btn-file"), fileMenu);

settingsHandle = initConfig(
  button("btn-config"),
  { get: getEditMode, set: setEditMode },
  {
    snapshot: () => librarySync.snapshot(),
    subscribe: (listener) => librarySync.subscribe(listener),
    refresh: () => librarySync.refresh(),
    start: () => librarySync.start(),
    cancel: () => librarySync.cancel(),
    openVerification: () => librarySync.openVerification(),
    copyCode: () => librarySync.copyCode(),
    copyLink: () => librarySync.copyLink(),
    logout: () => librarySync.logout(),
    sharingAccess: () => librarySync.sharingAccess(),
    createInvitation: (principalId, expiresInSeconds) => librarySync.createInvitation(principalId, expiresInSeconds),
    revokeInvitation: (id) => librarySync.revokeInvitation(id),
    createSharingPrincipal: (id, displayName, grants, expectedPolicySha) =>
      librarySync.createSharingPrincipal(id, displayName, grants, expectedPolicySha),
    updateSharingPrincipal: (id, displayName, grants, expectedPolicySha) =>
      librarySync.updateSharingPrincipal(id, displayName, grants, expectedPolicySha),
    revokeSharingSessions: (id, expectedPolicySha) =>
      librarySync.revokeSharingSessions(id, expectedPolicySha),
    removeSharingPrincipal: (id, expectedPolicySha) =>
      librarySync.removeSharingPrincipal(id, expectedPolicySha),
    pull: async () => {
      await libraryReady;
      return libraryView?.pull() ?? false;
    },
  },
  {
    exportBundle: async () => {
      const bundle = await exportRecoveryBundle();
      await downloadText(
        bundle,
        `mathdown-recovery-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        "application/json",
      );
    },
    listRecoveries: () => listRecoveryRevisions(),
    openRecovery: (id) => openRecoveryRevision(id),
    deleteRecovery: (id) => deleteRecoveryRevision(id),
    clear: clearLocalData,
  },
  {
    eventCount: () => diagnosticsStore.snapshot().events.length,
    exportBundle: () => downloadText(
      diagnosticsStore.export(librarySync.snapshot()),
      `mathdown-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      "application/json",
    ),
    clear: () => diagnosticsStore.clear(),
  },
);

// --- tab strip -------------------------------------------------------------
tabBar = new TabBar(tabBarEl, {
  onSelect: (id) => selectTab(id),
  onClose: (id) => closeTab(id),
  onNew: () => newTab(),
  onReorder: (id, toIndex) => reorderTab(id, toIndex),
  onBulkClose: ({ tabIds, dirtyTabIds }) => closeTabs(tabIds, dirtyTabIds.length > 0),
  onRevealTools: () => mobileChrome.reveal(),
});
// Keep the strip in sync with the tab set (open/close/switch/dirty/rename), and
// re-place the comment cards since the switched-in doc has its own anchors.
let dirtyProjectDocuments = "";
setOnTabs((tabs) => {
  tabBar?.render(tabs);
  const nextDirty = [...getDirtyDocumentIds()].sort().join("\n");
  if (nextDirty !== dirtyProjectDocuments) {
    dirtyProjectDocuments = nextDirty;
    scheduleProjectCatalogRefresh();
  }
  relayout();
});
tabBar.render(getTabs());

// Remote tab bodies are restored only after the hosted session has been
// validated. An expired/revoked shared session therefore cannot reveal a
// previous collaborator's cached project on application startup.
await librarySync.refresh();
// Cached remote text is not an authorization source. Before restoring a
// coauthor session, populate the path allowlist from the server-filtered index.
// Owner and unauthenticated startup retain the fast editor-first path.
if (librarySync.snapshot().status.principal?.kind === "coauthor") {
  try {
    await githubLibrary.list();
  } catch (error) {
    diagnosticsStore.record("application", error);
  }
}
await start(SAMPLE);

if (!isTauriRuntime) {
  window.setInterval(() => void librarySync.refresh(), 5 * 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void librarySync.refresh();
  });
}

// Install the awaited native close guard only after session restoration. If
// the app is closed during startup, the previous snapshot remains untouched
// instead of being replaced by the temporary blank tab.
if (isTauriRuntime) {
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
    installDesktopCloseGuard(
      getCurrentWindow(),
      prepareForRelaunch,
      () => {
        const detail = "Destination: browser recovery. Local recovery snapshot could not be saved; close was cancelled. Try again.";
        status.textContent = "Sync failed";
        status.title = detail;
        status.setAttribute("aria-label", detail);
        status.classList.add("is-dirty");
      },
    ),
  ).catch((error) => {
    console.error("[persistence] native close guard could not be installed", error);
  });
}

// Test hooks exist only in Vite development; production bundles contain none.
if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>;
  w.__editor = editor;
  w.__serialize = serialize;
  w.__exportTex = () => exportLatex(editor.view.state.doc, { standalone: false });
  w.__load = (text: string) => load(text, "example.md", null);
  w.__setEditMode = (m: "elements" | "mathlive") => setEditMode(m);
  w.__exportComments = () => editor.exportComments();
  w.__clearLocalData = clearLocalData;

  // Mount the on-disk `sample-library/` (served by Vite in dev) into the library
  // view without the gesture-gated folder picker, for exercising the library UI.
  const SAMPLE_LIB = [
    "overview.md",
    "wasserstein-ot.md",
    "proposition-2.md",
    "drafts/intro-draft.md",
    "drafts/results-draft.md",
    "references/katex-cheatsheet.md",
    "references/notation.md",
    "archive/old/deprecated.md",
    "verification/dependencies.md",
  ];
  w.__mockLibrary = async (folder = "sample-library", paths = SAMPLE_LIB) => {
    await libraryReady;
    if (!libraryView) return "no library view (unsupported)";
    const files: LibraryFile[] = [];
    for (const p of paths) {
      const res = await fetch(`/${folder}/${p}`);
      if (!res.ok) continue;
      const text = await res.text();
      const parsed = parseFrontmatter(text).frontmatter;
      const slash = p.lastIndexOf("/");
      files.push({
        name: slash >= 0 ? p.slice(slash + 1) : p,
        folder: slash >= 0 ? p.slice(0, slash) : "",
        meta: parsed.library,
        openCommentCount: countUnresolvedComments(parsed.comments),
        handle: { getFile: async () => new File([text], p) } as unknown as FileHandle,
      });
    }
    libraryView.injectMock(folder, files);
    if (libraryBtn instanceof HTMLButtonElement) {
      libraryBtn.classList.add("active");
      libraryBtn.setAttribute("aria-expanded", "true");
    }
    return `mounted ${files.length} files`;
  };
}

// `load` is not a useful readiness boundary for an ES module with asynchronous
// persistence and lazy workspaces. Expose an application-owned boundary for UI
// automation and for hosts that need to wait until the restored document is
// interactive. This does not expose any test-only capability in release builds.
workspace.dataset.appState = "ready";
window.dispatchEvent(new CustomEvent("mathdown:ready"));
}
