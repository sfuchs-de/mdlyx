import type { Node as PMNode } from "prosemirror-model";
import { TableView } from "prosemirror-tables";
import type { ViewMutationRecord } from "prosemirror-view";

// prosemirror-tables installs its own resize-aware NodeView, bypassing the
// schema's table toDOM function. Reapply Mathdown's authored label and caption
// to that live DOM so tables remain visible publication objects and real anchor
// targets while column resizing is enabled.
export class LabeledTableView extends TableView {
  private caption: HTMLTableCaptionElement | null = null;

  constructor(node: PMNode, defaultCellMinWidth: number) {
    super(node, defaultCellMinWidth);
    this.syncMetadata(node);
  }

  override update(node: PMNode): boolean {
    if (!super.update(node)) return false;
    this.syncMetadata(node);
    return true;
  }

  override ignoreMutation(record: ViewMutationRecord): boolean {
    if (
      record.target === this.table
      || (this.caption && (record.target === this.caption || this.caption.contains(record.target)))
    ) return true;
    return super.ignoreMutation(record);
  }

  private syncMetadata(node: PMNode) {
    const id = String(node.attrs.id ?? "");
    const caption = String(node.attrs.caption ?? "");
    this.table.id = id;
    if (id) this.table.dataset.tableId = id;
    else delete this.table.dataset.tableId;
    if (caption) {
      if (!this.caption) {
        this.caption = document.createElement("caption");
        this.table.insertBefore(this.caption, this.colgroup);
      }
      this.caption.textContent = caption;
    } else if (this.caption) {
      this.caption.remove();
      this.caption = null;
    }
  }
}
