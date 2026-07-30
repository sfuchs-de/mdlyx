import { Library, type LibraryFile } from "./library";
import {
  githubLibrary,
  type GitHubLibraryFile,
} from "./github-library";
import { normaliseDocumentPath } from "./library-document-path";
import { promptDialog } from "./dialogs";
import {
  LibrarySyncController,
  formatRemaining,
  sameSyncStructure,
  type LibrarySyncSnapshot,
} from "./library-sync-controller";
import {
  isGitHubFileRef,
  isNativeFileRef,
  type FileRef,
  type OpenedFile,
} from "./file-adapter";
import { parseFrontmatter, type DocMeta } from "../markdown/frontmatter";
import { parseMarkdown } from "../markdown/parse";
import {
  citationKeysFromSource,
  type CitationUsage,
} from "../publication/citation-catalog";
import { docTitle, labelColor } from "./doc-meta";
import type {
  CatalogDocument,
  DependencyManifestSource,
} from "./dependency-graph";
import type {
  ProjectCatalogLoadResult,
  ProjectOverviewSource,
} from "./project-catalog-controller";
import type { ProjectCatalogSnapshot, ProjectDocumentSummary } from "./project-overview";
import {
  libraryAttentionReasonLabel,
  libraryDocumentRoleLabel,
  projectLibraryProjection,
  type ProjectLibraryGroup,
  type ProjectLibraryMode,
  type ProjectLibraryDocument,
} from "./library-project-sections";
import type { ProjectWorkspaceLauncher } from "./project-workspace";
import type { SaveState } from "./save-coordinator";
import type {
  LibraryAsset,
  LibraryAssetWrite,
} from "./library-assets";
import {
  MAX_SEARCH_DOCUMENTS,
  MAX_SEARCH_DOCUMENT_CHARS,
  MAX_SEARCH_INDEX_CHARS,
  type SearchDocument,
  type SearchIndexSnapshot,
} from "./project-search-engine";
import {
  entryPath,
  matchesQuery,
  matchesFilters,
  splitFilter,
  groupEntries,
  GROUPS,
  isOtherNotesEntry,
  isReaderDocument,
  matchesDocumentVisibility,
  otherNotePath,
  OTHER_NOTES_FOLDER,
  OTHER_NOTES_LABEL,
  type GroupBy,
} from "./library-filter";

export interface LibraryViewHandlers {
  // Resolves only after the editor has focused/materialized the destination
  // tab. Library selection and anchor navigation must follow that completion.
  onOpen: (file: OpenedFile, context?: LibraryOpenContext) => void | Promise<void>;
  /** Focus an already-open provider file without reading it again. */
  onActivateExisting?: (
    file: LibraryFile,
    context: LibraryOpenContext,
  ) => boolean | Promise<boolean>;
  onRefresh?: (file: OpenedFile) => void; // replace a currently-open remote tab
  onManageSync?: () => void;
  onNavigateAnchor?: (
    anchor: string,
  ) => boolean | void | Promise<boolean | void>;
  onOpenGraph?: (project?: string, launcher?: ProjectWorkspaceLauncher) => void;
  onOpenOverview?: (project?: string, launcher?: ProjectWorkspaceLauncher) => void;
  onCatalogChange?: () => void;
  loadProjectCatalog?: () => Promise<ProjectCatalogLoadResult>;
  isDocumentDirty?: (documentId: string) => boolean;
  onVisibilityChange?: (visible: boolean) => void;
  /** Settings already renders an active device flow; avoid opening two mobile overlays. */
  shouldRevealDeviceFlow?: () => boolean;
}

export interface LibraryOpenContext {
  /** False once the source/provider which initiated this open is superseded. */
  isCurrent(): boolean;
}

const GROUP_KEY = "mdlyx:lib-groupby";
const VISIBILITY_KEY = "mdlyx:lib-visible:v1";
const PROJECT_MODE_KEY = "mdlyx:lib-project-mode:v1";
const PROJECT_DISCLOSURE_KEY = "mdlyx:lib-project-disclosure:v2";
const LARGE_GROUP_THRESHOLD = 200;
const GROUP_WINDOW_SIZE = 120;
const GROUP_WINDOW_OVERSCAN = 24;
const VIRTUAL_ROW_HEIGHT = 40;

export type LibraryRefreshReason =
  | "initial"
  | "pull"
  | "local-refresh"
  | "provider-change"
  | "create"
  | "metadata"
  | "explicit";

export type LibraryLoadState = "idle" | "loading" | "ready" | "stale" | "error";

export interface LibraryIndexSnapshot {
  provider: "github" | "folder" | "mock";
  providerIdentity: string;
  signature: string;
  revision: string;
  entries: LibraryFile[];
  loadedAt: number;
}

export interface LibraryPullActivity {
  state: "idle" | "pulling" | "succeeded" | "failed";
  at: number | null;
  message?: string;
}

export interface LibraryActivitySnapshot {
  activePath: string | null;
  path?: string | null;
  name?: string;
  provider?: string;
  saveState: SaveState;
  dirty: boolean;
  lastSavedAt: number | null;
  lastPull: LibraryPullActivity;
}

interface LibraryMenuAction {
  label: string;
  run: () => void;
  action?: "create" | "pull" | "refresh" | "provider";
  separatorBefore?: boolean;
}

// A left sidebar over a chosen folder of .md files, with a metadata index built
// from each file's frontmatter: search, filter by tag/project, and group by
// project / kind / tag / status. Clicking a file opens it; the active one is
// marked; each row keeps a compact title + kind/status summary while complete
// tags, paths, comments, and provider state remain available to assistive tech.
export class LibraryView {
  private readonly el: HTMLElement;
  private readonly lib = new Library();
  private readonly handlers: LibraryViewHandlers;
  // The active document, keyed by relative path ("folder/name") so files with the
  // same name in different folders don't collide.
  private activePath: string | null = null;
  // A path is only active inside the provider which opened it. Repositories and
  // local roots routinely contain identical relative paths; path alone must not
  // make a row from a replacement provider look active or skip its open.
  private activeProviderIdentity: string | null = null;
  private visible = false;
  private visibilityPreference: boolean | null = readBooleanPreference(VISIBILITY_KEY);

  private entries: LibraryFile[] = [];
  private source: "github" | "folder" = "github";
  private sync: LibrarySyncSnapshot;
  private query = "";
  private groupBy: GroupBy = "project";
  private readonly activeFilters = new Set<string>(); // "tag:foo" / "project:bar"
  // Project groups are disclosures. Explicit choices survive same-provider
  // rerenders and Pulls, while a fresh session starts compact. Search/filter
  // expansion is temporary and tracked separately so clearing a query restores
  // the user's normal disclosure state.
  private readonly projectGroupExpansion = new Map<string, boolean>();
  private readonly focusedCollapsedProjectGroups = new Set<string>();
  private lastRevealedActivePath: string | null = null;
  private readonly lastActiveProjectGroups = new Set<string>();
  // Dev/testing seam: an in-memory folder that bypasses the gesture-gated picker.
  private mock: { folderName: string; files: LibraryFile[] } | null = null;
  private filtersOpen = false; // facet panel collapsed by default
  private listEl: HTMLElement;
  private filtersEl: HTMLElement | null = null;
  private activeFiltersEl: HTMLElement | null = null;
  private filterBtn: HTMLButtonElement | null = null;
  private lastRenderError: string | null = null;
  private renderGeneration = 0;
  private indexSnapshot: LibraryIndexSnapshot | null = null;
  private loadState: LibraryLoadState = "idle";
  private refreshSequence = 0;
  private refreshInFlight: {
    providerIdentity: string;
    promise: Promise<boolean>;
  } | null = null;
  private providerGeneration = 0;
  private readonly openingPaths = new Map<string, {
    providerIdentity: string;
    generation: number;
    promise: Promise<boolean>;
  }>();
  private pullInFlight: Promise<boolean> | null = null;
  private readonly pendingActions = new Set<string>();
  private readonly groupWindows = new Map<string, number>();
  private virtualUpdateScheduled = false;
  private readonly groupFiles = new WeakMap<HTMLElement, LibraryFile[]>();
  private projectCatalogSnapshot: ProjectCatalogSnapshot | null = null;
  private projectCatalogInFlight: Promise<void> | null = null;
  private readonly projectModes = readProjectModePreferences(PROJECT_MODE_KEY);
  private readonly projectAreaExpansion = readBooleanPreferenceMap(PROJECT_DISCLOSURE_KEY);
  private readonly rowCache = new Map<string, HTMLButtonElement>();
  private readonly groupCache = new Map<string, HTMLElement>();
  private resultsEl: HTMLElement;
  private summaryEl: HTMLElement;
  private activityEl: HTMLElement | null = null;
  private renderDirty = true;
  private openMoreMenu: HTMLDetailsElement | null = null;
  private activity: LibraryActivitySnapshot = {
    activePath: null,
    saveState: "saved",
    dirty: false,
    lastSavedAt: null,
    lastPull: { state: "idle", at: null },
  };

  constructor(
    container: HTMLElement,
    handlers: LibraryViewHandlers,
    private readonly syncController = new LibrarySyncController(),
  ) {
    this.el = container;
    this.handlers = handlers;
    this.el.classList.add("library");
    this.el.hidden = true;
    // The list shell and its live result-count region are persistent across
    // refreshes. Reattaching these nodes avoids duplicate announcements and
    // retains the list's own scroll identity while header controls reconcile.
    this.listEl = el("div", "lib-list");
    this.summaryEl = el("div", "lib-list-summary");
    this.summaryEl.setAttribute("role", "status");
    this.summaryEl.setAttribute("aria-live", "polite");
    this.summaryEl.setAttribute("aria-atomic", "true");
    this.resultsEl = el("div", "lib-list-results");
    this.listEl.append(this.summaryEl, this.resultsEl);
    this.listEl.addEventListener("scroll", this.onListScroll, { passive: true });
    document.addEventListener("mousedown", this.onDocumentMouseDown, true);
    const saved = localStorage.getItem(GROUP_KEY);
    if (saved && (GROUPS as string[]).includes(saved)) {
      this.groupBy = saved as GroupBy;
    }
    this.sync = this.syncController.snapshot();
    this.syncController.subscribe((snapshot) => {
      const previous = this.sync;
      this.sync = snapshot;
      if (!this.visible) {
        this.renderDirty = true;
        // An in-progress device authorization is time-sensitive and may begin
        // from Settings while the Library is closed. Reveal it without
        // overwriting the user's ordinary visibility preference.
        if (snapshot.device && (this.handlers.shouldRevealDeviceFlow?.() ?? true)) {
          this.setVisible(true, { persist: false });
          void this.render();
        }
        return;
      }
      if (sameSyncStructure(previous, snapshot) && snapshot.device) {
        const countdown = this.el.querySelector<HTMLElement>(".lib-sync-countdown");
        if (countdown) countdown.textContent = `Code expires in ${formatRemaining(snapshot.device.remainingSeconds)}`;
      } else {
        void this.render();
      }
    });
  }

  get isVisible() {
    return this.visible;
  }

  get usesGitHub(): boolean {
    return !this.mock && this.source === "github";
  }

  async init() {
    await this.syncController.refresh();
    if (this.sync.status.state === "unavailable") {
      await this.lib.restore();
      this.source = "folder";
    }
    if (
      !this.activePath
      && this.providerGeneration === 0
      && this.activity.activePath
      && this.activityProviderMatchesCurrent(this.activity.provider)
    ) {
      this.activePath = this.activity.activePath;
      this.activeProviderIdentity = this.currentProviderIdentity();
    }
    const defaultVisible = this.sync.device
      ? true
      : typeof matchMedia === "function"
        ? matchMedia("(min-width: 800px)").matches
        : true;
    this.setVisible(this.sync.device ? true : this.visibilityPreference ?? defaultVisible, { persist: false });
    await this.render();
  }

  setGitHubConnectError(message: string | undefined): void {
    this.syncController.setError(message);
  }

  async toggle(): Promise<void> {
    this.setVisible(!this.visible);
    // Reopening a current snapshot retains the same controls, disclosure DOM,
    // keyboard focus identity, and scroll position. Hidden provider changes
    // mark the projection dirty and are reconciled on the next open.
    if (this.visible && (this.renderDirty || this.el.childElementCount === 0)) {
      await this.render();
    }
  }

  setVisible(
    visible: boolean,
    options: { persist?: boolean; restoreLauncherFocus?: boolean } = {},
  ): void {
    const changed = visible !== this.visible;
    if (changed && !visible) {
      this.el.dataset.restoreLauncherFocus = String(
        options.restoreLauncherFocus ?? this.el.contains(document.activeElement),
      );
    }
    this.visible = visible;
    this.el.hidden = !visible;
    if (options.persist !== false) {
      this.visibilityPreference = visible;
      localStorage.setItem(VISIBILITY_KEY, String(visible));
    }
    if (changed) this.handlers.onVisibilityChange?.(visible);
    if (visible) {
      queueMicrotask(() => {
        this.syncActiveStyles(false);
        this.revealActiveRow();
      });
    }
  }

  get snapshot(): LibraryIndexSnapshot | null {
    return this.indexSnapshot;
  }

  get state(): LibraryLoadState {
    return this.loadState;
  }

  setActivity(activity: Partial<LibraryActivitySnapshot>): void {
    const activePath = activity.activePath !== undefined ? activity.activePath : activity.path;
    this.activity = {
      ...this.activity,
      ...activity,
      ...(activePath !== undefined ? { activePath } : {}),
      lastPull: activity.lastPull ?? this.activity.lastPull,
    };
    // The first activity snapshot can arrive before the lazy Library has built
    // its index. Bind that startup identity only when its provider matches the
    // selected source. Later provider changes require an actual matching entry
    // or a successful Library open, so an old tab cannot claim a same-path row.
    if (
      activePath !== undefined
      && this.providerGeneration === 0
      && this.activityProviderMatchesCurrent(activity.provider)
    ) {
      this.activePath = activePath;
      this.activeProviderIdentity = this.currentProviderIdentity();
    }
    this.updateActivityStatus();
  }

  // Highlight the active document. The app retains the provider-relative path
  // for each tab, so prefer that exact identity before the legacy basename
  // fallback used by older/restored callers.
  setActive(name: string, handle?: FileRef, displayPath?: string) {
    const ref = handle ?? null;
    const suppliedPath = displayPath?.trim() || null;
    const exactPath = suppliedPath
      || (isGitHubFileRef(ref) ? ref.path : name.includes("/") ? name : null);
    const exactEntry = exactPath
      ? this.entries.find((entry) => entryPath(entry) === exactPath)
      : undefined;
    // An explicit provider-relative path is authoritative. If it is no longer
    // in this library, leave every row inactive instead of retargeting to an
    // unrelated first match with the same basename.
    const entry = exactEntry ?? (!suppliedPath && !isGitHubFileRef(ref)
      ? this.entries.find((candidate) => candidate.name === name)
      : undefined);
    const nextPath = entry && this.entryBelongsToCurrentProvider(entry, ref)
      ? entryPath(entry)
      : null;
    const changed = nextPath !== this.activePath;
    this.activePath = nextPath;
    this.activeProviderIdentity = nextPath ? this.currentProviderIdentity() : null;
    if (changed && this.visible && this.groupBy === "project" && !this.query.trim()) {
      this.renderList();
    } else {
      this.syncActiveStyles(changed);
    }
    this.revealActiveRow();
  }

  // Live-update the active doc's metadata (from an inspector edit) without a disk
  // read, so badges/grouping reflect changes immediately.
  setActiveMeta(meta: DocMeta) {
    if (!this.activePath || this.activeProviderIdentity !== this.currentProviderIdentity()) return;
    const entry = this.entries.find((e) => entryPath(e) === this.activePath);
    if (!entry) return;
    entry.meta = meta;
    this.commitInMemorySnapshot("metadata");
    if (this.visible) this.renderList();
    else this.renderDirty = true;
  }

  invalidateProjectCatalog(): void {
    this.projectCatalogSnapshot = null;
    this.projectCatalogInFlight = null;
    if (this.visible && this.hasExpandedProjectGroup()) void this.ensureProjectCatalog();
  }

  // Union of projects / tags across the library, for inspector suggestions.
  knownLabels(): { projects: string[]; tags: string[] } {
    const projects = new Set<string>();
    const tags = new Set<string>();
    for (const e of this.entries) {
      if (!isReaderDocument(e)) continue;
      e.meta.projects.forEach((p) => projects.add(p));
      e.meta.tags.forEach((t) => tags.add(t));
    }
    return {
      projects: [...projects].sort(),
      tags: [...tags].sort(),
    };
  }

  // --- document relations (#I70) ------------------------------------------
  // Every indexed doc that has a stable id (relation targets / id→title lookup).
  allDocs(): { id: string; title: string }[] {
    return this.entries
      .filter((e) => e.meta.id)
      .map((e) => ({ id: e.meta.id as string, title: docTitle(e.meta, e.name) }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  catalogDocuments(): CatalogDocument[] {
    return this.allDocs();
  }

  activeProject(): string | undefined {
    const entry = this.entries.find((candidate) => entryPath(candidate) === this.activePath);
    return entry?.meta.projects.length === 1 ? entry.meta.projects[0] : undefined;
  }

  activeDocumentPath(): string | null {
    return this.activePath;
  }

  catalogIdentity(): { providerIdentity: string; revision: string } {
    return {
      providerIdentity: this.currentProviderIdentity(),
      revision: this.indexSnapshot?.revision ?? this.projectSearchRevision(),
    };
  }

  canEditProjectAssets(projects: readonly string[]): boolean {
    if (this.mock) return false;
    return this.source === "github"
      ? githubLibrary.canEditProjectAssets(projects)
      : true;
  }

  async citationUsages(projects: readonly string[]): Promise<CitationUsage[]> {
    const projectSet = new Set(projects);
    const candidates = this.entries.filter((entry) =>
      entry.meta.projects.some((project) => projectSet.has(project)));
    const usages: CitationUsage[] = [];
    for (const entry of candidates) {
      const source = await this.readCatalogSource(entry);
      const parsed = parseFrontmatter(source);
      const counts = new Map<string, number>();
      parseMarkdown(parsed.body).descendants((node) => {
        if (node.type.name !== "citation") return true;
        for (const key of citationKeysFromSource(String(node.attrs.source ?? ""))) {
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return false;
      });
      for (const [key, occurrences] of counts) {
        usages.push({
          key,
          documentId: entry.meta.id,
          documentTitle: docTitle(entry.meta, entry.name),
          documentPath: entryPath(entry),
          occurrences,
        });
      }
    }
    return usages;
  }

  async listAssets(): Promise<LibraryAsset[]> {
    if (this.mock) return [];
    return this.source === "github"
      ? githubLibrary.listAssets()
      : this.lib.listAssets();
  }

  async readAsset(path: string): Promise<{ asset: LibraryAsset; bytes: Uint8Array }> {
    if (this.mock) throw new Error("Assets are unavailable in the in-memory test library");
    return this.source === "github"
      ? githubLibrary.readAsset(path)
      : this.lib.readAsset(path);
  }

  async writeAsset(input: LibraryAssetWrite): Promise<LibraryAsset> {
    if (this.mock) throw new Error("Assets are unavailable in the in-memory test library");
    return this.source === "github"
      ? githubLibrary.writeAsset(input)
      : this.lib.writeAsset(input);
  }

  projectOverviewSources(): ProjectOverviewSource[] {
    return this.entries
      .filter((entry) =>
        isReaderDocument(entry)
        && entry.meta.contains.includes("project-overview")
      )
      .map((entry) => ({
        path: entryPath(entry),
        read: async () => this.readCatalogSource(entry),
      }));
  }

  projectDocuments(): ProjectDocumentSummary[] {
    return this.entries.map((entry) => ({
      id: entry.meta.id ?? "",
      title: docTitle(entry.meta, entry.name),
      path: entryPath(entry),
      projects: [...entry.meta.projects],
      contains: [...entry.meta.contains],
      visibility: entry.meta.visibility,
      unresolvedCommentCount: entry.openCommentCount,
      dirty: entry.meta.id ? this.handlers.isDocumentDirty?.(entry.meta.id) ?? false : false,
    }));
  }

  setDocumentCommentCount(
    documentId: string | undefined,
    count: number,
    meta?: DocMeta,
    handle?: FileRef,
  ): void {
    const ref = handle ?? null;
    const entry = isGitHubFileRef(ref)
      ? this.entries.find((candidate) => entryPath(candidate) === ref.path)
      : this.entries.find((candidate) => candidate.meta.id === documentId);
    if (!entry) return;
    if (meta) entry.meta = meta;
    if (isGitHubFileRef(ref)) entry.handle = ref;
    entry.openCommentCount = Math.max(0, count);
    this.commitInMemorySnapshot("metadata");
    if (this.visible) this.renderList();
    else this.renderDirty = true;
  }

  dependencyManifestSources(): DependencyManifestSource[] {
    return this.entries
      // Include malformed declarations too: the graph catalog is responsible
      // for explaining an invalid project/id instead of silently hiding it.
      // Generated dependency readers carry the same semantic tag for Browse,
      // but are projections of the manifest rather than a second manifest.
      .filter((entry) =>
        (
          entry.meta.projection?.kind === "generated-result-manifest"
          || entry.meta.contains.includes("dependency-graph")
        )
        && entry.meta.projection?.kind !== "generated-dependency-reader"
        && !entry.meta.contains.includes("node-ledger")
        && !(
          entry.meta.contains.includes("nodes")
          && entry.meta.contains.includes("edges")
          && entry.meta.contains.includes("modules")
        )
      )
      .map((entry) => ({
        path: entryPath(entry),
        project: entry.meta.projects.length === 1 ? entry.meta.projects[0] : "",
        documentId: entry.meta.id ?? "",
        title: docTitle(entry.meta, entry.name),
        read: async () => this.readCatalogSource(entry),
        open: async () => {
          await this.openFile(entry);
          this.handlers.onNavigateAnchor?.("dependency-graph");
        },
      }));
  }

  // Docs whose `related` points AT `id` — the computed reverse links (backlinks).
  backlinksFor(id: string): { id: string; title: string; rel: string }[] {
    if (!id) return [];
    const out: { id: string; title: string; rel: string }[] = [];
    for (const e of this.entries) {
      for (const r of e.meta.related) {
        if (r.id === id) out.push({ id: e.meta.id ?? "", title: docTitle(e.meta, e.name), rel: r.rel });
      }
    }
    return out;
  }

  // Open a document by its stable id (used to navigate a relation/backlink).
  async openById(id: string, anchor?: string): Promise<boolean> {
    const entry = this.entries.find((e) => e.meta.id === id);
    if (!entry) return false;
    if (!await this.openFile(entry)) {
      throw new Error(`Could not open ${entryPath(entry)} from the current library`);
    }
    if (anchor && await this.handlers.onNavigateAnchor?.(anchor) === false) return false;
    return true;
  }

  async openByPath(path: string, anchor?: string): Promise<boolean> {
    const entry = this.entries.find((candidate) => entryPath(candidate) === path);
    if (!entry) return false;
    if (!await this.openFile(entry)) return false;
    if (anchor && await this.handlers.onNavigateAnchor?.(anchor) === false) return false;
    return true;
  }

  async projectSearchIndex(): Promise<SearchIndexSnapshot> {
    const supportEntries = this.entries.filter((entry) => !isReaderDocument(entry));
    const documents: SearchDocument[] = supportEntries
      .slice(0, MAX_SEARCH_DOCUMENTS)
      .map((entry) => ({
        id: entry.meta.id,
        title: docTitle(entry.meta, entry.name),
        path: entryPath(entry),
        projects: [...entry.meta.projects],
        visibility: "support",
        // Support contents stay out of the ordinary full-text index. Exact
        // stable-ID and path lookups are handled by the search engine.
        text: "",
      }));
    let indexedCharacters = 0;
    let truncatedContent = false;
    const readerEntries = this.entries.filter(isReaderDocument);
    const candidates = readerEntries.slice(0, MAX_SEARCH_DOCUMENTS);
    // Bound provider reads so a cold 1,000-document local index cannot saturate
    // the file bridge or GitHub request pool.
    for (let offset = 0; offset < candidates.length && indexedCharacters < MAX_SEARCH_INDEX_CHARS; offset += 8) {
      const batch = candidates.slice(offset, offset + 8);
      const readLimit = Math.min(
        MAX_SEARCH_DOCUMENT_CHARS,
        MAX_SEARCH_INDEX_CHARS - indexedCharacters,
      );
      // Read one sentinel character beyond the usable limit so truncation is
      // observable without loading the remainder of a browser/native file.
      const loaded = await Promise.all(batch.map(async (entry) => ({
        entry,
        source: await this.readSearchSource(entry, readLimit + 1),
      })));
      for (const { entry, source } of loaded) {
        const remaining = MAX_SEARCH_INDEX_CHARS - indexedCharacters;
        if (remaining <= 0) break;
        const text = source.slice(0, Math.min(MAX_SEARCH_DOCUMENT_CHARS, remaining));
        if (text.length < source.length) truncatedContent = true;
        documents.push({
          id: entry.meta.id,
          title: docTitle(entry.meta, entry.name),
          path: entryPath(entry),
          projects: [...entry.meta.projects],
          visibility: "reader",
          text,
        });
        indexedCharacters += text.length;
      }
    }
    const indexedReaderDocuments = documents.filter((document) => document.visibility !== "support").length;
    const indexedSupportDocuments = documents.length - indexedReaderDocuments;
    const omittedDocuments = Math.max(0, readerEntries.length - indexedReaderDocuments)
      + Math.max(0, supportEntries.length - indexedSupportDocuments);
    const truncated = omittedDocuments > 0 || truncatedContent;
    return {
      revision: this.projectSearchRevision(),
      documents,
      ...(truncated ? { truncated: true, omittedDocuments: Math.max(0, omittedDocuments) } : {}),
    };
  }

  projectSearchRevision(): string {
    return [this.currentRenderSource(), ...this.entries.map((entry) => {
      const handle = entry.handle;
      return `${entryPath(entry)}:${isGitHubFileRef(handle) ? handle.sha : "local"}`;
    })].join("|");
  }

  // Dev/testing seam: point the view at an in-memory set of files, bypassing the
  // gesture-gated folder picker (used to exercise the UI against a sample library).
  injectMock(folderName: string, files: LibraryFile[]) {
    this.resetProjectExpansion();
    this.mock = { folderName, files };
    this.invalidateProviderSnapshot();
    const signature = indexSignature(files);
    this.entries = files;
    this.indexSnapshot = {
      provider: "mock",
      providerIdentity: this.currentProviderIdentity(),
      signature,
      revision: `mock:${signature}`,
      entries: files,
      loadedAt: Date.now(),
    };
    this.setLoadState("ready");
    this.handlers.onCatalogChange?.();
    this.setVisible(true, { persist: false });
    void this.render();
  }

  async refresh(reason: LibraryRefreshReason = "explicit"): Promise<boolean> {
    const ok = await this.loadIndex(reason);
    if (this.visible) await this.render();
    else this.renderDirty = true;
    return ok;
  }

  // --- rendering ----------------------------------------------------------
  private async render() {
    const previousScrollTop = this.listEl?.scrollTop ?? 0;
    const previousFocusKey = (document.activeElement as HTMLElement | null)?.dataset.libraryFocusKey;
    const generation = ++this.renderGeneration;
    const renderSource = this.currentRenderSource();
    const isCurrent = () => generation === this.renderGeneration
      && renderSource === this.currentRenderSource();
    this.renderDirty = false;
    this.el.textContent = "";
    this.openMoreMenu = null;
    this.el.setAttribute("aria-busy", String(this.loadState === "loading"));
    this.filtersEl = null;
    this.activeFiltersEl = null;
    this.activityEl = null;

    const usingGithub = !this.mock && this.source === "github";
    const shared = usingGithub && this.sync.status.principal?.kind === "coauthor";
    const folderName = this.mock?.folderName ?? (usingGithub ? null : this.lib.folderName);
    const head = el("header", "lib-head");
    const identity = el("div", "lib-identity");
    const titleRow = el("div", "lib-title-row");
    titleRow.append(el("h2", "lib-title", "Library"));
    const sourceLabel = usingGithub
      ? shared ? "Shared library" : "Configured GitHub library"
      : this.mock
        ? `Sample · ${folderName}`
        : folderName
          ? `Local · ${folderName}`
          : "No library selected";
    const source = el("div", "lib-source", sourceLabel);
    source.title = sourceLabel;
    this.activityEl = el("div", "lib-activity");
    const sourceRow = el("div", "lib-source-row");
    sourceRow.append(source);
    if (usingGithub) sourceRow.append(this.syncBadge());
    identity.append(titleRow, sourceRow, this.activityEl);
    this.updateActivityStatus();
    head.append(identity);

    const close = headerAction(
      "close",
      "Close library",
      () => this.setVisible(false, { restoreLauncherFocus: true }),
    );
    close.classList.add("lib-drawer-close");
    close.dataset.libraryAction = "close";
    head.append(close);

    const actions = el("div", "lib-head-actions");
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "Library actions");
    const menuActions: LibraryMenuAction[] = [];
    if (this.mock) {
      menuActions.push(
        { label: "Refresh library", run: () => void this.refresh("local-refresh"), action: "refresh" },
        { label: "New document", run: () => void this.newDoc(), action: "create" },
      );
    } else if (usingGithub && this.sync.connected) {
      menuActions.push({
        label: shared ? "Pull latest shared changes" : "Pull latest from GitHub",
        run: () => void this.pull(),
        action: "pull",
      });
      if (!shared) {
        menuActions.push(
          { label: "New document", run: () => void this.newDoc(), action: "create" },
          { label: "New other note", run: () => void this.newOtherNote(), action: "create" },
        );
      }
      menuActions.push(
        {
          label: shared ? "Manage shared access" : "Manage GitHub sync",
          run: () => this.handlers.onManageSync?.(),
          separatorBefore: true,
        },
        { label: "Use a local folder", run: () => void this.chooseFolder(), action: "provider" },
      );
    } else if (!usingGithub && folderName) {
      menuActions.push(
        { label: "Refresh local library", run: () => void this.refresh("local-refresh"), action: "refresh" },
        { label: "New document", run: () => void this.newDoc(), action: "create" },
        { label: "New other note", run: () => void this.newOtherNote(), action: "create" },
        {
          label: "Use GitHub library",
          run: () => void this.useGithub(),
          action: "provider",
          separatorBefore: true,
        },
        { label: "Change folder", run: () => void this.chooseFolder(), action: "provider" },
      );
    }
    if (menuActions.length) {
      actions.append(this.moreMenu(menuActions));
      head.append(actions);
    }
    this.el.append(head);

    if (usingGithub && this.sync.status.state === "unavailable") {
      this.el.append(el("div", "lib-empty", "GitHub sync is not available in this deployment."));
      this.el.append(primaryBtn("Choose local folder…", () => void this.chooseFolder()));
      return;
    }
    if (usingGithub && this.sync.status.state === "setup") {
      this.el.append(el("div", "lib-empty", "GitHub sync setup is still in progress. Render cannot write to GitHub yet."));
      this.el.append(primaryBtn("Check sync status", () => void this.retryGitHub()));
      this.el.append(secondaryBtn("Choose local folder…", () => void this.chooseFolder()));
      return;
    }
    if (usingGithub && this.sync.status.state === "offline") {
      this.el.append(el("div", "lib-empty", "GitHub sync is temporarily unavailable. Your local tabs remain safe."));
      this.el.append(primaryBtn("Retry GitHub sync", () => void this.retryGitHub()));
      this.el.append(secondaryBtn("Choose local folder…", () => void this.chooseFolder()));
      return;
    }
    if (usingGithub && !this.sync.connected) {
      if (this.sync.device) {
        const verify = textBtn("Open GitHub verification", () => void this.syncController.openVerification());
        verify.className = "lib-choose";
        this.el.append(
          el("div", "lib-empty", "Finish connecting GitHub in your browser."),
          el("div", "lib-empty", `Enter this one-time code: ${this.sync.device.userCode}`),
          el("div", "lib-empty lib-sync-countdown", `Code expires in ${formatRemaining(this.sync.device.remainingSeconds)}`),
          verify,
          el("div", "lib-empty", "Waiting for GitHub approval…"),
          ...(this.sync.error ? [el("div", "lib-empty", this.sync.error)] : []),
          secondaryBtn("Copy code", () => void this.syncController.copyCode()),
          secondaryBtn("Copy link", () => void this.syncController.copyLink()),
          secondaryBtn("Cancel GitHub connection", () => this.syncController.cancel()),
        );
        return;
      }
      const connect = textBtn("Connect GitHub…", () => void this.syncController.start());
      connect.className = "lib-choose";
      this.el.append(
        el("div", "lib-empty", "Connect to browse and save the private GitHub library."),
        ...(this.sync.error ? [el("div", "lib-empty", this.sync.error)] : []),
        connect,
        secondaryBtn("Choose local folder…", () => void this.chooseFolder()),
      );
      return;
    }
    if (!usingGithub && !folderName) {
      const b = textBtn("Choose folder…", () => void this.chooseFolder());
      b.className = "lib-choose";
      this.el.append(b);
      if (this.sync.status.state !== "unavailable") this.el.append(secondaryBtn("Use GitHub library", () => void this.useGithub()));
      return;
    }

    if (!this.mock && !usingGithub) {
      const permitted = await this.lib.permitted();
      if (!isCurrent()) return;
      if (!permitted) {
        const b = textBtn(`Reconnect “${this.lib.folderName}”`, async () => {
          if (await this.lib.reconnect()) await this.refresh("explicit");
        });
        b.className = "lib-choose";
        this.el.append(b);
        return;
      }
    }

    // --- Search (full width, its own row) ---
    const search = document.createElement("input");
    search.type = "search";
    search.className = "lib-search";
    search.placeholder = "Search…";
    search.setAttribute("aria-label", "Search library documents");
    search.dataset.libraryFocusKey = "library-search";
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.focusedCollapsedProjectGroups.clear();
      this.renderList();
    });
    const controls = el("div", "lib-controls");
    controls.append(search);

    // --- View bar: group-by + a Filter toggle (facets collapse by default) ---
    const viewbar = el("div", "lib-viewbar");
    const group = document.createElement("select");
    group.className = "lib-group-select";
    group.title = "Group documents by…";
    group.setAttribute("aria-label", "Group library documents");
    group.dataset.libraryFocusKey = "library-grouping";
    for (const [val, label] of [
      ["flat", "No grouping"],
      ["folder", "By folder"],
      ["project", "By project"],
      ["kind", "By kind"],
      ["tag", "By tag"],
      ["status", "By status"],
    ] as [GroupBy, string][]) {
      const o = document.createElement("option");
      o.value = val;
      o.textContent = label;
      if (val === this.groupBy) o.selected = true;
      group.append(o);
    }
    group.addEventListener("change", () => {
      this.groupBy = group.value as GroupBy;
      localStorage.setItem(GROUP_KEY, this.groupBy);
      this.focusedCollapsedProjectGroups.clear();
      this.renderList();
    });

    const filterBtn = el("button", "lib-viewbtn") as HTMLButtonElement;
    filterBtn.type = "button";
    filterBtn.title = "Filter by project, collection, or tag";
    filterBtn.setAttribute("aria-expanded", String(this.filtersOpen));
    filterBtn.setAttribute("aria-controls", "library-filters");
    filterBtn.dataset.libraryFocusKey = "library-filter-toggle";
    filterBtn.addEventListener("click", () => {
      this.filtersOpen = !this.filtersOpen;
      this.renderFilterArea();
    });
    this.filterBtn = filterBtn;
    viewbar.append(group, filterBtn);
    controls.append(viewbar);

    // --- Filter area (facet panel + active-filter bar) ---
    this.filtersEl = el("div", "lib-filters");
    this.filtersEl.id = "library-filters";
    this.activeFiltersEl = el("div", "lib-active-filters");
    controls.append(this.filtersEl, this.activeFiltersEl);
    this.el.append(controls);

    // --- File list (persistent live region + scroll container) ---
    this.listEl.setAttribute("aria-busy", String(this.loadState === "loading"));
    this.listEl.replaceChildren(this.summaryEl, this.resultsEl);
    this.el.append(this.listEl);

    let loadError: string | null = null;
    if (this.indexSnapshot?.providerIdentity !== this.currentProviderIdentity()) {
      await this.loadIndex("initial");
      if (!isCurrent()) return;
    } else {
      this.entries = this.indexSnapshot.entries;
    }
    loadError = this.loadState === "stale" || this.loadState === "error"
      ? this.lastRenderError
      : null;
    // Drop filters that no longer exist in the library.
    for (const f of [...this.activeFilters]) {
      const [facet, val] = splitFilter(f);
      const known = this.knownLabels();
      const pool = facet === "tag"
        ? known.tags
        : facet === "project"
          ? known.projects
          : this.entries.some(isOtherNotesEntry)
            ? [OTHER_NOTES_FOLDER]
            : [];
      if (!pool.includes(val)) this.activeFilters.delete(f);
    }
    this.renderFilterArea();
    this.renderList();
    if (loadError) {
      const notice = el(
        "div",
        "lib-empty lib-stale-notice",
        this.entries.length
          ? `${loadError}. Showing the previous library index.`
          : loadError,
      );
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      notice.setAttribute("aria-atomic", "true");
      if (this.entries.length) this.listEl.prepend(notice);
      else this.listEl.replaceChildren(notice);
    }
    this.listEl.scrollTop = previousScrollTop;
    if (previousFocusKey) {
      this.el.querySelector<HTMLElement>(`[data-library-focus-key="${cssEscape(previousFocusKey)}"]`)
        ?.focus({ preventScroll: true });
    }
  }

  private currentRenderSource(): "github" | "folder" | "mock" {
    return this.mock ? "mock" : this.source === "github" ? "github" : "folder";
  }

  private currentProviderIdentity(): string {
    const provider = this.currentRenderSource();
    if (provider === "mock") return `mock:${this.mock?.folderName ?? "fixture"}`;
    if (provider === "folder") return `folder:${this.lib.folderName ?? "unselected"}`;
    return "github:configured-library";
  }

  private async listEntries(): Promise<LibraryFile[]> {
    return this.mock
      ? this.mock.files
      : this.source === "github"
        ? (await githubLibrary.list()) as GitHubLibraryFile[]
        : await this.lib.list();
  }

  private loadIndex(reason: LibraryRefreshReason): Promise<boolean> {
    const providerIdentity = this.currentProviderIdentity();
    if (this.refreshInFlight?.providerIdentity === providerIdentity) {
      return this.refreshInFlight.promise;
    }
    const sequence = ++this.refreshSequence;
    this.lastRenderError = null;
    this.setLoadState("loading");
    let promise!: Promise<boolean>;
    promise = (async () => {
      try {
        const entries = await this.listEntries();
        if (sequence !== this.refreshSequence || providerIdentity !== this.currentProviderIdentity()) {
          return false;
        }
        const signature = indexSignature(entries);
        const previous = this.indexSnapshot?.providerIdentity === providerIdentity
          ? this.indexSnapshot
          : null;
        const changed = previous?.signature !== signature;
        this.entries = entries;
        this.indexSnapshot = {
          provider: this.currentRenderSource(),
          providerIdentity,
          signature,
          revision: `${providerIdentity}:${signature}`,
          entries,
          loadedAt: Date.now(),
        };
        this.setLoadState("ready");
        if (changed) this.handlers.onCatalogChange?.();
        return true;
      } catch (error) {
        if (sequence !== this.refreshSequence || providerIdentity !== this.currentProviderIdentity()) {
          return false;
        }
        this.lastRenderError = error instanceof Error
          ? error.message
          : `Could not refresh the library (${reason})`;
        const retained = this.indexSnapshot?.providerIdentity === providerIdentity
          ? this.indexSnapshot
          : null;
        if (retained) {
          this.entries = retained.entries;
          this.setLoadState("stale");
        } else {
          this.entries = [];
          this.setLoadState("error");
        }
        return false;
      } finally {
        if (this.refreshInFlight?.promise === promise) this.refreshInFlight = null;
      }
    })();
    this.refreshInFlight = { providerIdentity, promise };
    return promise;
  }

  private invalidateProviderSnapshot(): void {
    this.cancelOpenRequests();
    this.refreshSequence++;
    this.refreshInFlight = null;
    this.indexSnapshot = null;
    this.entries = [];
    this.activePath = null;
    this.activeProviderIdentity = null;
    this.lastRenderError = null;
    this.rowCache.clear();
    this.groupCache.clear();
    this.groupWindows.clear();
    this.setLoadState("idle");
  }

  private cancelOpenRequests(): void {
    this.providerGeneration++;
    // Provider reads cannot always be aborted (notably browser file handles),
    // but clearing the de-duplication map lets the new provider open the same
    // relative path immediately. Completion guards below discard the old read.
    this.openingPaths.clear();
  }

  private activityProviderMatchesCurrent(provider: string | undefined): boolean {
    if (!provider) return false;
    const current = this.currentRenderSource();
    return (current === "github" && provider === "github")
      || (current === "folder" && provider === "local")
      || current === "mock";
  }

  private entryBelongsToCurrentProvider(entry: LibraryFile, handle: FileRef): boolean {
    const current = this.currentRenderSource();
    if (current === "mock") return true;
    const indexedHandle = entry.handle;
    if (current === "github") {
      return isGitHubFileRef(handle)
        && isGitHubFileRef(indexedHandle)
        && handle.path === indexedHandle.path;
    }
    if (!handle || !indexedHandle || isGitHubFileRef(handle) || isGitHubFileRef(indexedHandle)) {
      return false;
    }
    if (handle === indexedHandle) return true;
    if (isNativeFileRef(handle) && isNativeFileRef(indexedHandle)) {
      return handle.identity && indexedHandle.identity
        ? handle.identity === indexedHandle.identity
        : handle.grantId === indexedHandle.grantId;
    }
    // Browser handles from the current index normally retain object identity.
    // Separately restored handles require asynchronous isSameEntry(), which the
    // app performs before a Library open; do not guess synchronously here.
    return false;
  }

  private isActivePath(path: string): boolean {
    return path === this.activePath
      && this.activeProviderIdentity === this.currentProviderIdentity();
  }

  private commitInMemorySnapshot(reason: LibraryRefreshReason): void {
    if (!this.indexSnapshot || this.indexSnapshot.providerIdentity !== this.currentProviderIdentity()) {
      this.handlers.onCatalogChange?.();
      return;
    }
    const signature = indexSignature(this.entries);
    if (signature === this.indexSnapshot.signature) return;
    this.indexSnapshot = {
      ...this.indexSnapshot,
      signature,
      revision: `${this.indexSnapshot.providerIdentity}:${signature}:${reason}`,
      entries: this.entries,
      loadedAt: Date.now(),
    };
    this.handlers.onCatalogChange?.();
  }

  private setLoadState(state: LibraryLoadState): void {
    this.loadState = state;
    const busy = state === "loading";
    this.el.setAttribute("aria-busy", String(busy));
    this.listEl?.setAttribute("aria-busy", String(busy));
    for (const button of this.el.querySelectorAll<HTMLButtonElement>("[data-library-action]")) {
      const action = button.dataset.libraryAction;
      if (action !== "close") button.disabled = busy || (action ? this.pendingActions.has(action) : false);
    }
  }

  // Update the Filter button (label + active count + open state) and rebuild the
  // filter area: the full facet panel when open, otherwise a slim active-filter
  // bar when a filter is applied (so a collapsed panel still shows what's active).
  private renderFilterArea() {
    if (!this.filtersEl) return;
    const n = this.activeFilters.size;
    if (this.filterBtn) {
      this.filterBtn.textContent = n ? `Filter · ${n}` : "Filter";
      this.filterBtn.classList.toggle("is-open", this.filtersOpen);
      this.filterBtn.classList.toggle("has-active", n > 0);
      this.filterBtn.setAttribute("aria-expanded", String(this.filtersOpen));
    }

    this.filtersEl.textContent = "";
    if (this.activeFiltersEl) this.activeFiltersEl.textContent = "";
    this.filtersEl.hidden = !this.filtersOpen;
    const { projects, tags } = this.knownLabels();
    const collections = this.entries.some(isOtherNotesEntry) ? [OTHER_NOTES_FOLDER] : [];

    const chip = (facet: "project" | "tag" | "collection", val: string): HTMLButtonElement => {
      const key = `${facet}:${val}`;
      const c = document.createElement("button");
      c.type = "button";
      c.className = `lib-filter lib-filter-${facet}`;
      const label = facet === "collection"
        ? OTHER_NOTES_LABEL
        : facet === "project"
          ? this.projectLabel(val)
          : val;
      c.textContent = label;
      c.title = facet === "collection"
        ? `Show only the ${OTHER_NOTES_LABEL} collection`
        : `Show only ${facet} “${val}”`;
      if (facet === "project") c.style.setProperty("--chip", labelColor(val));
      const active = this.activeFilters.has(key);
      if (active) c.classList.add("is-on");
      c.setAttribute("aria-pressed", String(active));
      c.setAttribute("aria-label", `${active ? "Remove" : "Apply"} ${facet} filter: ${label}`);
      c.dataset.libraryFocusKey = `facet:${key}`;
      c.addEventListener("click", () => {
        const focusKey = c.dataset.libraryFocusKey;
        if (this.activeFilters.has(key)) this.activeFilters.delete(key);
        else this.activeFilters.add(key);
        this.focusedCollapsedProjectGroups.clear();
        this.renderFilterArea();
        this.renderList();
        if (focusKey) {
          const restored = this.el.querySelector<HTMLElement>(
            `[data-library-focus-key="${cssEscape(focusKey)}"]`,
          );
          (restored ?? this.filterBtn)?.focus({ preventScroll: true });
        }
      });
      return c;
    };
    const clearBtn = (): HTMLButtonElement => {
      const clear = el("button", "lib-clear", "✕ Clear filters") as HTMLButtonElement;
      clear.type = "button";
      clear.setAttribute("aria-label", "Clear all library filters");
      clear.dataset.libraryFocusKey = "clear-filters";
      clear.addEventListener("click", () => {
        this.activeFilters.clear();
        this.focusedCollapsedProjectGroups.clear();
        this.renderFilterArea();
        this.renderList();
        this.filterBtn?.focus({ preventScroll: true });
      });
      return clear;
    };

    if (this.filtersOpen) {
      // Full facet panel: labelled Projects / Tags rows.
      const panel = el("div", "lib-filterpanel");
      const facetRow = (label: string, facet: "project" | "tag" | "collection", values: string[]) => {
        if (!values.length) return;
        const row = el("fieldset", "lib-facet");
        row.append(el("legend", "lib-facet-label", label));
        for (const v of values) row.append(chip(facet, v));
        panel.append(row);
      };
      facetRow("Projects", "project", projects);
      facetRow("Collections", "collection", collections);
      facetRow("Tags", "tag", tags);
      if (!projects.length && !collections.length && !tags.length) {
        panel.append(el("div", "lib-empty", "No projects, collections, or tags yet"));
      }
      if (n) panel.append(clearBtn());
      this.filtersEl.append(panel);
    } else if (n) {
      // Collapsed but filtering → slim active-filter bar.
      const bar = el("div", "lib-activebar");
      bar.append(el("span", "lib-facet-label", "Filtered"));
      for (const f of this.activeFilters) {
        const [facet, val] = splitFilter(f);
        bar.append(chip(facet as "project" | "tag" | "collection", val));
      }
      bar.append(clearBtn());
      this.activeFiltersEl?.append(bar);
    }
  }

  private matches(e: LibraryFile): boolean {
    return matchesDocumentVisibility(e, this.query)
      && matchesQuery(e, this.query)
      && matchesFilters(e, this.activeFilters);
  }

  private renderList() {
    if (!this.listEl || !this.resultsEl || !this.summaryEl) return;
    const scrollTop = this.listEl.scrollTop;
    const focusedKey = (document.activeElement as HTMLElement | null)?.dataset.libraryFocusKey;
    const readerEntries = this.entries.filter(isReaderDocument);
    const supportCount = this.entries.length - readerEntries.length;
    const shown = this.entries.filter((entry) => this.matches(entry));
    const projectCount = new Set(readerEntries.flatMap((entry) => entry.meta.projects)).size;
    const focused = Boolean(this.query.trim() || this.activeFilters.size);
    const summaryText = focused
      ? `${shown.length} ${shown.length === 1 ? "match" : "matches"}`
      : [
          `${readerEntries.length} documents`,
          ...(supportCount ? [`${supportCount} support files`] : []),
          `${projectCount} ${projectCount === 1 ? "project" : "projects"}`,
        ].join(" · ");
    if (this.summaryEl.textContent !== summaryText) this.summaryEl.textContent = summaryText;
    this.duplicateTitles = duplicateDocumentTitles(shown);

    if (!this.entries.length || !shown.length) {
      this.resultsEl.replaceChildren(el(
        "div",
        "lib-empty",
        !this.entries.length
          ? "No .md files in this folder"
          : !focused && !readerEntries.length
            ? "No reader documents in this library"
            : "No documents match",
      ));
      return;
    }

    const nodes: Node[] = [];
    if (this.query.trim()) {
      const unique = deduplicateEntries(shown);
      nodes.push(this.windowedRows(unique, "search", true));
    } else if (this.groupBy === "flat") {
      nodes.push(this.windowedRows(shown, "flat", false));
    } else {
      const grouped = groupEntries(shown, this.groupBy);
      if (this.groupBy === "project") this.pruneProjectExpansion();
      for (const { key, files } of grouped) nodes.push(this.groupSection(key, files));
    }
    this.resultsEl.replaceChildren(...nodes);
    this.listEl.scrollTop = scrollTop;
    if (focusedKey) {
      this.resultsEl.querySelector<HTMLElement>(`[data-library-focus-key="${cssEscape(focusedKey)}"]`)?.focus();
    }
    this.syncActiveStyles(false);
  }

  private duplicateTitles = new Set<string>();

  private pruneProjectExpansion(): void {
    const currentKeys = new Set(
      groupEntries(this.entries.filter(isReaderDocument), "project").map(({ key }) => key),
    );
    for (const key of this.projectGroupExpansion.keys()) {
      if (!currentKeys.has(key)) this.projectGroupExpansion.delete(key);
    }
    for (const key of this.focusedCollapsedProjectGroups) {
      if (!currentKeys.has(key)) this.focusedCollapsedProjectGroups.delete(key);
    }
  }

  private groupSection(key: string, files: LibraryFile[]): HTMLElement {
    const cacheKey = `${this.groupBy}:${key}`;
    const group = this.groupCache.get(cacheKey) ?? el("section", "lib-group-section");
    this.groupCache.set(cacheKey, group);
    group.dataset.groupKey = key;
    group.dataset.groupMode = this.groupBy;
    group.dataset.focusedProject = String(this.groupBy === "project" && !key.startsWith("— "));
    group.dataset.paths = JSON.stringify(files.map(entryPath));
    group.dataset.rowHeight = String(VIRTUAL_ROW_HEIGHT);
    const isProject = this.groupBy === "project" && !key.startsWith("— ");
    const isOtherNotes = this.groupBy === "project" && key === `— ${OTHER_NOTES_LABEL}`;
    const label = isProject ? this.projectLabel(key) : key.replace(/^— /, "");
    const header = el(this.groupBy === "project" ? "button" : "h3", "lib-group-head");
    header.dataset.libraryFocusKey = `group:${cacheKey}`;
    if (header instanceof HTMLButtonElement) header.type = "button";
    else {
      header.classList.add("is-static");
      header.style.cursor = "default";
    }
    header.append(el("span", "lib-group-label", label));
    const count = el("span", "lib-group-count", String(files.length));
    count.setAttribute("aria-hidden", "true");
    header.append(count);
    if (isProject) {
      group.style.setProperty("--chip", labelColor(key));
      header.classList.add("lib-group-project");
      header.title = `${label} (${key})`;
    } else if (isOtherNotes) {
      header.classList.add("lib-group-collection");
    }
    const body = el("div", "lib-group-body");
    group.replaceChildren(header, body);
    this.groupFiles.set(group, files);
    if (this.groupBy === "project") {
      const stableId = `library-project-group-${shortHash(key)}`;
      header.id = `${stableId}-toggle`;
      header.setAttribute("aria-controls", stableId);
      header.setAttribute("aria-label", `${label}, ${files.length} ${files.length === 1 ? "document" : "documents"}`);
      const chevron = el("span", "lib-group-chevron", "›");
      chevron.setAttribute("aria-hidden", "true");
      header.append(chevron);
      body.id = stableId;
      body.setAttribute("role", "group");
      body.setAttribute("aria-labelledby", header.id);
      const facetFocused = this.activeFilters.size > 0;
      const containsActive = files.some((entry) => this.isActivePath(entryPath(entry)));
      const activeNeedsReveal = containsActive && (
        this.activePath !== this.lastRevealedActivePath
        || !this.lastActiveProjectGroups.has(key)
      );
      const expanded = activeNeedsReveal || (facetFocused
        ? !this.focusedCollapsedProjectGroups.has(key)
        : this.projectGroupExpansion.get(key) ?? false);
      this.setProjectGroupExpanded(group, expanded);
      if (expanded && isProject) void this.ensureProjectCatalog();
      header.addEventListener("click", () => {
        const next = header.getAttribute("aria-expanded") !== "true";
        if (this.activeFilters.size) {
          if (next) this.focusedCollapsedProjectGroups.delete(key);
          else this.focusedCollapsedProjectGroups.add(key);
        } else {
          this.projectGroupExpansion.set(key, next);
        }
        this.setProjectGroupExpanded(group, next);
        if (next && isProject) void this.ensureProjectCatalog();
      });
    } else {
      this.materializeGroup(group);
    }
    return group;
  }

  private setProjectGroupExpanded(group: HTMLElement, expanded: boolean): void {
    const header = group.querySelector<HTMLButtonElement>(".lib-group-head");
    const body = group.querySelector<HTMLElement>(".lib-group-body");
    if (!header || !body) return;
    header.setAttribute("aria-expanded", String(expanded));
    body.hidden = !expanded;
    group.classList.toggle("is-expanded", expanded);
    if (expanded) {
      const files = this.groupFiles.get(group) ?? [];
      const activeIndex = files.findIndex((entry) => this.isActivePath(entryPath(entry)));
      if (activeIndex >= 0 && files.length > LARGE_GROUP_THRESHOLD) {
        const windowKey = `${group.dataset.groupMode}:${group.dataset.groupKey ?? "group"}`;
        const maxStart = Math.max(0, files.length - GROUP_WINDOW_SIZE);
        const nextStart = Math.min(
          maxStart,
          Math.max(0, activeIndex - Math.floor(GROUP_WINDOW_SIZE / 2)),
        );
        if ((this.groupWindows.get(windowKey) ?? 0) !== nextStart) {
          this.groupWindows.set(windowKey, nextStart);
          body.replaceChildren();
        }
      }
      if (body.childElementCount === 0) this.materializeGroup(group);
    } else {
      body.replaceChildren();
    }
  }

  private materializeGroup(group: HTMLElement): void {
    const body = group.querySelector<HTMLElement>(".lib-group-body");
    const files = this.groupFiles.get(group);
    if (!body || !files) return;
    const project = group.dataset.groupMode === "project"
      && group.dataset.groupKey
      && !group.dataset.groupKey.startsWith("— ")
      ? group.dataset.groupKey
      : null;
    if (project) {
      this.materializeFocusedProject(body, files, project);
      this.syncActiveStyles(false);
      return;
    }
    body.replaceChildren(this.windowedRows(
      files,
      `${this.groupBy}:${group.dataset.groupKey ?? "group"}`,
      false,
      true,
    ));
    this.syncActiveStyles(false);
    this.scheduleVirtualUpdate();
  }

  private materializeFocusedProject(
    body: HTMLElement,
    files: LibraryFile[],
    project: string,
  ): void {
    const activePath = this.activeProviderIdentity === this.currentProviderIdentity()
      ? this.activePath
      : null;
    const projection = projectLibraryProjection(
      files,
      project,
      this.projectCatalogSnapshot,
      activePath,
      (id) => this.handlers.isDocumentDirty?.(id) ?? false,
      (path) => path === activePath
        && (this.activity.saveState === "failed" || this.activity.saveState === "conflict"),
    );
    const mode = this.projectMode(project);
    const nodes: Node[] = [this.projectModeControl(body, project, mode, projection.attentionCount)];

    if (mode === "attention") {
      nodes.push(projection.attentionDocuments.length
        ? this.projectDocumentList(
            projection.attentionDocuments,
            `${this.groupBy}:${project}:attention`,
            "lib-project-attention-list",
          )
        : el("p", "lib-project-empty", "Nothing currently needs attention."));
    } else {
      const groups = projection.browseGroups;
      const phoneOpenKey = this.phoneProjectOpenKey(
        project,
        groups,
        activePath,
      );
      for (const group of groups) {
        nodes.push(this.projectAreaDisclosure(
          project,
          group,
          activePath,
          phoneOpenKey,
        ));
      }
    }
    for (const message of projection.diagnostics) {
      const warning = el("p", "lib-project-diagnostic", message);
      warning.setAttribute("role", "status");
      nodes.push(warning);
    }
    body.replaceChildren(...nodes);
  }

  private projectMode(project: string): ProjectLibraryMode {
    return this.projectModes.get(this.projectPreferenceKey(project)) ?? "browse";
  }

  private projectModeControl(
    body: HTMLElement,
    project: string,
    selected: ProjectLibraryMode,
    attentionCount: number,
  ): HTMLElement {
    const control = el("div", "lib-project-modes");
    control.setAttribute("role", "toolbar");
    control.setAttribute("aria-label", `${this.projectLabel(project)} project controls`);
    const modes = el("div", "lib-project-mode-tabs");
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", "Document view");
    for (const mode of ["browse", "attention"] as const) {
      const label = `${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;
      const button = el("button", "lib-project-mode") as HTMLButtonElement;
      button.type = "button";
      button.dataset.mode = mode;
      button.setAttribute("aria-pressed", String(mode === selected));
      button.append(el("span", "lib-project-mode-label", label));
      if (mode === "attention" && attentionCount) {
        const count = el("span", "lib-project-mode-count", String(attentionCount));
        count.setAttribute("aria-hidden", "true");
        button.append(" ", count);
        button.setAttribute(
          "aria-label",
          `Attention, ${attentionCount} ${attentionCount === 1 ? "document" : "documents"}`,
        );
      }
      button.addEventListener("click", () => {
        if (mode === this.projectMode(project)) return;
        this.projectModes.set(this.projectPreferenceKey(project), mode);
        writePreferenceMap(PROJECT_MODE_KEY, this.projectModes);
        body.replaceChildren();
        const group = body.closest<HTMLElement>(".lib-group-section");
        if (group) this.materializeGroup(group);
      });
      modes.append(button);
    }
    const workspaces = el("div", "lib-project-workspace-actions");
    const overview = this.projectWorkspaceButton(project, "overview");
    const graph = this.projectWorkspaceButton(project, "graph");
    workspaces.append(overview, graph);
    control.append(modes, workspaces);
    return control;
  }

  private projectWorkspaceButton(
    project: string,
    workspace: "overview" | "graph",
  ): HTMLButtonElement {
    const label = workspace === "overview" ? "Overview" : "Graph";
    const contains = workspace === "overview" ? "project-overview" : "dependency-graph";
    const hasCanonicalSource = this.entries.some((entry) =>
      isReaderDocument(entry)
      && entry.meta.projects.length === 1
      && entry.meta.projects[0] === project
      && entry.meta.contains.includes(contains)
    );
    // A malformed graph declaration that names multiple projects must remain
    // reachable so the graph workspace can explain and diagnose the contract
    // error. It is never treated as a valid project graph.
    const hasMalformedGraphSource = workspace === "graph" && this.entries.some((entry) =>
      isReaderDocument(entry)
      && entry.meta.projects.length !== 1
      && entry.meta.projects.includes(project)
      && entry.meta.contains.includes("dependency-graph")
    );
    const available = hasCanonicalSource || hasMalformedGraphSource;
    const button = textBtn(label, () => {
      if (!available) return;
      const resolveLauncher = () => this.el.querySelector<HTMLButtonElement>(
        `[data-project-action="${workspace}"][data-project="${cssEscape(project)}"]`,
      );
      if (workspace === "overview") {
        this.handlers.onOpenOverview?.(project, resolveLauncher);
      } else {
        this.handlers.onOpenGraph?.(
          hasCanonicalSource ? project : undefined,
          resolveLauncher,
        );
      }
    });
    button.className = "lib-project-workspace-action";
    button.dataset.projectAction = workspace;
    button.dataset.project = project;
    button.dataset.libraryFocusKey = `project-workspace:${project}:${workspace}`;
    button.disabled = !available;
    button.setAttribute(
      "aria-label",
      `${label}: ${this.projectLabel(project)}`,
    );
    button.title = available
      ? hasMalformedGraphSource && !hasCanonicalSource
        ? "Review dependency graph configuration"
        : `Open ${this.projectLabel(project)} ${workspace}`
      : `${label} is not available for this project`;
    return button;
  }

  private projectAreaDisclosure(
    project: string,
    group: ProjectLibraryGroup,
    activePath: string | null,
    phoneOpenKey: string | null,
  ): HTMLDetailsElement {
    const details = document.createElement("details");
    details.className = "lib-project-area";
    details.dataset.area = group.key;
    const documents = [
      ...group.documents,
      ...group.sections.flatMap((section) => section.documents),
    ];
    details.dataset.paths = JSON.stringify(documents.map((item) => entryPath(item.file)));
    const stateKey = this.projectDisclosureKey(project, "browse", group.key);
    const containsActive = !!activePath
      && documents.some((item) => entryPath(item.file) === activePath);
    const directWindowKey = `${this.groupBy}:${project}:browse:${group.key}:direct`;
    if (containsActive && activePath) {
      this.primeProjectWindow(group.documents, directWindowKey, activePath);
      for (const section of group.sections) {
        this.primeProjectWindow(
          section.documents,
          `${this.groupBy}:${project}:browse:${group.key}:${section.key}`,
          activePath,
        );
      }
    }
    const requestedOpen = containsActive
      || this.projectAreaExpansion.get(stateKey) === true;
    details.open = phoneOpenKey === null ? requestedOpen : group.key === phoneOpenKey;

    const summary = document.createElement("summary");
    summary.append(
      el("span", "lib-project-section-label", group.label),
      el("span", "lib-project-section-count", String(documents.length)),
    );
    const content = el("div", "lib-project-area-content");
    const materialize = () => {
      if (!details.open) {
        content.replaceChildren();
        return;
      }
      if (content.childElementCount) return;
      if (group.documents.length) {
        content.append(this.windowedProjectRows(
          group.documents,
          directWindowKey,
        ));
      }
      for (const section of group.sections) {
        const subsection = document.createElement("details");
        subsection.className = "lib-project-subsection";
        subsection.dataset.section = section.key;
        const sectionPaths = section.documents.map((item) => entryPath(item.file));
        subsection.dataset.paths = JSON.stringify(sectionPaths);
        if (section.sequence !== null) {
          subsection.dataset.sequence = String(section.sequence);
          subsection.classList.add("is-model-stage");
        }
        const sectionStateKey = this.projectDisclosureKey(
          project,
          "browse",
          `${group.key}:${section.key}`,
        );
        const sectionContainsActive = !!activePath && sectionPaths.includes(activePath);
        subsection.open = sectionContainsActive
          || this.projectAreaExpansion.get(sectionStateKey) === true;
        const sectionSummary = document.createElement("summary");
        sectionSummary.className = "lib-project-subsection-summary";
        const heading = el("h5", "lib-project-subsection-title");
        if (section.sequence !== null) {
          const sequence = el(
            "span",
            "lib-project-subsection-sequence",
            String(section.sequence).padStart(2, "0"),
          );
          sequence.setAttribute("aria-hidden", "true");
          heading.append(sequence);
        }
        heading.append(
          el("span", "lib-project-section-label", section.label),
          el("span", "lib-project-section-count", String(section.documents.length)),
        );
        sectionSummary.append(heading);
        const sectionContent = el("div", "lib-project-subsection-content");
        const materializeSection = () => {
          if (!subsection.open) {
            sectionContent.replaceChildren();
            return;
          }
          if (sectionContent.childElementCount) return;
          sectionContent.append(this.windowedProjectRows(
            section.documents,
            `${this.groupBy}:${project}:browse:${group.key}:${section.key}`,
          ));
        };
        subsection.addEventListener("toggle", () => {
          this.projectAreaExpansion.set(sectionStateKey, subsection.open);
          writePreferenceMap(PROJECT_DISCLOSURE_KEY, this.projectAreaExpansion);
          if (subsection.open && isPhoneLibrary()) {
            for (const sibling of subsection.parentElement?.querySelectorAll<HTMLDetailsElement>(
              ":scope > .lib-project-subsection[open]",
            ) ?? []) {
              if (sibling === subsection) continue;
              sibling.open = false;
            }
          }
          materializeSection();
        });
        subsection.append(sectionSummary, sectionContent);
        materializeSection();
        content.append(subsection);
      }
    };
    details.addEventListener("toggle", () => {
      this.projectAreaExpansion.set(stateKey, details.open);
      writePreferenceMap(PROJECT_DISCLOSURE_KEY, this.projectAreaExpansion);
      if (details.open && isPhoneLibrary()) {
        for (const sibling of details.parentElement?.querySelectorAll<HTMLDetailsElement>(
          ":scope > .lib-project-area[open]",
        ) ?? []) {
          if (sibling === details) continue;
          sibling.open = false;
        }
      }
      materialize();
    });
    details.append(summary, content);
    materialize();
    return details;
  }

  private projectDocumentList(
    items: ProjectLibraryDocument[],
    key: string,
    className = "lib-project-document-list",
  ): HTMLElement {
    const section = el("section", className);
    section.append(this.windowedProjectRows(items, key));
    return section;
  }

  private phoneProjectOpenKey(
    project: string,
    groups: ProjectLibraryGroup[],
    activePath: string | null,
  ): string | null {
    if (!isPhoneLibrary()) return null;
    if (activePath) {
      const activeGroup = groups.find((group) => [
        ...group.documents,
        ...group.sections.flatMap((section) => section.documents),
      ].some((item) => entryPath(item.file) === activePath));
      if (activeGroup) return activeGroup.key;
    }
    const persistedGroup = groups.find((group) =>
      this.projectAreaExpansion.get(this.projectDisclosureKey(project, "browse", group.key)) === true
    );
    if (persistedGroup) return persistedGroup.key;
    return null;
  }

  private projectPreferenceKey(project: string): string {
    return `${this.currentProviderIdentity()}:${project}`;
  }

  private projectDisclosureKey(
    project: string,
    mode: ProjectLibraryMode,
    area: string,
  ): string {
    return `${this.projectPreferenceKey(project)}:${mode}:${area}`;
  }

  private windowedProjectRows(items: ProjectLibraryDocument[], key: string): DocumentFragment {
    const byPath = new Map(items.map((item) => [entryPath(item.file), item]));
    return this.windowedRows(items.map((item) => item.file), key, false, false, byPath);
  }

  private primeProjectWindow(
    items: ProjectLibraryDocument[],
    key: string,
    activePath: string,
  ): void {
    if (items.length <= LARGE_GROUP_THRESHOLD) return;
    const activeIndex = items.findIndex((item) => entryPath(item.file) === activePath);
    if (activeIndex < 0) return;
    const maxStart = Math.max(0, items.length - GROUP_WINDOW_SIZE);
    this.groupWindows.set(
      key,
      Math.min(maxStart, Math.max(0, activeIndex - Math.floor(GROUP_WINDOW_SIZE / 2))),
    );
  }

  private windowedRows(
    files: LibraryFile[],
    key: string,
    searchContext: boolean,
    virtualScroll = false,
    decorations?: Map<string, ProjectLibraryDocument>,
  ): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const bounded = files.length > LARGE_GROUP_THRESHOLD;
    const maxStart = Math.max(0, files.length - GROUP_WINDOW_SIZE);
    const start = bounded ? Math.min(this.groupWindows.get(key) ?? 0, maxStart) : 0;
    const end = bounded ? Math.min(files.length, start + GROUP_WINDOW_SIZE) : files.length;
    if (bounded) {
      fragment.append(virtualScroll
        ? this.virtualSpacer(start, "before")
        : this.windowControls(key, start, end, files.length));
    }
    for (let index = start; index < end; index++) {
      const entry = files[index];
      const row = this.fileRow(
        entry,
        `${key}:${entryPath(entry)}`,
        searchContext,
        decorations?.get(entryPath(entry)),
      );
      if (bounded) {
        const details = row.querySelector<HTMLElement>(".lib-sr-only");
        if (details) details.textContent += `. Document ${index + 1} of ${files.length}`;
      }
      fragment.append(row);
    }
    if (bounded) {
      fragment.append(virtualScroll
        ? this.virtualSpacer(files.length - end, "after")
        : this.windowControls(key, start, end, files.length));
    }
    return fragment;
  }

  private virtualSpacer(rows: number, position: "before" | "after"): HTMLElement {
    const spacer = el("div", `lib-virtual-spacer is-${position}`);
    spacer.style.height = `${Math.max(0, rows * VIRTUAL_ROW_HEIGHT)}px`;
    spacer.setAttribute("aria-hidden", "true");
    return spacer;
  }

  private readonly onListScroll = () => this.scheduleVirtualUpdate();

  private scheduleVirtualUpdate(): void {
    if (this.virtualUpdateScheduled || !this.visible) return;
    this.virtualUpdateScheduled = true;
    const run = () => {
      this.virtualUpdateScheduled = false;
      this.updateVirtualWindows();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else queueMicrotask(run);
  }

  private updateVirtualWindows(): void {
    const listRect = this.listEl.getBoundingClientRect();
    if (listRect.height <= 0) return;
    for (const group of this.resultsEl.querySelectorAll<HTMLElement>(".lib-group-section.is-expanded")) {
      if (group.dataset.focusedProject === "true") continue;
      const files = this.groupFiles.get(group);
      if (!files || files.length <= LARGE_GROUP_THRESHOLD) continue;
      const body = group.querySelector<HTMLElement>(".lib-group-body");
      if (!body || body.hidden) continue;
      const bodyRect = body.getBoundingClientRect();
      const firstVisible = Math.floor(Math.max(0, listRect.top - bodyRect.top) / VIRTUAL_ROW_HEIGHT);
      const maxStart = Math.max(0, files.length - GROUP_WINDOW_SIZE);
      const nextStart = Math.min(maxStart, Math.max(0, firstVisible - GROUP_WINDOW_OVERSCAN));
      const key = `${group.dataset.groupMode}:${group.dataset.groupKey ?? "group"}`;
      const current = this.groupWindows.get(key) ?? 0;
      if (Math.abs(nextStart - current) < GROUP_WINDOW_OVERSCAN) continue;
      this.groupWindows.set(key, nextStart);
      this.materializeGroup(group);
    }
  }

  private windowControls(key: string, start: number, end: number, total: number): HTMLElement {
    const controls = el("nav", "lib-window-controls");
    controls.setAttribute("aria-label", "Document window");
    const previous = secondaryBtn("Previous", () => {
      this.groupWindows.set(key, Math.max(0, start - GROUP_WINDOW_SIZE));
      this.renderList();
    });
    previous.disabled = start === 0;
    const next = secondaryBtn("Next", () => {
      this.groupWindows.set(key, Math.min(total - GROUP_WINDOW_SIZE, start + GROUP_WINDOW_SIZE));
      this.renderList();
    });
    next.disabled = end >= total;
    controls.append(previous, el("span", "lib-window-summary", `${start + 1}–${end} of ${total}`), next);
    return controls;
  }

  private syncActiveStyles(forceReveal: boolean): void {
    if (
      this.groupBy === "project"
      && this.activePath
      && this.activeProviderIdentity === this.currentProviderIdentity()
    ) {
      for (const group of this.el.querySelectorAll<HTMLElement>(".lib-group-section")) {
        const key = group.dataset.groupKey;
        const containsActive = this.groupFiles.get(group)
          ?.some((entry) => this.isActivePath(entryPath(entry)));
        if (containsActive && key && (forceReveal || this.activePath !== this.lastRevealedActivePath)) {
          this.projectGroupExpansion.set(key, true);
          this.focusedCollapsedProjectGroups.delete(key);
          this.setProjectGroupExpanded(group, true);
        }
      }
    }
    const currentActiveGroups = new Set<string>();
    const activeRows: Array<{ group: HTMLElement; key: string }> = [];
    let foundActive = false;
    for (const row of this.el.querySelectorAll<HTMLElement>(".lib-file")) {
      const active = !!row.dataset.path && this.isActivePath(row.dataset.path);
      row.classList.toggle("is-active", active);
      if (active) row.setAttribute("aria-current", "page");
      else row.removeAttribute("aria-current");
      if (active) foundActive = true;
      if (active && this.groupBy === "project") {
        const group = row.closest<HTMLElement>(".lib-group-section");
        const key = group?.dataset.groupKey;
        if (group && key) {
          currentActiveGroups.add(key);
          activeRows.push({ group, key });
        }
      }
    }
    const activePathChanged = this.activePath !== this.lastRevealedActivePath;
    for (const { group, key } of activeRows) {
      // A same-path Pull can move a document to a new project. Reveal newly
      // containing groups, while preserving a user's manual collapse choice
      // for an already-known active group.
      if (forceReveal || activePathChanged || !this.lastActiveProjectGroups.has(key)) {
        this.projectGroupExpansion.set(key, true);
        this.focusedCollapsedProjectGroups.delete(key);
        this.setProjectGroupExpanded(group, true);
      }
    }
    for (const group of this.el.querySelectorAll<HTMLElement>(".lib-group-section")) {
      group.classList.toggle("has-active-document", Boolean(group.querySelector(".lib-file.is-active")));
    }
    if (foundActive) {
      this.lastRevealedActivePath = this.activePath;
      this.lastActiveProjectGroups.clear();
      currentActiveGroups.forEach((key) => this.lastActiveProjectGroups.add(key));
    }
  }

  private revealActiveRow(): void {
    if (
      !this.visible
      || !this.activePath
      || this.activeProviderIdentity !== this.currentProviderIdentity()
    ) return;
    const row = [...this.el.querySelectorAll<HTMLElement>(".lib-file")]
      .find((candidate) => candidate.dataset.path === this.activePath);
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  }

  private resetProjectExpansion(): void {
    this.projectGroupExpansion.clear();
    this.focusedCollapsedProjectGroups.clear();
    this.lastRevealedActivePath = null;
    this.lastActiveProjectGroups.clear();
  }

  private hasExpandedProjectGroup(): boolean {
    return !!this.resultsEl.querySelector(
      '.lib-group-section[data-focused-project="true"].is-expanded',
    );
  }

  private async ensureProjectCatalog(): Promise<void> {
    if (this.projectCatalogSnapshot || !this.handlers.loadProjectCatalog) return;
    if (this.projectCatalogInFlight) return this.projectCatalogInFlight;
    this.projectCatalogInFlight = this.handlers.loadProjectCatalog()
      .then((loaded) => {
        this.projectCatalogSnapshot = loaded.snapshot;
        if (this.visible && this.groupBy === "project") this.renderList();
      })
      .catch(() => {
        // The structural/index-only projection remains usable. Overview and
        // Graph surface the detailed source error when explicitly opened.
      })
      .finally(() => {
        this.projectCatalogInFlight = null;
      });
    return this.projectCatalogInFlight;
  }

  private fileRow(
    e: LibraryFile,
    instanceKey = entryPath(e),
    searchContext = false,
    projection?: ProjectLibraryDocument,
  ): HTMLButtonElement {
    let row = this.rowCache.get(instanceKey);
    if (!row) {
      row = document.createElement("button");
      row.type = "button";
      row.addEventListener("click", () => {
        if (row?.getAttribute("aria-disabled") === "true") return;
        const current = this.entries.find((entry) => entryPath(entry) === row?.dataset.path);
        if (current) void this.openFile(current);
      });
      this.rowCache.set(instanceKey, row);
    }
    row.className = "lib-file";
    const path = entryPath(e);
    const title = docTitle(e.meta, e.name);
    row.replaceChildren();
    row.dataset.path = path;
    row.dataset.libraryFocusKey = `file:${instanceKey}`;
    const opening = this.openingPaths.has(path);
    row.disabled = false;
    row.setAttribute("aria-disabled", String(opening));
    row.setAttribute("aria-busy", String(opening));
    row.classList.toggle("is-opening", opening);
    if (this.isActivePath(path)) row.classList.add("is-active");
    row.classList.toggle(
      "is-curated",
      !!projection?.focusPlacement && !projection.roles.includes("overview"),
    );

    // Project colour remains available as a quiet accent in non-project views.
    // The enclosing project disclosure already supplies it in the default view.
    const project = e.meta.projects[0];
    if (project) {
      row.classList.add("has-project");
      row.style.setProperty("--proj", labelColor(project));
    } else {
      row.style.removeProperty("--proj");
    }

    const rowSequence = shortHash(instanceKey);
    const titleEl = el("span", "lib-file-title", title);
    titleEl.id = `library-file-title-${rowSequence}`;
    const duplicateTitle = this.duplicateTitles.has(title.toLocaleLowerCase());
    if (duplicateTitle) {
      row.removeAttribute("aria-labelledby");
      row.setAttribute("aria-label", `${title}, ${path}`);
    } else {
      row.removeAttribute("aria-label");
      row.setAttribute("aria-labelledby", titleEl.id);
    }
    const primary = el("span", "lib-file-primary");
    primary.append(titleEl);
    if (projection?.keyResultCount) {
      const results = el(
        "span",
        "lib-file-key-results",
        `${projection.keyResultCount} ${projection.keyResultCount === 1 ? "result" : "results"}`,
      );
      results.title = `${projection.keyResultCount} curated key ${projection.keyResultCount === 1 ? "result" : "results"}`;
      results.setAttribute("aria-hidden", "true");
      primary.append(results);
    } else if (projection?.focusPlacement && !projection.roles.includes("overview")) {
      const curated = el("span", "lib-file-curated");
      curated.title = "Included in the project reading path";
      curated.setAttribute("aria-hidden", "true");
      primary.append(curated);
    }
    if (e.openCommentCount > 0) {
      const comments = el("span", "lib-file-comments", String(e.openCommentCount));
      comments.title = `${e.openCommentCount} unresolved ${e.openCommentCount === 1 ? "comment" : "comments"}`;
      comments.setAttribute("aria-hidden", "true");
      comments.prepend(commentIcon());
      primary.append(comments);
    }
    row.append(primary);

    const meta = el("span", "lib-meta");
    if (searchContext || duplicateTitle) {
      const project = e.meta.projects[0];
      const context = project
        ? `${this.projectLabel(project)} · ${abbreviatePath(path)}`
        : abbreviatePath(path);
      meta.append(el("span", "lib-file-context", context));
    }

    const exceptionalAttention = projection?.attention.find((reason) =>
      reason !== "active" && reason !== "comments"
    );
    if (exceptionalAttention) {
      meta.append(el(
        "span",
        "lib-attention-reason",
        libraryAttentionReasonLabel(exceptionalAttention),
      ));
    }

    const dirty = e.meta.id ? this.handlers.isDocumentDirty?.(e.meta.id) ?? false : false;
    row.classList.toggle("has-meta", meta.childElementCount > 0);
    if (meta.childElementCount > 0) row.append(meta);

    const semanticRoles = projection?.roles.filter((role) => role !== "key-result-owner") ?? [];
    row.title = [
      title,
      path,
      ...(e.meta.projects.length
        ? [`${e.meta.projects.length === 1 ? "Project" : "Projects"}: ${e.meta.projects.join(", ")}`]
        : []),
      ...(e.meta.kind ? [`Kind: ${humanizeMetaValue(e.meta.kind)}`] : []),
      ...(e.meta.status ? [`Status: ${humanizeMetaValue(e.meta.status)}`] : []),
      ...(e.meta.projection?.read_only ? ["Generated Contract v2 projection (read-only)"] : []),
      ...(e.meta.tags.length ? [`Tags: ${e.meta.tags.join(", ")}`] : []),
      ...(e.openCommentCount ? [`Unresolved comments: ${e.openCommentCount}`] : []),
      ...(dirty ? ["Unsaved changes"] : []),
      ...(semanticRoles.length
        ? [`Library role: ${semanticRoles.map(libraryDocumentRoleLabel).join(", ")}`]
        : []),
      ...(projection?.keyResultCount
        ? [`Owns ${projection.keyResultCount} curated key ${projection.keyResultCount === 1 ? "result" : "results"}`]
        : []),
      ...(projection?.focusPlacement?.purpose
        ? [`Reading purpose: ${projection.focusPlacement.purpose}`]
        : []),
      ...(projection?.attention.length
        ? [`Attention: ${projection.attention.map(libraryAttentionReasonLabel).join(", ")}`]
        : []),
    ].join("\n");

    const accessibleDetails = [
      ...(!duplicateTitle ? [`Path: ${path}`] : []),
      ...(e.meta.projects.length
        ? [`${e.meta.projects.length === 1 ? "Project" : "Projects"}: ${e.meta.projects.join(", ")}`]
        : []),
      ...(e.meta.kind ? [`Kind: ${e.meta.kind}`] : []),
      ...(e.meta.status ? [`Status: ${e.meta.status}`] : []),
      ...(e.meta.projection?.read_only ? ["Generated Contract v2 projection, read-only"] : []),
      ...(e.meta.tags.length ? [`Tags: ${e.meta.tags.join(", ")}`] : []),
      ...(e.openCommentCount
        ? [`${e.openCommentCount} unresolved ${e.openCommentCount === 1 ? "comment" : "comments"}`]
        : []),
      ...(dirty ? ["Unsaved changes in an open tab"] : []),
      ...(opening ? ["Opening document"] : []),
      ...(semanticRoles.length
        ? [`Library role: ${semanticRoles.map(libraryDocumentRoleLabel).join(", ")}`]
        : []),
      ...(projection?.keyResultCount
        ? [`Owns ${projection.keyResultCount} curated key ${projection.keyResultCount === 1 ? "result" : "results"}`]
        : []),
      ...(projection?.focusPlacement?.purpose
        ? [`Reading purpose: ${projection.focusPlacement.purpose}`]
        : []),
      ...(projection?.attention.length
        ? [`Attention: ${projection.attention.map(libraryAttentionReasonLabel).join(", ")}`]
        : []),
    ];
    const details = el("span", "lib-sr-only", accessibleDetails.join(". "));
    details.id = `library-file-details-${rowSequence}`;
    row.setAttribute("aria-describedby", details.id);
    row.append(details);

    return row;
  }

  // --- actions ------------------------------------------------------------
  private async chooseFolder() {
    if (this.pendingActions.has("provider")) return;
    this.pendingActions.add("provider");
    this.setLoadState(this.loadState);
    this.cancelOpenRequests();
    this.syncController.cancel();
    this.mock = null; // a real folder supersedes any injected dev mock
    try {
      if (await this.lib.choose()) {
        this.resetProjectExpansion();
        this.source = "folder";
        this.invalidateProviderSnapshot();
        this.setVisible(true);
        await this.refresh("provider-change");
      }
    } finally {
      this.pendingActions.delete("provider");
      this.setLoadState(this.loadState);
    }
  }

  private async useGithub() {
    if (this.pendingActions.has("provider")) return;
    this.pendingActions.add("provider");
    this.cancelOpenRequests();
    this.mock = null;
    this.resetProjectExpansion();
    try {
      await this.syncController.refresh();
      this.source = "github";
      this.invalidateProviderSnapshot();
      this.setVisible(true);
      await this.refresh("provider-change");
    } finally {
      this.pendingActions.delete("provider");
      this.setLoadState(this.loadState);
    }
  }

  async pull(): Promise<boolean> {
    if (this.pullInFlight) return this.pullInFlight;
    const promise = (async () => {
      this.pendingActions.add("pull");
      this.activity.lastPull = { state: "pulling", at: null };
      this.updateActivityStatus();
      try {
        const refreshed = await this.refresh(this.usesGitHub ? "pull" : "local-refresh");
        if (!refreshed) throw new Error(this.lastRenderError ?? "Library refresh failed");
        if (
          this.activePath
          && this.activeProviderIdentity === this.currentProviderIdentity()
          && this.handlers.onRefresh
        ) {
          const active = this.entries.find((entry) => entryPath(entry) === this.activePath);
          if (active && isGitHubFileRef(active.handle)) {
            this.handlers.onRefresh(await githubLibrary.open(active as GitHubLibraryFile));
          }
        }
        this.activity.lastPull = { state: "succeeded", at: Date.now() };
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Pull failed";
        this.activity.lastPull = { state: "failed", at: Date.now(), message };
        this.showActionNotice("Pull failed. Your local tab was not changed.");
        return false;
      } finally {
        this.pendingActions.delete("pull");
        this.updateActivityStatus();
        this.setLoadState(this.loadState);
      }
    })();
    this.pullInFlight = promise;
    return promise.finally(() => {
      if (this.pullInFlight === promise) this.pullInFlight = null;
    });
  }

  private async retryGitHub() {
    await this.syncController.refresh();
    if (this.sync.connected) await this.refresh("provider-change");
    else await this.render();
  }

  private syncBadge(): HTMLElement {
    const shared = this.sync.status.principal?.kind === "coauthor";
    const labels: Record<LibrarySyncSnapshot["status"]["state"], { short: string; full: string }> = {
      unavailable: { short: "Unavailable", full: "Library service unavailable" },
      setup: { short: "Setup pending", full: "Library service setup pending" },
      offline: { short: "Offline", full: "Library service offline" },
      ready: this.sync.connected
        ? shared
          ? { short: "Shared", full: `Shared access as ${this.sync.status.principal?.displayName ?? "coauthor"}` }
          : { short: "Connected", full: "Connected to GitHub" }
        : { short: "Sign in", full: "Library sign-in or invitation needed" },
    };
    const label = labels[this.sync.status.state];
    const connected = this.sync.status.state === "ready" && this.sync.connected ? " is-connected" : "";
    const badge = el("span", `lib-sync lib-sync-${this.sync.status.state}${connected}`, label.short);
    badge.setAttribute("role", "status");
    badge.setAttribute("aria-label", label.full);
    badge.title = label.full;
    return badge;
  }

  private updateActivityStatus(): void {
    if (!this.activityEl) return;
    const saveLabel: Record<SaveState, string> = {
      dirty: "Changes pending",
      queued: "Saving…",
      saving: "Saving…",
      saved: "Saved",
      conflict: "Sync failed",
      failed: "Sync failed",
    };
    const pull = this.activity.lastPull;
    const pullLabel = pull.state === "pulling"
      ? "Pulling…"
      : pull.state === "failed"
        ? "Pull failed"
        : pull.state === "succeeded" && pull.at
          ? `Pulled ${new Date(pull.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          : null;
    const saveShort = this.activity.dirty && this.activity.saveState === "saved"
      ? "Changes pending"
      : saveLabel[this.activity.saveState];
    const short = pullLabel ? `${saveShort} · ${pullLabel}` : saveShort;
    const details = [
      short,
      this.activity.activePath || this.activity.name
        ? `Document: ${this.activity.activePath ?? this.activity.name}`
        : "No active library document",
      this.activity.provider ? `Destination: ${this.activity.provider}` : "",
      this.activity.lastSavedAt ? `Last saved: ${new Date(this.activity.lastSavedAt).toLocaleString()}` : "",
      pull.at ? `Last pull: ${new Date(pull.at).toLocaleString()}` : "",
      pull.message ?? "",
    ].filter(Boolean).join(". ");
    const saveStatus = el("span", "lib-activity-save", saveShort);
    this.activityEl.dataset.saveState = this.activity.saveState;
    this.activityEl.dataset.pullState = pull.state;
    this.activityEl.classList.toggle(
      "is-idle",
      saveShort === "Saved" && pull.state === "idle",
    );
    this.activityEl.replaceChildren(saveStatus);
    if (pullLabel) {
      const pullStatus = el(
        "span",
        `lib-activity-pull${pull.state === "failed" ? " is-failed" : ""}`,
        pullLabel,
      );
      this.activityEl.append(pullStatus);
    }
    this.activityEl.title = details;
    this.activityEl.setAttribute("role", "status");
    this.activityEl.setAttribute("aria-label", details);
  }

  private moreMenu(items: LibraryMenuAction[]): HTMLElement {
    const details = document.createElement("details");
    details.className = "lib-head-more";
    const summary = el("summary", "lib-head-action has-label") as HTMLElement;
    summary.setAttribute("aria-label", "More library actions");
    summary.setAttribute("aria-haspopup", "menu");
    summary.setAttribute("aria-expanded", "false");
    summary.setAttribute("aria-controls", "library-more-menu");
    summary.title = "More library actions";
    summary.append(libraryIcon("more"), el("span", "lib-head-action-label", "More"));
    const menu = el("div", "lib-head-menu");
    menu.id = "library-more-menu";
    menu.setAttribute("role", "menu");
    // WebKit does not focus a button when it is pointer-clicked. Its focusout
    // can consequently run between mousedown and click; closing <details> at
    // that point removes the menu item's rendered box and cancels the click.
    // Keep the menu alive for the complete pointer activation and let the
    // item's click handler close it after its action has launched.
    let pointerInsideMenu = false;
    for (const item of items) {
      if (item.separatorBefore) {
        const separator = el("div", "lib-head-menu-separator");
        separator.setAttribute("role", "separator");
        menu.append(separator);
      }
      const button = textBtn(item.label, () => {
        details.removeAttribute("open");
        item.run();
      });
      button.setAttribute("role", "menuitem");
      if (item.action) {
        button.dataset.libraryAction = item.action;
        button.dataset.libraryFocusKey = `library-action:${item.action}`;
        button.disabled = this.loadState === "loading"
          || this.pendingActions.has(item.action);
      }
      menu.append(button);
    }
    const menuItems = () => [
      ...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
    ];
    const close = (restoreFocus: boolean) => {
      details.open = false;
      summary.setAttribute("aria-expanded", "false");
      if (this.openMoreMenu === details) this.openMoreMenu = null;
      if (restoreFocus) summary.focus({ preventScroll: true });
    };
    details.addEventListener("toggle", () => {
      if (details.open) {
        if (this.openMoreMenu && this.openMoreMenu !== details) this.openMoreMenu.open = false;
        this.openMoreMenu = details;
      } else if (this.openMoreMenu === details) {
        this.openMoreMenu = null;
      }
      summary.setAttribute("aria-expanded", String(details.open));
    });
    summary.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      details.open = true;
      const available = menuItems();
      available[event.key === "ArrowUp" ? available.length - 1 : 0]
        ?.focus({ preventScroll: true });
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const available = menuItems();
      if (!available.length) return;
      event.preventDefault();
      const current = available.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? available.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length;
      available[next].focus({ preventScroll: true });
    });
    details.addEventListener("focusout", () => {
      if (pointerInsideMenu) return;
      queueMicrotask(() => {
        if (!details.contains(document.activeElement)) close(false);
      });
    });
    menu.addEventListener("mousedown", () => {
      pointerInsideMenu = true;
      document.addEventListener("mouseup", () => {
        // Mouseup precedes click. Defer cleanup until after the click has
        // dispatched so an unfocused WebKit activation cannot be interrupted.
        window.setTimeout(() => {
          pointerInsideMenu = false;
          if (details.open && !details.contains(document.activeElement)) close(false);
        }, 0);
      }, { capture: true, once: true });
    }, true);
    details.append(summary, menu);
    return details;
  }

  private readonly onDocumentMouseDown = (event: MouseEvent) => {
    const open = this.openMoreMenu;
    if (!open || open.contains(event.target as Node)) return;
    open.open = false;
    this.openMoreMenu = null;
  };

  private projectLabel(project: string): string {
    const candidates = this.entries.filter((entry) =>
      isReaderDocument(entry)
      && entry.meta.projects.length === 1
      && entry.meta.projects[0] === project
      && entry.meta.contains.includes("project-overview"));
    if (candidates.length === 1) {
      const title = docTitle(candidates[0].meta, candidates[0].name);
      if (!isGenericProjectTitle(title)) return title;
    }
    return humanizeProjectId(project);
  }

  private async readFile(f: LibraryFile): Promise<OpenedFile> {
    return isGitHubFileRef(f.handle)
      ? await githubLibrary.open(f as GitHubLibraryFile)
      : await this.lib.open(f);
  }

  private async readCatalogSource(f: LibraryFile): Promise<string> {
    return isGitHubFileRef(f.handle)
      ? githubLibrary.catalogSource(f as GitHubLibraryFile)
      : (await this.lib.open(f)).text;
  }

  private async readSearchSource(f: LibraryFile, maxChars: number): Promise<string> {
    return isGitHubFileRef(f.handle)
      // GitHub documents are already bounded by the library API's document
      // contract; retain its SHA cache and truncate before indexing.
      ? (await githubLibrary.catalogSource(f as GitHubLibraryFile)).slice(0, maxChars)
      : this.lib.readPrefix(f, maxChars);
  }

  private async openFile(f: LibraryFile): Promise<boolean> {
    const path = entryPath(f);
    const providerIdentity = this.currentProviderIdentity();
    if (this.isActivePath(path)) return true;
    const generation = this.providerGeneration;
    const isCurrent = () => providerIdentity === this.currentProviderIdentity()
      && generation === this.providerGeneration;
    const inFlight = this.openingPaths.get(path);
    if (inFlight?.providerIdentity === providerIdentity && inFlight.generation === generation) {
      return inFlight.promise;
    }
    let promise!: Promise<boolean>;
    promise = (async () => {
      try {
        const activatedExisting = this.handlers.onActivateExisting
          ? await this.handlers.onActivateExisting(f, { isCurrent })
          : false;
        if (activatedExisting) {
          if (!isCurrent()) return false;
          this.activePath = path;
          this.activeProviderIdentity = providerIdentity;
          this.activity.activePath = path;
          this.syncActiveStyles(true);
          this.revealActiveRow();
          if (typeof matchMedia === "function" && matchMedia("(max-width: 799px)").matches) {
            this.setVisible(false, { restoreLauncherFocus: false });
          }
          return true;
        }
        const opened = await this.readFile(f);
        if (!isCurrent()) return false;
        await this.handlers.onOpen(opened, { isCurrent });
        if (!isCurrent()) return false;
        this.activePath = path;
        this.activeProviderIdentity = providerIdentity;
        this.activity.activePath = path;
        this.syncActiveStyles(true);
        this.revealActiveRow();
        if (typeof matchMedia === "function" && matchMedia("(max-width: 799px)").matches) {
          // Navigation transfers focus into the editor; it must not bounce back
          // to the Library launcher when the narrow drawer closes.
          this.setVisible(false, { restoreLauncherFocus: false });
        }
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        const reason = error instanceof Error ? error.message : "unknown provider error";
        this.showActionNotice(`Could not open ${path}: ${reason}`);
        return false;
      } finally {
        if (this.openingPaths.get(path)?.promise === promise) {
          this.openingPaths.delete(path);
        }
        this.renderList();
      }
    })();
    this.openingPaths.set(path, { providerIdentity, generation, promise });
    this.renderList();
    return promise;
  }

  private async newDoc() {
    // In-DOM prompt — window.prompt() always returns null in the desktop
    // WebView, which made document creation impossible there.
    const name = await promptDialog(
      `New document path (use ${OTHER_NOTES_FOLDER}/ for notes outside a project):`,
      "untitled.md",
    );
    if (!name) return;
    await this.createDoc(name.trim());
  }

  private async newOtherNote() {
    const name = await promptDialog("New note name (subfolders are allowed):", "untitled.md");
    if (!name) return;
    await this.createDoc(otherNotePath(name));
  }

  private async createDoc(path: string) {
    if (this.pendingActions.has("create")) return;
    const clean = normaliseDocumentPath(path);
    if (!clean) {
      this.showActionNotice("Enter a valid note path using forward slashes; hidden folders and parent paths are not allowed.");
      return;
    }
    let opened: OpenedFile | null;
    this.pendingActions.add("create");
    this.setLoadState(this.loadState);
    try {
      opened = this.source === "github" && !this.mock
        ? await githubLibrary.create(clean)
        : await this.lib.create(clean);
      if (!opened) return;
      await this.handlers.onOpen(opened);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown provider error";
      this.showActionNotice(`Could not create ${clean}: ${reason}`);
      return;
    } finally {
      this.pendingActions.delete("create");
      this.setLoadState(this.loadState);
    }
    await this.refresh("create");
    // Carry the requested relative path through local and native creation so a
    // same-named file elsewhere in the library cannot receive the active mark.
    this.setActive(clean, opened.handle);
  }

  private showActionNotice(message: string) {
    this.el.querySelector(".lib-action-notice")?.remove();
    const notice = el("div", "lib-empty lib-action-notice", message);
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    if (this.listEl) this.listEl.prepend(notice);
    else this.el.append(notice);
  }
}

// --- helpers --------------------------------------------------------------
function el(tag: string, className: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = className;
  if (text != null) n.textContent = text;
  return n;
}
function textBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
function primaryBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = textBtn(label, onClick);
  b.className = "lib-choose";
  return b;
}
function secondaryBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = textBtn(label, onClick);
  b.className = "lib-secondary";
  return b;
}
type HeaderIcon = "plus" | "note" | "refresh" | "settings" | "local" | "branch" | "more" | "close";

function headerAction(
  icon: HeaderIcon,
  title: string,
  onClick: () => void,
  label?: string,
): HTMLButtonElement {
  const b = textBtn("", onClick);
  b.className = `lib-head-action${label ? " has-label" : ""}`;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.append(libraryIcon(icon));
  if (label) b.append(el("span", "lib-head-action-label", label));
  return b;
}

const ICON_PATHS: Record<HeaderIcon, string[]> = {
  plus: ["M12 5v14", "M5 12h14"],
  note: ["M6 3h8l4 4v14H6z", "M14 3v5h5", "M9 13h6", "M12 10v6"],
  refresh: ["M20 11a8 8 0 0 0-14.9-4", "M4 4v5h5", "M4 13a8 8 0 0 0 14.9 4", "M20 20v-5h-5"],
  settings: ["M4 7h10", "M18 7h2", "M4 17h2", "M10 17h10", "M14 4v6", "M8 14v6"],
  local: ["M4 5h16v14H4z", "M4 14h16", "M8 17h.01"],
  branch: ["M6 3v12", "M18 9a6 6 0 0 1-6 6H6", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  close: ["M6 6l12 12", "M18 6 6 18"],
};

function libraryIcon(icon: HeaderIcon): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICON_PATHS[icon]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function commentIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2.5 3.5h11v7h-6l-3.5 2.5v-2.5H2.5z");
  svg.append(path);
  return svg;
}

const GENERIC_PROJECT_TITLES = new Set([
  "index",
  "overview",
  "project index",
  "project overview",
]);

function isGenericProjectTitle(title: string): boolean {
  return GENERIC_PROJECT_TITLES.has(title.trim().toLocaleLowerCase());
}

function humanizeProjectId(project: string): string {
  return project
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.length <= 3 && part === part.toUpperCase()
      ? part
      : `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ") || project;
}

function humanizeMetaValue(value: string): string {
  return value.trim().replace(/[-_]+/g, " ");
}

function readBooleanPreference(key: string): boolean | null {
  const value = localStorage.getItem(key);
  return value === "true" ? true : value === "false" ? false : null;
}

function readProjectModePreferences(key: string): Map<string, ProjectLibraryMode> {
  const parsed = readPreferenceRecord(key);
  const entries: Array<[string, ProjectLibraryMode]> = [];
  for (const [entry, value] of Object.entries(parsed)) {
    if (value === "attention") entries.push([entry, "attention"]);
    else if (value === "focus" || value === "browse") entries.push([entry, "browse"]);
  }
  return new Map(entries);
}

function readBooleanPreferenceMap(key: string): Map<string, boolean> {
  const parsed = readPreferenceRecord(key);
  return new Map(Object.entries(parsed).flatMap(([entry, value]) =>
    typeof value === "boolean" ? [[entry, value]] : []
  ));
}

function readPreferenceRecord(key: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function writePreferenceMap<T>(key: string, values: Map<string, T>): void {
  localStorage.setItem(key, JSON.stringify(Object.fromEntries(values)));
}

function isPhoneLibrary(): boolean {
  return typeof matchMedia === "function" && matchMedia("(max-width: 599px)").matches;
}

function indexSignature(entries: LibraryFile[]): string {
  const material = [...entries]
    .sort((a, b) => entryPath(a).localeCompare(entryPath(b)))
    .map((entry) => JSON.stringify({
      path: entryPath(entry),
      meta: entry.meta,
      comments: entry.openCommentCount,
      sha: isGitHubFileRef(entry.handle) ? entry.handle.sha : null,
    }))
    .join("\n");
  return shortHash(material);
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function duplicateDocumentTitles(entries: LibraryFile[]): Set<string> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const title = docTitle(entry.meta, entry.name).toLocaleLowerCase();
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([title]) => title));
}

function deduplicateEntries(entries: LibraryFile[]): LibraryFile[] {
  const unique = new Map<string, LibraryFile>();
  for (const entry of entries) unique.set(entryPath(entry), entry);
  return [...unique.values()];
}

function abbreviatePath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  return `${parts[0]}/…/${parts.slice(-2).join("/")}`;
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/[\\"]/g, "\\$&");
}
