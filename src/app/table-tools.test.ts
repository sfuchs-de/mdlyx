import { describe, expect, it } from "vitest";
import { schema } from "../editor/schema";
import { logicalColumnCells } from "./table-tools";

const paragraph = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const cell = (text: string, attrs: Record<string, unknown> = {}) =>
  schema.nodes.table_cell.create({ ...attrs }, paragraph(text));

describe("table tools", () => {
  it("resolves logical columns through merged cells", () => {
    const table = schema.nodes.table.create(null, [
      schema.nodes.table_row.create(null, [cell("merged", { colspan: 2 })]),
      schema.nodes.table_row.create(null, [cell("left"), cell("right")]),
    ]);
    // TableMap offsets include each cell's content size.
    expect(logicalColumnCells(table, 21)).toEqual([1, 21]);
  });
});
