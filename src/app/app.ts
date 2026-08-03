import type { EditorView } from "prosemirror-view";
import type { EditorState } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import { createEditor, type EditorHandle } from "../editor/create-editor";
import { parseMarkdown } from "../markdown/parse";
import { serializeMarkdown } from "../markdown/serialize";
import {
  commentActivityDigest,
  parseFrontmatter,
  serializeFrontmatter,
  toKatexMacros,
  countUnresolvedComments,
  type Frontmatter,
  type DocMeta,
  type PublicationSettings,
} from "../markdown/frontmatter";
import { newDocId } from "./doc-meta";
import { confirmDialog } from "./dialogs";
import { exportLatex } from "../tex/export-latex";
import { perf, timed } from "../perf/instrument";
import { CommentsMargin } from "./comments-margin";
import { SelectionPopover } from "./selection-popover";
import { newFileState, type FileState } from "./file-state";
import {
  openMarkdown,
  saveMarkdown,
  saveMarkdownAs,
  downloadText,
  displayPathAfterSave,
  isGitHubFileRef,
  isNativeFileRef,
  isRemoteConflict,
  reconnectNativeFile,
  sameFileRef,
  type FileRef,
  type GitHubFileRef,
  type NativeFileRef,
  type RemoteConflictResult,
  type FileHandle,
  type SaveResult,
} from "./file-adapter";
import {
  LEGACY_SESSION_KEY,
  PERSISTED_SESSION_KEY,
  PersistenceError,
  deleteRecoveryRevision,
  exportRecoveryBundle,
  listRecoveryRevisions,
  persistenceStore,
  recoveryKey,
  type RecoveryRevision,
} from "./persistence-store";
import {
  SaveCoordinator,
  type SaveState,
  type SaveRetryMetadata,
  type SaveOperationResult,
} from "./save-coordinator";
import { reconcileNativeRecovery } from "./native-recovery";
import { installBrowserRecoveryLifecycle } from "./recovery-lifecycle";
import { computeNumbering, type NumberingConfig } from "../editor/numbering";
import type { ResultReference } from "../editor/result-references";

const EDITMODE_KEY = "mdlyx:editmode";
const SERIALIZE_DEBOUNCE = 500;
const AUTOSAVE_DEBOUNCE = 2500;
const SESSION_DEBOUNCE = 1000;

function loadEditMode(): "elements" | "mathlive" {
  try {
    return localStorage.getItem(EDITMODE_KEY) === "mathlive" ? "mathlive" : "elements";
  } catch {
    return "elements";
  }
}

interface Debounced<T extends unknown[]> {
  (...a: T): void;
  cancel(): void;
}

function debounce<T extends unknown[]>(fn: (...a: T) => void, ms: number): Debounced<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const wrapped = ((...a: T) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = undefined;
      fn(...a);
    }, ms);
  }) as Debounced<T>;
  wrapped.cancel = () => {
    if (t) clearTimeout(t);
    t = undefined;
  };
  return wrapped;
}

// One open document. The single EditorView holds the ACTIVE tab's live state;
// every other (parked) tab keeps its full ProseMirror state in `state` so its
// undo history, comments, and selection survive a switch. A not-yet-materialized
// tab (restored from the session but not yet viewed) keeps only `pendingBody` and
// is parsed on first activation.
interface Tab {
  id: string;
  file: FileState;
  frontmatter: Frontmatter;
  state: EditorState | null; // parked snapshot; null while active / not materialized
  materialized: boolean;
  pendingBody: string;
  scrollTop: number;
  // Bumped on every doc/comment change; an async save captures it and only clears
  // `dirty` if nothing changed meanwhile (per-tab so a switch mid-save is safe).
  rev: number;
  // One coordinator serializes every local/native/GitHub write and invalidates
  // queued work when the tab's persistence identity changes.
  save: SaveCoordinator;
  /** Highest document revision already represented by a queued provider write. */
  lastEnqueuedRev: number;
  saveAsInProgress: boolean;
  /**
   * Stable native identity retained even while its process-local grant is
   * unavailable. It is safe to persist and lets a later launch reconnect
   * without ever trying to reuse the expired grant.
   */
  reconnectableNative: NativeFileRef | null;
  /** Exact last-known disk source used to prevent restart-time overwrites. */
  nativeBaseText: string | null;
  /** Disk and recovery diverged; Save As is required before writing. */
  nativeConflict: boolean;
  /** Provider-relative display identity used by the compact tab tooltip. */
  displayPath: string;
}

/** What the tab-strip UI needs to render each tab. */
export interface TabView {
  id: string;
  name: string;
  /** Provider-relative identity when available; the compact strip still shows the basename. */
  path?: string;
  dirty: boolean;
  active: boolean;
}

export interface DocumentActivitySnapshot {
  path: string;
  name: string;
  saveState: SaveState;
  dirty: boolean;
  lastSavedAt: number | null;
  provider: "github" | "local" | "memory";
}

export interface RemoteDocumentAccess {
  authorized: boolean;
  canEditContent: boolean;
  canEditComments: boolean;
  canManageAllComments: boolean;
  sharedAccess?: boolean;
}

export interface PersistedSessionTab {
  name: string;
  path?: string;
  text: string;
  dirty: boolean;
  remote?: Pick<GitHubFileRef, "path" | "sha">;
  localHandle?: FileHandle;
  native?: NativeFileRef;
  nativeBaseText?: string;
  save?: SaveRetryMetadata;
}
export interface PersistedSessionV2 {
  version: 2;
  revision: number;
  tabs: PersistedSessionTab[];
  activeIndex: number;
}

interface LegacySessionData {
  tabs: PersistedSessionTab[];
  activeIndex: number;
}

let tabIdSeq = 0;
const newTabId = () => `tab${++tabIdSeq}`;

function tabDisplayPath(name: string, handle: FileRef, supplied?: string): string {
  const explicit = supplied?.trim();
  if (explicit) return explicit;
  return isGitHubFileRef(handle) ? handle.path : name;
}

export function initApp(host: HTMLElement, dom: {
  status: HTMLElement;
  workspace: HTMLElement;
  authorName: string;
  buttons: Record<
    "new" | "open" | "save" | "saveAs" | "exportTex" | "comments",
    HTMLButtonElement
  >;
}) {
  const tabs: Tab[] = [];
  // A valid active tab exists from construction, so any callback that reads the
  // active document (editor getMacros, inspector getMeta) never sees null. start()
  // either restores a saved session (replacing this) or loads the default into it.
  let active: Tab;
  let loading = false;
  let onLoad: ((name: string, handle: FileRef, displayPath: string) => void) | null = null;
  let onMeta: ((meta: DocMeta) => void) | null = null;
  let onTabs: ((tabs: TabView[]) => void) | null = null;
  let onActivity: ((snapshot: DocumentActivitySnapshot) => void) | null = null;
  let onPersisted: ((
    documentId: string | undefined,
    unresolvedCommentCount: number,
    meta: DocMeta,
    handle: FileRef,
    commentDigest?: string,
    origin?: "save" | "remote",
  ) => void) | null = null;
  let onDocumentLinkOpen: ((
    id: string,
    anchor?: string,
  ) => boolean | Promise<boolean>) | null = null;
  let onResultLinkOpen: ((resultId: string) => boolean | Promise<boolean>) | null = null;
  let onMarkdownLinkOpen: ((href: string, sourcePath: string) => boolean | Promise<boolean>) | null = null;
  let onLibraryAssetRead: ((path: string) => Promise<{ bytes: Uint8Array; mimeType: string } | null>) | null = null;
  let publicationResolver: (() => Promise<PublicationSettings>) | null = null;
  let persistenceWarning: string | null = null;
  let persistedSessionRevision = 0;
  let sessionPersistenceQueue: Promise<void> = Promise.resolve();
  // Clearing recovery data is followed by a reload. Disable every lifecycle
  // writer first so pagehide cannot recreate the session that was just erased.
  // Startup begins with a placeholder tab while IndexedDB is read. Lifecycle
  // events during that window must leave the last good snapshot untouched.
  let lifecyclePersistenceEnabled = false;
  // Which editor a click/arrow opens. Double-click always opens MathLive. Persisted.
  let editMode: "elements" | "mathlive" = loadEditMode();
  let remoteAccess: (meta: DocMeta, path?: string) => RemoteDocumentAccess = () => ({
    authorized: true,
    canEditContent: true,
    canEditComments: true,
    canManageAllComments: true,
  });
  let sharedAuthor: { displayName: string; principalId?: string } = { displayName: dom.authorName };

  // Seed the first tab up front (createTab is a hoisted function declaration).
  const initialTab = createTab("", "untitled.md", null);
  tabs.push(initialTab);
  active = initialTab;

  const authorFor = (kind: "user" | "ai") =>
    kind === "ai" ? "AI reviewer" : sharedAuthor.displayName;

  const accessFor = (tab: Tab = active): RemoteDocumentAccess => {
    if (tab.frontmatter.library.projection?.read_only === true) {
      const remote = isGitHubFileRef(tab.file.handle)
        ? remoteAccess(tab.frontmatter.library, tab.file.handle.path)
        : null;
      return {
        authorized: remote?.authorized ?? true,
        canEditContent: false,
        canEditComments: false,
        canManageAllComments: false,
        ...(remote?.sharedAccess ? { sharedAccess: true } : {}),
      };
    }
    return isGitHubFileRef(tab.file.handle)
      ? remoteAccess(tab.frontmatter.library, tab.file.handle.path)
      : { authorized: true, canEditContent: true, canEditComments: true, canManageAllComments: true };
  };
  const isReadOnly = (tab: Tab = active) => !accessFor(tab).canEditContent;
  const canComment = (tab: Tab = active) => accessFor(tab).canEditComments;

  function pulseHighlight(id: string) {
    const span = host.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(id)}"]`);
    if (!span) return;
    span.classList.remove("comment-flash");
    void span.offsetWidth;
    span.classList.add("comment-flash");
  }

  const commentsMargin = new CommentsMargin(host, {
    onFocus: (id) => {
      editor.selectComment(id);
      pulseHighlight(id);
      const anchor = host.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(id)}"]`);
      if (anchor) {
        const reduced = typeof matchMedia === "function"
          && matchMedia("(prefers-reduced-motion: reduce)").matches;
        anchor.scrollIntoView({
          block: "center",
          inline: "nearest",
          behavior: reduced ? "auto" : "smooth",
        });
      }
    },
    onResolve: (id, resolved) => { if (canComment()) editor.resolveComment(id, resolved); },
    onRemove: (id) => { if (canComment()) editor.removeComment(id); },
    onReply: (id, body, kind) => {
      if (canComment()) editor.addReply(id, {
        kind,
        author: authorFor(kind),
        ...(kind === "user" && sharedAuthor.principalId ? { principalId: sharedAuthor.principalId } : {}),
        body,
      });
    },
    onSetPriority: (id, priority) => { if (canComment()) editor.setPriority(id, priority); },
    onSetStatus: (id, status) => { if (canComment()) editor.setStatus(id, status); },
    onSetColor: (id, color) => { if (canComment()) editor.setColor(id, color); },
    onSetBody: (id, body) => { if (canComment()) editor.setBody(id, body); },
    onVisibilityChange: (visible) => setCommentsButton(visible),
  });

  const selectionPopover = new SelectionPopover(({ kind, body, color }) => {
    if (!canComment()) return;
    const id = editor.addComment({
      kind,
      author: authorFor(kind),
      ...(kind === "user" && sharedAuthor.principalId ? { principalId: sharedAuthor.principalId } : {}),
      body,
      color,
    });
    if (id) {
      commentsMargin.setVisible(true);
      setCommentsButton(true);
      const v = editor.view;
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, v.state.selection.to)));
      requestAnimationFrame(() => {
        if (body.trim()) commentsMargin.focus(id);
        else pulseHighlight(id);
      });
    }
  });
  document.body.appendChild(selectionPopover.dom);

  const editor: EditorHandle = createEditor(host, {
    getMacros: () => toKatexMacros(active.frontmatter),
    getConfig: () => active.frontmatter.numbering,
    getEditMode: () => editMode,
    // Loads may import stored comments before the read-only editor props are
    // refreshed; outside that guarded load window projections are immutable.
    getEditable: () => loading || !isReadOnly(),
    getCommentEditable: () => loading || canComment(),
    commentsOnChange: (comments) => commentsMargin.render(comments),
    onSelectionChange: (view) => selectionPopover.update(view),
    onCommentClick: (id) => {
      if (!commentsMargin.isVisible) {
        commentsMargin.setVisible(true);
        setCommentsButton(true);
      }
      commentsMargin.focus(id);
    },
    onDocumentLinkOpen: (id, anchor) => {
      void openDocumentLink(id, anchor);
    },
    onReferenceOpen: (id) => {
      openReference(id);
    },
    onResultLinkOpen: (id) => {
      void openResultLink(id);
    },
    onMarkdownLinkOpen: (href) => {
      void openMarkdownLink(href);
    },
    readFigureAsset: async (path) => onLibraryAssetRead?.(path) ?? null,
    onChange: (view) => {
      commentsMargin.reposition();
      if (loading || (!accessFor().canEditContent && !accessFor().canEditComments)) return;
      active.rev++;
      active.file.dirty = true;
      active.save.markDirty(active.rev);
      updateStatus();
      notifyTabs();
      scheduleSerialize(view);
      scheduleAutosave();
      scheduleSession();
    },
  });

  commentsMargin.setAnchorResolver((id) => editor.commentAnchorTop(id));
  window.addEventListener("resize", () => commentsMargin.reposition());

  // --- serialization ------------------------------------------------------
  function serializeActive(commit = true): string {
    if (commit) editor.commitActiveMath();
    active.frontmatter.comments = editor.exportComments();
    perf.countSerialize();
    return timed(
      "serialize",
      () =>
        serializeFrontmatter(active.frontmatter) +
        serializeMarkdown(editor.view.state.doc),
    );
  }

  const scheduleSerialize = debounce((_view: EditorView) => {
    active.file.markdown = serializeActive(false);
  }, SERIALIZE_DEBOUNCE);

  function enqueueSave(
    tab: Tab,
    text: string,
    atRev: number,
    origin: "autosave" | "manual",
    operation?: () => Promise<SaveOperationResult<SaveResult | RemoteConflictResult>>,
  ): Promise<void> {
    // Closing owns a quiesced provider queue. Do not advance lastEnqueuedRev for
    // a write which was deliberately rejected, or Cancel could suppress the
    // autosave that must be re-armed afterward.
    if (tab.save.isQuiesced) return Promise.resolve();
    const write: () => Promise<SaveOperationResult<SaveResult | RemoteConflictResult>> = operation ?? (async () => {
      const result = await saveMarkdown(text, tab.file.handle, tab.file.name);
      if (!result) return { kind: "cancelled" } as const;
      return isRemoteConflict(result)
        ? { kind: "conflict", value: result } as const
        : { kind: "saved", value: result } as const;
    });
    tab.lastEnqueuedRev = Math.max(tab.lastEnqueuedRev, atRev);
    return tab.save.enqueue(atRev, write).then((attempt) => {
      if (attempt.kind === "cancelled") return;
      if (attempt.kind === "conflict") {
        resolveRemoteConflict(tab, text, attempt.value as RemoteConflictResult, atRev);
        return;
      }
      if (attempt.kind === "saved") {
        const result = attempt.value;
        markSaved(tab, result.name, result.handle, atRev, text);
        return;
      }
      const label = origin === "autosave" ? "autosave" : "save";
      console.warn(`[${label}] file write failed; keeping local session`, attempt.error);
      markSaveFailed(tab, atRev);
      if (
        origin === "autosave" &&
        tab.rev === atRev &&
        attempt.error instanceof DOMException &&
        attempt.error.name === "NotAllowedError"
      ) {
        tab.file.handle = null;
        tab.save.cancel("dirty");
        if (tab === active) {
          setCompactStatus(
            "Changes pending",
            tab,
            "Browser file permission was lost; recovery is local until Save writes to disk",
            true,
          );
        }
      }
    });
  }

  // --- autosave (disk, when a handle is held) -----------------------------
  const scheduleAutosave = debounce(async () => {
    const tab = active;
    if (!tab.file.dirty || tab.nativeConflict) return;
    const atRev = tab.rev;
    const text = serializeActive(false);
    tab.file.markdown = text;
    void persistSession();
    if (tab.file.handle && !tab.saveAsInProgress) {
      // A lifecycle flush can already have queued this exact revision without
      // cancelling the ordinary debounce. Do not create a duplicate provider
      // commit while that write is still queued or in flight. A failed attempt
      // is no longer busy, so this timer remains a bounded retry opportunity.
      const saveBusy = tab.save.state === "queued" || tab.save.state === "saving";
      if (!saveBusy || tab.lastEnqueuedRev < atRev) {
        await enqueueSave(tab, text, atRev, "autosave");
      }
    }
  }, AUTOSAVE_DEBOUNCE);

  // --- session persistence (all open tabs, restored on relaunch) ----------
  function persistableLocalHandle(handle: FileRef): FileHandle | undefined {
    return handle && typeof handle === "object" && !isGitHubFileRef(handle) && handle.kind === "file"
      ? handle
      : undefined;
  }

  function persistedSessionSnapshot(): PersistedSessionV2 {
    return {
      version: 2,
      revision: ++persistedSessionRevision,
      tabs: tabs.map((t) => ({
        name: t.file.name,
        path: t.displayPath,
        text: t === active ? serializeActive(false) : t.file.markdown,
        dirty: t.file.dirty,
        remote: isGitHubFileRef(t.file.handle)
          ? { path: t.file.handle.path, sha: t.file.handle.sha }
          : undefined,
        native: isNativeFileRef(t.file.handle)
          ? t.file.handle
          : t.reconnectableNative ?? undefined,
        nativeBaseText: t.reconnectableNative && t.file.dirty
          ? t.nativeBaseText ?? undefined
          : undefined,
        localHandle: persistableLocalHandle(t.file.handle),
        save: t.save.snapshot(),
      })),
      activeIndex: Math.max(0, tabs.indexOf(active)),
    };
  }

  function persistenceFailed(error: unknown): void {
    const kind = error instanceof PersistenceError ? error.kind : "unknown";
    persistenceWarning = kind === "quota"
      ? "local recovery storage is full — export a recovery bundle"
      : "local recovery storage is unavailable";
    updateStatus();
  }

  function persistSession(required = false): Promise<void> {
    if (!lifecyclePersistenceEnabled) return Promise.resolve();
    // Snapshot synchronously, then serialize writes so an older, slower
    // transaction can never overwrite the recovery revision awaited below.
    const data = persistedSessionSnapshot();
    const operation = sessionPersistenceQueue.then(() =>
      persistenceStore.set(PERSISTED_SESSION_KEY, data));
    sessionPersistenceQueue = operation.catch(() => undefined);
    return operation.then(
      () => {
        persistenceWarning = null;
      },
      (error) => {
        persistenceFailed(error);
        if (required) throw error;
      },
    );
  }
  const scheduleSession = debounce(() => void persistSession(), SESSION_DEBOUNCE);

  function captureFinalRecoveryState(): void {
    if (!lifecyclePersistenceEnabled) return;
    // Relaunch/close is a terminal boundary: commit the live math editor and
    // cancel background work before awaiting the final IndexedDB snapshot.
    // Ordinary visibility/pagehide recovery deliberately does neither.
    editor.commitActiveMath();
    scheduleSerialize.cancel();
    scheduleAutosave.cancel();
    scheduleSession.cancel();
    active.file.markdown = serializeActive(false);
  }

  async function prepareForRelaunch(): Promise<void> {
    captureFinalRecoveryState();
    await persistSession(true);
  }

  const flushRecoveryBestEffort = () => {
    if (!lifecyclePersistenceEnabled) return;
    // Backgrounding is not a terminal shutdown. Snapshot the latest committed
    // editor state without closing an active equation or cancelling any pending
    // serialize/session/provider debounce. Start both durable recovery and the
    // provider write now because a later pagehide may end the process abruptly.
    const tab = active;
    editor.checkpointActiveMath();
    const atRev = tab.rev;
    const text = serializeActive(false);
    tab.file.markdown = text;
    void persistSession();
    const saveBusy = tab.save.state === "queued" || tab.save.state === "saving";
    if (tab.file.dirty && tab.file.handle && !tab.saveAsInProgress &&
        !tab.nativeConflict && (!saveBusy || tab.lastEnqueuedRev < atRev)) {
      void enqueueSave(tab, text, atRev, "autosave");
    }
  };
  // Browser lifecycle events cannot be awaited, but starting the IndexedDB
  // provider request here closes the debounce gap when a tab is backgrounded or
  // discarded. Tauri's final close still uses the awaited terminal path above.
  installBrowserRecoveryLifecycle({
    flush: flushRecoveryBestEffort,
    resume: () => {
      if (!lifecyclePersistenceEnabled || !active.file.dirty || !active.file.handle ||
          active.saveAsInProgress || active.nativeConflict) return;
      const saveBusy = active.save.state === "queued" || active.save.state === "saving";
      if (!saveBusy) scheduleAutosave();
    },
  });

  // --- tab lifecycle ------------------------------------------------------
  function createTab(text: string, name: string, handle: FileRef, path?: string): Tab {
    const parsed = parseFrontmatter(text);
    const file = newFileState();
    file.name = name;
    file.handle = handle;
    file.markdown = text;
    file.dirty = false;
    file.lastSavedAt = handle ? Date.now() : null;
    let tab!: Tab;
    const save = new SaveCoordinator((state) => {
      file.saveState = state;
      if (tab && tabs.includes(tab)) {
        if (tab === active) updateStatus();
        notifyTabs();
      }
    });
    tab = {
      id: newTabId(),
      file,
      frontmatter: parsed.frontmatter,
      state: null,
      materialized: false,
      pendingBody: parsed.body,
      scrollTop: 0,
      rev: 0,
      save,
      lastEnqueuedRev: 0,
      saveAsInProgress: false,
      reconnectableNative: isNativeFileRef(handle) ? handle : null,
      nativeBaseText: isNativeFileRef(handle) ? text : null,
      nativeConflict: false,
      displayPath: tabDisplayPath(name, handle, path),
    };
    return tab;
  }

  // Park the active tab: flush its snapshot + text so a later switch/save/restore
  // reads current content, and cancel its background timers. Skipped when the
  // active tab has already been removed (closing it — nothing to preserve).
  function parkActive() {
    if (!active || !tabs.includes(active)) return;
    scheduleSerialize.cancel();
    scheduleAutosave.cancel();
    active.file.markdown = serializeActive(false);
    active.state = editor.captureState();
    active.scrollTop = host.scrollTop;
    active.materialized = true;
    // Switching tabs cancels the global debounce, so persist the outgoing
    // provider-backed revision now rather than stranding it indefinitely.
    const saveBusy = active.save.state === "queued" || active.save.state === "saving";
    if (active.file.dirty && active.file.handle && !active.saveAsInProgress &&
        !active.nativeConflict && (!saveBusy || active.lastEnqueuedRev < active.rev)) {
      void enqueueSave(active, active.file.markdown, active.rev, "autosave");
    }
  }

  // Make `tab` the active document in the single EditorView.
  function activate(tab: Tab) {
    if (tab === active && tab.materialized) return;
    parkActive();
    active = tab;
    loading = true;
    if (!tab.materialized) {
      editor.setDoc(parseMarkdown(tab.pendingBody));
      editor.importComments(tab.frontmatter.comments);
      tab.pendingBody = "";
      tab.materialized = true;
    } else if (tab.state) {
      editor.restoreState(tab.state);
      tab.state = null;
    }
    loading = false;
    refreshForActive();
    requestAnimationFrame(() => {
      host.scrollTop = tab.scrollTop;
    });
  }

  // Replace the ACTIVE tab's document in place (file New default, __load, Restore).
  function loadIntoActive(text: string, name: string, handle: FileRef, path?: string) {
    scheduleSerialize.cancel();
    scheduleAutosave.cancel();
    active.save.cancel("saved");
    const parsed = parseFrontmatter(text);
    active.frontmatter = parsed.frontmatter;
    active.rev++;
    loading = true;
    perf.countParse();
    editor.setDoc(timed("parse", () => parseMarkdown(parsed.body)));
    editor.importComments(parsed.frontmatter.comments);
    loading = false;
    active.file.name = name;
    active.file.handle = handle;
    active.reconnectableNative = isNativeFileRef(handle) ? handle : null;
    active.nativeBaseText = isNativeFileRef(handle) ? text : null;
    active.nativeConflict = false;
    active.displayPath = tabDisplayPath(name, handle, path);
    active.file.markdown = text;
    active.file.dirty = false;
    active.file.lastSavedAt = handle ? Date.now() : null;
    active.file.saveState = "saved";
    active.materialized = true;
    active.pendingBody = "";
    active.scrollTop = 0;
    refreshForActive();
    void persistSession();
  }

  // Shared tail: sync numbering, comment margin, chrome, and listeners to the
  // now-active document.
  function refreshForActive() {
    editor.refreshEditable();
    commentsMargin.setAccess({
      canComment: canComment(),
      canManageAll: accessFor().canManageAllComments,
      principalId: sharedAuthor.principalId,
    });
    selectionPopover.setReadOnly(!canComment());
    editor.refreshNumbering();
    commentsMargin.render(editor.listComments());
    const hasComments = editor.listComments().length > 0;
    commentsMargin.setVisible(hasComments);
    setCommentsButton(hasComments);
    dom.buttons.save.disabled = !accessFor().canEditContent && !accessFor().canEditComments;
    dom.buttons.saveAs.disabled = isReadOnly();
    dom.buttons.comments.disabled = !canComment() && !hasComments;
    const readOnlyTitle = active.frontmatter.library.projection?.read_only
      ? "Generated from results.yaml and dependency-graph.json; edit through a reviewed GitHub pull request"
      : "This shared document is read-only";
    dom.buttons.save.title = !accessFor().canEditContent && accessFor().canEditComments
      ? "Save comments"
      : isReadOnly() ? readOnlyTitle : "Save";
    dom.buttons.saveAs.title = isReadOnly() ? readOnlyTitle : "Save As";
    updateStatus();
    notifyTabs();
    editor.view.focus();
    onLoad?.(active.file.name, active.file.handle, active.displayPath);
    onMeta?.(active.frontmatter.library);
    const saveBusy = active.save.state === "queued" || active.save.state === "saving";
    if (active.file.dirty && active.file.handle && !active.nativeConflict &&
        (!saveBusy || active.lastEnqueuedRev < active.rev)) {
      scheduleAutosave();
    }
  }

  // Open a document in a tab, focusing an already-open one instead of duplicating.
  async function openInTab(
    text: string,
    name: string,
    handle: FileRef,
    path?: string,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    if (!isCurrent()) return;
    let existing: Tab | undefined;
    for (const tab of tabs) {
      const matches = await sameDoc(tab, name, handle);
      // File-handle identity checks can yield to the browser/native bridge.
      // A provider switch during that await invalidates this open before it
      // can activate or create a tab carrying the previous provider's handle.
      if (!isCurrent()) return;
      if (matches) {
        existing = tab;
        break;
      }
    }
    if (!isCurrent()) return;
    if (existing) {
      if (isNativeFileRef(handle) && existing.reconnectableNative) {
        const recoveryText = existing === active
          ? serializeActive(false)
          : existing.file.markdown;
        const decision = reconcileNativeRecovery(
          recoveryText,
          existing.file.dirty,
          existing.nativeBaseText ?? undefined,
          text,
        );
        const liveHandle = decision.attachGrant ? handle : null;
        if (existing === active) {
          loadIntoActive(decision.text, name, liveHandle, path);
        } else {
          const parsed = parseFrontmatter(decision.text);
          existing.frontmatter = parsed.frontmatter;
          existing.file.name = name;
          existing.file.handle = liveHandle;
          existing.file.markdown = decision.text;
          existing.file.lastSavedAt = decision.dirty ? null : Date.now();
          existing.file.saveState = decision.dirty ? "dirty" : "saved";
          existing.state = null;
          existing.materialized = false;
          existing.pendingBody = parsed.body;
          existing.scrollTop = 0;
          existing.save.cancel(decision.dirty ? "dirty" : "saved");
        }
        existing.reconnectableNative = handle;
        existing.nativeBaseText = decision.baseText ?? null;
        existing.nativeConflict = decision.conflict;
        existing.displayPath = tabDisplayPath(name, handle, path);
        existing.file.dirty = decision.dirty;
        if (decision.dirty) {
          existing.rev = Math.max(existing.rev + 1, existing.save.snapshot().latestRevision + 1);
          existing.save.markDirty(existing.rev);
        }
        activate(existing);
        updateStatus();
        notifyTabs();
        void persistSession();
        if (decision.dirty && decision.attachGrant) scheduleAutosave();
        return;
      }
      activate(existing);
      return;
    }
    const tab = createTab(text, name, handle, path);
    tabs.push(tab);
    activate(tab);
    void persistSession();
  }

  async function activateExisting(
    name: string,
    handle: FileRef,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    for (const tab of tabs) {
      if (!isCurrent()) return false;
      const matches = await sameDoc(tab, name, handle);
      if (!isCurrent()) return false;
      if (matches) {
        activate(tab);
        return true;
      }
    }
    return false;
  }

  async function sameDoc(t: Tab, name: string, handle: FileRef): Promise<boolean> {
    if (handle && t.file.handle && await sameFileRef(handle, t.file.handle)) return true;
    if (handle && !t.file.handle && t.reconnectableNative &&
        await sameFileRef(handle, t.reconnectableNative)) return true;
    // Fall back to name identity for handle-less (restored / in-memory) docs.
    return !handle && !t.file.handle && t.file.name === name;
  }

  function newTab() {
    const tab = createTab("", "untitled.md", null);
    tabs.push(tab);
    activate(tab);
    void persistSession();
  }

  // Tabs already closing — a second close request (double click, ⌘W repeat)
  // must not stack a duplicate dialog or start another provider barrier.
  const closingTabs = new Set<string>();

  async function closeTab(id: string, confirmedDirtyRevision?: number) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (closingTabs.has(id)) return;
    closingTabs.add(id);
    const pausedAutosave = tab === active;
    let removed = false;
    if (pausedAutosave) scheduleAutosave.cancel();
    const closeLease = tab.save.quiesce();
    try {
      // Freeze first, then await the one provider operation which may already
      // have started. Queued work is cancelled by the coordinator. Only after
      // the provider is idle is it safe to ask whether remaining edits should
      // be discarded.
      await closeLease.idle;
      // Save As / Pull / replacement cancels the old persistence generation.
      // An invalidated close request must not show a stale Discard dialog or
      // remove the newly established identity and queue.
      if (!tabs.includes(tab) || !closeLease.owns()) return;

      // Re-evaluate after settlement: a successful latest-revision write may
      // have made the tab clean, while typing during an older write keeps it
      // dirty and requires the in-DOM confirmation.
      // An aggregate bulk-close confirmation covers only the exact dirty
      // revision which was visible when that dialog opened. A clean tab can
      // become dirty while earlier tabs drain, and a previously dirty tab can
      // receive a newer edit. Neither edit may inherit the stale approval.
      if (tab.file.dirty && confirmedDirtyRevision !== tab.rev) {
        const ok = await confirmDialog(`Discard unsaved changes in ${tab.file.name}?`, {
          confirmLabel: "Discard",
          danger: true,
        });
        if (!ok) return;
        if (!closeLease.owns()) return;
      }

      // Re-resolve after the awaits — the tab may have been moved meanwhile.
      const idx = tabs.indexOf(tab);
      if (idx < 0) return;
      tab.save.cancel("saved");
      const wasActive = tab === active;
      if (wasActive) {
        // parkActive() will early-return once the tab is spliced out, so its
        // pending debounces must be cancelled HERE — a still-armed autosave would
        // otherwise fire later against whichever tab becomes active.
        scheduleSerialize.cancel();
        scheduleAutosave.cancel();
        scheduleSession.cancel();
      }
      tabs.splice(idx, 1); // remove first so parkActive() won't preserve it
      removed = true;
      if (tabs.length === 0) {
        const fresh = createTab("", "untitled.md", null);
        tabs.push(fresh);
        activate(fresh);
      } else if (wasActive) {
        activate(tabs[Math.min(idx, tabs.length - 1)]);
      }
      notifyTabs();
      void persistSession();
    } finally {
      closingTabs.delete(id);
      if (!removed && tabs.includes(tab)) {
        const resumed = closeLease.resume();
        if (resumed && tab.file.dirty) {
          // The drained/cancelled queue must advertise the newest revision as
          // dirty before it is rearmed. Active tabs use the shared debounce;
          // parked tabs have no global timer, so enqueue their stored source
          // directly against the retained provider identity.
          tab.save.markDirty(tab.rev);
          if (tab === active) {
            scheduleAutosave();
          } else if (tab.file.handle && !tab.nativeConflict && !tab.saveAsInProgress) {
            void enqueueSave(tab, tab.file.markdown, tab.rev, "autosave");
          }
        }
      }
    }
  }

  async function closeTabs(ids: string[], confirmDirty = true): Promise<void> {
    const unique = [...new Set(ids)].filter((id) => tabs.some((tab) => tab.id === id));
    if (!unique.length) return;
    const dirtySnapshot = unique
      .map((id) => tabs.find((tab) => tab.id === id))
      .filter((tab): tab is Tab => Boolean(tab?.file.dirty))
      .map((tab) => ({ id: tab.id, revision: tab.rev, name: tab.file.name }));
    const confirmedRevisions = new Map<string, number>();
    if (confirmDirty && dirtySnapshot.length) {
      const names = dirtySnapshot.slice(0, 4).map((tab) => tab.name).join(", ");
      const remainder = dirtySnapshot.length > 4
        ? ` and ${dirtySnapshot.length - 4} more`
        : "";
      const ok = await confirmDialog(
        `Discard unsaved changes in ${dirtySnapshot.length} ${dirtySnapshot.length === 1 ? "tab" : "tabs"}: ${names}${remainder}?`,
        { confirmLabel: "Discard and close", danger: true },
      );
      if (!ok) return;
      for (const snapshot of dirtySnapshot) {
        confirmedRevisions.set(snapshot.id, snapshot.revision);
      }
    }
    // Closing sequentially keeps activation, persistence, and save barriers
    // deterministic while the aggregate dialog prevents confirmation storms.
    // Tabs which were clean (including Close all saved) deliberately receive
    // no token, so a late edit is re-confirmed instead of silently discarded.
    for (const id of unique) await closeTab(id, confirmedRevisions.get(id));
  }

  function reorderTab(id: string, toIndex: number) {
    const from = tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const clamped = Math.max(0, Math.min(toIndex, tabs.length - 1));
    if (from === clamped) return;
    const [tab] = tabs.splice(from, 1);
    tabs.splice(clamped, 0, tab);
    notifyTabs();
    void persistSession();
  }

  function tabViews(): TabView[] {
    return tabs.map((t) => ({
      id: t.id,
      name: t.file.name,
      path: t.displayPath,
      dirty: t.file.dirty,
      active: t === active,
    }));
  }
  function notifyTabs() {
    onTabs?.(tabViews());
  }

  function activitySnapshot(): DocumentActivitySnapshot {
    return {
      path: active.displayPath,
      name: active.file.name,
      saveState: active.file.saveState,
      dirty: active.file.dirty,
      lastSavedAt: active.file.lastSavedAt,
      provider: isGitHubFileRef(active.file.handle)
        ? "github"
        : active.file.handle ? "local" : "memory",
    };
  }

  function notifyActivity(): void {
    onActivity?.(activitySnapshot());
  }

  // --- document metadata (library properties) -----------------------------
  function getMeta(): DocMeta {
    return active.frontmatter.library;
  }

  function updateMeta(patch: Partial<DocMeta>) {
    if (isReadOnly()) return;
    active.frontmatter.library = { ...active.frontmatter.library, ...patch };
    if (!active.frontmatter.library.id) active.frontmatter.library.id = newDocId();
    active.rev++;
    active.file.dirty = true;
    active.save.markDirty(active.rev);
    updateStatus();
    notifyTabs();
    scheduleSerialize(editor.view);
    scheduleAutosave();
    scheduleSession();
    onMeta?.(active.frontmatter.library);
  }

  function getPublication(): PublicationSettings {
    return active.frontmatter.publication;
  }

  function getPublicationOverrides() {
    return active.frontmatter.publicationOverrides;
  }

  function getNumbering() {
    return active.frontmatter.numbering;
  }

  function updateNumbering(patch: Partial<NumberingConfig>) {
    if (isReadOnly()) return;
    active.frontmatter.numbering = { ...active.frontmatter.numbering, ...patch };
    active.rev++;
    active.file.dirty = true;
    active.save.markDirty(active.rev);
    editor.refreshNumbering();
    updateStatus();
    notifyTabs();
    scheduleSerialize(editor.view);
    scheduleAutosave();
    scheduleSession();
  }

  function updatePublication(patch: Partial<PublicationSettings>) {
    if (isReadOnly()) return;
    active.frontmatter.publication = { ...active.frontmatter.publication, ...patch };
    active.frontmatter.publicationOverrides = {
      ...active.frontmatter.publicationOverrides,
      ...patch,
    };
    active.rev++;
    active.file.dirty = true;
    active.save.markDirty(active.rev);
    updateStatus();
    notifyTabs();
    scheduleSerialize(editor.view);
    scheduleAutosave();
    scheduleSession();
  }

  function markSaved(
    tab: Tab,
    name: string,
    handle: FileRef,
    atRev: number | undefined,
    persistedText: string,
  ) {
    // A successful remote write always advances the path/SHA. If more typing
    // landed during the request, keep the tab dirty so the queued/latest save
    // can commit it with this new SHA.
    const previousHandle = tab.file.handle;
    tab.file.name = name;
    tab.file.handle = handle;
    tab.reconnectableNative = isNativeFileRef(handle) ? handle : null;
    if (isNativeFileRef(handle)) {
      tab.nativeBaseText = persistedText;
      tab.nativeConflict = false;
    } else {
      tab.nativeBaseText = null;
      tab.nativeConflict = false;
    }
    tab.displayPath = displayPathAfterSave(tab.displayPath, name, previousHandle, handle);
    const isCurrentRevision = atRev == null || tab.rev === atRev;
    if (isCurrentRevision) {
      tab.file.markdown = persistedText;
      tab.file.dirty = false;
    }
    tab.file.lastSavedAt = Date.now();
    if (tab === active) updateStatus();
    notifyTabs();
    void persistSession();
    // The index must describe what actually reached disk/GitHub, not newer
    // editor metadata that may have changed while the request was in flight.
    const persisted = parseFrontmatter(persistedText).frontmatter;
    onPersisted?.(
      persisted.library.id,
      countUnresolvedComments(persisted.comments),
      persisted.library,
      tab.file.handle,
      commentActivityDigest(persisted.comments),
      "save",
    );
  }

  // A remote write is SHA-guarded. If GitHub reports a newer version, remote
  // content wins by design; keep the local serialized text in browser storage so
  // nothing is silently lost, then replace the affected tab with the remote copy.
  function resolveRemoteConflict(
    tab: Tab,
    attemptedText: string,
    result: RemoteConflictResult,
    atRev?: number,
  ) {
    // A conflict can return while the user is still typing. Remote still wins,
    // but recovery must preserve the newest editor buffer—not merely the older
    // snapshot that happened to be sent with this request.
    const recoveryText = atRev != null && tab.rev !== atRev
      ? tab === active
        ? serializeActive(false)
        : tab.file.markdown
      : attemptedText;
    storeRemoteRecovery(tab, recoveryText);
    replaceWithRemote(tab, result.text, result.name, result.handle);
    if (tab === active) {
      setCompactStatus(
        "Sync failed",
        tab,
        "Remote version restored; the conflicting local draft is preserved in recovery",
        true,
      );
    }
  }

  function markSaveFailed(tab: Tab, atRev?: number) {
    // A failed write is deliberately non-destructive: the serialized document
    // remains in browser storage and dirty for the next autosave or Pull.
    if (atRev != null && tab.rev !== atRev) {
      // The queued snapshot was already stale when its request started. A
      // newer edit set the tab dirty, but the request set `saving` afterward;
      // restore an honest retryable state instead of leaving the UI stuck.
      tab.save.markDirty(tab.rev);
      if (tab === active) updateStatus();
      notifyTabs();
      void persistSession();
      return;
    }
    if (tab === active) updateStatus();
    notifyTabs();
    void persistSession();
  }

  async function openDocumentLink(id: string, anchor?: string) {
    const destination = `${id}${anchor ? `#${anchor}` : ""}`;
    try {
      const opened = await onDocumentLinkOpen?.(id, anchor);
      if (!opened) {
        setCompactStatus(
          "Sync failed",
          active,
          anchor
            ? `Anchor “${anchor}” was not found in document “${id}”`
            : `Document “${id}” was not found in the current library`,
          true,
        );
      }
    } catch (error) {
      console.warn("[document link] could not open target", error);
      setCompactStatus("Sync failed", active, `Could not open document “${destination}”`, true);
    }
  }

  async function openResultLink(id: string) {
    try {
      const opened = await onResultLinkOpen?.(id);
      if (!opened) {
        setCompactStatus(
          "Sync failed",
          active,
          `Result “${id}” is unavailable in the current library`,
          true,
        );
      }
    } catch (error) {
      console.warn("[result link] could not open target", error);
      setCompactStatus("Sync failed", active, `Could not open result “${id}”`, true);
    }
  }

  function openReference(id: string): boolean {
    if (computeNumbering(editor.view.state.doc, getNumbering()).duplicates.has(id)) {
      setCompactStatus(
        "Sync failed",
        active,
        `Reference “${id}” is ambiguous because its label is defined more than once`,
        true,
      );
      return false;
    }
    const target = host.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (!target) {
      setCompactStatus(
        "Sync failed",
        active,
        `Reference “${id}” was not found in the current document`,
        true,
      );
      return false;
    }
    target.scrollIntoView({ block: "center" });
    editor.view.focus();
    updateStatus();
    return true;
  }

  async function openMarkdownLink(href: string) {
    if (href.startsWith("#")) {
      try {
        openReference(decodeURIComponent(href.slice(1)));
        return;
      } catch {
        // The common failure path below provides one consistent user message.
      }
      setCompactStatus("Sync failed", active, `Link “${href}” could not be opened`, true);
      return;
    }
    try {
      const opened = await onMarkdownLinkOpen?.(href, active.displayPath);
      if (opened) updateStatus();
      else {
        setCompactStatus(
          "Sync failed",
          active,
          `Link “${href}” is unavailable in the current library`,
          true,
        );
      }
    } catch (error) {
      console.warn("[markdown link] could not open target", error);
      setCompactStatus("Sync failed", active, `Could not open link “${href}”`, true);
    }
  }

  function storeRemoteRecovery(tab: Tab, localText: string) {
    const path = isGitHubFileRef(tab.file.handle) ? tab.file.handle.path : tab.file.name;
    try {
      const createdAt = Date.now();
      const revision: RecoveryRevision = {
        id: crypto.randomUUID(),
        kind: "github-conflict",
        name: tab.file.name,
        path,
        text: localText,
        createdAt,
        documentRevision: tab.rev,
      };
      void persistenceStore.set(recoveryKey(revision), revision).catch((error) => {
        const kind = error instanceof PersistenceError ? error.kind : "unknown";
        persistenceWarning = kind === "quota"
          ? "recovery storage is full — export the current document now"
          : "could not persist the conflict recovery draft";
        if (tab === active) updateStatus();
      });
    } catch (error) {
      console.warn("[recovery] could not prepare conflict draft", error);
    }
  }

  function replaceWithRemote(tab: Tab, text: string, name: string, handle: FileRef) {
    if (tab === active) {
      loadIntoActive(text, name, handle);
    } else {
      const parsed = parseFrontmatter(text);
      tab.frontmatter = parsed.frontmatter;
      tab.file.name = name;
      tab.file.handle = handle;
      tab.reconnectableNative = isNativeFileRef(handle) ? handle : null;
      tab.nativeBaseText = isNativeFileRef(handle) ? text : null;
      tab.nativeConflict = false;
      tab.displayPath = tabDisplayPath(name, handle);
      tab.file.markdown = text;
      tab.file.dirty = false;
      tab.file.lastSavedAt = Date.now();
      tab.file.saveState = "saved";
      tab.state = null;
      tab.materialized = false;
      tab.pendingBody = parsed.body;
      tab.scrollTop = 0;
      tab.rev++;
      tab.save.cancel("saved");
      notifyTabs();
      void persistSession();
    }
    // Pulls and SHA conflicts replace persisted source outside the normal save
    // success path. Propagate both metadata and comment counts for active and
    // parked tabs so the shared project catalog cannot retain the old index.
    onPersisted?.(
      tab.frontmatter.library.id,
      countUnresolvedComments(tab.frontmatter.comments),
      tab.frontmatter.library,
      tab.file.handle,
      commentActivityDigest(tab.frontmatter.comments),
      "remote",
    );
  }

  function refreshRemote(text: string, name: string, handle: FileRef) {
    if (!isGitHubFileRef(handle)) return;
    const tab = tabs.find((candidate) =>
      isGitHubFileRef(candidate.file.handle) && candidate.file.handle.path === handle.path,
    );
    if (!tab) {
      void openInTab(text, name, handle);
      return;
    }
    const localText = tab === active ? serializeActive(false) : tab.file.markdown;
    const wasDirty = tab.file.dirty;
    if (wasDirty) storeRemoteRecovery(tab, localText);
    replaceWithRemote(tab, text, name, handle);
    if (wasDirty && tab === active) {
      setCompactStatus(
        "Sync failed",
        tab,
        "Pull restored the remote version; the local draft is preserved in recovery",
        true,
      );
    }
  }

  // --- UI -----------------------------------------------------------------
  type CompactStatus =
    | "Saved"
    | "Saving…"
    | "Changes pending"
    | "Sync failed"
    | "Read-only projection"
    | "Shared read-only";

  function statusDestination(tab: Tab): string {
    if (isGitHubFileRef(tab.file.handle)) {
      return accessFor(tab).sharedAccess ? `shared library · ${tab.file.handle.path}` : `GitHub · ${tab.file.handle.path}`;
    }
    if (tab.file.handle) return `local file · ${tab.displayPath}`;
    return "browser recovery";
  }

  function setCompactStatus(
    label: CompactStatus,
    tab: Tab,
    detail: string,
    emphasized = tab.file.dirty,
  ): void {
    const lastSaved = tab.file.lastSavedAt
      ? ` Last saved: ${new Date(tab.file.lastSavedAt).toLocaleString()}.`
      : "";
    const description = `Document: ${tab.displayPath || tab.file.name}. `
      + `Destination: ${statusDestination(tab)}. ${detail}.${lastSaved}`;
    dom.status.textContent = label;
    dom.status.title = description;
    dom.status.setAttribute("aria-label", description);
    dom.status.classList.toggle("is-dirty", emphasized);
  }

  function updateStatus() {
    if (active.frontmatter.library.projection?.read_only === true) {
      setCompactStatus(
        "Read-only projection",
        active,
        "Generated from results.yaml and dependency-graph.json; propose changes through a reviewed GitHub pull request",
        false,
      );
      notifyActivity();
      return;
    }
    if (!accessFor().canEditContent && !accessFor().canEditComments) {
      setCompactStatus("Shared read-only", active, "Shared project access permits reading only", false);
      notifyActivity();
      return;
    }
    if (active.nativeConflict) {
      const warning = persistenceWarning ? ` · ${persistenceWarning}` : "";
      setCompactStatus(
        "Sync failed",
        active,
        `Disk changed while MdLyx was closed; recovery was kept and Save As is required${warning}`,
        true,
      );
      notifyActivity();
      return;
    }
    const detail = active.file.saveState === "queued"
      ? isGitHubFileRef(active.file.handle) ? "queued for GitHub…" : "save queued…"
      : active.file.saveState === "saving"
        ? isGitHubFileRef(active.file.handle) ? "saving to GitHub…" : "saving…"
      : active.file.saveState === "conflict"
        ? "save conflict — remote version retained and local recovery preserved"
      : active.file.saveState === "failed"
        ? isGitHubFileRef(active.file.handle)
          ? "GitHub sync failed — changes kept locally"
          : "save failed — changes kept locally"
        : active.file.saveState === "dirty"
          ? "changes pending"
        : active.file.lastSavedAt
          ? `saved ${new Date(active.file.lastSavedAt).toLocaleTimeString()}`
          : "not yet saved";
    const warning = persistenceWarning ? ` · ${persistenceWarning}` : "";
    const short = active.file.saveState === "queued" || active.file.saveState === "saving"
      ? "Saving…"
      : active.file.saveState === "failed" || active.file.saveState === "conflict"
        ? "Sync failed"
        : active.file.saveState === "dirty" || active.file.dirty
          ? "Changes pending"
          : active.file.lastSavedAt ? "Saved" : "Changes pending";
    setCompactStatus(short, active, `${detail}${warning}`, active.file.dirty);
    notifyActivity();
  }

  // --- commands -----------------------------------------------------------
  function cmdNew() {
    newTab();
  }

  async function cmdOpen() {
    const opened = await openMarkdown();
    if (opened) await openInTab(opened.text, opened.name, opened.handle, opened.path);
  }

  async function cmdSave() {
    if (isReadOnly()) {
      updateStatus();
      return;
    }
    // The manual save contains the latest editor state. Cancel the debounce
    // scheduled by the same edit so it does not create an identical follow-up
    // GitHub commit; a subsequent edit schedules its own autosave normally.
    scheduleAutosave.cancel();
    const tab = active;
    const text = serializeActive();
    const atRev = tab.rev;
    tab.file.markdown = text;
    await enqueueSave(tab, text, atRev, "manual");
  }

  async function cmdSaveAs() {
    if (isReadOnly()) {
      updateStatus();
      return;
    }
    scheduleAutosave.cancel();
    const tab = active;
    const text = serializeActive();
    const atRev = tab.rev;
    tab.file.markdown = text;
    // Save As establishes a different persistence identity. Invalidate older
    // queued writes before opening the picker so none can later restore the old
    // path/SHA over the newly selected handle.
    tab.save.cancel("dirty");
    tab.saveAsInProgress = true;
    try {
      await enqueueSave(tab, text, atRev, "manual", async () => {
        const result = await saveMarkdownAs(text, tab.file.name);
        return result
          ? { kind: "saved", value: result }
          : { kind: "cancelled" };
      });
    } finally {
      tab.saveAsInProgress = false;
      // An edit made while the native picker was open was deliberately not
      // autosaved to the old handle. Retry it against the new handle now.
      if (tab === active && tab.file.dirty && tab.file.handle) scheduleAutosave();
    }
  }

  async function cmdExportTex() {
    editor.commitActiveMath();
    perf.countExport();
    const publication = publicationResolver
      ? await publicationResolver()
      : active.frontmatter.publication;
    const frontmatter = {
      ...active.frontmatter,
      publication,
    };
    const tex = timed("export", () =>
      exportLatex(editor.view.state.doc, { frontmatter }),
    );
    const base = active.file.name.replace(/\.md$/i, "") || "untitled";
    await downloadText(tex, `${base}.tex`, "text/x-tex");
  }

  function setEditMode(mode: "elements" | "mathlive") {
    if (mode === editMode) return;
    editor.commitActiveMath();
    editMode = mode;
    try {
      localStorage.setItem(EDITMODE_KEY, mode);
    } catch {
      /* non-fatal */
    }
    editor.view.focus();
  }

  dom.buttons.new.onclick = cmdNew;
  dom.buttons.open.onclick = cmdOpen;
  dom.buttons.save.onclick = cmdSave;
  dom.buttons.saveAs.onclick = cmdSaveAs;
  dom.buttons.exportTex.onclick = cmdExportTex;

  function setCommentsButton(active_: boolean) {
    dom.buttons.comments.classList.toggle("active", active_);
    dom.buttons.comments.setAttribute("aria-pressed", String(active_));
  }
  function cmdToggleComments() {
    const show = !commentsMargin.isVisible;
    commentsMargin.setVisible(show);
    setCommentsButton(show);
  }
  dom.buttons.comments.onclick = cmdToggleComments;

  function focusComment(id: string): boolean {
    if (!editor.listComments().some((comment) => comment.id === id)) return false;
    const anchor = host.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(id)}"]`);
    commentsMargin.setVisible(true);
    setCommentsButton(true);
    editor.selectComment(id);
    commentsMargin.focus(id);
    pulseHighlight(id);
    if (anchor) {
      const reduced = typeof matchMedia === "function"
        && matchMedia("(prefers-reduced-motion: reduce)").matches;
      anchor.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: reduced ? "auto" : "smooth",
      });
    }
    editor.view.focus();
    return true;
  }

  window.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "s") {
      e.preventDefault();
      if (e.shiftKey) void cmdSaveAs();
      else void cmdSave();
    } else if (key === "o") {
      e.preventDefault();
      void cmdOpen();
    } else if (key === "t") {
      e.preventDefault();
      newTab();
    } else if (key === "w") {
      e.preventDefault();
      void closeTab(active.id);
    }
  });

  // Warn before closing while ANY tab has unsaved changes.
  window.addEventListener("beforeunload", (e) => {
    if (lifecyclePersistenceEnabled && tabs.some((t) => t.file.dirty)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // --- startup: restore the previous session (or the default doc) ---------
  function validSession(value: unknown): value is PersistedSessionV2 | LegacySessionData {
    if (!value || typeof value !== "object") return false;
    const session = value as Partial<PersistedSessionV2>;
    return Array.isArray(session.tabs) && session.tabs.length > 0 && session.tabs.every((tab) => {
      if (!tab || typeof tab !== "object") return false;
      const candidate = tab as Partial<PersistedSessionTab>;
      return typeof candidate.name === "string"
        && typeof candidate.text === "string"
        && typeof candidate.dirty === "boolean";
    });
  }

  function asV2(value: PersistedSessionV2 | LegacySessionData): PersistedSessionV2 {
    if ("version" in value && value.version === 2) return value;
    return { version: 2, revision: 1, tabs: value.tabs, activeIndex: value.activeIndex };
  }

  async function restoredSessionData(): Promise<PersistedSessionV2 | null> {
    try {
      // Prefer a legacy snapshot when present. This makes migration crash-safe:
      // the old key is removed only after the IndexedDB copy can be read back.
      const legacyRaw = localStorage.getItem(LEGACY_SESSION_KEY);
      if (legacyRaw) {
        const parsed = JSON.parse(legacyRaw) as unknown;
        if (validSession(parsed)) {
          const migrated = asV2(parsed);
          try {
            await persistenceStore.set(PERSISTED_SESSION_KEY, migrated);
            const verified = await persistenceStore.get<PersistedSessionV2>(PERSISTED_SESSION_KEY);
            if (verified?.version === 2 && verified.tabs.length === migrated.tabs.length) {
              localStorage.removeItem(LEGACY_SESSION_KEY);
            }
          } catch (error) {
            persistenceWarning = "legacy recovery loaded; IndexedDB migration is pending";
            console.warn("[persistence] session migration deferred", error);
          }
          return migrated;
        }
      }
      const stored = await persistenceStore.get<PersistedSessionV2>(PERSISTED_SESSION_KEY);
      return validSession(stored) ? asV2(stored) : null;
    } catch (error) {
      persistenceWarning = "local recovery could not be read";
      console.warn("[persistence] session restore failed", error);
      return null;
    }
  }

  async function restoreSession(): Promise<boolean> {
    try {
      const data = await restoredSessionData();
      if (!data) return false;
      persistedSessionRevision = data.revision;
      const restoredTabs: Tab[] = [];
      for (const st of data.tabs) {
        if (st.remote) {
          const meta = parseFrontmatter(st.text ?? "").frontmatter.library;
          if (!remoteAccess(meta, st.remote.path).authorized) continue;
        }
        let handle: FileRef = st.remote
          ? { kind: "github", path: st.remote.path, sha: st.remote.sha }
          : st.localHandle ?? null;
        let text = st.text ?? "";
        let nativeIdentity: NativeFileRef | null = null;
        let nativeBaseText = st.nativeBaseText;
        let nativeConflict = false;
        let restoredDirty = !!st.dirty;
        if (st.native) {
          nativeIdentity = st.native;
          try {
            const reconnected = await reconnectNativeFile(st.native);
            if (reconnected) {
              nativeIdentity = isNativeFileRef(reconnected.handle)
                ? reconnected.handle
                : st.native;
              const decision = reconcileNativeRecovery(
                text,
                restoredDirty,
                nativeBaseText,
                reconnected.text,
              );
              text = decision.text;
              restoredDirty = decision.dirty;
              handle = decision.attachGrant ? reconnected.handle : null;
              nativeBaseText = decision.baseText;
              nativeConflict = decision.conflict;
            } else {
              handle = null;
              persistenceWarning = "a native file needs reconnection; its recovery text was retained";
            }
          } catch (error) {
            handle = null;
            persistenceWarning = "a native file needs reconnection; its recovery text was retained";
            console.warn("[persistence] native file reconnect failed", error);
          }
        }
        const tab = createTab(text, st.name || "untitled.md", handle, st.path);
        tab.reconnectableNative = nativeIdentity;
        tab.nativeBaseText = nativeBaseText ?? null;
        tab.nativeConflict = nativeConflict;
        tab.file.dirty = restoredDirty;
        tab.rev = Math.max(st.save?.latestRevision ?? 0, restoredDirty ? 1 : 0);
        tab.lastEnqueuedRev = 0; // in-flight work cannot survive a process restart
        if (st.save) tab.save.restore(st.save);
        if (!tab.file.dirty) tab.save.cancel("saved");
        else if (tab.save.state === "saved") tab.save.markDirty(tab.rev);
        restoredTabs.push(tab);
      }
      if (restoredTabs.length === 0) return false;
      tabs.splice(0, tabs.length, ...restoredTabs); // discard placeholder atomically
      const idx = Math.max(0, Math.min(data.activeIndex ?? 0, tabs.length - 1));
      activate(tabs[idx]);
      return true;
    } catch {
      return false;
    }
  }

  async function start(initial: string): Promise<void> {
    if (!await restoreSession()) {
      // Load the default document into the pre-created initial tab.
      loadIntoActive(initial, "untitled.md", null);
    }
    lifecyclePersistenceEnabled = true;
    notifyTabs();
    if (active.file.dirty && active.file.handle) scheduleAutosave();
    void persistSession();
  }

  async function clearLocalData(): Promise<void> {
    lifecyclePersistenceEnabled = false;
    scheduleSerialize.cancel();
    scheduleAutosave.cancel();
    scheduleSession.cancel();
    await sessionPersistenceQueue;
    // A deferred v1→v2 migration deliberately leaves the legacy snapshot in
    // localStorage until IndexedDB verification succeeds. Explicit clearing
    // must remove both stores, or startup will simply migrate the old tabs back.
    localStorage.removeItem(LEGACY_SESSION_KEY);
    await persistenceStore.clear();
  }

  async function openRecoveryRevision(id: string): Promise<boolean> {
    const revision = (await listRecoveryRevisions(persistenceStore))
      .find((candidate) => candidate.id === id);
    if (!revision) return false;
    const base = revision.name.replace(/\.md$/i, "") || "document";
    const timestamp = new Date(revision.createdAt)
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", " ")
      .replace("Z", "");
    const tab = createTab(
      revision.text,
      `${base} recovery ${timestamp}.md`,
      null,
    );
    tab.rev = Math.max(1, revision.documentRevision ?? 1);
    tab.file.dirty = true;
    tab.save.markDirty(tab.rev);
    tabs.push(tab);
    activate(tab);
    void persistSession();
    return true;
  }

  async function purgeRemoteData(): Promise<void> {
    const remotePaths = new Set(tabs.flatMap((tab) =>
      isGitHubFileRef(tab.file.handle) ? [tab.file.handle.path] : [],
    ));
    scheduleSerialize.cancel();
    scheduleAutosave.cancel();
    scheduleSession.cancel();
    for (const tab of tabs) {
      if (isGitHubFileRef(tab.file.handle)) tab.save.cancel("saved");
    }
    const remaining = tabs.filter((tab) => !isGitHubFileRef(tab.file.handle));
    if (!remaining.length) remaining.push(createTab("", "untitled.md", null));
    const target = remaining.includes(active) ? active : remaining[0];
    if (target !== active) activate(target);
    tabs.splice(0, tabs.length, ...remaining);
    refreshForActive();
    const recoveries = await persistenceStore.list<RecoveryRevision>("recovery:");
    await Promise.all(recoveries
      .filter(({ value }) => value.path && remotePaths.has(value.path))
      .map(({ key }) => persistenceStore.delete(key)));
    await persistSession();
  }

  return {
    editor,
    start,
    // Replace the active tab's document in place (debug __load / programmatic).
    load: loadIntoActive,
    // Open a document in a tab (focus if already open) — library / File▸Open.
    open: openInTab,
    // Internal links can focus an existing tab without waiting for another
    // provider read. New destinations still flow through `open`; the context
    // guard prevents a provider switch from activating a stale tab.
    activateExisting,
    // Pull updates an already-open GitHub document in place (remote wins).
    refreshRemote,
    isDirty: () => tabs.some((t) => t.file.dirty),
    relayout: () => commentsMargin.reposition(),
    focusComment,
    setSelectionUiObscured: (obscured: boolean) => selectionPopover.setObscured(obscured),
    setRemoteAccess: (
      resolver: (meta: DocMeta, path?: string) => RemoteDocumentAccess,
      identity?: { displayName: string; principalId?: string },
    ) => {
      remoteAccess = resolver;
      sharedAuthor = identity ?? { displayName: dom.authorName };
      refreshForActive();
    },
    purgeRemoteData,
    getEditMode: () => editMode,
    setEditMode,
    getMeta,
    updateMeta,
    getPublication,
    getPublicationOverrides,
    getNumbering,
    updateNumbering,
    updatePublication,
    isReadOnly: () => isReadOnly(),
    serialize: () => serializeActive(false),
    // Tab strip API.
    getTabs: tabViews,
    getDirtyDocumentIds: () => new Set(
      tabs
        .filter((tab) => tab.file.dirty && tab.frontmatter.library.id)
        .map((tab) => tab.frontmatter.library.id as string),
    ),
    selectTab: (id: string) => {
      const t = tabs.find((x) => x.id === id);
      if (t) activate(t);
    },
    closeTab,
    closeTabs,
    newTab,
    reorderTab,
    setOnTabs: (cb: (t: TabView[]) => void) => {
      onTabs = cb;
    },
    setOnActivity: (cb: (snapshot: DocumentActivitySnapshot) => void) => {
      onActivity = cb;
      cb(activitySnapshot());
    },
    setOnLoad: (cb: (name: string, handle: FileRef, displayPath: string) => void) => {
      onLoad = cb;
    },
    setOnMeta: (cb: (meta: DocMeta) => void) => {
      onMeta = cb;
    },
    setOnPersisted: (cb: (
      documentId: string | undefined,
      unresolvedCommentCount: number,
      meta: DocMeta,
      handle: FileRef,
      commentDigest?: string,
      origin?: "save" | "remote",
    ) => void) => {
      onPersisted = cb;
    },
    setOnDocumentLinkOpen: (
      cb: (id: string, anchor?: string) => boolean | Promise<boolean>,
    ) => {
      onDocumentLinkOpen = cb;
    },
    setOnResultLinkOpen: (
      cb: (resultId: string) => boolean | Promise<boolean>,
    ) => {
      onResultLinkOpen = cb;
    },
    setResultReferences: (references: readonly ResultReference[]) =>
      editor.setResultReferences(references),
    setOnMarkdownLinkOpen: (
      cb: (href: string, sourcePath: string) => boolean | Promise<boolean>,
    ) => {
      onMarkdownLinkOpen = cb;
    },
    setOnLibraryAssetRead: (cb: (path: string) => Promise<{ bytes: Uint8Array; mimeType: string } | null>) => {
      onLibraryAssetRead = cb;
      editor.refreshFigureAssets();
    },
    setPublicationResolver: (resolver: () => Promise<PublicationSettings>) => {
      publicationResolver = resolver;
    },
    prepareForRelaunch,
    exportRecoveryBundle: () => exportRecoveryBundle(persistenceStore),
    listRecoveryRevisions: () => listRecoveryRevisions(persistenceStore),
    openRecoveryRevision,
    deleteRecoveryRevision: (id: string) => deleteRecoveryRevision(persistenceStore, id),
    clearLocalData,
  };
}
