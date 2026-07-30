import { MobileSheetController } from "./mobile-sheet";

export interface AnchoredPanelOptions {
  /** Synchronize panel contents immediately before it becomes visible. */
  beforeOpen?: () => void;
  /** Select the control that receives focus after the panel opens. */
  initialFocus?: () => HTMLElement | null;
  onOpen?: () => void;
  onClose?: () => void;
  /** Viewports below this width use the phone bottom-sheet placement. */
  narrowBreakpoint?: number;
  /** A mounted modal owns outside clicks and Escape until it is dismissed. */
  nestedDialogSelector?: string;
  /** Optional visual anchor; ARIA ownership always remains on the launcher. */
  positioningAnchor?: () => Element | DOMRect | null;
}

const DEFAULT_NESTED_DIALOG = ".dialog-overlay, [aria-modal='true']";
let activePanel: AnchoredPanelController | null = null;

/**
 * Shared lifecycle, placement, focus, and ARIA behavior for toolbar panels.
 * Only one anchored panel is open at a time; modal dialogs mounted by a panel
 * temporarily take ownership of outside clicks and Escape.
 */
export class AnchoredPanelController {
  private readonly options: Required<Pick<AnchoredPanelOptions, "narrowBreakpoint" | "nestedDialogSelector">>
    & Omit<AnchoredPanelOptions, "narrowBreakpoint" | "nestedDialogSelector">;
  private destroyed = false;
  private lastAnchorRect: DOMRect | null = null;
  private readonly generatedClose: HTMLButtonElement | null;
  private readonly mobileSheet: MobileSheetController;

  constructor(
    readonly launcher: HTMLButtonElement,
    readonly panel: HTMLElement,
    options: AnchoredPanelOptions = {},
  ) {
    this.options = {
      narrowBreakpoint: options.narrowBreakpoint ?? 600,
      nestedDialogSelector: options.nestedDialogSelector ?? DEFAULT_NESTED_DIALOG,
      beforeOpen: options.beforeOpen,
      initialFocus: options.initialFocus,
      onOpen: options.onOpen,
      onClose: options.onClose,
      positioningAnchor: options.positioningAnchor,
    };
    if (!panel.id) throw new Error("An anchored panel requires a stable id");
    panel.hidden = true;
    panel.classList.add("anchored-panel");
    if (panel.querySelector(".config-close, [data-anchored-panel-close]")) {
      this.generatedClose = null;
    } else {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "anchored-panel-mobile-close";
      close.dataset.anchoredPanelClose = "";
      close.setAttribute("aria-label", "Close panel");
      close.tabIndex = -1;
      close.textContent = "×";
      close.addEventListener("click", this.onMobileClose);
      panel.prepend(close);
      this.generatedClose = close;
    }
    launcher.setAttribute("aria-controls", panel.id);
    launcher.setAttribute("aria-haspopup", "dialog");
    launcher.setAttribute("aria-expanded", "false");
    launcher.addEventListener("click", this.onLauncherClick);
    this.mobileSheet = new MobileSheetController(panel, {
      onDismiss: () => this.close(),
    });
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  open(): void {
    if (this.destroyed || this.isOpen) return;
    if (activePanel && activePanel !== this) activePanel.close(false);
    activePanel = this;
    this.options.beforeOpen?.();
    // A hidden element has no useful box. Reveal invisibly, measure and place,
    // then expose it to avoid a frame at its stale/default coordinates.
    this.panel.style.visibility = "hidden";
    this.panel.hidden = false;
    this.launcher.classList.add("active");
    this.launcher.setAttribute("aria-expanded", "true");
    this.reposition();
    this.panel.style.removeProperty("visibility");
    document.addEventListener("mousedown", this.onOutside, true);
    document.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.onResize);
    window.visualViewport?.addEventListener("resize", this.onResize);
    window.visualViewport?.addEventListener("scroll", this.onResize);
    this.options.onOpen?.();
    (this.options.initialFocus?.() ?? firstFocusable(this.panel) ?? this.panel).focus();
  }

  close(restoreFocus = true): void {
    if (!this.isOpen) return;
    this.mobileSheet.deactivate();
    this.panel.hidden = true;
    this.panel.removeAttribute("data-panel-layout");
    this.launcher.classList.remove("active");
    this.launcher.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", this.onOutside, true);
    document.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.onResize);
    window.visualViewport?.removeEventListener("resize", this.onResize);
    window.visualViewport?.removeEventListener("scroll", this.onResize);
    if (activePanel === this) activePanel = null;
    this.options.onClose?.();
    if (restoreFocus && this.launcher.isConnected) {
      // Narrow toolbar overflow moves the real launcher into a menu that closes
      // as its panel opens. Focusing a descendant of that now-hidden menu drops
      // focus to <body>; restore to the visible More trigger instead.
      const fallbackId = this.launcher.dataset.anchoredPanelFocusFallback;
      const fallback = fallbackId ? document.getElementById(fallbackId) : null;
      const target = this.launcher.closest("[hidden]") && fallback instanceof HTMLElement
        ? fallback
        : this.launcher;
      target.focus({ preventScroll: true });
    }
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  reposition(): void {
    if (!this.isOpen) return;
    const viewport = viewportBox();
    const gutter = 8;
    this.panel.style.right = "auto";
    this.panel.style.bottom = "auto";
    if (viewport.width < this.options.narrowBreakpoint) {
      if (this.generatedClose) this.generatedClose.tabIndex = 0;
      this.panel.dataset.panelLayout = "sheet";
      this.mobileSheet.activate();
      return;
    }

    this.mobileSheet.deactivate();
    if (this.generatedClose) this.generatedClose.tabIndex = -1;
    delete this.panel.dataset.panelLayout;
    this.panel.style.removeProperty("width");
    this.panel.style.removeProperty("max-width");
    const candidate = this.options.positioningAnchor?.() ?? this.launcher;
    const measuredAnchor = candidate instanceof Element ? candidate.getBoundingClientRect() : candidate;
    if (measuredAnchor && (measuredAnchor.width > 0 || measuredAnchor.height > 0)) {
      this.lastAnchorRect = measuredAnchor;
    }
    const anchor = this.lastAnchorRect ?? this.launcher.getBoundingClientRect();
    const panel = this.panel.getBoundingClientRect();
    const minLeft = viewport.left + gutter;
    const maxLeft = Math.max(minLeft, viewport.right - gutter - panel.width);
    const left = clamp(anchor.right - panel.width, minLeft, maxLeft);
    const below = anchor.bottom + 6;
    const above = anchor.top - 6 - panel.height;
    const maxTop = Math.max(viewport.top + gutter, viewport.bottom - gutter - panel.height);
    const top = below + panel.height <= viewport.bottom - gutter
      ? below
      : above >= viewport.top + gutter ? above : clamp(below, viewport.top + gutter, maxTop);
    this.panel.style.left = `${Math.round(left)}px`;
    this.panel.style.top = `${Math.round(top)}px`;
    this.panel.style.maxHeight = `${Math.max(0, Math.round(viewport.bottom - gutter - top))}px`;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.close(false);
    this.destroyed = true;
    this.launcher.removeEventListener("click", this.onLauncherClick);
    this.launcher.removeAttribute("aria-controls");
    this.launcher.removeAttribute("aria-haspopup");
    this.launcher.removeAttribute("aria-expanded");
    this.panel.classList.remove("anchored-panel");
    this.mobileSheet.destroy();
    this.generatedClose?.removeEventListener("click", this.onMobileClose);
    this.generatedClose?.remove();
  }

  private hasNestedDialog(): boolean {
    return Boolean(document.querySelector(this.options.nestedDialogSelector));
  }

  private readonly onLauncherClick = () => this.toggle();
  private readonly onMobileClose = () => this.close();

  private readonly onOutside = (event: MouseEvent) => {
    if (this.hasNestedDialog()) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (!this.panel.contains(target) && !this.launcher.contains(target)) this.close();
  };

  private readonly onKey = (event: KeyboardEvent) => {
    if (
      event.key === "Tab"
      && this.panel.dataset.panelLayout === "sheet"
      && !this.hasNestedDialog()
    ) {
      containFocus(this.panel, event);
      return;
    }
    if (event.key !== "Escape" || this.hasNestedDialog()) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  private readonly onResize = () => this.reposition();
}

function containFocus(panel: HTMLElement, event: KeyboardEvent): void {
  const focusables = [...panel.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
    "textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
  )].filter((element) => {
    if (element.tabIndex < 0 || element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    return style?.display !== "none" && style?.visibility !== "hidden";
  });
  if (!focusables.length) return;
  const current = focusables.indexOf(document.activeElement as HTMLElement);
  if (current < 0) {
    event.preventDefault();
    focusables[event.shiftKey ? focusables.length - 1 : 0].focus({ preventScroll: true });
    return;
  }
  if (!event.shiftKey && current !== focusables.length - 1) return;
  if (event.shiftKey && current > 0) return;
  event.preventDefault();
  focusables[event.shiftKey ? focusables.length - 1 : 0].focus({ preventScroll: true });
}

function firstFocusable(panel: HTMLElement): HTMLElement | null {
  const candidates = panel.querySelectorAll<HTMLElement>(
    "[autofocus], button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
    "textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
  );
  return [...candidates].find((element) =>
    !element.classList.contains("anchored-panel-mobile-close")
    || panel.dataset.panelLayout === "sheet") ?? null;
}

function viewportBox(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
  const visual = window.visualViewport;
  const left = visual?.offsetLeft ?? 0;
  const top = visual?.offsetTop ?? 0;
  const width = visual?.width ?? window.innerWidth;
  const height = visual?.height ?? window.innerHeight;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
