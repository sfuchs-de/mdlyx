import { keymap } from "prosemirror-keymap";
import { baseKeymap, chainCommands, toggleMark } from "prosemirror-commands";
import { undo, redo } from "prosemirror-history";
import { splitListItem } from "prosemirror-schema-list";
import { goToNextCell } from "prosemirror-tables";
import type { Command } from "prosemirror-state";
import { schema } from "./schema";
import {
  insertInlineMath,
  insertDisplayMath,
  displayMathOnEnter,
  editSelectedMath,
  selectInlineMathLeft,
  selectInlineMathRight,
  enterDisplayMathLeft,
  enterDisplayMathRight,
} from "./commands";

// Some arrow keys aren't in baseKeymap; fall back to a no-op so chaining is safe.
const base = (key: string): Command =>
  (baseKeymap as Record<string, Command>)[key] ?? (() => false);

export function buildKeymap() {
  return keymap({
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,

    "Mod-b": toggleMark(schema.marks.strong),
    "Mod-i": toggleMark(schema.marks.em),
    "Mod-`": toggleMark(schema.marks.code),

    "Mod-m": insertInlineMath,
    "Shift-Mod-m": insertDisplayMath,

    // Arrow keys flow the caret into an adjacent equation (inline or, from a
    // gap cursor, a display block) instead of stepping over it.
    ArrowLeft: chainCommands(
      selectInlineMathLeft,
      enterDisplayMathLeft,
      base("ArrowLeft"),
    ),
    ArrowRight: chainCommands(
      selectInlineMathRight,
      enterDisplayMathRight,
      base("ArrowRight"),
    ),
    ArrowUp: chainCommands(enterDisplayMathLeft, base("ArrowUp")),
    ArrowDown: chainCommands(enterDisplayMathRight, base("ArrowDown")),

    // Tab moves between table cells (no-op outside a table).
    Tab: goToNextCell(1),
    "Shift-Tab": goToNextCell(-1),

    // Enter: open a selected equation, else "$$"+Enter, list split, default.
    Enter: chainCommands(
      editSelectedMath,
      displayMathOnEnter,
      splitListItem(schema.nodes.list_item),
      baseKeymap["Enter"],
    ),
  });
}

export function buildBaseKeymap() {
  return keymap(baseKeymap);
}
