import { describe, it, expect } from "vitest";
import { schema } from "../editor/schema";
import { parseMarkdown } from "./parse";
import { serializeMarkdown } from "./serialize";
import { exportLatex } from "../tex/export-latex";

const TABLE = [
  "| Symbol | Meaning | Value |",
  "| --- | --- | --- |",
  "| $\\alpha$ | **growth** | $0.1$ |",
  "| $\\beta$ | text | $-0.15$ |",
].join("\n");

describe("tables & horizontal rules", () => {
  it("parses a GFM table into table nodes", () => {
    const doc = parseMarkdown(TABLE);
    const table = doc.firstChild!;
    expect(table.type.name).toBe("table");
    expect(table.childCount).toBe(3); // header + 2 body rows
    expect(table.firstChild!.firstChild!.type.name).toBe("table_header");
    // A body cell keeps inline math.
    const bodyCell = table.child(1).firstChild!;
    expect(bodyCell.type.name).toBe("table_cell");
    const inlineMath = bodyCell.firstChild!.firstChild!;
    expect(inlineMath.type.name).toBe("math_inline");
    expect(inlineMath.attrs.latex).toBe("\\alpha");
  });

  it("round-trips a table to stable Markdown", () => {
    const once = serializeMarkdown(parseMarkdown(TABLE));
    const twice = serializeMarkdown(parseMarkdown(once));
    expect(once).toBe(twice);
    expect(once).toContain("| Symbol | Meaning | Value |");
    expect(once).toContain("| --- | --- | --- |");
    expect(once).toContain("**growth**");
  });

  it("renders authored HTML breaks in table cells and preserves them on save", () => {
    const source = [
      "| Document | Results |",
      "| --- | --- |",
      "| Queueing | `R-DEMO-RBM-EXP`<br>`R-DEMO-LAPLACE` |",
    ].join("\n");
    const doc = parseMarkdown(source);
    const resultCell = doc.firstChild!.child(1).child(1).firstChild!;
    expect(resultCell.textContent).toBe("R-DEMO-RBM-EXPR-DEMO-LAPLACE");
    expect(resultCell.child(1).type.name).toBe("hard_break");
    const markdown = serializeMarkdown(doc);
    expect(markdown).toContain("`R-DEMO-RBM-EXP`<br>`R-DEMO-LAPLACE`");
    expect(serializeMarkdown(parseMarkdown(markdown))).toBe(markdown);
  });

  it("preserves per-column alignment through the round-trip (#I15)", () => {
    const src = [
      "| L | C | R |",
      "| :--- | :---: | ---: |",
      "| 1 | 2 | 3 |",
    ].join("\n");
    const doc = parseMarkdown(src);
    const headerRow = doc.firstChild!.firstChild!;
    expect(headerRow.child(0).attrs.align).toBe("left");
    expect(headerRow.child(1).attrs.align).toBe("center");
    expect(headerRow.child(2).attrs.align).toBe("right");
    const once = serializeMarkdown(doc);
    expect(once).toContain("| :--- | :---: | ---: |");
    expect(serializeMarkdown(parseMarkdown(once))).toBe(once); // idempotent
  });

  it("exports column alignment to the tabular spec (#I15)", () => {
    const src = "| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |";
    const tex = exportLatex(parseMarkdown(src), { standalone: false });
    expect(tex).toContain("\\begin{tabular}{lcr}");
  });

  it("round-trips and exports a captioned, labelled table wrapper", () => {
    const source = `${TABLE}\n{#tbl:parameters caption="Model \\"parameters\\""}`;
    const doc = parseMarkdown(source);
    const table = doc.firstChild!;
    expect(table.attrs.id).toBe("tbl:parameters");
    expect(table.attrs.caption).toBe('Model "parameters"');
    expect(serializeMarkdown(doc)).toBe(`${source}\n`);
    const tex = exportLatex(doc, { standalone: false });
    expect(tex).toContain("\\begin{table}[htbp]");
    expect(tex).toContain('\\caption{Model "parameters"}');
    expect(tex).toContain("\\label{tbl:parameters}");
  });

  it("never loses body cells when a row overflows the header width (review s45)", () => {
    // A hand-authored `|` inside a code span splits the row (GFM semantics), so
    // this body row has 3 cells under a 2-column header. The overflow must fold
    // into the last column — padRow used to silently DELETE it.
    const src = "| a | b |\n| --- | --- |\n| 1 | `x|y` |";
    const doc = parseMarkdown(src);
    const table = doc.firstChild!.type.name === "table" ? doc.firstChild! : doc.firstChild!.firstChild!;
    const bodyRow = table.child(1);
    expect(bodyRow.childCount).toBe(2);
    expect(bodyRow.child(1).textContent).toContain("x");
    expect(bodyRow.child(1).textContent).toContain("y"); // nothing dropped
    const once = serializeMarkdown(doc);
    expect(serializeMarkdown(parseMarkdown(once))).toBe(once); // idempotent
  });

  it("an unpaired $ in a cell (currency) never merges cells (review s45)", () => {
    // Regression guard for the reverted span-aware split: `$5 | Qty $3` must
    // stay two cells, not become one inline-math cell that eats the separator.
    const src = "| Price $5 | Qty $3 |\n| --- | --- |\n| 1 | 2 |";
    const doc = parseMarkdown(src);
    const table = doc.firstChild!.type.name === "table" ? doc.firstChild! : doc.firstChild!.firstChild!;
    const header = table.firstChild!;
    expect(header.childCount).toBe(2);
    expect(header.child(0).textContent).toBe("Price $5");
    expect(header.child(1).textContent).toBe("Qty $3");
    expect(table.child(1).child(1).textContent).toBe("2"); // nothing dropped
    const once = serializeMarkdown(doc);
    expect(serializeMarkdown(parseMarkdown(once))).toBe(once);
  });

  it("app-authored cells with pipes in code/math round-trip via escapes", () => {
    // The serializer escapes every `|` in a cell (including inside code/math),
    // so app-authored content round-trips losslessly through the GFM split.
    const cell = schema.nodes.table_cell.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("x|y", [schema.marks.code.create()])]),
    ]);
    const header = schema.nodes.table_header.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("h")]),
    ]);
    const table = schema.nodes.table.create(null, [
      schema.nodes.table_row.create(null, [header]),
      schema.nodes.table_row.create(null, [cell]),
    ]);
    const doc = schema.nodes.doc.create(null, [table]);
    const md = serializeMarkdown(doc);
    expect(md).toContain("\\|"); // pipe escaped inside the code span
    const back = parseMarkdown(md);
    const backTable = back.firstChild!.type.name === "table" ? back.firstChild! : back.firstChild!.firstChild!;
    expect(backTable.child(1).child(0).textContent).toBe("x|y");
    expect(serializeMarkdown(back)).toBe(md);
  });

  it("round-trips every paragraph in a multi-paragraph cell", () => {
    const link = schema.marks.link.create({ href: "docs/detail.md", title: null });
    const cell = schema.nodes.table_cell.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("first paragraph")]),
      schema.nodes.paragraph.create(null, [schema.text("linked second", [link])]),
      schema.nodes.paragraph.create(null, [schema.nodes.math_inline.create({ latex: "x+y" })]),
    ]);
    const header = schema.nodes.table_header.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("h")]),
    ]);
    const original = schema.nodes.doc.create(null, [
      schema.nodes.table.create(null, [
        schema.nodes.table_row.create(null, [header]),
        schema.nodes.table_row.create(null, [cell]),
      ]),
    ]);

    const markdown = serializeMarkdown(original);
    expect(markdown).toContain(
      "first paragraph<br data-mdlyx-paragraph><br>[linked second](docs/detail.md)"
      + "<br data-mdlyx-paragraph><br>$x+y$",
    );
    const reparsed = parseMarkdown(markdown);
    const table = reparsed.firstChild!;
    const reparsedCell = table.child(1).child(0);
    expect(reparsedCell.childCount).toBe(3);
    expect(reparsedCell.child(0).textContent).toBe("first paragraph");
    expect(reparsedCell.child(1).textContent).toBe("linked second");
    expect(reparsedCell.child(1).firstChild!.marks.some((mark) => mark.type.name === "link")).toBe(true);
    expect(reparsedCell.child(2).firstChild!.type.name).toBe("math_inline");
    expect(serializeMarkdown(reparsed)).toBe(markdown);
  });

  it("round-trips structured blocks in a table cell without flattening them", () => {
    const paragraph = (text: string) =>
      schema.nodes.paragraph.create(null, [schema.text(text)]);
    const list = schema.nodes.bullet_list.create(null, [
      schema.nodes.list_item.create(null, [paragraph("one")]),
      schema.nodes.list_item.create(null, [paragraph("two")]),
    ]);
    const display = schema.nodes.math_display.create({
      latex: "x=y",
      label: "eq:cell",
      env: "equation",
      numbered: true,
      tag: null,
    });
    const code = schema.nodes.code_block.create(
      { language: "ts" },
      schema.text("const edge = /a\\|b/;\nif (a < b && c > d) x = y | z;"),
    );
    const header = schema.nodes.table_header.create(null, [paragraph("Result")]);
    const cell = schema.nodes.table_cell.create(null, [
      paragraph("Before"),
      list,
      display,
      code,
      paragraph("After"),
    ]);
    const original = schema.nodes.doc.create(null, [
      schema.nodes.table.create(null, [
        schema.nodes.table_row.create(null, [header]),
        schema.nodes.table_row.create(null, [cell]),
      ]),
    ]);

    const markdown = serializeMarkdown(original);
    expect(markdown).toContain('<span data-mdlyx-cell-block="bullet_list">- one');
    expect(markdown).toContain('<span data-mdlyx-cell-block="math_display">$$');
    expect(markdown).toContain('<span data-mdlyx-cell-block="code_block">```ts');
    expect(markdown).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/); // source stays human-readable
    const reparsed = parseMarkdown(markdown);
    expect(reparsed.toJSON()).toEqual(original.toJSON());
    expect(serializeMarkdown(reparsed)).toBe(markdown);
  });

  it("does not add the structured-cell extension to ordinary GFM tables", () => {
    const source = "| A | B |\n| --- | --- |\n| one | two |\n";
    const markdown = serializeMarkdown(parseMarkdown(source));
    expect(markdown).toBe(source);
    expect(markdown).not.toContain("data-mdlyx-cell-block");
  });

  it("still splits on escaped and plain pipes correctly", () => {
    const src = "| a \\| b | y |\n| --- | --- |\n| 1 | 2 |";
    const doc = parseMarkdown(src);
    const table = doc.firstChild!.type.name === "table" ? doc.firstChild! : doc.firstChild!.firstChild!;
    expect(table.firstChild!.childCount).toBe(2);
    expect(table.firstChild!.child(0).textContent).toBe("a | b");
  });

  it("parses a horizontal rule and round-trips it", () => {
    const doc = parseMarkdown("above\n\n---\n\nbelow");
    expect(doc.child(1).type.name).toBe("horizontal_rule");
    const md = serializeMarkdown(doc);
    expect(md).toContain("\n---\n");
  });

  it("does not treat a plain pipe sentence as a table", () => {
    const doc = parseMarkdown("use a | b to pipe things");
    expect(doc.firstChild!.type.name).toBe("paragraph");
  });

  it("exports a table to a LaTeX tabular", () => {
    const tex = exportLatex(parseMarkdown(TABLE), { standalone: false });
    expect(tex).toContain("\\begin{tabular}{lll}");
    expect(tex).toContain("Symbol & Meaning & Value \\\\");
    expect(tex).toContain("\\hline");
    expect(tex).toContain("\\textbf{growth}");
    expect(tex).toContain("$\\alpha$");
    expect(tex).toContain("\\end{tabular}");
  });

  it("exports a horizontal rule", () => {
    const tex = exportLatex(parseMarkdown("a\n\n---\n\nb"), { standalone: false });
    expect(tex).toContain("\\rule{\\linewidth}");
  });
});
