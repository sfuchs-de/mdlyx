import type { Node as PMNode } from "prosemirror-model";
import type { Decoration, EditorView, NodeView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import type { MathfieldElement } from "mathlive";
import { renderKatex } from "./render-katex";
import { InlineMathEditor } from "./inline-math-editor";
import { perf } from "../../perf/instrument";

export type MacrosProvider = () => Record<string, string>;
// "elements" = fluid in-place element-by-element editing (KaTeX + overlay input).
// "mathlive" = the full WYSIWYG MathLive field for the whole equation.
export type EditMode = "elements" | "mathlive";
export type EditModeProvider = () => EditMode;

// The single math node currently in live-editing mode, if any. The save path
// calls commitActiveMath() so an in-progress edit is flushed before serializing
// (#I05).
let activeMathView: MathView | null = null;
export function commitActiveMath(): void {
  activeMathView?.forceCommit();
}

/** Persist a genuinely edited live value without closing the active NodeView. */
export function checkpointActiveMath(): void {
  activeMathView?.checkpoint();
}

// Commit the active equation when the user mouses down anywhere outside it (the
// element editor keeps focus in a plain <input>, so clicking away must close it
// explicitly — relying on the input's blur alone mis-fires on transient focus
// changes and can discard a just-opened empty equation).
export function commitActiveMathIfOutside(target: EventTarget | null): void {
  const v = activeMathView;
  if (!v) return;
  if (target instanceof Node && v.dom.contains(target)) return;
  v.forceCommit();
}

// A single NodeView shared by inline and display math. It renders cheap static
// KaTeX while idle and only instantiates a MathLive field for the equation the
// user is actively editing — never for the hundreds of others in the document.
export class MathView implements NodeView {
  dom: HTMLElement;
  private node: PMNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly getMacros: MacrosProvider;
  private readonly getEditMode: EditModeProvider;
  private readonly displayMode: boolean;

  private field: MathfieldElement | null = null;
  private inline: InlineMathEditor | null = null;
  private editing = false;
  // When the caret arrows into the equation, where MathLive's caret should land.
  private pendingCaret: "start" | "end" | null = null;
  // Guards the re-entrant commit path (blur → deselect → commit).
  private committing = false;
  private mathLiveLoading = false;
  // MathLive may canonicalize source merely by assigning field.value. Opening
  // and closing an equation must not turn that normalization into a document
  // edit; persist only after a real input event.
  private userEdited = false;
  private decorations: readonly Decoration[];
  private overflowObserver: ResizeObserver | null = null;
  private overflowFrame = 0;

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    getMacros: MacrosProvider,
    decorations: readonly Decoration[],
    getEditMode: EditModeProvider = () => "elements",
  ) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.getMacros = getMacros;
    this.getEditMode = getEditMode;
    this.decorations = decorations;
    this.displayMode = node.type.name === "math_display";

    this.dom = document.createElement(this.displayMode ? "div" : "span");
    this.dom.className = this.displayMode ? "math-display" : "math-inline";
    this.dom.setAttribute("data-math", "");
    this.syncAnchorId();
    // Let keyboard commands reach this NodeView instance from the DOM node.
    (this.dom as unknown as { __mathView: MathView }).__mathView = this;
    // A real click opens the editor (works even when the node is already
    // selected). Keyboard selection only highlights — see selectNode().
    this.dom.addEventListener("click", () => {
      if (!this.editing) this.activate();
    });
    // Double-click always opens the full (MathLive) editor, regardless of mode
    // — escalating from the inline element editor if it opened on the first click.
    this.dom.addEventListener("dblclick", (e) => {
      e.preventDefault();
      if (this.inline) this.escalateToFull();
      else if (!this.editing) void this.activateFull();
    });
    this.renderStatic();
  }

  // --- static (idle) rendering -------------------------------------------
  private renderStatic() {
    this.overflowObserver?.disconnect();
    this.overflowObserver = null;
    if (this.overflowFrame) cancelAnimationFrame(this.overflowFrame);
    this.overflowFrame = 0;
    this.dom.textContent = "";
    const mount = document.createElement(this.displayMode ? "div" : "span");
    this.dom.appendChild(mount);
    const latex = this.node.attrs.latex as string;
    if (latex.trim() === "") {
      // Empty equation: show a placeholder so it stays clickable.
      mount.className = "math-empty";
      mount.textContent = this.displayMode ? "( empty equation )" : "( … )";
      return;
    }
    // Display math scrolls on this inner element (see .math-body in styles.css)
    // so the absolutely-positioned equation number never scrolls into the formula.
    if (this.displayMode) {
      mount.className = "math-body";
    }
    renderKatex(
      latex,
      mount,
      this.displayMode,
      this.getMacros(),
      this.node.attrs.env as string,
    );
    if (this.displayMode) {
      this.decorateDisplay();
      let fitFactor = 1;
      const syncOverflow = () => {
        if (this.overflowFrame) cancelAnimationFrame(this.overflowFrame);
        this.overflowFrame = requestAnimationFrame(() => {
          this.overflowFrame = 0;
          if (!mount.isConnected || this.editing || mount.clientWidth <= 0) return;
          const naturalWidth = mount.scrollWidth / fitFactor;
          const floor = window.matchMedia?.("(max-width: 599px)").matches ? 0.88 : 0.94;
          const ratio = naturalWidth > 0 ? (mount.clientWidth - 1) / naturalWidth : 1;
          const nextFactor = naturalWidth > mount.clientWidth + 1
            ? Math.max(floor, Math.min(1, ratio))
            : 1;
          if (Math.abs(nextFactor - fitFactor) > 0.002) {
            fitFactor = nextFactor;
            mount.style.setProperty("--math-fit-factor", fitFactor.toFixed(4));
          }
          mount.classList.toggle("is-fitted", fitFactor < 0.998);
          // Reading after the custom-property write forces the final KaTeX box
          // into this decision, avoiding a one-frame false scrollbar.
          const overflowing = mount.scrollWidth > mount.clientWidth + 1;
          mount.classList.toggle("is-overflowing", overflowing);
          if (overflowing) {
            mount.tabIndex = 0;
            mount.setAttribute("role", "region");
            mount.setAttribute("aria-label", "Scrollable display equation");
          } else {
            mount.removeAttribute("tabindex");
            mount.removeAttribute("role");
            mount.removeAttribute("aria-label");
            mount.scrollLeft = 0;
          }
        });
      };
      syncOverflow();
      void document.fonts?.ready.then(syncOverflow);
      if (typeof ResizeObserver !== "undefined") {
        this.overflowObserver = new ResizeObserver(syncOverflow);
        this.overflowObserver.observe(mount);
        const renderedMath = mount.querySelector<HTMLElement>(".katex");
        if (renderedMath) this.overflowObserver.observe(renderedMath);
      }
    }
  }

  // The number assigned by the numbering plugin, delivered via decoration spec.
  private eqNumber(): string | null {
    for (const d of this.decorations) {
      const spec = d.spec as { eqNumber?: string };
      if (spec.eqNumber != null) return spec.eqNumber;
    }
    return null;
  }

  private syncAnchorId() {
    this.dom.id = this.displayMode ? String(this.node.attrs.label ?? "") : "";
  }

  // Show the computed equation number on numbered display equations.
  private decorateDisplay() {
    const num = this.eqNumber();
    if (num == null) return;
    const tag = document.createElement("span");
    tag.className = "math-number";
    tag.textContent = `(${num})`;
    this.dom.appendChild(tag);
  }

  // --- editing (active) state --------------------------------------------
  // Entry point: pick the editor for the current mode. Double-click bypasses
  // this and always calls activateFull().
  activate() {
    if (this.editing) return;
    if (this.getEditMode() === "mathlive") void this.activateFull();
    else this.activateInline();
  }

  // Seamless entry: the text caret arrowed into this equation. Open the editor
  // and land the caret at the entering edge so traversal feels continuous.
  enterFromArrow(edge: "start" | "end") {
    if (this.editing) return;
    this.pendingCaret = edge;
    this.activate();
  }

  private beginEditing() {
    this.overflowObserver?.disconnect();
    this.overflowObserver = null;
    if (this.overflowFrame) cancelAnimationFrame(this.overflowFrame);
    this.overflowFrame = 0;
    this.editing = true;
    this.userEdited = false;
    activeMathView = this;
    perf.mathActivated();
    this.dom.classList.add("is-editing");
    this.dom.textContent = "";
  }

  // Fluid element-by-element editing: one real KaTeX render, a transparent
  // input over just the active element, cursor navigation between elements.
  private activateInline() {
    const edge = this.pendingCaret ?? "start";
    this.pendingCaret = null;
    this.beginEditing();
    const inline = new InlineMathEditor(this.dom, this.node.attrs.latex as string, {
      displayMode: this.displayMode,
      getMacros: this.getMacros,
      env: this.displayMode ? (this.node.attrs.env as string) : undefined,
      onChange: () => { this.userEdited = true; },
      onExit: (dir) => {
        this.finishEdit(inline.value());
        this.moveSelectionOut(dir);
      },
      onDone: () => this.finishEdit(inline.value()),
    });
    this.inline = inline;
    // Keep the equation number visible while editing so the design is unchanged.
    if (this.displayMode) this.decorateDisplay();
    requestAnimationFrame(() => inline.start(edge));
  }

  // Commit the inline editor's value and reopen the equation in MathLive.
  private escalateToFull() {
    const v = this.inline?.value() ?? (this.node.attrs.latex as string);
    this.finishEdit(v);
    requestAnimationFrame(() => void this.activateFull());
  }

  // Full WYSIWYG editor (MathLive) for the whole equation.
  private async activateFull() {
    if ((this.editing && !this.inline) || this.mathLiveLoading) return;
    if (!customElements.get("math-field")) {
      this.mathLiveLoading = true;
      try {
        await import("mathlive");
      } catch (error) {
        console.error("[mathlive] full equation editor could not be loaded", error);
        this.renderStatic();
        return;
      } finally {
        this.mathLiveLoading = false;
      }
    }
    if (this.editing && !this.inline) return; // activated while the chunk loaded
    if (this.inline) {
      this.inline.destroy();
      this.inline = null;
    }
    this.beginEditing();

    // Imported lazily so the custom element registers before first use.
    const MathfieldCtor = customElements.get(
      "math-field",
    ) as (new () => MathfieldElement) | undefined;
    const field = (
      MathfieldCtor
        ? new MathfieldCtor()
        : document.createElement("math-field")
    ) as MathfieldElement;

    field.value = this.node.attrs.latex as string;
    // We manage focus/commit ourselves; keep MathLive's own menus minimal.
    field.mathVirtualKeyboardPolicy = "manual";
    this.field = field;
    this.dom.appendChild(field);

    field.addEventListener("beforeinput", (e) => e.stopPropagation());
    field.addEventListener("input", (e) => {
      this.userEdited = true;
      e.stopPropagation();
    });

    // Caret tries to leave the field at an edge → commit and move into the doc.
    field.addEventListener("move-out", (e) => {
      const dir = (e as CustomEvent).detail?.direction as string;
      this.commitField();
      this.moveSelectionOut(dir === "backward" || dir === "upward" ? -1 : 1);
    });

    field.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.commitField();
        this.moveSelectionOut(1);
      }
    });

    field.addEventListener("blur", () => this.commitField());

    // Defer focus until the element upgrades and lays out, then land the caret
    // at the edge we entered from (if any) so arrow traversal is continuous.
    const caret = this.pendingCaret;
    this.pendingCaret = null;
    requestAnimationFrame(() => {
      field.focus();
      if (caret) {
        try {
          field.position = caret === "start" ? 0 : field.lastOffset;
        } catch {
          /* MathLive positioning best-effort */
        }
      }
    });
  }

  // Read the MathLive field's value and finish.
  private commitField() {
    const v = this.field ? this.field.value : (this.node.attrs.latex as string);
    this.finishEdit(v);
  }

  // Commit whichever editor is active (used by blur/deselect/save flush).
  private commitActive() {
    if (!this.editing || this.committing) return;
    if (this.field) this.commitField();
    else if (this.inline) this.finishEdit(this.inline.value());
    else this.finishEdit(this.node.attrs.latex as string);
  }

  /** Current live value without changing focus or the NodeView's editing state. */
  private activeValue(): string {
    if (this.field) return this.field.value;
    if (this.inline) return this.inline.value();
    return this.node.attrs.latex as string;
  }

  /**
   * Checkpoint lifecycle recovery into the ProseMirror document while leaving
   * the equation editor mounted. Activation or canonicalization alone is a
   * no-op; only an actual input event may dirty the document.
   */
  checkpoint() {
    if (!this.editing || this.committing || !this.userEdited) return;
    const newLatex = this.activeValue();
    if (newLatex === this.node.attrs.latex) {
      this.userEdited = false;
      return;
    }
    const pos = this.getPos();
    if (pos == null) return;
    const tr = this.view.state.tr.setNodeAttribute(pos, "latex", newLatex);
    tr.setMeta("addToHistory", true);
    this.view.dispatch(tr);
    // dispatch synchronously updates this NodeView's node while preserving its
    // DOM. A later input starts a new checkpoint; closing now creates no duplicate.
    this.userEdited = false;
  }

  // Write the edited LaTeX back as one history step and return to static
  // rendering. Shared by both editors.
  private finishEdit(newLatex: string) {
    if (!this.editing || this.committing) return;
    this.committing = true;
    const pos = this.getPos();

    this.field = null;
    if (this.inline) {
      this.inline.destroy();
      this.inline = null;
    }
    this.editing = false;
    perf.mathDeactivated();
    if (activeMathView === this) activeMathView = null;

    const persistChange = this.userEdited && newLatex !== this.node.attrs.latex;
    this.userEdited = false;
    if (pos != null && persistChange) {
      const tr = this.view.state.tr.setNodeAttribute(pos, "latex", newLatex);
      tr.setMeta("addToHistory", true);
      this.view.dispatch(tr);
      // dispatch triggers update() which re-renders; done.
    } else {
      this.dom.classList.remove("is-editing");
      this.renderStatic();
    }
    this.committing = false;
  }

  // Public entry point for the save path to flush an in-progress edit.
  forceCommit() {
    this.commitActive();
  }

  private moveSelectionOut(dir: 1 | -1) {
    const pos = this.getPos();
    if (pos == null) return;
    const doc = this.view.state.doc;
    const target = dir === -1 ? pos : pos + this.node.nodeSize;
    const sel = TextSelection.near(doc.resolve(target), dir);
    this.view.dispatch(this.view.state.tr.setSelection(sel));
    this.view.focus();
  }

  // --- ProseMirror NodeView contract -------------------------------------
  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.decorations = decorations;
    this.syncAnchorId();
    if (!this.editing) {
      this.dom.classList.remove("is-editing");
      this.renderStatic();
    }
    return true;
  }

  // Keyboard selection just highlights the node (so Backspace deletes and Enter
  // opens it); a mouse click opens it via the dom click handler above.
  selectNode() {
    this.dom.classList.add("ProseMirror-selectednode");
  }

  deselectNode() {
    this.dom.classList.remove("ProseMirror-selectednode");
    this.commitActive();
  }

  // While editing, the active editor (MathLive field or inline element editor)
  // owns all keyboard/pointer events inside the NodeView's subtree.
  stopEvent(event: Event): boolean {
    if (!this.editing) return false;
    const target = event.target as globalThis.Node | null;
    return !!target && this.dom.contains(target);
  }

  // The active editors mutate their own DOM; PM must never try to read it.
  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    this.overflowObserver?.disconnect();
    this.overflowObserver = null;
    if (this.overflowFrame) cancelAnimationFrame(this.overflowFrame);
    this.overflowFrame = 0;
    this.field = null;
    if (this.inline) {
      this.inline.destroy();
      this.inline = null;
    }
    this.dom.textContent = "";
  }
}
