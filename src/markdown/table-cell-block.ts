const BLOCK_OPEN = '<span data-mdlyx-cell-block="';
const BLOCK_LINE = "<br data-mdlyx-cell-line>";
const BLOCK_PATTERN = /^<span data-mdlyx-cell-block="([a-z][a-z0-9_]*)">([\s\S]*)<\/span>$/;

// GFM tables only admit inline cell content. Keep ordinary paragraph cells as
// ordinary GFM, but wrap a genuine block in a small readable HTML extension so
// its Markdown source can stay on the table's one physical row. Generic
// Markdown renderers show the source with line breaks; Mathdown can reconstruct
// the original ProseMirror block exactly.
export function encodeTableCellBlock(type: string, markdown: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(type)) {
    throw new Error(`Unsupported table-cell block type: ${type}`);
  }
  const source = markdown
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // A source backslash immediately before `|` would become indistinguishable
    // from the outer GFM row's pipe escape. Keep it visible but inert until the
    // cell has already been split into columns.
    .replace(/\\/g, "&#92;")
    .replace(/\n/g, BLOCK_LINE);
  return `${BLOCK_OPEN}${type}">${source}</span>`;
}

export function decodeTableCellBlock(
  source: string,
): { type: string; markdown: string } | null {
  const match = BLOCK_PATTERN.exec(source);
  if (!match) return null;
  const markdown = match[2]
    .replaceAll(BLOCK_LINE, "\n")
    // Decode in this order: an authored literal `&lt;` was encoded as
    // `&amp;lt;` and must remain `&lt;`, not turn into `<`.
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#92;/g, "\\")
    .replace(/&amp;/g, "&");
  return { type: match[1], markdown };
}
