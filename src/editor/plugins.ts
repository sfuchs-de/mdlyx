import { history } from "prosemirror-history";
import { gapCursor } from "prosemirror-gapcursor";
import { dropCursor } from "prosemirror-dropcursor";
import { columnResizing, tableEditing } from "prosemirror-tables";
import type { Plugin } from "prosemirror-state";
import { buildInputRules } from "./inputrules";
import { buildKeymap } from "./keymap";
import { buildNumbering, defaultNumbering } from "./numbering";
import type { NumberingConfig } from "./numbering";
import { buildComments, type Comment } from "./comments";
import { LabeledTableView } from "./table-nodeview";

export interface PluginOptions {
  getConfig?: () => NumberingConfig;
  commentsOnChange?: (comments: Comment[]) => void;
}

// gapcursor lets the caret sit before/after block atoms (display equations),
// which is what keeps them from becoming cursor traps.
export function buildPlugins(options: PluginOptions = {}): Plugin[] {
  const getConfig = options.getConfig ?? (() => defaultNumbering);
  return [
    buildInputRules(),
    buildKeymap(),
    columnResizing({ View: LabeledTableView }),
    tableEditing(),
    dropCursor(),
    gapCursor(),
    buildNumbering(getConfig),
    buildComments(options.commentsOnChange),
    history(),
  ];
}
