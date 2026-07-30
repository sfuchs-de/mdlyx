import { renderKatex, rendersCleanly } from "./render-katex";
import {
  parseMath,
  mathToLatex,
  instrumentMath,
  parseEnvGrid,
  envGridToLatex,
  katexGridEnv,
  effectiveEnv,
  LEAF_CLASS,
  type LeafRef,
  type MathTerm,
} from "./math-ast";
import { expandCommand, insertScript, type Edit } from "./math-input-assist";

// Fluid, in-place equation editing (the econagent/LyX "element-by-element" feel,
// taken further so the design NEVER changes): the whole equation is a single
// real KaTeX render; every editable element is tagged so we can measure it; and
// only the active element is covered by a transparent, size-matched <input>.
// Cursor keys move between elements (arrows at a boundary, Tab, Up/Down between
// stacked slots); the rest of the equation stays typeset the entire time.

export interface InlineEditorOptions {
  displayMode: boolean;
  getMacros: () => Record<string, string>;
  onChange?: () => void; // actual user input, not activation/navigation
  onExit: (dir: 1 | -1) => void; // caret left the equation past an edge
  onDone: () => void; // committed (blur / Enter) without leaving to a side
  env?: string; // display node's env attr (align/gather/cases → per-cell grid)
}

export class InlineMathEditor {
  private readonly container: HTMLElement;
  private readonly mount: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly opts: InlineEditorOptions;

  private terms = parseMath("");
  private leaves: LeafRef[] = [];
  private leafEls: (HTMLElement | null)[] = [];
  private activeIndex = 0;
  private activeGlyph = true; // active element shows its live glyph (vs. source)
  private activePadPx = 0; // width reserved for the active element's source
  private navigating = false; // suppress the blur handler during internal moves
  private started = false;
  private destroyed = false; // guards deferred callbacks after teardown
  // While the source ends in a bare `\command`, we keep showing source and wait
  // this long before resolving it to its glyph — so typing toward `\int` never
  // flashes the glyph of an accidental valid prefix (`\in`).
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onResize = () => this.position();
  // Set when the whole equation is an env grid stored as body-only (display
  // `env=align|gather|cases`): value() must then return the body, not \begin…\end.
  private readonly gridEnv: string | null;

  constructor(container: HTMLElement, latex: string, opts: InlineEditorOptions) {
    this.container = container;
    this.opts = opts;
    // Resolve the env from content too (opts.env may be the default `equation`
    // for a body that actually uses alignment markers), so such an equation edits
    // as a grid — matching how it renders — instead of desyncing (#I14).
    this.gridEnv = opts.displayMode ? katexGridEnv(effectiveEnv(opts.env ?? "equation", latex)) : null;
    if (this.gridEnv) {
      // Wrap the body as a grid environment so KaTeX renders it correctly and
      // each cell becomes an editable element.
      const grid = parseEnvGrid(latex);
      this.terms = [{
        kind: "env",
        name: this.gridEnv,
        colspec: "",
        rows: grid.rows,
        format: grid.format,
      }];
    } else {
      this.terms = parseMath(latex);
      // An empty equation (e.g. just-inserted) needs one editable leaf to type into.
      if (this.terms.length === 0) this.terms = [{ kind: "text", text: "" }];
    }

    container.classList.add("inline-math-editing");
    this.mount = document.createElement(opts.displayMode ? "div" : "span");
    this.mount.className = "ime-render";

    this.input = document.createElement("input");
    this.input.className = "ime-input";
    // The NodeView starts the editor on the next animation frame. Expose that
    // boundary so automation and assistive UI never interact with the temporary
    // constructor state just before start() selects the entry leaf.
    this.input.dataset.editorState = "initializing";
    this.input.spellcheck = false;
    this.input.autocapitalize = "off";
    this.input.setAttribute("autocomplete", "off");
    // Background/highlight comes from CSS (.ime-input) — a soft tint marks the
    // specific element under the caret; it's translucent so the live glyph
    // beneath still shows through.

    container.textContent = "";
    container.appendChild(this.mount);
    container.appendChild(this.input);

    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.input.addEventListener("blur", () => this.onBlur());
    // Click any element to edit it directly.
    this.mount.addEventListener("mousedown", (e) => this.onMountMouseDown(e));
    window.addEventListener("resize", this.onResize);
    // KaTeX display centering / font load settle a layout frame after render,
    // shifting element boxes — reposition the overlay whenever the render's size
    // changes so it never lags behind the (re)laid-out element.
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.started) this.position();
      });
    }

    this.renderMath();
  }

  // Resolve the clicked element by coordinates rather than the event target —
  // KaTeX's overlapping vlist spans make the raw target unreliable.
  private onMountMouseDown(e: MouseEvent) {
    // Prefer the explicitly tagged leaf in the event path when one exists.
    // KaTeX creates overlapping layout spans, so ordinary user clicks still
    // fall back to geometric hit-testing; the tag removes ambiguity for direct
    // leaf clicks and gives deterministic automation an observable target.
    const target = e.target instanceof Element
      ? e.target.closest<HTMLElement>("[data-math-leaf-index]")
      : null;
    const tagged = target?.dataset.mathLeafIndex;
    const taggedIndex = tagged != null && /^\d+$/.test(tagged)
      ? Number(tagged)
      : null;
    const idx = taggedIndex ?? this.leafAtPoint(e.clientX, e.clientY);
    if (idx == null) return;
    e.preventDefault(); // keep focus on our input (no blur)
    this.navigating = true;
    this.activate(idx); // re-renders (reflecting any pending edit) + reflows
    this.navigating = false;
  }

  private leafAtPoint(x: number, y: number): number | null {
    let containing: number | null = null;
    let containingArea = Infinity;
    let nearest: number | null = null;
    let nearestDist = Infinity;
    this.leafEls.forEach((el, i) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Distance from the point to the element's BOX (0 on an axis the point is
      // inside), not to its centre. So a click in the gap between grid cells
      // resolves to the row/column-adjacent cell rather than a diagonal one (#I49).
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const dist = Math.hypot(dx, dy);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
      if (dx === 0 && dy === 0) {
        const area = r.width * r.height; // point is inside — prefer the smallest such box
        if (area < containingArea) {
          containingArea = area;
          containing = i;
        }
      }
    });
    // Prefer the smallest element under the cursor; else the nearest box, if close.
    if (containing != null) return containing;
    return nearestDist < 40 ? nearest : null;
  }

  value(): string {
    // For a body-only env node, return just the grid (no \begin/\end).
    if (this.gridEnv) {
      const env = this.terms[0] as MathTerm;
      if (env.kind === "env") return envGridToLatex(env.rows, env.format);
    }
    return mathToLatex(this.terms);
  }

  // Called by the NodeView to open a specific edge on entry (arrow-in). The
  // NodeView defers this in a rAF, so it can fire after the editor was already
  // destroyed (e.g. a double-click escalated to MathLive) — bail if so, or we'd
  // render into a detached mount and steal focus from the new field.
  start(edge: "start" | "end") {
    if (this.destroyed) return;
    this.started = true;
    // Reveal before activate() focuses the input. A visibility-hidden control
    // cannot receive focus in WebKit/Chromium; this update and activate() run in
    // one task, so observers still see only the fully initialized ready state.
    this.input.dataset.editorState = "ready";
    const idx = edge === "end" ? this.leaves.length - 1 : 0;
    this.activate(Math.max(0, idx));
    // Reposition once fonts are ready (their metrics shift the layout).
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(() => this.started && this.position());
    }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.settleTimer);
    window.removeEventListener("resize", this.onResize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.started = false;
    this.container.classList.remove("inline-math-editing");
  }

  // --- rendering ----------------------------------------------------------
  private renderMath() {
    const { latex, leaves } = instrumentMath(this.terms, {
      activeLeaf: this.activeIndex,
      activeGlyph: this.activeGlyph,
      padPx: this.activePadPx,
    });
    this.leaves = leaves;
    this.mount.textContent = "";
    renderKatex(latex, this.mount, this.opts.displayMode, this.opts.getMacros(), "equation", true);
    this.leafEls = leaves.map(
      (_, i) => this.mount.querySelector<HTMLElement>(`.${LEAF_CLASS}-${i}`),
    );
    this.leafEls.forEach((element, index) => {
      if (element) element.dataset.mathLeafIndex = String(index);
    });
    // Observe the actual rendered math (inline-block, so it resizes when KaTeX
    // fonts load / the equation re-centers) and reposition the overlay then.
    this.resizeObserver?.disconnect();
    const katex = this.mount.querySelector<HTMLElement>(".katex");
    if (katex) this.resizeObserver?.observe(katex);
  }

  // Overlay the input on the active leaf, matching its box and font so the
  // equation's layout is untouched — only a caret appears.
  private activate(index: number) {
    if (this.leaves.length === 0) return;
    clearTimeout(this.settleTimer); // new leaf — drop any pending settle
    this.activeIndex = Math.max(0, Math.min(index, this.leaves.length - 1));
    this.input.dataset.activeLeaf = String(this.activeIndex);
    delete this.input.dataset.positioned;
    const term = this.leaves[this.activeIndex].term;
    this.input.value = term.text;
    // Decide the mode from the source alone (no DOM needed): a complete, valid
    // token renders as its live glyph; an incomplete command shows source.
    this.activeGlyph = rendersCleanly(term.text, this.opts.getMacros());
    this.activePadPx = 0;
    this.renderMath();
    // reveal all leaves; the active one shows its glyph (input overlays it) or is
    // hidden behind the source input, decided per-mode in position().
    this.leafEls.forEach((el) => el && (el.style.visibility = ""));
    this.position();
    this.input.focus();
    this.input.select();
    // Source mode needs the reserved width measured + re-rendered so neighbours
    // reflow; glyph mode is already correct from the single render above.
    if (!this.activeGlyph) this.reflowActive();
    // Display-mode centering / font metrics settle over the next frame(s), which
    // shifts the element box; re-run positioning so the overlay tracks it.
    this.scheduleReposition();
  }

  private scheduleReposition() {
    requestAnimationFrame(() => {
      if (this.started) this.position();
      requestAnimationFrame(() => this.started && this.position());
    });
    // Backstop the font-load reflow window with placement-only passes (the
    // ResizeObserver on .katex covers most of it; these catch anything it misses).
    for (const ms of [60, 200, 400]) {
      setTimeout(() => this.started && this.position(), ms);
    }
  }

  // Re-evaluate the active element's mode against its current source and render:
  // a valid token renders as its live glyph; an incomplete command reserves its
  // source width so neighbours reflow. Re-renders (safely — an invalid source is
  // never emitted as math), then places the input. NEVER called from the
  // ResizeObserver (only placement runs there), so it cannot cause a render loop.
  private reflowActive(forceSource = false) {
    const leaf = this.leaves[this.activeIndex];
    if (!leaf) return;
    const clean =
      !forceSource && rendersCleanly(leaf.term.text, this.opts.getMacros());
    if (clean) {
      this.activeGlyph = true;
      this.activePadPx = 0;
    } else {
      this.activeGlyph = false;
      // Reserve the visible source width so the input doesn't cover neighbours.
      const el = this.leafEls[this.activeIndex];
      if (el) this.input.style.font = getComputedStyle(el).font;
      this.input.style.width = "6px";
      this.activePadPx = Math.max(this.input.scrollWidth + 2, 6);
    }
    this.renderMath();
    this.position();
  }

  // Placement only: overlay the input on the active element's current box. Does
  // NOT re-render, so it is safe to call from the ResizeObserver, timers and rAF.
  private position() {
    const el = this.leafEls[this.activeIndex];
    if (!el) return;
    const c = this.container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    this.input.style.font = style.font;
    this.input.style.caretColor = style.color;
    this.input.style.left = `${r.left - c.left}px`;
    this.input.style.top = `${r.top - c.top}px`;
    this.input.style.height = `${r.height}px`;
    if (this.activeGlyph) {
      // The element shows its real glyph; the input is a transparent caret layer
      // on top of it (its source text, if wider, is invisible so nothing spills).
      el.style.visibility = "";
      this.input.style.color = "transparent";
      this.input.style.width = `${Math.max(r.width, 6)}px`;
      this.input.dataset.renderMode = "glyph";
    } else {
      // Incomplete command: the element is a hidden strut of the reserved width;
      // the input shows the source text over it, neighbours already reflowed.
      el.style.visibility = "hidden";
      this.input.style.color = style.color;
      this.input.style.width = "6px";
      this.input.style.width = `${Math.max(this.input.scrollWidth, r.width, 6)}px`;
      this.input.dataset.renderMode = "source";
    }
    this.input.dataset.positioned = "true";
  }

  // --- editing ------------------------------------------------------------
  private onInput() {
    this.opts.onChange?.();
    this.leaves[this.activeIndex].term.text = this.input.value;
    clearTimeout(this.settleTimer);
    // If the source still ends in a bare `\command`, the user may be mid-word
    // (typing `\int`): keep showing source rather than flashing a prefix's glyph
    // (`\in` → ∈). Resolve to the glyph on a brief pause, or immediately once a
    // terminator (space, `_`, `^`, digit, …) ends the command.
    const partialCommand = /\\[a-zA-Z]*$/.test(this.input.value);
    this.reflowActive(partialCommand);
    if (partialCommand) {
      this.settleTimer = setTimeout(() => {
        if (this.started) this.reflowActive(false);
      }, 500);
    }
  }

  // Re-render (so the just-edited element typesets), then activate the target
  // leaf, or exit the equation if we ran off an end.
  private moveTo(index: number, dir: 1 | -1) {
    clearTimeout(this.settleTimer);
    this.navigating = true;
    if (index < 0 || index >= this.leaves.length) {
      this.activeIndex = -1;
      this.activeGlyph = true;
      this.activePadPx = 0;
      this.renderMath(); // re-typeset everything before leaving the equation
      this.opts.onExit(dir);
    } else {
      this.activate(index); // resets pad, re-renders, reflows for the new leaf
    }
    this.navigating = false;
  }

  private atStart(): boolean {
    return this.input.selectionStart === 0 && this.input.selectionEnd === 0;
  }
  private atEnd(): boolean {
    const len = this.input.value.length;
    return this.input.selectionStart === len && this.input.selectionEnd === len;
  }

  // Geometric Up/Down: nearest leaf whose box is above/below the active one.
  private verticalTarget(dir: 1 | -1): number | null {
    const cur = this.leafEls[this.activeIndex];
    if (!cur) return null;
    const cr = cur.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    let best: number | null = null;
    let bestDist = Infinity;
    this.leafEls.forEach((el, i) => {
      if (!el || i === this.activeIndex) return;
      const r = el.getBoundingClientRect();
      const above = r.bottom <= cr.top + 1;
      const below = r.top >= cr.bottom - 1;
      if ((dir < 0 && !above) || (dir > 0 && !below)) return;
      const dx = Math.abs(r.left + r.width / 2 - cx);
      const dy = Math.abs(r.top - cr.top);
      const dist = dx + dy * 0.5;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  }

  // Apply a text edit to the active leaf's input (typing-assist helpers).
  private applyEdit(edit: Edit) {
    this.opts.onChange?.();
    clearTimeout(this.settleTimer);
    this.input.value = edit.value;
    this.leaves[this.activeIndex].term.text = edit.value;
    this.input.setSelectionRange(edit.caret, edit.caret);
    // A skeleton like `\frac{}{}` or `x^{}` should become real navigable slots
    // immediately (not stay one opaque leaf until commit+reopen, #I50). If the
    // re-parse split it, we land in the first new empty slot; otherwise just reflow.
    if (!this.trySplit()) this.reflowActive();
  }

  // Re-parse the whole equation from its current source; if that yields MORE
  // editable leaves than we have now (a structural command completed), adopt the
  // structured tree and activate the first empty slot at/after the edited leaf, so
  // typing flows straight into the numerator / exponent / … Returns whether it split.
  private trySplit(): boolean {
    if (this.gridEnv) return false; // grid cells are already per-cell leaves
    const parsed = parseMath(this.value());
    if (!parsed.length) return false;
    const dry = instrumentMath(parsed, { activeLeaf: -1, activeGlyph: true, padPx: 0 });
    if (dry.leaves.length <= this.leaves.length) return false; // nothing new to split
    const from = this.activeIndex;
    this.terms = parsed;
    this.renderMath();
    let target = this.leaves.findIndex((l, i) => i >= from && !l.term.text);
    if (target < 0) target = Math.min(from, this.leaves.length - 1);
    this.activate(target);
    return true;
  }

  private onKeyDown(e: KeyboardEvent) {
    // Typing ergonomics (before navigation): ^/_ script braces, and
    // `\cmd`+space → skeleton with the caret in the first slot.
    if ((e.key === "^" || e.key === "_") && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      this.applyEdit(
        insertScript(
          this.input.value,
          this.input.selectionStart ?? this.input.value.length,
          this.input.selectionEnd ?? this.input.value.length,
          e.key,
        ),
      );
      return;
    }
    if (e.key === " ") {
      const edit = expandCommand(
        this.input.value,
        this.input.selectionStart ?? this.input.value.length,
      );
      if (edit) {
        e.preventDefault();
        this.applyEdit(edit);
        return;
      }
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        this.finish();
        this.opts.onDone();
        return;
      case "Enter":
        e.preventDefault();
        this.finish();
        this.opts.onExit(1);
        return;
      case "Tab":
        e.preventDefault();
        this.moveTo(this.activeIndex + (e.shiftKey ? -1 : 1), e.shiftKey ? -1 : 1);
        return;
      case "ArrowRight":
        if (this.atEnd()) {
          e.preventDefault();
          this.moveTo(this.activeIndex + 1, 1);
        }
        return;
      case "ArrowLeft":
        if (this.atStart()) {
          e.preventDefault();
          this.moveTo(this.activeIndex - 1, -1);
        }
        return;
      case "ArrowUp":
      case "ArrowDown": {
        const target = this.verticalTarget(e.key === "ArrowUp" ? -1 : 1);
        if (target != null) {
          e.preventDefault();
          this.moveTo(target, e.key === "ArrowUp" ? -1 : 1);
        }
        return;
      }
    }
  }

  private onBlur() {
    if (this.navigating) return; // internal move, not a real blur
    // Re-typeset (so the committed look is right); the actual commit/teardown on
    // click-away is driven by a mousedown-outside handler at the editor level,
    // which is robust to the transient focus changes a plain <input> sees.
    this.finish();
  }

  // Re-render so everything is typeset again; the NodeView reads value() to
  // write the committed LaTeX.
  private finish() {
    clearTimeout(this.settleTimer);
    // No active element on commit: render every leaf as its real source so the
    // typeset result matches what will be stored (invalid source shows as an
    // error, exactly as the committed node would).
    this.activeIndex = -1;
    this.activeGlyph = true;
    this.activePadPx = 0;
    this.renderMath();
    this.leafEls.forEach((el) => el && (el.style.visibility = ""));
  }
}
