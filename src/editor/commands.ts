import { NodeSelection, Selection, TextSelection } from "prosemirror-state";
import type { Command, EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { GapCursor } from "prosemirror-gapcursor";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";

const isMath = (node: PMNode | null | undefined) =>
  !!node &&
  (node.type === schema.nodes.math_inline ||
    node.type === schema.nodes.math_display);

// Open the MathView at `pos` with the caret landing at the entering edge, so
// arrowing into an equation flows straight in (no click, no visible mode swap).
function enterMathAt(view: EditorView | undefined, pos: number, dir: 1 | -1) {
  if (!view) return;
  const dom = view.nodeDOM(pos) as
    | { __mathView?: { enterFromArrow(edge: "start" | "end"): void } }
    | null;
  dom?.__mathView?.enterFromArrow(dir === 1 ? "start" : "end");
}

// Open the editor of the math node at `pos` (used right after inserting one).
function activateMathAt(view: EditorView | undefined, pos: number) {
  if (!view) return;
  const dom = view.nodeDOM(pos) as { __mathView?: { activate(): void } } | null;
  dom?.__mathView?.activate();
}

// Insert an empty inline math node, select it, and open its editor.
export const insertInlineMath: Command = (state, dispatch, view) => {
  const node = schema.nodes.math_inline.create({ latex: "" });
  if (dispatch) {
    let tr = state.tr.replaceSelectionWith(node, false);
    const pos = tr.selection.from - node.nodeSize;
    tr = tr.setSelection(NodeSelection.create(tr.doc, pos));
    dispatch(tr.scrollIntoView());
    activateMathAt(view, pos);
  }
  return true;
};

// Insert an empty display-math block, select it, and open its editor.
export const insertDisplayMath: Command = (state, dispatch, view) => {
  const node = schema.nodes.math_display.create({ latex: "" });
  if (dispatch) {
    let tr = state.tr.replaceSelectionWith(node, false);
    const pos = Math.max(0, tr.selection.from - node.nodeSize);
    tr = tr.setSelection(NodeSelection.create(tr.doc, pos));
    dispatch(tr.scrollIntoView());
    activateMathAt(view, pos);
  }
  return true;
};

// When a math node is selected (e.g. via keyboard nav), Enter opens its editor.
export const editSelectedMath: Command = (state, _dispatch, view) => {
  const sel = state.selection;
  if (!(sel instanceof NodeSelection) || !isMath(sel.node)) return false;
  activateMathAt(view, sel.from);
  return true;
};

// Arrow navigation that makes an equation feel embedded in the text:
//  - caret adjacent to an inline equation → open it, caret at the near edge
//  - a keyboard-selected equation (e.g. after Backspace-select) → step past it
// MathLive then handles internal caret movement; its move-out event returns the
// caret to the adjacent text. The result is continuous traversal, no traps.
function enterAdjacentInlineMath(dir: 1 | -1): Command {
  return (state, dispatch, view) => {
    const sel = state.selection;
    // Already node-selected → step the caret past it (leave it be).
    if (sel instanceof NodeSelection && sel.node.type === schema.nodes.math_inline) {
      const pos = dir === 1 ? sel.to : sel.from;
      if (dispatch) {
        dispatch(
          state.tr
            .setSelection(Selection.near(state.doc.resolve(pos), dir))
            .scrollIntoView(),
        );
      }
      return true;
    }
    if (!sel.empty) return false;
    const $pos = sel.$from;
    const adjacent = dir === 1 ? $pos.nodeAfter : $pos.nodeBefore;
    if (adjacent && adjacent.type === schema.nodes.math_inline) {
      const from = dir === 1 ? $pos.pos : $pos.pos - adjacent.nodeSize;
      if (dispatch) {
        dispatch(state.tr.setSelection(NodeSelection.create(state.doc, from)));
      }
      enterMathAt(view, from, dir);
      return true;
    }
    return false;
  };
}

// Enter a display equation adjacent to the caret. Fires from a GapCursor next to
// it OR — the case #I48 missed — from an empty TextSelection sitting at the
// entering edge of a textblock whose sibling (at doc level) is the equation, so a
// plain arrow at a paragraph edge flows in instead of stepping over it.
function enterAdjacentDisplayMath(dir: 1 | -1): Command {
  return (state: EditorState, dispatch, view) => {
    const sel = state.selection;
    let gapPos: number;
    if (sel instanceof GapCursor) {
      gapPos = sel.$from.pos;
    } else if (sel.empty && sel instanceof TextSelection) {
      const $f = sel.$from;
      if ($f.depth === 0) return false;
      const atEdge =
        dir === 1 ? $f.parentOffset === $f.parent.content.size : $f.parentOffset === 0;
      if (!atEdge) return false;
      gapPos = dir === 1 ? $f.after() : $f.before();
    } else {
      return false;
    }
    const $pos = state.doc.resolve(gapPos);
    const adjacent = dir === 1 ? $pos.nodeAfter : $pos.nodeBefore;
    if (adjacent && adjacent.type === schema.nodes.math_display) {
      const from = dir === 1 ? $pos.pos : $pos.pos - adjacent.nodeSize;
      if (dispatch) {
        dispatch(state.tr.setSelection(NodeSelection.create(state.doc, from)));
      }
      enterMathAt(view, from, dir);
      return true;
    }
    return false;
  };
}

export const selectInlineMathLeft = enterAdjacentInlineMath(-1);
export const selectInlineMathRight = enterAdjacentInlineMath(1);
export const enterDisplayMathLeft = enterAdjacentDisplayMath(-1);
export const enterDisplayMathRight = enterAdjacentDisplayMath(1);

// Enter inside a paragraph whose whole text is "$$" converts it to a display
// equation (the "$$ then Enter" gesture).
export const displayMathOnEnter: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  const parent = $from.parent;
  if (parent.type !== schema.nodes.paragraph) return false;
  if (parent.textContent !== "$$") return false;

  if (dispatch) {
    const start = $from.before();
    const end = $from.after();
    const node = schema.nodes.math_display.create({ latex: "" });
    let tr = state.tr.replaceRangeWith(start, end, node);
    tr = tr.setSelection(NodeSelection.create(tr.doc, start));
    dispatch(tr.scrollIntoView());
    activateMathAt(view, start);
  }
  return true;
};
