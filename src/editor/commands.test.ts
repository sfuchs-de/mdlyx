import { describe, it, expect } from "vitest";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import { schema } from "./schema";
import {
  selectInlineMathLeft,
  selectInlineMathRight,
  editSelectedMath,
  insertInlineMath,
  enterDisplayMathLeft,
  enterDisplayMathRight,
} from "./commands";

// doc: <p>a[math]b</p> — the inline math node sits at position 2.
function stateWithInlineMath(cursor: number) {
  const math = schema.nodes.math_inline.create({ latex: "x" });
  const para = schema.nodes.paragraph.create(null, [
    schema.text("a"),
    math,
    schema.text("b"),
  ]);
  const doc = schema.nodes.doc.create(null, [para]);
  const state = EditorState.create({ schema, doc });
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, cursor)),
  );
}

function run(
  command: Command,
  state: EditorState,
): { handled: boolean; next: EditorState | null } {
  let next: EditorState | null = null;
  const handled = command(state, (tr) => {
    next = state.apply(tr);
  });
  return { handled, next };
}

describe("math keyboard commands", () => {
  it("selects an inline equation when the caret arrows into it", () => {
    const { handled, next } = run(selectInlineMathRight, stateWithInlineMath(2));
    expect(handled).toBe(true);
    expect(next!.selection).toBeInstanceOf(NodeSelection);
    expect((next!.selection as NodeSelection).node.type.name).toBe("math_inline");
  });

  it("steps the caret past an already-selected equation", () => {
    let state = stateWithInlineMath(2);
    state = run(selectInlineMathRight, state).next!; // now node-selected
    const { handled, next } = run(selectInlineMathRight, state);
    expect(handled).toBe(true);
    expect(next!.selection).toBeInstanceOf(TextSelection);
    expect(next!.selection.from).toBe(3); // just after the math node
  });

  it("does nothing when the caret is not adjacent to inline math", () => {
    // Cursor at position 1 → nodeAfter is the text 'a', not math.
    expect(run(selectInlineMathRight, stateWithInlineMath(1)).handled).toBe(false);
    expect(run(selectInlineMathLeft, stateWithInlineMath(1)).handled).toBe(false);
  });

  it("editSelectedMath only fires on a selected math node", () => {
    let state = stateWithInlineMath(2);
    expect(run(editSelectedMath, state).handled).toBe(false); // text selection
    state = run(selectInlineMathRight, state).next!;
    expect(run(editSelectedMath, state).handled).toBe(true); // node selection
  });

  // doc: <p>text</p><math_display/><p>text</p>. The display node is at pos 6
  // (after "text" = 4 chars + 2 boundary tokens of the first paragraph).
  function stateWithDisplayMath(cursor: number) {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("text")]),
      schema.nodes.math_display.create({ latex: "x" }),
      schema.nodes.paragraph.create(null, [schema.text("more")]),
    ]);
    const state = EditorState.create({ schema, doc });
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, cursor)));
  }

  it("enters an adjacent display equation from a text caret at the paragraph edge (#I48)", () => {
    // caret at end of the first paragraph (pos 5) → ArrowDown/Right should enter
    const down = run(enterDisplayMathRight, stateWithDisplayMath(5));
    expect(down.handled).toBe(true);
    expect((down.next!.selection as NodeSelection).node.type.name).toBe("math_display");
    // caret at start of the last paragraph (pos 8) → ArrowUp/Left enters it
    const up = run(enterDisplayMathLeft, stateWithDisplayMath(8));
    expect(up.handled).toBe(true);
    expect((up.next!.selection as NodeSelection).node.type.name).toBe("math_display");
  });

  it("does not enter display math from mid-paragraph (#I48)", () => {
    expect(run(enterDisplayMathRight, stateWithDisplayMath(2)).handled).toBe(false);
  });

  it("insertInlineMath inserts and selects a new empty equation", () => {
    const { handled, next } = run(insertInlineMath, stateWithInlineMath(1));
    expect(handled).toBe(true);
    const sel = next!.selection as NodeSelection;
    expect(sel).toBeInstanceOf(NodeSelection);
    expect(sel.node.type.name).toBe("math_inline");
    expect(sel.node.attrs.latex).toBe("");
  });
});
