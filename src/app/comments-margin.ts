import {
  HIGHLIGHT_COLORS,
  DEFAULT_COLOR,
  type Comment,
  type CommentKind,
  type HighlightColor,
  type Priority,
  type Reply,
  type ReviewStatus,
} from "../editor/comments";
import { MobileSheetController } from "./mobile-sheet";

export interface CommentsMarginHandlers {
  onFocus: (id: string) => void; // clicked a card → scroll doc to its anchor
  onResolve: (id: string, resolved: boolean) => void;
  onRemove: (id: string) => void;
  onReply: (id: string, body: string, kind: CommentKind) => void;
  onSetPriority: (id: string, priority?: Priority) => void;
  onSetStatus: (id: string, status: ReviewStatus) => void;
  onSetColor: (id: string, color: HighlightColor) => void;
  onSetBody: (id: string, body: string) => void;
  onVisibilityChange?: (visible: boolean) => void;
}

const PRIORITIES: Priority[] = ["P0", "P1", "P2", "P3"];

// Review cards that float in the right margin, each vertically aligned to the
// text it annotates (econagent-style). Cards are absolutely positioned inside
// the scrolling editor host, so they track the document as it scrolls; on doc
// edits / resize we recompute their tops and de-overlap them.
export class CommentsMargin {
  private readonly host: HTMLElement;
  private readonly handlers: CommentsMarginHandlers;
  private readonly cards = new Map<string, HTMLElement>();
  private comments: Comment[] = [];
  private anchorTop: (id: string) => number | null = () => null;
  private visible = false;
  private activeId: string | null = null;
  private signature = "";
  private connectors: SVGSVGElement | null = null;
  private followRaf = 0;
  private ro: ResizeObserver | null = null;
  private paperObserved = false;
  private readOnly = false;
  private canManageAll = true;
  private principalId: string | undefined;
  private readonly sheet: HTMLElement;
  private readonly sheetBody: HTMLElement;
  private readonly sheetCount: HTMLElement;
  private readonly sheetController: MobileSheetController;
  private readonly reviewLauncher: HTMLButtonElement;
  private sheetMinimized = false;
  private phoneMode = false;

  constructor(host: HTMLElement, handlers: CommentsMarginHandlers) {
    this.host = host;
    this.handlers = handlers;
    this.sheet = el("section", "comments-review-sheet");
    this.sheet.hidden = true;
    this.sheet.setAttribute("role", "dialog");
    this.sheet.setAttribute("aria-labelledby", "comments-review-title");
    const header = el("header", "comments-review-header");
    const heading = document.createElement("h2");
    heading.id = "comments-review-title";
    heading.textContent = "Comments";
    this.sheetCount = el("span", "comments-review-count");
    this.sheetCount.setAttribute("role", "status");
    this.sheetCount.setAttribute("aria-live", "polite");
    const minimize = btn("Minimize", () => this.minimizePhoneSheet());
    minimize.className = "comments-review-minimize";
    const close = btn("×", () => this.setVisible(false));
    close.className = "comments-review-close";
    close.setAttribute("aria-label", "Close comments");
    header.append(heading, this.sheetCount, minimize, close);
    this.sheetBody = el("div", "comments-review-list");
    this.sheet.append(header, this.sheetBody);
    document.body.appendChild(this.sheet);
    this.sheetController = new MobileSheetController(this.sheet, {
      onDismiss: () => this.minimizePhoneSheet(),
    });
    this.reviewLauncher = btn("Review comments", () => this.openPhoneSheet());
    this.reviewLauncher.className = "comments-review-launcher";
    this.reviewLauncher.hidden = true;
    document.body.appendChild(this.reviewLauncher);
    // Any resize of the editor pane (toggling a sidebar, window resize, a type-
    // size change) shifts the text column and the cards, so re-place + redraw.
    // Deferred to a frame so we never reflow inside the observer callback.
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => {
        if (this.visible) requestAnimationFrame(() => this.reposition());
      });
      this.ro.observe(this.host);
    }
  }

  setAnchorResolver(fn: (id: string) => number | null) {
    this.anchorTop = fn;
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.host.classList.toggle("comments-visible", visible);
    this.handlers.onVisibilityChange?.(visible);
    if (visible) {
      this.sheetMinimized = false;
      this.rebuild();
      requestAnimationFrame(() => this.reposition());
    } else {
      this.sheetController.deactivate();
      this.sheet.hidden = true;
      this.reviewLauncher.hidden = true;
      this.sheetMinimized = false;
      this.clear();
    }
  }

  get isVisible() {
    return this.visible;
  }

  setReadOnly(readOnly: boolean) {
    this.setAccess({ canComment: !readOnly, canManageAll: !readOnly });
  }

  setAccess(access: { canComment: boolean; canManageAll: boolean; principalId?: string }) {
    const readOnly = !access.canComment;
    if (
      this.readOnly === readOnly
      && this.canManageAll === access.canManageAll
      && this.principalId === access.principalId
    ) return;
    this.readOnly = readOnly;
    this.canManageAll = access.canManageAll;
    this.principalId = access.principalId;
    if (this.visible) this.rebuild();
  }

  // Called when the comment set changes; rebuilds only if content differs.
  render(comments: Comment[]) {
    this.comments = comments;
    if (!this.visible) return;
    const sig = JSON.stringify(
      comments.map((c) => [
        c.id,
        c.body,
        c.resolved,
        c.kind,
        c.replies.length,
        c.priority ?? "",
        c.status ?? "",
        c.color ?? "",
      ]),
    );
    if (sig !== this.signature) {
      this.signature = sig;
      this.rebuild();
    }
    requestAnimationFrame(() => this.reposition());
  }

  focus(id: string) {
    this.activeId = id;
    if (this.phoneMode && this.sheetMinimized) this.openPhoneSheet();
    for (const [cid, card] of this.cards) {
      card.classList.toggle("is-active", cid === id);
    }
    const card = this.cards.get(id);
    if (card) {
      const reducedMotion = typeof matchMedia === "function"
        && matchMedia("(prefers-reduced-motion: reduce)").matches;
      card.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
      this.pulse(id);
    }
    this.drawConnectors(); // refresh the active connector's emphasis
  }

  pulse(id: string) {
    const card = this.cards.get(id);
    if (!card) return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    card.classList.remove("is-flash");
    void card.offsetWidth; // restart the animation
    card.classList.add("is-flash");
  }

  // --- internal -----------------------------------------------------------
  private clear() {
    for (const card of this.cards.values()) card.remove();
    this.cards.clear();
    this.signature = "";
    this.connectors?.remove();
    this.connectors = null;
    if (this.followRaf) cancelAnimationFrame(this.followRaf);
    this.followRaf = 0;
  }

  private ensureConnectors(): SVGSVGElement {
    if (!this.connectors) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "comment-connectors");
      // behind the cards, above the text; never intercepts clicks
      this.host.insertBefore(svg, this.host.firstChild);
      this.connectors = svg;
    }
    return this.connectors;
  }

  // Draw a thin leader line from each card to the top of the text it annotates,
  // so the connection is clear even when a card is pushed down to avoid overlap.
  // All coordinates are taken from LIVE bounding rects (converted into the host's
  // scrolled content space, the same space `anchorTop` and the SVG use), so the
  // line tracks a card while it animates to a new position rather than snapping to
  // its destination ahead of it.
  private drawConnectors() {
    if (!this.visible) return;
    const svg = this.ensureConnectors();
    const paper = this.host.querySelector<HTMLElement>(".ProseMirror");
    const w = this.host.clientWidth;
    const h = this.host.scrollHeight;
    svg.setAttribute("width", `${w}`);
    svg.setAttribute("height", `${h}`);
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!paper) return;
    const NS = "http://www.w3.org/2000/svg";
    const hostRect = this.host.getBoundingClientRect();
    const sx = this.host.scrollLeft;
    const sy = this.host.scrollTop;
    const textRight = paper.getBoundingClientRect().right - hostRect.left + sx;
    for (const [id, card] of this.cards) {
      const anchorY = this.anchorTop(id);
      if (anchorY == null) continue;
      const cardRect = card.getBoundingClientRect();
      const x1 = textRight;
      const y1 = anchorY + 4; // near the top of the highlighted line
      const x2 = cardRect.left - hostRect.left + sx; // current left edge of the card
      const y2 = cardRect.top - hostRect.top + sy + 13; // near the card's header row
      const path = document.createElementNS(NS, "path");
      // gentle S-curve from the text edge to the card
      const dx = Math.max(12, (x2 - x1) / 2);
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
      path.setAttribute(
        "class",
        "comment-connector" + (id === this.activeId ? " is-active" : ""),
      );
      svg.appendChild(path);
    }
  }

  // Redraw connectors every frame for a short window so the lines follow the
  // cards' `top` CSS transition (and any resize-driven reflow) instead of jumping
  // ahead. Re-called reposition just restarts the window.
  private followConnectors(frames = 20) {
    if (this.followRaf) cancelAnimationFrame(this.followRaf);
    let remaining = frames;
    const step = () => {
      this.drawConnectors();
      if (--remaining > 0 && this.visible) {
        this.followRaf = requestAnimationFrame(step);
      } else {
        this.followRaf = 0;
      }
    };
    this.followRaf = requestAnimationFrame(step);
  }

  private rebuild() {
    this.clear();
    this.phoneMode = this.isPhone();
    this.host.classList.toggle("comments-phone", this.phoneMode);
    const target = this.phoneMode ? this.sheetBody : this.host;
    for (const c of this.comments) {
      const card = this.buildCard(c);
      this.cards.set(c.id, card);
      target.appendChild(card);
    }
    if (this.phoneMode) {
      const unresolved = this.comments.filter((comment) => comment.resolved !== true).length;
      this.sheetCount.textContent = `${unresolved} unresolved · ${this.comments.length} total`;
      if (!this.sheetMinimized) this.openPhoneSheet(false);
    } else {
      this.sheetController.deactivate();
      this.sheet.hidden = true;
      this.reviewLauncher.hidden = true;
    }
    if (this.activeId) this.focus(this.activeId);
  }

  // Below this pane width the side gutter would squeeze the text column, so the
  // cards fall back to a stacked list below the document (#I21).
  private static readonly NARROW_PX = 680;

  // Position each card at its anchor's top, pushing down to avoid overlap.
  reposition() {
    if (!this.visible) return;
    const phone = this.isPhone();
    if (phone !== this.phoneMode) {
      this.phoneMode = phone;
      this.rebuild();
      return;
    }
    if (phone) {
      this.host.classList.add("comments-phone", "comments-narrow");
      for (const card of this.cards.values()) card.style.top = "";
      this.connectors?.remove();
      this.connectors = null;
      this.sheetController.reposition();
      return;
    }
    // Observe the text column once it exists, so a reflow that changes its height
    // (e.g. a type-size change) also re-places the cards + lines.
    if (!this.paperObserved && this.ro) {
      const paper = this.host.querySelector<HTMLElement>(".ProseMirror");
      if (paper) {
        this.ro.observe(paper);
        this.paperObserved = true;
      }
    }
    // Narrow pane → stacked list below the doc: cards go to CSS `position: static`
    // (which ignores `top`), no reserved gutter, no leader lines.
    const narrow = this.host.clientWidth < CommentsMargin.NARROW_PX;
    this.host.classList.toggle("comments-narrow", narrow);
    if (narrow) {
      // stacked list: mark the first card (for the divider), clear absolute tops
      const cards = [...this.cards.values()];
      cards.forEach((c, i) => {
        c.style.top = "";
        c.classList.toggle("is-first-narrow", i === 0);
      });
      if (this.followRaf) cancelAnimationFrame(this.followRaf);
      this.followRaf = 0;
      this.connectors?.remove();
      this.connectors = null;
      return;
    }
    for (const [, card] of this.cards) card.classList.remove("is-first-narrow");
    const gap = 10;
    const entries = [...this.cards.entries()]
      .map(([id, card]) => ({ id, card, top: this.anchorTop(id) ?? 0 }))
      .sort((a, b) => a.top - b.top);
    let cursor = 0;
    for (const { card, top } of entries) {
      const y = Math.max(top, cursor);
      card.style.top = `${y}px`;
      cursor = y + card.offsetHeight + gap;
    }
    this.followConnectors();
  }

  private buildCard(c: Comment): HTMLElement {
    const color = c.color ?? DEFAULT_COLOR;
    const card = el("div", `comment-card comment-card-${c.kind} comment-card-color-${color}`);
    card.classList.toggle("is-read-only", this.readOnly);
    const canManage = this.canManageAll || Boolean(this.principalId && c.principalId === this.principalId);
    card.classList.toggle("is-reply-only", !this.readOnly && !canManage);
    if (c.resolved) card.classList.add("is-resolved");
    if (c.orphaned) card.classList.add("is-orphaned");
    card.dataset.cardId = c.id;
    card.addEventListener("click", (e) => {
      // Focus the card unless a control was clicked.
      const t = e.target as HTMLElement;
      if (t.closest("button, textarea, input, select, a")) return;
      this.handlers.onFocus(c.id);
      if (this.phoneMode) this.minimizePhoneSheet();
    });

    const head = el("div", "cc-head");
    head.append(badge(c.kind), authorEl(c.author), this.colorDots(c), this.prioritySelect(c));
    card.appendChild(head);

    if (c.orphaned) {
      const warning = el("div", "cc-orphan-warning");
      warning.textContent = "Anchor not found · review text was preserved";
      warning.setAttribute("role", "status");
      card.appendChild(warning);
    }

    if (c.body.trim()) {
      card.appendChild(bodyEl(c.body));
    } else {
      // Bare highlight — offer to add a note in place.
      const add = btn("＋ Add note", () => this.openNote(card, c.id));
      add.className = "cc-add-note";
      card.appendChild(add);
    }

    for (const r of c.replies) card.appendChild(replyEl(r));

    if (c.status && c.status !== "open") card.appendChild(statusChip(c.status));

    const actions = el("div", "cc-actions");
    const resolve = btn(c.resolved ? "Reopen" : "Resolve", () =>
      this.handlers.onResolve(c.id, !c.resolved),
    );
    const reply = btn("Reply", () => this.toggleReply(card, c.id));
    reply.classList.add("cc-reply");
    actions.append(resolve, reply);
    // Accept / reject a still-open AI suggestion.
    if (c.kind === "ai" && (c.status ?? "open") === "open") {
      const accept = btn("Accept", () => this.handlers.onSetStatus(c.id, "accepted"));
      accept.classList.add("cc-accept");
      const reject = btn("Reject", () => this.handlers.onSetStatus(c.id, "rejected"));
      reject.classList.add("cc-reject");
      actions.append(accept, reject);
    }
    const del = btn("Delete", () => this.handlers.onRemove(c.id));
    del.classList.add("cc-delete");
    actions.append(del);
    card.appendChild(actions);

    if (this.readOnly) {
      for (const control of card.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("button, input, textarea, select")) {
        control.disabled = true;
      }
    } else if (!canManage) {
      for (const control of card.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("button, input, textarea, select")) {
        if (!control.classList.contains("cc-reply")) control.disabled = true;
      }
    }

    return card;
  }

  private isPhone(): boolean {
    return typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 599px)").matches
      : window.innerWidth < 600;
  }

  private openPhoneSheet(focus = true): void {
    if (!this.visible || !this.isPhone()) return;
    this.phoneMode = true;
    this.sheetMinimized = false;
    this.reviewLauncher.hidden = true;
    this.sheet.hidden = false;
    this.sheetController.activate();
    if (focus) {
      const target = this.activeId ? this.cards.get(this.activeId) : null;
      (target ?? this.sheet.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
    }
  }

  private minimizePhoneSheet(): void {
    if (!this.visible || !this.phoneMode) return;
    this.sheetMinimized = true;
    this.sheetController.deactivate();
    this.sheet.hidden = true;
    this.reviewLauncher.hidden = false;
    const unresolved = this.comments.filter((comment) => !comment.resolved).length;
    this.reviewLauncher.textContent = `${unresolved} comments`;
    this.reviewLauncher.setAttribute(
      "aria-label",
      `Review comments, ${unresolved} unresolved`,
    );
    this.reviewLauncher.focus({ preventScroll: true });
  }

  // A row of colour dots to recolour the highlight (Paperpile-style).
  private colorDots(c: Comment): HTMLElement {
    const current = c.color ?? DEFAULT_COLOR;
    const row = el("div", "cc-colors");
    for (const color of HIGHLIGHT_COLORS) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = `cc-color cc-color-${color}${color === current ? " is-selected" : ""}`;
      dot.title = color;
      dot.addEventListener("mousedown", (e) => e.stopPropagation());
      dot.addEventListener("click", () => this.handlers.onSetColor(c.id, color));
      row.appendChild(dot);
    }
    return row;
  }

  // Inline editor to add the first note to a bare highlight.
  private openNote(card: HTMLElement, id: string) {
    if (card.querySelector(".cc-note-box")) return;
    const addBtn = card.querySelector(".cc-add-note");
    const box = el("div", "cc-note-box");
    const ta = document.createElement("textarea");
    ta.rows = 2;
    ta.placeholder = "Add a note…";
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        box.remove();
        if (addBtn instanceof HTMLElement) addBtn.hidden = false;
      }
    });
    const commit = () => {
      const body = ta.value.trim();
      if (body) this.handlers.onSetBody(id, body);
    };
    const row = el("div", "cc-reply-actions");
    row.append(btn("Save", commit));
    box.append(ta, row);
    if (addBtn instanceof HTMLElement) addBtn.hidden = true;
    card.appendChild(box);
    ta.focus();
    this.reposition();
  }

  private prioritySelect(c: Comment): HTMLElement {
    const sel = document.createElement("select");
    sel.className = "cc-priority";
    if (c.priority) sel.classList.add(`cc-priority-${c.priority}`);
    const none = new Option("—", "");
    sel.add(none);
    for (const p of PRIORITIES) sel.add(new Option(p, p));
    sel.value = c.priority ?? "";
    sel.addEventListener("change", () =>
      this.handlers.onSetPriority(c.id, (sel.value || undefined) as Priority | undefined),
    );
    // Don't let selecting fire the card's focus handler.
    sel.addEventListener("mousedown", (e) => e.stopPropagation());
    return sel;
  }

  private toggleReply(card: HTMLElement, id: string) {
    const existing = card.querySelector(".cc-reply-box");
    if (existing) {
      existing.remove();
      return;
    }
    const box = el("div", "cc-reply-box");
    const ta = document.createElement("textarea");
    ta.rows = 2;
    ta.placeholder = "Reply…";
    const row = el("div", "cc-reply-actions");
    const submit = (kind: CommentKind) => {
      const body = ta.value.trim();
      if (body) this.handlers.onReply(id, body, kind);
    };
    const me = btn("Reply", () => submit("user"));
    const ai = btn("As AI", () => submit("ai"));
    ai.classList.add("as-ai");
    row.append(me, ai);
    box.append(ta, row);
    card.appendChild(box);
    ta.focus();
    this.reposition();
  }
}

// --- small DOM helpers ----------------------------------------------------
function el(tag: string, className: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = className;
  return n;
}
function badge(kind: CommentKind): HTMLElement {
  const b = el("span", `cc-badge cc-badge-${kind}`);
  b.textContent = kind === "ai" ? "AI" : "You";
  return b;
}
function authorEl(author: string): HTMLElement {
  const a = el("span", "cc-author");
  a.textContent = author;
  return a;
}
function bodyEl(text: string): HTMLElement {
  const b = el("div", "cc-body");
  b.textContent = text;
  return b;
}
function replyEl(r: Reply): HTMLElement {
  const wrap = el("div", `cc-reply cc-reply-${r.kind}`);
  wrap.append(badge(r.kind), bodyEl(r.body));
  return wrap;
}
function statusChip(status: ReviewStatus): HTMLElement {
  const chip = el("span", `cc-status cc-status-${status}`);
  chip.textContent = status === "accepted" ? "✓ Accepted" : "✗ Rejected";
  return chip;
}
function btn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
