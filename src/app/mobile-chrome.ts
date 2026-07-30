const PHONE_QUERY = "(max-width: 599px)";
const DOWN_COLLAPSE_PX = 48;
const UP_REVEAL_PX = 16;

export interface MobileChromeOptions {
  matchMedia?: (query: string) => MediaQueryList;
  blockerSelector?: string;
}

/** Reading-first phone chrome. It reacts to deliberate scroll travel rather
 * than individual wheel/touch events, and never hides controls while an
 * interactive overlay or editor is active. */
export class MobileChromeController {
  private readonly media: MediaQueryList;
  private readonly blockerSelector: string;
  private readonly observer: MutationObserver | null;
  private lastTop = 0;
  private downTravel = 0;
  private upTravel = 0;
  private collapsed = false;
  private destroyed = false;

  constructor(
    private readonly app: HTMLElement,
    private readonly toolbar: HTMLElement,
    private readonly scroller: HTMLElement,
    options: MobileChromeOptions = {},
  ) {
    const matcher = options.matchMedia ?? window.matchMedia.bind(window);
    this.media = matcher(PHONE_QUERY);
    this.blockerSelector = options.blockerSelector ?? [
      "body.mobile-sheet-open",
      ".library-drawer-open",
      ".tab-overview-panel:not([hidden])",
      ".dialog-overlay",
      ".selection-popover:not([hidden])",
      ".math-display.is-editing",
      ".math-inline.is-editing",
      "math-field:focus-within",
    ].join(",");
    this.lastTop = scroller.scrollTop;
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
    toolbar.addEventListener("focusin", this.onToolbarFocus);
    app.addEventListener("mathdown:reveal-mobile-tools", this.onRevealRequest);
    this.media.addEventListener?.("change", this.onMediaChange);
    this.observer = typeof MutationObserver === "function"
      ? new MutationObserver(this.onMutation)
      : null;
    this.observer?.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "aria-modal"],
    });
    this.syncViewport();
  }

  get isCollapsed(): boolean {
    return this.collapsed;
  }

  reveal(): void {
    this.resetTravel();
    this.setCollapsed(false);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.toolbar.removeEventListener("focusin", this.onToolbarFocus);
    this.app.removeEventListener("mathdown:reveal-mobile-tools", this.onRevealRequest);
    this.media.removeEventListener?.("change", this.onMediaChange);
    this.observer?.disconnect();
    this.setCollapsed(false);
    this.app.classList.remove("is-phone-layout");
  }

  private readonly onScroll = () => {
    if (!this.media.matches) return;
    const top = Math.max(0, this.scroller.scrollTop);
    const delta = top - this.lastTop;
    this.lastTop = top;
    if (top <= 1 || this.hasBlocker() || this.needsAttention()) {
      this.reveal();
      return;
    }
    if (Math.abs(delta) < 0.5) return;
    if (delta > 0) {
      this.downTravel += delta;
      this.upTravel = 0;
      if (!this.collapsed && this.downTravel >= DOWN_COLLAPSE_PX) this.setCollapsed(true);
    } else {
      this.upTravel += -delta;
      this.downTravel = 0;
      if (this.collapsed && this.upTravel >= UP_REVEAL_PX) this.setCollapsed(false);
    }
  };

  private readonly onToolbarFocus = () => this.reveal();
  private readonly onRevealRequest = () => this.reveal();
  private readonly onMediaChange = () => this.syncViewport();
  private readonly onMutation = () => {
    if (!this.media.matches) return;
    if (this.hasBlocker() || this.needsAttention()) this.reveal();
  };

  private syncViewport(): void {
    this.app.classList.toggle("is-phone-layout", this.media.matches);
    this.lastTop = this.scroller.scrollTop;
    this.resetTravel();
    if (!this.media.matches || this.scroller.scrollTop <= 1) this.setCollapsed(false);
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed && this.media.matches;
    this.app.classList.toggle("mobile-chrome-collapsed", this.collapsed);
    this.toolbar.setAttribute("aria-hidden", String(this.collapsed));
    if (this.collapsed) this.toolbar.setAttribute("inert", "");
    else this.toolbar.removeAttribute("inert");
  }

  private resetTravel(): void {
    this.downTravel = 0;
    this.upTravel = 0;
  }

  private hasBlocker(): boolean {
    if (this.toolbar.contains(document.activeElement)) return true;
    try {
      return Boolean(document.querySelector(this.blockerSelector));
    } catch {
      return false;
    }
  }

  private needsAttention(): boolean {
    const status = this.toolbar.querySelector<HTMLElement>("#file-status");
    const normalized = status?.textContent?.trim().toLocaleLowerCase() ?? "";
    return normalized.includes("failed")
      || Boolean(this.toolbar.querySelector(".update-available, [data-needs-attention='true']"));
  }
}

export interface VisualViewportTraceEntry {
  at: number;
  reason: string;
  scale: number;
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
  focused: string;
}

/** Opt-in iPhone diagnostic (`?viewportTrace=1`). Nothing is transmitted; the
 * bounded trace is exposed only in the local page for inspection/export. */
export function installVisualViewportTrace(): () => void {
  const enabled = new URLSearchParams(window.location.search).get("viewportTrace") === "1";
  const viewport = window.visualViewport;
  if (!enabled || !viewport) return () => undefined;
  const entries: VisualViewportTraceEntry[] = [];
  const tracedWindow = window as unknown as {
    __mathdownVisualViewportTrace?: VisualViewportTraceEntry[];
  };
  tracedWindow.__mathdownVisualViewportTrace = entries;
  const capture = (reason: string) => {
    const focused = document.activeElement;
    entries.push({
      at: Date.now(),
      reason,
      scale: viewport.scale,
      width: viewport.width,
      height: viewport.height,
      offsetLeft: viewport.offsetLeft,
      offsetTop: viewport.offsetTop,
      focused: focused instanceof HTMLElement
        ? `${focused.tagName.toLocaleLowerCase()}${focused.id ? `#${focused.id}` : ""}${focused.className ? `.${String(focused.className).trim().replaceAll(/\s+/g, ".")}` : ""}`
        : "",
    });
    if (entries.length > 120) entries.splice(0, entries.length - 120);
  };
  const onResize = () => capture("resize");
  const onScroll = () => capture("scroll");
  const onFocus = () => capture("focus");
  const onOrientation = () => capture("orientation");
  viewport.addEventListener("resize", onResize);
  viewport.addEventListener("scroll", onScroll);
  document.addEventListener("focusin", onFocus, true);
  window.addEventListener("orientationchange", onOrientation);
  capture("start");
  return () => {
    viewport.removeEventListener("resize", onResize);
    viewport.removeEventListener("scroll", onScroll);
    document.removeEventListener("focusin", onFocus, true);
    window.removeEventListener("orientationchange", onOrientation);
    delete tracedWindow.__mathdownVisualViewportTrace;
  };
}
