import type { EditorView } from "prosemirror-view";
import {
  HIGHLIGHT_COLORS,
  DEFAULT_COLOR,
  type CommentKind,
  type HighlightColor,
} from "../editor/comments";

export interface SelectionAdd {
  kind: CommentKind;
  body: string;
  color: HighlightColor;
}

export interface SelectionPopoverRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SelectionPopoverViewport extends SelectionPopoverRect {
  width: number;
  height: number;
}

/** Place a selection action inside the visual viewport, preferring above. */
export function selectionPopoverPosition(
  anchor: SelectionPopoverRect,
  size: { width: number; height: number },
  viewport: SelectionPopoverViewport,
  gutter = 8,
  gap = 8,
): { left: number; top: number; placement: "above" | "below" } {
  const minLeft = viewport.left + gutter;
  const maxLeft = Math.max(minLeft, viewport.right - gutter - size.width);
  const centred = (anchor.left + anchor.right - size.width) / 2;
  const left = clamp(centred, minLeft, maxLeft);
  const minTop = viewport.top + gutter;
  const maxTop = Math.max(minTop, viewport.bottom - gutter - size.height);
  const above = anchor.top - gap - size.height;
  const below = anchor.bottom + gap;
  const placement = above >= minTop || below + size.height > viewport.bottom - gutter
    ? "above"
    : "below";
  return {
    left,
    top: clamp(placement === "above" ? above : below, minTop, maxTop),
    placement,
  };
}

// Paperpile-style: select text and a row of colour swatches appears. Click a
// swatch to highlight instantly (no note needed); click the note button to add
// a note as well. Highlighting is the primary action; the note is optional.
export class SelectionPopover {
  readonly dom: HTMLElement;
  private readonly onAdd: (add: SelectionAdd) => void;
  private readonly bar: HTMLElement;
  private readonly composer: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private composing = false;
  private color: HighlightColor = DEFAULT_COLOR;
  private kind: CommentKind = "user";
  private readOnly = false;
  private anchor: SelectionPopoverRect | null = null;
  private view: EditorView | null = null;
  private obscured = false;
  private repositionFrame = 0;
  private compositionDocument: EditorView["state"]["doc"] | null = null;

  constructor(onAdd: (add: SelectionAdd) => void) {
    this.onAdd = onAdd;
    this.dom = document.createElement("div");
    this.dom.className = "selection-popover";
    this.dom.hidden = true;
    this.dom.setAttribute("aria-label", "Selection actions");
    // Keep the editor selection while interacting with the pill.
    this.dom.addEventListener("pointerdown", (e) => {
      // Preventing a touch pointerdown suppresses the synthesized click in
      // WebKit. ProseMirror retains its state selection when a touch control
      // receives focus, so only mouse/pen interactions need this guard.
      if (
        e.pointerType !== "touch"
        && (e.target as HTMLElement).tagName.toLowerCase() !== "textarea"
      ) {
        e.preventDefault();
      }
    });

    // --- primary bar: colour swatches + "note" -----------------------------
    this.bar = document.createElement("div");
    this.bar.className = "sp-bar";
    this.bar.setAttribute("role", "toolbar");
    this.bar.setAttribute("aria-label", "Highlight selected text");
    for (const c of HIGHLIGHT_COLORS) {
      this.bar.appendChild(
        swatch(c, () => this.onAdd({ kind: "user", body: "", color: c })),
      );
    }
    const note = document.createElement("button");
    note.type = "button";
    note.className = "sp-note";
    note.title = "Add a note";
    // A thin outline speech-mark icon + label — quiet but a touch more polished
    // than a bare word.
    note.append(
      commentIcon(),
      Object.assign(document.createElement("span"), { textContent: "Note" }),
    );
    note.addEventListener("click", () => this.startComposing("user", this.color));
    this.bar.appendChild(note);

    // --- composer: pick colour, type a note --------------------------------
    this.composer = document.createElement("div");
    this.composer.className = "sp-composer";
    this.composer.hidden = true;
    this.composer.setAttribute("role", "group");
    this.composer.setAttribute("aria-label", "Add a comment to selected text");

    const swatchRow = document.createElement("div");
    swatchRow.className = "sp-composer-swatches";
    for (const c of HIGHLIGHT_COLORS) {
      const s = swatch(c, () => this.selectColor(c, swatchRow));
      s.dataset.color = c;
      swatchRow.appendChild(s);
    }

    this.textarea = document.createElement("textarea");
    this.textarea.rows = 2;
    this.textarea.placeholder = "Add a note…";
    this.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.reset();
      }
    });

    const row = document.createElement("div");
    row.className = "sp-composer-actions";
    const send = button("Comment", () => this.submit());
    const ai = button("As AI", () => {
      this.kind = "ai";
      this.submit();
    });
    ai.classList.add("as-ai");
    row.append(send, ai);
    this.composer.append(swatchRow, this.textarea, row);

    this.dom.append(this.bar, this.composer);
    window.addEventListener("resize", this.scheduleReposition, { passive: true });
    window.addEventListener("scroll", this.scheduleReposition, { passive: true, capture: true });
    window.visualViewport?.addEventListener("resize", this.scheduleReposition, { passive: true });
    window.visualViewport?.addEventListener("scroll", this.scheduleReposition, { passive: true });
  }

  private selectColor(c: HighlightColor, row: HTMLElement) {
    this.color = c;
    for (const s of Array.from(row.children) as HTMLElement[]) {
      s.classList.toggle("is-selected", s.dataset.color === c);
    }
  }

  private startComposing(kind: CommentKind, color: HighlightColor) {
    this.composing = true;
    this.compositionDocument = this.view?.state.doc ?? null;
    this.kind = kind;
    this.color = color;
    this.bar.hidden = true;
    this.composer.hidden = false;
    this.textarea.value = "";
    const row = this.composer.querySelector<HTMLElement>(".sp-composer-swatches");
    if (row) this.selectColor(color, row);
    // Keep the selected passage stationary while the phone keyboard opens.
    // Mobile CSS guarantees a 16px editing surface, preventing iOS Safari's
    // separate focus-zoom heuristic from changing the visual viewport scale.
    this.textarea.focus({ preventScroll: true });
    this.scheduleReposition();
  }

  private submit() {
    const body = this.textarea.value.trim();
    this.onAdd({ kind: this.kind, body, color: this.color });
    this.reset();
    this.hide();
  }

  private reset() {
    this.composing = false;
    this.compositionDocument = null;
    this.kind = "user";
    this.bar.hidden = false;
    this.composer.hidden = true;
    this.textarea.value = "";
    this.scheduleReposition();
  }

  update(view: EditorView) {
    this.view = view;
    if (this.composing && !this.compositionMatches(view)) this.reset();
    if (this.readOnly || this.editorUnavailable()) {
      this.dom.hidden = true;
      return;
    }
    if (this.composing) return; // keep the composer put while typing
    const sel = view.state.selection;
    const { from, to, empty } = sel;
    // Only for real text selections — not a selected equation node, and not
    // when a math editor's own input owns the selection.
    const isNodeSelection = "node" in sel;
    const active = document.activeElement;
    const inEquationInput =
      active instanceof HTMLElement &&
      (active.classList.contains("ime-input") ||
        active.tagName.toLowerCase() === "math-field");
    if (empty || from === to || isNodeSelection || inEquationInput) {
      this.hide();
      return;
    }
    this.refreshAnchor(view);
    this.dom.hidden = false;
    this.scheduleReposition();
  }

  hide() {
    if (this.composing) return;
    this.dom.hidden = true;
  }

  setReadOnly(readOnly: boolean) {
    this.readOnly = readOnly;
    if (readOnly) {
      this.reset();
      this.dom.hidden = true;
    }
  }

  setObscured(obscured: boolean): void {
    this.obscured = obscured;
    if (obscured) {
      this.dom.hidden = true;
      return;
    }
    if (!this.view) return;
    if (this.composing && !this.compositionMatches(this.view)) this.reset();
    if (this.view.state.selection.empty) return;
    if (this.composing) {
      this.dom.hidden = false;
      this.scheduleReposition();
    } else {
      this.update(this.view);
    }
  }

  private readonly scheduleReposition = () => {
    if (this.repositionFrame) return;
    this.repositionFrame = requestAnimationFrame(() => {
      this.repositionFrame = 0;
      this.reposition();
    });
  };

  private reposition(): void {
    if (this.editorUnavailable()) {
      this.dom.hidden = true;
      return;
    }
    if (this.view && !this.view.state.selection.empty) this.refreshAnchor(this.view);
    if (this.dom.hidden || !this.anchor) return;
    const rect = this.dom.getBoundingClientRect();
    const visual = window.visualViewport;
    const left = visual?.offsetLeft ?? 0;
    const top = visual?.offsetTop ?? 0;
    const width = visual?.width ?? window.innerWidth;
    const height = visual?.height ?? window.innerHeight;
    const position = selectionPopoverPosition(
      this.anchor,
      { width: rect.width, height: rect.height },
      { left, top, right: left + width, bottom: top + height, width, height },
    );
    this.dom.style.left = `${Math.round(position.left)}px`;
    this.dom.style.top = `${Math.round(position.top)}px`;
    this.dom.dataset.placement = position.placement;
  }

  private editorUnavailable(): boolean {
    const editor = this.view?.dom;
    return this.obscured
      || !editor?.isConnected
      || Boolean(editor.closest("[hidden], [inert]"));
  }

  private compositionMatches(view: EditorView): boolean {
    return this.compositionDocument === view.state.doc;
  }

  private refreshAnchor(view: EditorView): void {
    const { from, to } = view.state.selection;
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    this.anchor = {
      left: Math.min(start.left, end.left),
      top: Math.min(start.top, end.top),
      right: Math.max(start.right, end.right),
      bottom: Math.max(start.bottom, end.bottom),
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function swatch(color: HighlightColor, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `sp-swatch sp-swatch-${color}`;
  b.title = `Highlight ${color}`;
  b.setAttribute("aria-label", `Highlight ${color}`);
  b.addEventListener("click", onClick);
  return b;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// A minimalist thin-stroke speech-mark, monochrome (inherits text colour).
function commentIcon(): SVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.3");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", "M2 3.5h12v8H6.5L3.5 14v-2.5H2z");
  svg.appendChild(p);
  return svg;
}
