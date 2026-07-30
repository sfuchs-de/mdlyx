let activeSheet: MobileSheetController | null = null;

export interface MobileSheetOptions {
  onDismiss: () => void;
  app?: HTMLElement | null;
}

/**
 * Shared modal chrome for phone bottom sheets. The owned panel remains in
 * charge of its content and focus order; this controller supplies the scrim,
 * safe visual-viewport placement, and background inertness.
 */
export class MobileSheetController {
  private readonly scrim: HTMLButtonElement;
  private readonly app: HTMLElement | null;
  private active = false;
  private appWasInert = false;
  private previousModal: string | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    private readonly panel: HTMLElement,
    private readonly options: MobileSheetOptions,
  ) {
    this.app = options.app ?? document.getElementById("app");
    this.scrim = document.createElement("button");
    this.scrim.type = "button";
    this.scrim.className = "mobile-sheet-scrim";
    this.scrim.tabIndex = -1;
    this.scrim.setAttribute("aria-label", "Close panel");
    this.scrim.hidden = true;
    this.scrim.addEventListener("click", this.onScrimClick);
    document.body.appendChild(this.scrim);
  }

  get isActive(): boolean {
    return this.active;
  }

  activate(): void {
    if (this.active) {
      this.reposition();
      return;
    }
    if (activeSheet && activeSheet !== this) activeSheet.options.onDismiss();
    activeSheet = this;
    this.active = true;
    this.previousModal = this.panel.getAttribute("aria-modal");
    this.panel.setAttribute("aria-modal", "true");
    this.panel.dataset.mobileSheet = "true";
    this.scrim.hidden = false;
    document.body.classList.add("mobile-sheet-open");
    if (this.app && !this.app.contains(this.panel)) {
      this.appWasInert = this.app.hasAttribute("inert");
      this.app.setAttribute("inert", "");
    }
    this.reposition();
    document.addEventListener("keydown", this.onKeyDown, true);
    window.visualViewport?.addEventListener("resize", this.onViewportChange);
    window.visualViewport?.addEventListener("scroll", this.onViewportChange);
    if (!this.resizeObserver && typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.reposition());
    }
    this.resizeObserver?.observe(this.panel);
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    delete this.panel.dataset.mobileSheet;
    if (this.previousModal == null) this.panel.removeAttribute("aria-modal");
    else this.panel.setAttribute("aria-modal", this.previousModal);
    this.previousModal = null;
    this.scrim.hidden = true;
    if (this.app && !this.appWasInert) this.app.removeAttribute("inert");
    this.appWasInert = false;
    if (activeSheet === this) activeSheet = null;
    if (!activeSheet) document.body.classList.remove("mobile-sheet-open");
    document.removeEventListener("keydown", this.onKeyDown, true);
    window.visualViewport?.removeEventListener("resize", this.onViewportChange);
    window.visualViewport?.removeEventListener("scroll", this.onViewportChange);
    this.resizeObserver?.disconnect();
  }

  reposition(): void {
    if (!this.active) return;
    const visual = window.visualViewport;
    const left = visual?.offsetLeft ?? 0;
    const top = visual?.offsetTop ?? 0;
    // Some Chromium/WebKit zoom combinations report both the visual viewport
    // and inner size a fraction larger than the actual layout viewport. Clamp
    // to all three so rounding can never leave a sheet a sub-pixel outside the
    // visible edge.
    const layoutWidth = document.documentElement.clientWidth || window.innerWidth;
    const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
    const width = Math.min(
      visual?.width ?? window.innerWidth,
      window.innerWidth,
      layoutWidth,
    );
    const height = Math.min(
      visual?.height ?? window.innerHeight,
      window.innerHeight,
      layoutHeight,
    );
    const gutter = 8;
    // Linux WebKit can expose each viewport metric about one physical-pixel
    // larger than Playwright's requested layout viewport. Floor the usable
    // box and retain one CSS pixel of rounding reserve, keeping the intended
    // gutter even when every observable metric shares that discrepancy.
    const roundingReserve = 1;
    const maxWidth = Math.max(0, Math.floor(width - gutter * 2) - roundingReserve);
    const maxHeight = Math.max(0, Math.floor(height - gutter * 2) - roundingReserve);
    this.panel.style.left = `${Math.ceil(left + gutter)}px`;
    this.panel.style.width = `${maxWidth}px`;
    this.panel.style.maxWidth = `${maxWidth}px`;
    this.panel.style.maxHeight = `${maxHeight}px`;
    const measured = Math.min(this.panel.getBoundingClientRect().height, maxHeight);
    this.panel.style.top = `${Math.max(
      Math.ceil(top + gutter),
      Math.floor(top + height - gutter - measured) - 1,
    )}px`;
  }

  destroy(): void {
    this.deactivate();
    this.scrim.removeEventListener("click", this.onScrimClick);
    this.scrim.remove();
  }

  private readonly onScrimClick = () => this.options.onDismiss();
  private readonly onViewportChange = () => this.reposition();
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.active || this.hasNestedDialog()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.options.onDismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = [...this.panel.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    )].filter((element) => !element.closest("[hidden], [inert], [aria-hidden='true']"));
    if (focusables.length === 0) return;
    const current = focusables.indexOf(document.activeElement as HTMLElement);
    const wrapForward = !event.shiftKey && current === focusables.length - 1;
    const wrapBack = event.shiftKey && current <= 0;
    if (!wrapForward && !wrapBack && current >= 0) return;
    event.preventDefault();
    focusables[event.shiftKey ? focusables.length - 1 : 0].focus({ preventScroll: true });
  };

  private hasNestedDialog(): boolean {
    return [...document.querySelectorAll<HTMLElement>(".dialog-overlay, [aria-modal='true']")]
      .some((element) => element !== this.panel && !element.hidden);
  }
}
