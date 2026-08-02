import { EditorState, NodeSelection, type Plugin } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Slice, type Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";
import { parseMarkdown } from "../markdown/parse";
import { normalizeLlmMarkdown, hasRenderableMath } from "../markdown/normalize";
import { buildPlugins } from "./plugins";
import {
  MathView,
  checkpointActiveMath,
  commitActiveMath,
  commitActiveMathIfOutside,
  type MacrosProvider,
  type EditModeProvider,
} from "./math/math-nodeview";
import { XRefView } from "./xref-nodeview";
import { FigureView, type FigureAssetReader } from "./figure-nodeview";
import { CitationView } from "./citation-nodeview";
import { DetailsView } from "./details-nodeview";
import type { CitationStyle } from "../markdown/frontmatter";
import type { CitationCatalogSnapshot } from "../publication/citation-catalog";
import { numberingKey, defaultNumbering, type NumberingConfig } from "./numbering";
import {
  addComment,
  addReply,
  setResolved,
  setPriority,
  setStatus,
  setColor,
  setBody,
  removeComment,
  selectComment,
  exportComments,
  importComments,
  getComments,
  commentsKey,
  type Comment,
  type CommentKind,
  type HighlightColor,
  type Priority,
  type ReviewStatus,
  type StoredComment,
} from "./comments";
import type { ResultReference } from "./result-references";

type FigureDom = HTMLElement & { __figureView?: { refresh(): void } };

export interface EditorHandle {
  view: EditorView;
  /** Replace the whole document, resetting history (used by file open/new). */
  setDoc(doc: PMNode): void;
  /** Snapshot the full editor state (doc + selection + undo history + comments)
   *  so a tab can be parked and later restored intact. */
  captureState(): EditorState;
  /** Restore a previously captured state without dirtying the document. */
  restoreState(state: EditorState): void;
  /** The active document's comments (to re-render the margin after a tab swap). */
  listComments(): Comment[];
  /** Flush an in-progress math edit into the document. */
  commitActiveMath(): void;
  /** Checkpoint a genuinely edited math value without closing its live editor. */
  checkpointActiveMath(): void;
  /** Force the numbering plugin to recompute (after a config change). */
  refreshNumbering(): void;
  /** Re-evaluate the active document's editable/read-only state. */
  refreshEditable(): void;
  /** Retry provider-backed figure previews after the active library changes. */
  refreshFigureAssets(): void;
  /** Replace the active library's catalog-known formal result references. */
  setResultReferences(references: readonly ResultReference[]): Promise<void>;
  /** Refresh live publication labels without changing the stored citation source. */
  setCitationCatalog(snapshot: CitationCatalogSnapshot | null, style: CitationStyle): void;
  /** Add a comment/highlight over the current selection. Returns its id, or null. */
  addComment(fields: {
    kind: CommentKind;
    author: string;
    principalId?: string;
    body: string;
    color?: HighlightColor;
  }): string | null;
  addReply(id: string, reply: { kind: CommentKind; author: string; principalId?: string; body: string }): void;
  resolveComment(id: string, resolved: boolean): void;
  setPriority(id: string, priority?: Priority): void;
  setStatus(id: string, status: ReviewStatus): void;
  setColor(id: string, color: HighlightColor): void;
  setBody(id: string, body: string): void;
  removeComment(id: string): void;
  selectComment(id: string): void;
  exportComments(): StoredComment[];
  importComments(stored: StoredComment[]): void;
  /** Content-relative top (px, scrolls with the doc) of a comment's anchor. */
  commentAnchorTop(id: string): number | null;
  destroy(): void;
}

export interface EditorOptions {
  doc?: PMNode;
  getMacros?: MacrosProvider;
  getConfig?: () => NumberingConfig;
  getEditMode?: EditModeProvider;
  onChange?: (view: EditorView) => void;
  commentsOnChange?: (comments: Comment[]) => void;
  /** Fires when the selection changes (for the add-comment popover). */
  onSelectionChange?: (view: EditorView) => void;
  /** Fires when a comment highlight in the document is clicked. */
  onCommentClick?: (id: string) => void;
  /** Opens a stable-id document link and its optional in-document anchor. */
  onDocumentLinkOpen?: (target: string, anchor?: string) => void;
  /** Opens an in-document equation/section/figure/table/theorem reference. */
  onReferenceOpen?: (target: string) => void;
  /** Opens a formal result's catalog-declared owner document and anchor. */
  onResultLinkOpen?: (resultId: string) => void;
  /** Routes a safe authored Markdown href through the app/library provider. */
  onMarkdownLinkOpen?: (href: string) => void;
  /** Resolve private/local figure bytes without exposing provider URLs. */
  readFigureAsset?: FigureAssetReader;
  /** Generated projections use this to remain selectable but immutable. */
  getEditable?: () => boolean;
  /** Commenters keep the document body immutable while adding anchored marks. */
  getCommentEditable?: () => boolean;
}

export function createEditor(
  host: HTMLElement,
  options: EditorOptions = {},
): EditorHandle {
  const getMacros: MacrosProvider = options.getMacros ?? (() => ({}));
  const getConfig = options.getConfig ?? (() => defaultNumbering);
  const getEditMode: EditModeProvider = options.getEditMode ?? (() => "elements");
  const getEditable = options.getEditable ?? (() => true);
  const getCommentEditable = options.getCommentEditable ?? getEditable;
  const readFigureAsset: FigureAssetReader = options.readFigureAsset ?? (async () => null);
  let resultReferences: readonly ResultReference[] = [];
  let resultReferencePlugin: Plugin | null = null;
  let resultReferenceModule: typeof import("./result-references") | null = null;
  let loadingResultReferences: Promise<typeof import("./result-references")> | null = null;
  let lastTouchedNavigation: { key: string; at: number } | null = null;
  let suppressedClickNavigation: { key: string; at: number } | null = null;
  let suppressedDoubleClickNavigation: { key: string; at: number } | null = null;
  let citationCatalog: CitationCatalogSnapshot | null = null;
  let citationStyle: CitationStyle = "authoryear";
  const citationViews = new Set<CitationView>();

  type Navigation = {
    kind: "document" | "reference" | "result" | "markdown";
    target: string;
    anchor?: string;
    atom: HTMLElement | null;
  };

  const invokeNavigation = (navigation: Navigation) => {
    if (navigation.kind === "document") {
      options.onDocumentLinkOpen?.(navigation.target, navigation.anchor);
    } else if (navigation.kind === "reference") {
      options.onReferenceOpen?.(navigation.target);
    } else if (navigation.kind === "result") {
      options.onResultLinkOpen?.(navigation.target);
    } else {
      options.onMarkdownLinkOpen?.(navigation.target);
    }
  };

  const navigationFor = (element: Element | null): Navigation | null => {
    const documentLink = element?.closest<HTMLElement>("[data-doc-link]");
    const documentId = documentLink?.dataset.target;
    if (documentId) {
      return {
        kind: "document" as const,
        target: documentId,
        ...(documentLink.dataset.anchor ? { anchor: documentLink.dataset.anchor } : {}),
        atom: documentLink,
      };
    }

    const resultLink = element?.closest<HTMLElement>("[data-result-id]");
    const resultId = resultLink?.dataset.resultId;
    if (resultId) {
      return {
        kind: "result" as const,
        target: resultId,
        atom: resultLink,
      };
    }

    const reference = element?.closest<HTMLElement>("[data-xref-target]");
    const referenceId = reference?.dataset.xrefTarget;
    if (referenceId) return { kind: "reference" as const, target: referenceId, atom: reference };

    const link = element?.closest<HTMLAnchorElement>("a[href]:not([data-xref])");
    const href = link?.getAttribute("href");
    return href ? { kind: "markdown" as const, target: href, atom: null } : null;
  };

  const buildState = (doc?: PMNode) =>
    EditorState.create({
      schema,
      doc,
      plugins: [
        ...buildPlugins({
          getConfig,
          commentsOnChange: options.commentsOnChange,
        }),
        ...(resultReferencePlugin ? [resultReferencePlugin] : []),
      ],
    });

  const view = new EditorView(host, {
    state: buildState(options.doc),
    editable: getEditable,
    nodeViews: {
      math_inline: (node, view, getPos, decorations) =>
        new MathView(node, view, getPos, getMacros, decorations, getEditMode),
      math_display: (node, view, getPos, decorations) =>
        new MathView(node, view, getPos, getMacros, decorations, getEditMode),
      xref: (node, _view, _getPos, decorations) =>
        new XRefView(node, decorations),
      figure: (node) => new FigureView(node, readFigureAsset),
      citation: (node) => {
        const citation = new CitationView(
          node,
          () => ({ snapshot: citationCatalog, style: citationStyle }),
          (destroyed) => citationViews.delete(destroyed),
        );
        citationViews.add(citation);
        return citation;
      },
      details_disclosure: (node) => new DetailsView(node),
    },
    dispatchTransaction(tr) {
      const commentChanged = tr.getMeta(commentsKey) != null;
      // `editable: false` blocks DOM input, but toolbar commands can still
      // dispatch transactions programmatically. Reject every content/comment
      // mutation while a generated projection is active; selection and plugin
      // bookkeeping transactions remain available for navigation.
      if (commentChanged ? !getCommentEditable() : (tr.docChanged && !getEditable())) return;
      const prevSel = view.state.selection;
      const newState = view.state.apply(tr);
      view.updateState(newState);
      // A comment-store change (reply / resolve / priority / status / colour /
      // note) is a metadata-only transaction with no doc change — it must still
      // dirty the document so it's persisted and backed up. (Loads use addMany
      // but the app guards those with its `loading` flag.)
      if (tr.docChanged || commentChanged) options.onChange?.(view);
      if (tr.docChanged || !prevSel.eq(newState.selection)) {
        options.onSelectionChange?.(view);
      }
    },
    handleClickOn(editorView, _pos, node, nodePos, event) {
      const target = event.target as HTMLElement | null;
      // WebKit can apply the atom's NodeSelection between pointerup and click
      // without delivering the NodeView's own click listener reliably under a
      // busy event loop. Resolve the live NodeView from the stable document
      // position as an idempotent fallback so one click still opens math.
      if (node.type === schema.nodes.math_inline || node.type === schema.nodes.math_display) {
        const dom = editorView.nodeDOM(nodePos) as
          | { __mathView?: { activate(): void } }
          | null;
        dom?.__mathView?.activate();
      }
      const navigation = navigationFor(target);
      const navigationKey = navigation
        ? `${navigation.kind}:${navigation.target}#${navigation.anchor ?? ""}`
        : null;
      if (
        navigationKey
        && suppressedClickNavigation?.key === navigationKey
        && performance.now() - suppressedClickNavigation.at < 750
      ) {
        suppressedClickNavigation = null;
        event.preventDefault();
        return true;
      }
      const touchAtomSelected = navigation?.atom
        && typeof matchMedia === "function"
        && matchMedia("(pointer: coarse)").matches
        && (
          navigation.atom.classList.contains("ProseMirror-selectednode")
          || (
            editorView.state.selection instanceof NodeSelection
            && editorView.state.selection.from === nodePos
          )
        );
      if (
        navigation
        && (event.metaKey || event.ctrlKey || touchAtomSelected)
      ) {
        event.preventDefault();
        if (touchAtomSelected) lastTouchedNavigation = null;
        invokeNavigation(navigation);
        return true; // the first unmodified tap/click still selects for editing
      }
      // An authored Markdown link is a live <a> inside contenteditable. Suppress
      // its default same-webview navigation on an ordinary editing click; the
      // explicit modified click / second touch above is the navigation gesture.
      if (navigation?.kind === "markdown") event.preventDefault();

      const el = target?.closest?.(
        "[data-comment-id]",
      );
      const id = el?.getAttribute("data-comment-id");
      if (id) options.onCommentClick?.(id);
      return false; // don't consume — let PM place the caret too
    },
    handleKeyDown(editorView, event) {
      if (event.key !== "Enter") return false;
      const focusedNavigation = navigationFor(
        event.target instanceof Element ? event.target : null,
      );
      if (focusedNavigation?.kind === "result") {
        event.preventDefault();
        invokeNavigation(focusedNavigation);
        return true;
      }
      if (editorView.state.selection instanceof NodeSelection) {
        const node = editorView.state.selection.node;
        const target = node.attrs.target as string | undefined;
        if (target && node.type === schema.nodes.doc_link) {
          event.preventDefault();
          options.onDocumentLinkOpen?.(
            target,
            (node.attrs.anchor as string | null) ?? undefined,
          );
          return true;
        }
        if (target && node.type === schema.nodes.xref) {
          event.preventDefault();
          options.onReferenceOpen?.(target);
          return true;
        }
      }
      if (!event.metaKey && !event.ctrlKey) return false;
      // ProseMirror may leave an explicit empty stored-mark set after a click,
      // even while the caret is visibly inside linked text. Treat that empty
      // set as transient input state and resolve the authored link from the
      // caret itself so Cmd/Ctrl-Enter remains deterministic.
      const storedMarks = editorView.state.storedMarks;
      const marks = storedMarks?.length
        ? storedMarks
        : editorView.state.selection.$from.marks();
      const link = marks.find((mark) => mark.type === schema.marks.link);
      const href = link?.attrs.href as string | undefined;
      if (!href) return false;
      event.preventDefault();
      options.onMarkdownLinkOpen?.(href);
      return true;
    },
    // Pasting a Markdown document that carries math (incl. ChatGPT/LLM `\(…\)` /
    // `\[…\]`, or the degraded copied-from-rendered form) is parsed as Markdown so
    // its equations render, rather than landing as literal text. Plain text and
    // in-app copies fall through to default paste.
    handlePaste(view, event) {
      const text = event.clipboardData?.getData("text/plain");
      if (!text || !text.includes("\n")) return false;
      // Never hijack a paste inside a code block — code must stay literal.
      if (view.state.selection.$from.parent.type.spec.code) return false;
      // Only route through the Markdown parser on a real math signal (not prose
      // that merely contains dollar amounts, and not `\(` inside a code sample).
      if (!hasRenderableMath(text)) return false;
      const frag = parseMarkdown(normalizeLlmMarkdown(text)).content;
      if (!frag.size) return false;
      // Open a leading/trailing PARAGRAPH so its inline content merges into the
      // caret's block instead of splitting it; headings/blocks stay closed.
      const openStart = frag.firstChild?.type === schema.nodes.paragraph ? 1 : 0;
      const openEnd = frag.lastChild?.type === schema.nodes.paragraph ? 1 : 0;
      view.dispatch(
        view.state.tr
          .replaceSelection(new Slice(frag, openStart, openEnd))
          .scrollIntoView(),
      );
      return true;
    },
    handleDOMEvents: {
      click(_v, event) {
        // ProseMirror does not run handleClickOn for every link descendant once
        // the whole document is non-editable. Intercept at the DOM boundary so
        // reader sessions and generated projections behave like documents:
        // one ordinary click follows a link without letting the webview replace
        // the application page.
        if (getEditable()) return false;
        const navigation = navigationFor(event.target instanceof Element ? event.target : null);
        if (!navigation) return false;
        event.preventDefault();
        invokeNavigation(navigation);
        return true;
      },
      dblclick(_v, event) {
        const navigation = navigationFor(event.target instanceof Element ? event.target : null);
        if (!navigation) return false;
        const key = `${navigation.kind}:${navigation.target}#${navigation.anchor ?? ""}`;
        if (
          suppressedDoubleClickNavigation?.key === key
          && performance.now() - suppressedDoubleClickNavigation.at < 750
        ) {
          suppressedDoubleClickNavigation = null;
          event.preventDefault();
          return true;
        }
        event.preventDefault();
        invokeNavigation(navigation);
        return true;
      },
      pointerup(_v, event) {
        const pointer = event as PointerEvent;
        if (pointer.pointerType !== "touch") return false;
        const navigation = navigationFor(event.target instanceof Element ? event.target : null);
        if (!navigation) {
          lastTouchedNavigation = null;
          return false;
        }
        const key = `${navigation.kind}:${navigation.target}#${navigation.anchor ?? ""}`;
        const now = performance.now();
        if (
          lastTouchedNavigation?.key === key
          && now - lastTouchedNavigation.at < 1_500
        ) {
          lastTouchedNavigation = null;
          // Chromium requires the pointerup path for selected atoms, while
          // WebKit also delivers a subsequent selected-node click and Chromium
          // may synthesize dblclick after the second tap. Suppress those
          // matching follow-ups so every engine performs exactly one open.
          suppressedClickNavigation = { key, at: now };
          suppressedDoubleClickNavigation = { key, at: now };
          event.preventDefault();
          invokeNavigation(navigation);
          return true;
        }
        lastTouchedNavigation = { key, at: now };
        return false;
      },
      // Clicking anywhere outside the equation being edited commits and closes
      // it (the element editor lives in a focused <input>, so it won't blur into
      // the doc on its own).
      mousedown(_v, event) {
        commitActiveMathIfOutside(event.target);
        return false;
      },
    },
  });

  return {
    view,
    setDoc(doc: PMNode) {
      view.updateState(buildState(doc));
      options.onChange?.(view);
    },
    captureState: () => view.state,
    restoreState(state: EditorState) {
      // Swap the whole state in place. No onChange — a tab switch is not an edit.
      view.updateState(
        resultReferencePlugin && !state.plugins.includes(resultReferencePlugin)
          ? state.reconfigure({ plugins: [...state.plugins, resultReferencePlugin] })
          : state,
      );
      // Parked tab states may predate the latest library Pull/catalog refresh.
      // Reconcile their derived decorations without touching document history.
      resultReferenceModule?.refreshResultReferences(view);
    },
    listComments: () => getComments(view.state),
    checkpointActiveMath,
    commitActiveMath,
    refreshNumbering() {
      view.dispatch(view.state.tr.setMeta(numberingKey, true));
    },
    refreshEditable() {
      view.setProps({ editable: getEditable });
    },
    refreshFigureAssets() {
      for (const element of host.querySelectorAll<FigureDom>("figure.document-figure")) {
        element.__figureView?.refresh();
      }
    },
    async setResultReferences(references) {
      resultReferences = references;
      // Most standalone documents have no project catalog. Keep this optional
      // decorator out of the startup entry and load it only when formal result
      // IDs are actually available.
      if (!resultReferencePlugin && references.length) {
        loadingResultReferences ??= import("./result-references");
        resultReferenceModule = await loadingResultReferences;
        resultReferencePlugin = resultReferenceModule.buildResultReferences(
          () => resultReferences,
          (resultId) => options.onResultLinkOpen?.(resultId),
        );
      }
      if (
        resultReferencePlugin
        && !view.state.plugins.includes(resultReferencePlugin)
      ) {
        view.updateState(view.state.reconfigure({
          plugins: [...view.state.plugins, resultReferencePlugin],
        }));
      }
      resultReferenceModule?.refreshResultReferences(view);
    },
    setCitationCatalog(snapshot, style) {
      citationCatalog = snapshot;
      citationStyle = style;
      for (const citation of citationViews) citation.refresh();
    },
    addComment: (fields) => addComment(view, fields),
    addReply: (id, reply) => addReply(view, id, reply),
    resolveComment: (id, resolved) => setResolved(view, id, resolved),
    setPriority: (id, priority) => setPriority(view, id, priority),
    setStatus: (id, status) => setStatus(view, id, status),
    setColor: (id, color) => setColor(view, id, color),
    setBody: (id, body) => setBody(view, id, body),
    removeComment: (id) => removeComment(view, id),
    selectComment: (id) => selectComment(view, id),
    exportComments: () => exportComments(view.state),
    importComments: (stored) => importComments(view, stored),
    commentAnchorTop: (id) => {
      const el = host.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(id)}"]`);
      if (!el) return null;
      const hostRect = host.getBoundingClientRect();
      return el.getBoundingClientRect().top - hostRect.top + host.scrollTop;
    },
    destroy() {
      view.destroy();
    },
  };
}
