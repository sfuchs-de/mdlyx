interface OverflowItem {
  button: HTMLButtonElement;
  label: string;
  placeholder: Comment;
}

/** Moves low-frequency toolbar actions into the real narrow-screen More menu. */
export class ToolbarOverflow {
  private readonly items: OverflowItem[];
  private readonly media: MediaQueryList;
  private pointerInsideMenu = false;

  constructor(
    private readonly trigger: HTMLButtonElement,
    private readonly host: HTMLElement,
    private readonly menu: HTMLElement,
    actions: Array<{ button: HTMLButtonElement; label: string }>,
    matchMedia: (query: string) => MediaQueryList = window.matchMedia.bind(window),
  ) {
    this.items = actions.map(({ button, label }) => {
      const placeholder = document.createComment(`toolbar-${button.id}`);
      button.before(placeholder);
      return { button, label, placeholder };
    });
    this.media = matchMedia("(max-width: 799px)");
    this.trigger.addEventListener("click", this.onTrigger);
    this.trigger.addEventListener("keydown", this.onTriggerKey);
    this.menu.addEventListener("click", this.onMenuClick);
    this.menu.addEventListener("mousedown", this.onMenuMouseDown, true);
    document.addEventListener("mouseup", this.onDocumentMouseUp, true);
    this.menu.addEventListener("keydown", this.onMenuKey);
    this.menu.addEventListener("focusout", this.onFocusOut);
    document.addEventListener("mousedown", this.onOutside, true);
    document.addEventListener("keydown", this.onKey, true);
    this.media.addEventListener?.("change", this.onMediaChange);
    this.sync();
  }

  destroy(): void {
    this.close(false);
    this.trigger.removeEventListener("click", this.onTrigger);
    this.trigger.removeEventListener("keydown", this.onTriggerKey);
    this.menu.removeEventListener("click", this.onMenuClick);
    this.menu.removeEventListener("mousedown", this.onMenuMouseDown, true);
    document.removeEventListener("mouseup", this.onDocumentMouseUp, true);
    this.menu.removeEventListener("keydown", this.onMenuKey);
    this.menu.removeEventListener("focusout", this.onFocusOut);
    document.removeEventListener("mousedown", this.onOutside, true);
    document.removeEventListener("keydown", this.onKey, true);
    this.media.removeEventListener?.("change", this.onMediaChange);
    for (const item of this.items) item.placeholder.replaceWith(item.button);
  }

  private sync(): void {
    this.close(false);
    if (this.media.matches) {
      this.host.hidden = false;
      for (const item of this.items) {
        item.button.classList.add("tb-overflow-action");
        item.button.setAttribute("role", "menuitem");
        item.button.dataset.overflowLabel = item.label;
        item.button.dataset.anchoredPanelFocusFallback = this.trigger.id;
        this.menu.append(item.button);
      }
      return;
    }
    this.host.hidden = true;
    for (const item of this.items) {
      item.button.classList.remove("tb-overflow-action");
      item.button.removeAttribute("role");
      delete item.button.dataset.overflowLabel;
      delete item.button.dataset.anchoredPanelFocusFallback;
      item.placeholder.after(item.button);
    }
  }

  private readonly onMediaChange = () => this.sync();

  private readonly onTrigger = () => {
    if (this.menu.hidden) this.open();
    else this.close(true);
  };

  private readonly onTriggerKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (this.menu.hidden) this.open();
    const items = this.menuItems();
    items[event.key === "ArrowUp" ? items.length - 1 : 0]?.focus({ preventScroll: true });
  };

  private open(): void {
    this.menu.hidden = false;
    this.trigger.classList.add("active");
    this.trigger.setAttribute("aria-expanded", "true");
    this.menu.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }

  private close(restoreFocus: boolean): void {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.trigger.classList.remove("active");
    this.trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) this.trigger.focus({ preventScroll: true });
  }

  private readonly onMenuClick = (event: MouseEvent) => {
    if (!(event.target as HTMLElement).closest("button")) return;
    // The action's own listener runs before bubbling reaches the menu.
    this.close(false);
  };

  private readonly onMenuKey = (event: KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = this.menuItems();
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus({ preventScroll: true });
  };

  private readonly onFocusOut = () => {
    // WebKit does not focus buttons on pointer click. Its focusout can run
    // between mousedown and click; hiding the menu there removes the target and
    // cancels the launcher's click. The menu's click handler owns that path.
    if (this.pointerInsideMenu) return;
    queueMicrotask(() => {
      if (!this.host.contains(document.activeElement)) this.close(false);
    });
  };

  private readonly onMenuMouseDown = () => {
    this.pointerInsideMenu = true;
  };

  private readonly onDocumentMouseUp = () => {
    if (!this.pointerInsideMenu) return;
    window.setTimeout(() => {
      this.pointerInsideMenu = false;
      if (!this.host.contains(document.activeElement) && !this.menu.hidden) this.close(false);
    }, 0);
  };

  private readonly onOutside = (event: MouseEvent) => {
    if (this.menu.hidden) return;
    const target = event.target as Node;
    if (!this.host.contains(target)) this.close(false);
  };

  private readonly onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || this.menu.hidden) return;
    event.preventDefault();
    this.close(true);
  };

  private menuItems(): HTMLButtonElement[] {
    return [...this.menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])')];
  }
}
