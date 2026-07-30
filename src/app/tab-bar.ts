import type { DocumentActivitySnapshot, TabView } from "./app";
import { MobileSheetController } from "./mobile-sheet";

export interface TabBarHandlers {
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onReorder: (id: string, toIndex: number) => void;
  /**
   * Close several tabs through one application-level operation. The dirty ids
   * are supplied separately so the application can show one aggregate
   * confirmation instead of opening a confirmation for every tab.
   *
   * This remains optional for embedders created before the tab overview. The
   * fallback calls onClose for each id; Mathdown itself should always wire the
   * aggregate handler.
   */
  onBulkClose?: (request: TabBulkCloseRequest) => void | Promise<void>;
  onRevealTools?: () => void;
}

export interface TabBulkCloseRequest {
  mode: "others" | "saved";
  activeId: string | null;
  tabIds: string[];
  dirtyTabIds: string[];
}

interface TabParts {
  item: HTMLDivElement;
  tab: HTMLButtonElement;
  label: HTMLSpanElement;
  dirty: HTMLSpanElement;
  close: HTMLButtonElement;
}

let overviewId = 0;

function viewSignature(tabs: TabView[]): string {
  return JSON.stringify(tabs.map((tab) => [
    tab.id,
    tab.name,
    tab.path ?? "",
    tab.dirty,
    tab.active,
  ]));
}

// The horizontal strip of open documents above the editor pane. The scrollable
// tab list and fixed New button are separate so the creation affordance never
// disappears off-screen. Tab nodes are reconciled by id: save-state notifications
// do not repeatedly destroy focus, drag state, or the full strip DOM.
export class TabBar {
  private readonly host: HTMLElement;
  private readonly scroll: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly add: HTMLButtonElement;
  private readonly actions: HTMLDivElement;
  private readonly overviewToggle: HTMLButtonElement;
  private readonly overviewToggleCount: HTMLSpanElement;
  private readonly overviewPanel: HTMLDivElement;
  private readonly overviewSearch: HTMLInputElement;
  private readonly overviewList: HTMLDivElement;
  private readonly overviewCount: HTMLSpanElement;
  private readonly announcer: HTMLSpanElement;
  private readonly mobileBar: HTMLDivElement;
  private readonly mobileTitle: HTMLSpanElement;
  private readonly mobilePath: HTMLSpanElement;
  private readonly mobileActivity: HTMLSpanElement;
  private readonly mobileCount: HTMLSpanElement;
  private readonly mobileOverview: HTMLButtonElement;
  private readonly mobileNew: HTMLButtonElement;
  private readonly mobileTools: HTMLButtonElement;
  private readonly overviewSheet: MobileSheetController;
  private readonly closeCurrent: HTMLButtonElement;
  private readonly closeOthers: HTMLButtonElement;
  private readonly closeSaved: HTMLButtonElement;
  private readonly handlers: TabBarHandlers;
  private readonly parts = new Map<string, TabParts>();
  private readonly resizeObserver: ResizeObserver | null;
  private dragId: string | null = null;
  private signature = "";
  private activeId: string | null = null;
  private views: TabView[] = [];
  private revealScheduled = false;
  private overviewOpen = false;
  private dirtySignature = "";
  private overviewLauncher: HTMLButtonElement;
  private activity: DocumentActivitySnapshot | null = null;

  constructor(host: HTMLElement, handlers: TabBarHandlers) {
    this.host = host;
    this.handlers = handlers;
    this.host.classList.add("tab-bar");

    this.scroll = document.createElement("div");
    this.scroll.className = "tab-scroll";
    this.list = document.createElement("div");
    this.list.className = "tab-list";
    // A labelled button group is used instead of ARIA tablist because every
    // visual tab also has a separate, accessible close button. This avoids an
    // invalid tablist child hierarchy while retaining roving focus and the
    // complete keyboard tab behavior below.
    this.list.setAttribute("role", "group");
    this.list.setAttribute("aria-label", "Open document tabs");
    this.scroll.appendChild(this.list);

    this.add = document.createElement("button");
    this.add.type = "button";
    this.add.className = "tab-new";
    this.add.title = "New tab";
    this.add.setAttribute("aria-label", "New tab");
    this.add.textContent = "+";
    this.add.addEventListener("click", () => this.handlers.onNew());

    const panelId = `tab-overview-panel-${++overviewId}`;
    this.overviewToggle = document.createElement("button");
    this.overviewToggle.type = "button";
    this.overviewToggle.className = "tab-overview-toggle";
    this.overviewToggle.title = "View all open tabs";
    this.overviewToggle.setAttribute("aria-label", "View all open tabs");
    this.overviewToggle.setAttribute("aria-haspopup", "dialog");
    this.overviewToggle.setAttribute("aria-expanded", "false");
    this.overviewToggle.setAttribute("aria-controls", panelId);
    const overviewGlyph = document.createElement("span");
    overviewGlyph.className = "tab-overview-glyph";
    overviewGlyph.setAttribute("aria-hidden", "true");
    overviewGlyph.textContent = "☰";
    this.overviewToggleCount = document.createElement("span");
    this.overviewToggleCount.className = "tab-overview-toggle-count";
    this.overviewToggleCount.setAttribute("aria-hidden", "true");
    this.overviewToggle.append(overviewGlyph, this.overviewToggleCount);
    this.overviewToggle.addEventListener("click", () => this.toggleOverview(this.overviewToggle));

    this.actions = document.createElement("div");
    this.actions.className = "tab-actions";
    this.actions.append(this.overviewToggle, this.add);

    this.mobileBar = document.createElement("div");
    this.mobileBar.className = "mobile-document-bar";
    const identity = document.createElement("div");
    identity.className = "mobile-document-identity";
    this.mobileTitle = document.createElement("span");
    this.mobileTitle.className = "mobile-document-title";
    this.mobilePath = document.createElement("span");
    this.mobilePath.className = "mobile-document-path";
    identity.append(this.mobileTitle, this.mobilePath);
    const meta = document.createElement("div");
    meta.className = "mobile-document-meta";
    this.mobileActivity = document.createElement("span");
    this.mobileActivity.className = "mobile-document-activity";
    this.mobileActivity.setAttribute("role", "status");
    this.mobileActivity.setAttribute("aria-live", "polite");
    this.mobileCount = document.createElement("span");
    this.mobileCount.className = "mobile-document-count";
    meta.append(this.mobileActivity, this.mobileCount);

    this.mobileTools = this.mobileAction("Tools", "Show editing tools", () => {
      this.handlers.onRevealTools?.();
      this.host.dispatchEvent(new CustomEvent("mathdown:reveal-mobile-tools", { bubbles: true }));
    });
    this.mobileTools.classList.add("mobile-document-tools");
    this.mobileOverview = this.mobileAction("☰", "View all open tabs", () => {
      this.toggleOverview(this.mobileOverview);
    });
    this.mobileOverview.classList.add("mobile-document-tabs");
    this.mobileOverview.setAttribute("aria-haspopup", "dialog");
    this.mobileNew = this.mobileAction("+", "New tab", () => this.handlers.onNew());
    this.mobileNew.classList.add("mobile-document-new");
    const mobileActions = document.createElement("div");
    mobileActions.className = "mobile-document-actions";
    mobileActions.append(this.mobileTools, this.mobileOverview, this.mobileNew);
    this.mobileBar.append(identity, meta, mobileActions);

    this.announcer = document.createElement("span");
    this.announcer.className = "tab-announcer lib-sr-only";
    this.announcer.setAttribute("role", "status");
    this.announcer.setAttribute("aria-live", "polite");
    this.announcer.setAttribute("aria-atomic", "true");

    this.overviewPanel = document.createElement("div");
    this.overviewPanel.id = panelId;
    this.overviewPanel.className = "tab-overview-panel";
    this.overviewPanel.setAttribute("role", "dialog");
    this.overviewPanel.setAttribute("aria-label", "Open tabs");
    this.overviewPanel.hidden = true;
    this.overviewLauncher = this.overviewToggle;
    this.mobileOverview.setAttribute("aria-controls", panelId);
    this.mobileOverview.setAttribute("aria-expanded", "false");

    const header = document.createElement("div");
    header.className = "tab-overview-header";
    const title = document.createElement("strong");
    title.textContent = "Open tabs";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "tab-overview-dismiss";
    dismiss.setAttribute("aria-label", "Close open tabs menu");
    dismiss.title = "Close";
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => this.closeOverview(true));
    header.append(title, dismiss);

    this.overviewSearch = document.createElement("input");
    this.overviewSearch.type = "search";
    this.overviewSearch.className = "tab-overview-search";
    this.overviewSearch.placeholder = "Find an open tab…";
    this.overviewSearch.setAttribute("aria-label", "Find an open tab");
    this.overviewSearch.addEventListener("input", () => this.renderOverview());

    this.overviewCount = document.createElement("span");
    this.overviewCount.className = "tab-overview-count";
    this.overviewCount.setAttribute("role", "status");
    this.overviewCount.setAttribute("aria-live", "polite");

    this.overviewList = document.createElement("div");
    this.overviewList.className = "tab-overview-list";
    this.overviewList.setAttribute("role", "list");
    this.overviewList.setAttribute("aria-label", "Open documents");

    const footer = document.createElement("div");
    footer.className = "tab-overview-actions";
    this.closeCurrent = this.overviewAction("Close current", () => {
      if (!this.activeId) return;
      this.closeOverview(true);
      this.handlers.onClose(this.activeId);
    });
    this.closeCurrent.classList.add("tab-overview-close-current");
    this.closeOthers = this.overviewAction("Close others", () => {
      const closing = this.views.filter((view) => view.id !== this.activeId);
      this.requestBulkClose("others", closing);
    });
    this.closeOthers.classList.add("tab-overview-close-others");
    this.closeSaved = this.overviewAction("Close all saved", () => {
      this.requestBulkClose("saved", this.views.filter((view) => !view.dirty));
    });
    this.closeSaved.classList.add("tab-overview-close-saved");
    footer.append(this.closeCurrent, this.closeOthers, this.closeSaved);

    this.overviewPanel.append(
      header,
      this.overviewSearch,
      this.overviewCount,
      this.overviewList,
      footer,
    );

    this.host.replaceChildren(this.mobileBar, this.scroll, this.actions, this.announcer);
    // The panel is a body-level portal so the tab strip's intentional overflow
    // clipping cannot cut it off. Positioning remains anchored to the toggle.
    document.body.appendChild(this.overviewPanel);
    this.overviewSheet = new MobileSheetController(this.overviewPanel, {
      onDismiss: () => this.closeOverview(true),
    });

    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => {
        this.scheduleRevealActive();
        if (this.overviewOpen) this.positionOverview();
      });
      this.resizeObserver.observe(this.host);
      this.resizeObserver.observe(this.scroll);
    } else {
      this.resizeObserver = null;
    }
    window.addEventListener("resize", this.onWindowResize);
  }

  render(tabs: TabView[]): void {
    this.views = tabs.map((tab) => ({ ...tab }));
    this.overviewToggleCount.textContent = String(tabs.length);
    this.overviewToggle.title = `View all ${tabs.length} open ${tabs.length === 1 ? "tab" : "tabs"}`;
    this.announceDirtyState(tabs);
    const nextSignature = viewSignature(tabs);
    if (nextSignature === this.signature) return;
    this.signature = nextSignature;

    const nextIds = new Set(tabs.map((tab) => tab.id));
    for (const [id, parts] of this.parts) {
      if (nextIds.has(id)) continue;
      parts.item.remove();
      this.parts.delete(id);
    }

    tabs.forEach((view, index) => {
      const parts = this.parts.get(view.id) ?? this.createTab(view.id);
      this.parts.set(view.id, parts);
      this.updateTab(parts, view);

      // insertBefore is a no-op for nodes already at this position, preserving
      // focus during the frequent dirty/save notifications from the editor.
      const current = this.list.children.item(index);
      if (current !== parts.item) this.list.insertBefore(parts.item, current);
    });
    const nextActive = tabs.find((tab) => tab.active)?.id ?? null;
    if (nextActive !== this.activeId) {
      this.activeId = nextActive;
      this.scheduleRevealActive();
    }
    this.renderMobileBar();
    if (this.overviewOpen) this.renderOverview();
  }

  setActivity(activity: DocumentActivitySnapshot): void {
    this.activity = { ...activity };
    this.renderMobileBar();
  }

  /** Re-run active-tab containment after an external workspace transition. */
  revealActive(): void {
    this.scheduleRevealActive();
  }

  private announceDirtyState(tabs: TabView[]): void {
    const dirty = tabs.filter((tab) => tab.dirty);
    const signature = dirty.map((tab) => tab.id).sort().join("|");
    if (signature === this.dirtySignature) return;
    const hadDirtyTabs = this.dirtySignature.length > 0;
    this.dirtySignature = signature;
    if (dirty.length === 0) {
      if (hadDirtyTabs) this.announcer.textContent = "All open tabs are saved.";
      return;
    }
    this.announcer.textContent = dirty.length === 1
      ? `${dirty[0].path?.trim() || dirty[0].name} has unsaved changes.`
      : `${dirty.length} open tabs have unsaved changes.`;
  }

  destroy(): void {
    this.closeOverview(false);
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this.onWindowResize);
    this.overviewSheet.destroy();
    this.overviewPanel.remove();
  }

  private createTab(id: string): TabParts {
    const item = document.createElement("div");
    item.className = "tab-item";
    item.dataset.id = id;

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab";
    tab.dataset.id = id;
    tab.id = `document-tab-${id}`;
    tab.setAttribute("aria-controls", "editor-host");
    tab.setAttribute("aria-keyshortcuts", "Delete Backspace");
    tab.draggable = true;

    const label = document.createElement("span");
    label.className = "tab-label";
    const dirty = document.createElement("span");
    dirty.className = "tab-dirty";
    dirty.setAttribute("aria-hidden", "true");
    dirty.textContent = "●";
    tab.append(label, dirty);

    // The close affordance is a real sibling button, rather than an interactive
    // span nested in the role=tab button. This supplies a 24px pointer target and
    // an independent accessible name without invalid nested controls.
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    const closeGlyph = document.createElement("span");
    closeGlyph.setAttribute("aria-hidden", "true");
    closeGlyph.textContent = "×";
    close.appendChild(closeGlyph);

    item.append(tab, close);
    this.wireTab({ item, tab, label, dirty, close });
    return { item, tab, label, dirty, close };
  }

  private updateTab(parts: TabParts, view: TabView): void {
    const path = view.path?.trim() || view.name;
    parts.item.classList.toggle("is-active", view.active);
    parts.item.classList.toggle("is-dirty", view.dirty);
    parts.tab.classList.toggle("is-active", view.active);
    parts.tab.classList.toggle("is-dirty", view.dirty);
    if (view.active) parts.tab.setAttribute("aria-current", "page");
    else parts.tab.removeAttribute("aria-current");
    parts.tab.setAttribute("aria-label", `${path}${view.dirty ? ", unsaved changes" : ""}`);
    parts.tab.tabIndex = view.active ? 0 : -1;
    parts.tab.title = `${path}${view.dirty ? " · Unsaved changes" : ""} · Delete or Backspace to close`;
    if (parts.label.textContent !== view.name) parts.label.textContent = view.name;

    parts.close.tabIndex = view.active ? 0 : -1;
    parts.close.setAttribute(
      "aria-label",
      `Close ${path}${view.dirty ? ", unsaved changes" : ""}`,
    );
    parts.close.title = `Close ${path}`;
  }

  private wireTab(parts: TabParts): void {
    const id = () => parts.item.dataset.id ?? "";

    parts.tab.addEventListener("click", () => this.handlers.onSelect(id()));
    parts.close.addEventListener("click", () => this.handlers.onClose(id()));
    parts.tab.addEventListener("keydown", (event) => {
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        this.handlers.onClose(id());
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        this.moveFocus(id(), event.key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        this.focusBoundary(event.key === "Home" ? 0 : -1);
      }
    });

    parts.tab.addEventListener("mousedown", (event) => {
      // Middle-click closes; left-click selects (drag handled via dragstart).
      if (event.button === 1) {
        event.preventDefault();
        this.handlers.onClose(id());
      }
    });

    parts.tab.addEventListener("dragstart", (event) => {
      this.dragId = id();
      parts.item.classList.add("is-dragging");
      event.dataTransfer?.setData("text/plain", this.dragId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    parts.tab.addEventListener("dragend", () => {
      this.dragId = null;
      parts.item.classList.remove("is-dragging");
    });
    parts.item.addEventListener("dragover", (event) => {
      if (!this.dragId || this.dragId === id()) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    parts.item.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = this.dragId;
      if (!from || from === id()) return;
      const targetIndex = [...this.list.querySelectorAll<HTMLElement>(".tab-item")]
        .findIndex((element) => element.dataset.id === id());
      if (targetIndex >= 0) this.handlers.onReorder(from, targetIndex);
    });
  }

  private moveFocus(id: string, delta: number): void {
    const tabs = this.tabButtons();
    const current = tabs.findIndex((tab) => tab.dataset.id === id);
    if (current < 0 || tabs.length === 0) return;
    const next = (current + delta + tabs.length) % tabs.length;
    this.selectAndFocus(tabs[next].dataset.id ?? "");
  }

  private focusBoundary(index: 0 | -1): void {
    const tabs = this.tabButtons();
    const target = index === 0 ? tabs[0] : tabs[tabs.length - 1];
    if (target) this.selectAndFocus(target.dataset.id ?? "");
  }

  private selectAndFocus(id: string): void {
    if (!id) return;
    this.handlers.onSelect(id);
    // App selection deliberately focuses the editor. Arrow/Home/End navigation
    // is the exception: restore focus to the newly selected tab afterward.
    queueMicrotask(() => {
      const tab = this.parts.get(id)?.tab;
      if (!tab) return;
      tab.focus({ preventScroll: true });
      this.reveal(id);
    });
  }

  private reveal(id: string): void {
    const item = this.parts.get(id)?.item;
    if (item && typeof item.scrollIntoView === "function") {
      item.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    }
  }

  private scheduleRevealActive(): void {
    if (!this.activeId || this.revealScheduled) return;
    this.revealScheduled = true;
    queueMicrotask(() => {
      this.revealScheduled = false;
      if (this.activeId) this.reveal(this.activeId);
    });
  }

  private overviewAction(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab-overview-action";
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  private mobileAction(label: string, accessibleName: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mobile-document-action";
    button.textContent = label;
    button.title = accessibleName;
    button.setAttribute("aria-label", accessibleName);
    button.addEventListener("click", action);
    return button;
  }

  private toggleOverview(launcher: HTMLButtonElement): void {
    if (this.overviewOpen) this.closeOverview(true);
    else this.openOverview(launcher);
  }

  private openOverview(launcher: HTMLButtonElement): void {
    if (this.overviewOpen) return;
    this.overviewLauncher = launcher;
    this.overviewOpen = true;
    this.overviewPanel.hidden = false;
    this.overviewToggle.setAttribute("aria-expanded", "true");
    this.mobileOverview.setAttribute("aria-expanded", "true");
    this.overviewSearch.value = "";
    this.renderOverview();
    this.positionOverview();
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.addEventListener("keydown", this.onDocumentKeyDown, true);
    queueMicrotask(() => this.overviewSearch.focus());
  }

  private closeOverview(restoreFocus: boolean): void {
    if (!this.overviewOpen) return;
    this.overviewOpen = false;
    this.overviewSheet.deactivate();
    this.overviewPanel.hidden = true;
    this.overviewToggle.setAttribute("aria-expanded", "false");
    this.mobileOverview.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.removeEventListener("keydown", this.onDocumentKeyDown, true);
    if (restoreFocus) this.overviewLauncher.focus({ preventScroll: true });
  }

  private renderOverview(): void {
    const query = this.overviewSearch.value.trim().toLocaleLowerCase();
    const matching = this.views.filter((view) => {
      if (!query) return true;
      return view.name.toLocaleLowerCase().includes(query) ||
        (view.path ?? "").toLocaleLowerCase().includes(query);
    });

    const rows = matching.map((view) => {
      const row = document.createElement("div");
      row.className = "tab-overview-item";
      row.setAttribute("role", "listitem");
      row.classList.toggle("is-active", view.active);
      row.classList.toggle("is-dirty", view.dirty);

      const select = document.createElement("button");
      select.type = "button";
      select.className = "tab-overview-select";
      select.dataset.id = view.id;
      const path = view.path?.trim() || view.name;
      select.setAttribute(
        "aria-label",
        `Open ${path}${view.dirty ? ", unsaved changes" : ""}`,
      );
      if (view.active) select.setAttribute("aria-current", "page");

      const name = document.createElement("span");
      name.className = "tab-overview-name";
      name.textContent = view.name;
      select.appendChild(name);
      if (path !== view.name) {
        const context = document.createElement("span");
        context.className = "tab-overview-path";
        context.textContent = path;
        select.appendChild(context);
      }
      if (view.dirty) {
        const dirty = document.createElement("span");
        dirty.className = "tab-overview-dirty";
        dirty.setAttribute("aria-hidden", "true");
        dirty.textContent = "●";
        select.appendChild(dirty);
      }
      select.addEventListener("click", () => {
        this.closeOverview(false);
        this.handlers.onSelect(view.id);
      });
      row.appendChild(select);
      return row;
    });

    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "tab-overview-empty";
      empty.textContent = "No open tabs match.";
      this.overviewList.replaceChildren(empty);
    } else {
      this.overviewList.replaceChildren(...rows);
    }
    this.overviewCount.textContent = `${matching.length} of ${this.views.length} open tabs`;
    this.closeCurrent.disabled = !this.activeId;
    this.closeOthers.disabled = this.views.length <= 1 || !this.activeId;
    this.closeSaved.disabled = !this.views.some((view) => !view.dirty);
  }

  private requestBulkClose(mode: TabBulkCloseRequest["mode"], views: TabView[]): void {
    if (views.length === 0) return;
    const request: TabBulkCloseRequest = {
      mode,
      activeId: this.activeId,
      tabIds: views.map((view) => view.id),
      dirtyTabIds: views.filter((view) => view.dirty).map((view) => view.id),
    };
    this.closeOverview(true);
    if (this.handlers.onBulkClose) {
      void this.handlers.onBulkClose(request);
      return;
    }
    // Compatibility fallback. The application wiring should use onBulkClose so
    // dirty tabs receive one aggregate confirmation before any are discarded.
    request.tabIds.forEach((id) => this.handlers.onClose(id));
  }

  private positionOverview(): void {
    if (!this.overviewOpen) return;
    const phone = typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 599px)").matches
      : window.innerWidth < 600;
    if (phone) {
      this.overviewPanel.dataset.panelLayout = "sheet";
      this.overviewSheet.activate();
      return;
    }
    this.overviewSheet.deactivate();
    delete this.overviewPanel.dataset.panelLayout;
    const gutter = 8;
    const anchor = this.overviewLauncher.getBoundingClientRect();
    const panel = this.overviewPanel.getBoundingClientRect();
    const width = Math.min(Math.max(panel.width, 280), Math.max(0, window.innerWidth - gutter * 2));
    const height = Math.min(panel.height, Math.max(0, window.innerHeight - gutter * 2));
    const left = Math.min(
      Math.max(gutter, anchor.right - width),
      Math.max(gutter, window.innerWidth - width - gutter),
    );
    const below = anchor.bottom + 4;
    const top = below + height <= window.innerHeight - gutter
      ? below
      : Math.max(gutter, anchor.top - height - 4);
    this.overviewPanel.style.position = "fixed";
    this.overviewPanel.style.left = `${left}px`;
    this.overviewPanel.style.top = `${top}px`;
    this.overviewPanel.style.width = `${width}px`;
    this.overviewPanel.style.maxHeight = `${Math.max(0, window.innerHeight - top - gutter)}px`;
  }

  private readonly onWindowResize = (): void => {
    this.scheduleRevealActive();
    if (this.overviewOpen) this.positionOverview();
  };

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (
      this.overviewPanel.contains(target)
      || this.overviewToggle.contains(target)
      || this.mobileOverview.contains(target)
    ) return;
    this.closeOverview(false);
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Tab" && this.overviewPanel.dataset.panelLayout === "sheet") {
      containPanelFocus(this.overviewPanel, event);
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.closeOverview(true);
  };

  private tabButtons(): HTMLButtonElement[] {
    return [...this.list.querySelectorAll<HTMLButtonElement>(".tab")];
  }

  private renderMobileBar(): void {
    const active = this.views.find((view) => view.active) ?? null;
    const name = active?.name ?? this.activity?.name ?? "No document";
    const path = active?.path?.trim() || this.activity?.path?.trim() || name;
    const duplicate = this.views.filter((view) => view.name === name).length > 1;
    this.mobileTitle.textContent = name;
    this.mobileTitle.title = path;
    this.mobileTitle.setAttribute("aria-label", path);
    this.mobilePath.textContent = duplicate ? pathQualifier(path, name) : "";
    this.mobilePath.hidden = !duplicate || !this.mobilePath.textContent;
    this.mobileCount.textContent = `${this.views.length} open`;
    const state = this.activity?.saveState ?? (active?.dirty ? "dirty" : "saved");
    const labels: Record<string, string> = {
      dirty: "Changes pending",
      queued: "Changes pending",
      saving: "Saving…",
      saved: "Saved",
      conflict: "Sync failed",
      failed: "Sync failed",
    };
    this.mobileActivity.textContent = labels[state] ?? "";
    this.mobileActivity.dataset.state = state;
    this.mobileActivity.title = this.activity
      ? `${path} · ${labels[state] ?? state}`
      : `${path}${active?.dirty ? " · Changes pending" : " · Saved"}`;
  }
}

function pathQualifier(path: string, basename: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.at(-1) === basename) parts.pop();
  if (parts.length === 0) return "";
  return parts.slice(-2).join("/");
}

function containPanelFocus(panel: HTMLElement, event: KeyboardEvent): void {
  const controls = [...panel.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
  )].filter((element) => !element.closest("[hidden], [inert]"));
  if (controls.length === 0) return;
  const current = controls.indexOf(document.activeElement as HTMLElement);
  const atEnd = !event.shiftKey && current === controls.length - 1;
  const atStart = event.shiftKey && current <= 0;
  if (!atEnd && !atStart && current >= 0) return;
  event.preventDefault();
  controls[event.shiftKey ? controls.length - 1 : 0].focus({ preventScroll: true });
}
