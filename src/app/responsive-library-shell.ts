export const LIBRARY_DRAWER_BREAKPOINT = 800;

export interface ResponsiveLibraryShellHandlers {
  requestClose(restoreLauncherFocus?: boolean): void | Promise<void>;
  onLayoutChange?(drawerOpen: boolean): void;
}

/**
 * Keeps the responsive Library drawer's chrome and accessibility state in sync
 * with LibraryView. LibraryView remains the source of truth for visibility and
 * persistence; this controller owns only viewport-specific shell behaviour.
 */
export class ResponsiveLibraryShell {
  private visible = false;
  private drawerActive = false;
  private lastInteractionWasKeyboard = false;
  private inertBackground: Array<{ element: HTMLElement; wasInert: boolean }> = [];
  private readonly media: MediaQueryList;

  constructor(
    private readonly workspace: HTMLElement,
    private readonly library: HTMLElement,
    private readonly trigger: HTMLButtonElement,
    private readonly scrim: HTMLButtonElement,
    private readonly handlers: ResponsiveLibraryShellHandlers,
    matchMedia: (query: string) => MediaQueryList = window.matchMedia.bind(window),
  ) {
    this.media = matchMedia(`(max-width: ${LIBRARY_DRAWER_BREAKPOINT - 1}px)`);
    this.scrim.addEventListener("click", this.onScrimClick);
    this.library.tabIndex = -1;
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("mousedown", this.onDocumentMouseDown, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    this.media.addEventListener?.("change", this.onMediaChange);
    this.sync(false);
  }

  get narrow(): boolean {
    return this.media.matches;
  }

  sync(visible: boolean): void {
    const wasDrawerOpen = this.drawerActive;
    const shouldRestoreLauncher = this.visible
      && !visible
      && this.narrow
      && this.library.dataset.restoreLauncherFocus === "true";
    delete this.library.dataset.restoreLauncherFocus;
    this.visible = visible;
    const drawerOpen = visible && this.narrow;
    this.workspace.classList.toggle("library-drawer-open", drawerOpen);
    this.library.classList.toggle("is-drawer", this.narrow);
    this.scrim.hidden = !drawerOpen;
    // Pointer users can dismiss through the scrim; keyboard users have the
    // explicit close button and Escape. Keeping the scrim out of the tab order
    // prevents focus from stepping outside the drawer at its final control.
    this.scrim.tabIndex = -1;
    this.trigger.classList.toggle("active", visible);
    this.trigger.setAttribute("aria-expanded", String(visible));
    if (drawerOpen) this.activateDrawerBackground();
    else this.restoreDrawerBackground();
    this.drawerActive = drawerOpen;
    this.handlers.onLayoutChange?.(drawerOpen);
    if (drawerOpen && !wasDrawerOpen) this.focusDrawer();
    if (shouldRestoreLauncher) this.trigger.focus({ preventScroll: true });
  }

  destroy(): void {
    this.scrim.removeEventListener("click", this.onScrimClick);
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("mousedown", this.onDocumentMouseDown, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.media.removeEventListener?.("change", this.onMediaChange);
    this.restoreDrawerBackground();
    this.drawerActive = false;
    this.workspace.classList.remove("library-drawer-open");
    this.library.classList.remove("is-drawer");
    this.scrim.hidden = true;
    this.scrim.tabIndex = -1;
  }

  private readonly onMediaChange = () => this.sync(this.visible);

  private readonly onScrimClick = () => {
    if (!this.visible || !this.narrow) return;
    void this.handlers.requestClose(true);
    this.trigger.focus({ preventScroll: true });
  };

  private readonly onPointerDown = () => {
    this.lastInteractionWasKeyboard = false;
  };

  private readonly onDocumentMouseDown = (event: MouseEvent) => {
    if (!this.visible || !this.narrow) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (
      this.library.contains(target)
      || this.trigger.contains(target)
      || this.scrim.contains(target)
      || target.closest('.dialog-overlay, [role="dialog"]:not([hidden])')
    ) return;
    // Toolbar controls live outside #workspace, and therefore outside the
    // scrim. Treat their activation as an ordinary outside click while leaving
    // the event untouched so the requested panel/action can still open.
    void this.handlers.requestClose(false);
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) {
      this.lastInteractionWasKeyboard = true;
    }
    if (!this.visible || !this.narrow) return;
    if (event.key === "Tab" && !this.hasNestedDialog()) {
      this.containFocus(event);
      return;
    }
    if (event.key !== "Escape") return;
    // A nested dialog or toolbar panel owns the first Escape.
    if (this.hasNestedDialog()) return;
    event.preventDefault();
    void this.handlers.requestClose(true);
    this.trigger.focus({ preventScroll: true });
  };

  private activateDrawerBackground(): void {
    if (this.inertBackground.length > 0) return;
    for (const child of this.workspace.children) {
      if (!(child instanceof HTMLElement) || child === this.library || child === this.scrim) continue;
      this.inertBackground.push({ element: child, wasInert: child.hasAttribute("inert") });
      child.setAttribute("inert", "");
    }
  }

  private restoreDrawerBackground(): void {
    for (const { element, wasInert } of this.inertBackground) {
      if (wasInert) element.setAttribute("inert", "");
      else element.removeAttribute("inert");
    }
    this.inertBackground = [];
  }

  private focusDrawer(): void {
    if (this.lastInteractionWasKeyboard) {
      const preferred = this.library.querySelector<HTMLElement>(".lib-drawer-close");
      (preferred ?? this.drawerFocusables()[0])?.focus({ preventScroll: true });
      return;
    }
    // Pointer/touch opening should announce the drawer without painting a large
    // keyboard focus ring around its close button. The first Tab still moves to
    // that button through containFocus; keyboard-triggered opening focuses it
    // immediately above.
    this.library.focus({ preventScroll: true });
  }

  private containFocus(event: KeyboardEvent): void {
    const focusables = this.drawerFocusables();
    if (focusables.length === 0) return;
    const active = document.activeElement;
    const current = active instanceof HTMLElement ? focusables.indexOf(active) : -1;
    const next = event.shiftKey
      ? current <= 0 ? focusables.length - 1 : current - 1
      : current < 0 || current >= focusables.length - 1 ? 0 : current + 1;
    // Drive the complete focus cycle ourselves. WebKit's default Tab policy
    // may skip buttons depending on the platform keyboard-navigation setting,
    // which would otherwise send focus to the document body.
    event.preventDefault();
    focusables[next].focus({ preventScroll: true });
  }

  private drawerFocusables(): HTMLElement[] {
    const selector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const jsdom = /jsdom/i.test(elementUserAgent(this.library));
    return [...this.library.querySelectorAll<HTMLElement>(selector)].filter((element) => {
      if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      if (style?.display === "none" || style?.visibility === "hidden") return false;
      // CSS-only collapsed controls have no layout box. JSDOM deliberately has
      // no layout engine, so its unit fixtures rely on the semantic checks above.
      return jsdom || element.getClientRects().length > 0;
    });
  }

  private hasNestedDialog(): boolean {
    return [...document.querySelectorAll<HTMLElement>('.dialog-overlay, [role="dialog"]:not([hidden])')]
      .some((dialog) => dialog !== this.library);
  }
}

function elementUserAgent(element: Element): string {
  return element.ownerDocument.defaultView?.navigator.userAgent ?? "";
}
