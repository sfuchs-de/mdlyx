import type { Node as PMNode } from "prosemirror-model";
import type { Command } from "prosemirror-state";
import { NodeSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  mergeCells,
  splitCell,
  TableMap,
} from "prosemirror-tables";
import { AnchoredPanelController } from "./anchored-panel";

export interface ActiveTable {
  node: PMNode;
  position: number;
}

/** Relative cell offsets occupying the selected cell's logical table column. */
export function logicalColumnCells(table: PMNode, selectedCellOffset: number): number[] {
  const map = TableMap.get(table);
  const column = map.findCell(selectedCellOffset).left;
  return [...new Set(Array.from(
    { length: map.height },
    (_, row) => map.map[row * map.width + column],
  ))];
}

export function activeTable(view: EditorView): ActiveTable | null {
  const selection = view.state.selection;
  if (selection instanceof NodeSelection && selection.node.type.name === "table") {
    return { node: selection.node, position: selection.from };
  }
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const node = selection.$from.node(depth);
    if (node.type.name === "table") return { node, position: selection.$from.before(depth) };
  }
  return null;
}

export class TableTools {
  private readonly panel = document.createElement("section");
  private readonly caption = document.createElement("input");
  private readonly label = document.createElement("input");
  private readonly status = document.createElement("span");

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly view: EditorView,
  ) {
    this.panel.id = "table-tools";
    this.panel.hidden = true;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "Table tools");

    const title = document.createElement("h2");
    title.className = "config-title";
    title.textContent = "Table";

    this.caption.className = "navigator-input";
    this.caption.placeholder = "Caption";
    this.caption.setAttribute("aria-label", "Table caption");
    this.caption.addEventListener("change", () => this.updateMetadata());
    this.label.className = "navigator-input";
    this.label.placeholder = "Label, for example tbl:results";
    this.label.setAttribute("aria-label", "Table label");
    this.label.addEventListener("change", () => this.updateMetadata());

    this.panel.append(
      title,
      group("Rows", [
        action("Before", () => this.run(addRowBefore)),
        action("After", () => this.run(addRowAfter)),
        action("Delete", () => this.run(deleteRow)),
      ]),
      group("Columns", [
        action("Before", () => this.run(addColumnBefore)),
        action("After", () => this.run(addColumnAfter)),
        action("Delete", () => this.run(deleteColumn)),
      ]),
      group("Cells", [
        action("Merge", () => this.run(mergeCells)),
        action("Split", () => this.run(splitCell)),
      ]),
      group("Align", [
        action("Left", () => this.alignColumn("left")),
        action("Center", () => this.alignColumn("center")),
        action("Right", () => this.alignColumn("right")),
      ]),
      this.caption,
      this.label,
      group("Table", [action("Delete table", () => this.run(deleteTable))]),
    );
    this.status.className = "navigator-result";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.panel.append(this.status);
    document.body.append(this.panel);

    new AnchoredPanelController(this.button, this.panel, {
      beforeOpen: () => {
        const table = activeTable(this.view);
        this.caption.value = (table?.node.attrs.caption as string | null) ?? "";
        this.label.value = (table?.node.attrs.id as string | null) ?? "";
        this.status.textContent = table ? "Table selected" : "Place the cursor in a table";
      },
    });
  }

  private run(command: Command): void {
    const changed = command(this.view.state, this.view.dispatch, this.view);
    this.status.textContent = changed ? "Table updated" : "Select the relevant table cells first";
    this.view.focus();
  }

  private updateMetadata(): void {
    const table = activeTable(this.view);
    if (!table) {
      this.status.textContent = "Place the cursor in a table";
      return;
    }
    const id = this.label.value.trim();
    if (id && !/^[A-Za-z][\w:.-]*$/.test(id)) {
      this.status.textContent = "Labels must start with a letter and contain no spaces";
      return;
    }
    const attrs = {
      ...table.node.attrs,
      caption: this.caption.value.trim() || null,
      id: id || null,
    };
    this.view.dispatch(this.view.state.tr.setNodeMarkup(table.position, undefined, attrs));
    this.status.textContent = "Caption and label updated";
  }

  private alignColumn(align: "left" | "center" | "right"): void {
    const table = activeTable(this.view);
    if (!table) {
      this.status.textContent = "Place the cursor in a table";
      return;
    }
    const selection = this.view.state.selection;
    let cellPosition: number | null = null;
    for (let depth = selection.$from.depth; depth > 0; depth--) {
      const type = selection.$from.node(depth).type.name;
      if (type === "table_cell" || type === "table_header") {
        cellPosition = selection.$from.before(depth);
        break;
      }
    }
    if (cellPosition == null) {
      this.status.textContent = "Place the cursor in a table cell";
      return;
    }
    const selectedOffset = cellPosition - table.position - 1;
    let cellOffsets: number[];
    try {
      cellOffsets = logicalColumnCells(table.node, selectedOffset);
    } catch {
      this.status.textContent = "Could not resolve the selected column";
      return;
    }
    let transaction = this.view.state.tr;
    for (const offset of cellOffsets) {
      const cell = table.node.nodeAt(offset);
      if (!cell) continue;
      const position = table.position + 1 + offset;
      transaction = transaction.setNodeMarkup(position, undefined, { ...cell.attrs, align });
    }
    this.view.dispatch(transaction);
    this.status.textContent = `Column aligned ${align}`;
    this.view.focus();
  }

}

function action(text: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function group(label: string, buttons: HTMLButtonElement[]): HTMLElement {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "table-tool-group";
  const legend = document.createElement("legend");
  legend.textContent = label;
  const controls = document.createElement("div");
  controls.className = "navigator-controls";
  controls.append(...buttons);
  fieldset.append(legend, controls);
  return fieldset;
}
