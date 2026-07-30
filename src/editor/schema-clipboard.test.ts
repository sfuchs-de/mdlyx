// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { DOMParser as PMDOMParser, DOMSerializer, type Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";

// ProseMirror's clipboard serializes nodes with toDOM and re-parses the HTML
// with the schema's parseDOM rules on paste. Any node with toDOM but no
// parseDOM is silently destroyed by a copy/paste (review s45): figures became
// nothing, footnotes became text, raw LaTeX became a code block, and
// math_display dropped its `tag` attribute.
function clipboardRoundTrip(node: PMNode): PMNode {
  const dom = DOMSerializer.fromSchema(schema).serializeNode(node, { document });
  const container = document.createElement("div");
  container.appendChild(dom);
  const parsed = PMDOMParser.fromSchema(schema).parse(container);
  expect(parsed.childCount).toBeGreaterThan(0);
  return parsed.firstChild!;
}

describe("clipboard (toDOM -> parseDOM) round-trip", () => {
  it("preserves a figure with all attributes", () => {
    const fig = schema.nodes.figure.create({
      src: "assets/plot.png",
      alt: "A plot",
      caption: "Figure caption",
      id: "fig:plot",
      width: "60%",
    });
    const back = clipboardRoundTrip(fig);
    expect(back.type.name).toBe("figure");
    expect(back.attrs).toEqual(fig.attrs);
  });

  it("preserves a figure with an external (non-previewed) src", () => {
    const fig = schema.nodes.figure.create({ src: "https://x.com/a.png", alt: "", caption: "", id: null, width: null });
    const back = clipboardRoundTrip(fig);
    expect(back.type.name).toBe("figure");
    expect(back.attrs.src).toBe("https://x.com/a.png");
  });

  it("preserves a non-CSS TeX figure width in a data attribute", () => {
    const fig = schema.nodes.figure.create({
      src: "assets/plot.pdf",
      alt: "",
      caption: "",
      id: null,
      width: "0.7\\linewidth",
    });
    const back = clipboardRoundTrip(fig);
    expect(back.attrs.width).toBe("0.7\\linewidth");
  });

  it("preserves a footnote reference", () => {
    const ref = schema.nodes.footnote_ref.create({ label: "note1" });
    const para = schema.nodes.paragraph.create(null, [schema.text("a"), ref]);
    const back = clipboardRoundTrip(para);
    expect(back.childCount).toBe(2);
    expect(back.child(1).type.name).toBe("footnote_ref");
    expect(back.child(1).attrs.label).toBe("note1");
  });

  it("preserves a footnote definition without absorbing its label chrome", () => {
    const def = schema.nodes.footnote_definition.create({ label: "note1" }, [
      schema.nodes.paragraph.create(null, schema.text("body text")),
    ]);
    const back = clipboardRoundTrip(def);
    expect(back.type.name).toBe("footnote_definition");
    expect(back.attrs.label).toBe("note1");
    // The "[^note1]" label span is presentation, not content.
    expect(back.textContent).toBe("body text");
  });

  it("preserves a raw LaTeX block (not captured by code_block's pre rule)", () => {
    const raw = schema.nodes.raw_latex.create({ latex: "\\usepackage{tikz}" });
    const back = clipboardRoundTrip(raw);
    expect(back.type.name).toBe("raw_latex");
    expect(back.attrs.latex).toBe("\\usepackage{tikz}");
  });

  it("preserves an invisible Mathdown source marker and its navigation id", () => {
    const marker = schema.nodes.mathdown_source_marker.create({
      directive: "mathdown-claim:R-DEMO-PRICE",
    });
    const dom = DOMSerializer.fromSchema(schema).serializeNode(marker, { document }) as HTMLElement;
    expect(dom.id).toBe("mathdown-claim:R-DEMO-PRICE");
    expect(dom.getAttribute("aria-hidden")).toBe("true");
    const back = clipboardRoundTrip(marker);
    expect(back.type.name).toBe("mathdown_source_marker");
    expect(back.attrs.directive).toBe("mathdown-claim:R-DEMO-PRICE");
  });

  it("renders and preserves a Markdown details disclosure", () => {
    const disclosure = schema.nodes.details_disclosure.create(
      {
        summary: "Full derivation ledger",
        openSource: "<details open>",
        summarySource: "<summary>Full derivation ledger</summary>",
        closeSource: "</details>",
        initiallyOpen: true,
      },
      [schema.nodes.paragraph.create(null, schema.text("Ledger body."))],
    );
    const dom = DOMSerializer.fromSchema(schema).serializeNode(
      disclosure,
      { document },
    ) as HTMLDetailsElement;
    expect(dom.tagName).toBe("DETAILS");
    expect(dom.open).toBe(true);
    expect(dom.querySelector(":scope > summary")?.textContent).toBe(
      "Full derivation ledger",
    );
    expect(dom.textContent).not.toContain("<details>");
    expect(dom.textContent).not.toContain("</details>");

    const back = clipboardRoundTrip(disclosure);
    expect(back.type.name).toBe("details_disclosure");
    expect(back.attrs).toEqual(disclosure.attrs);
    expect(back.textContent).toBe("Ledger body.");
  });

  it("preserves a stable document link and its owner anchor", () => {
    const link = schema.nodes.doc_link.create({
      target: "sample-model:resolvent",
      anchor: "proof:existence",
      label: "Existence proof",
    });
    const back = clipboardRoundTrip(schema.nodes.paragraph.create(null, link));
    expect(back.firstChild?.type.name).toBe("doc_link");
    expect(back.firstChild?.attrs).toMatchObject({
      target: "sample-model:resolvent",
      anchor: "proof:existence",
      label: "Existence proof",
    });
  });

  it("preserves the exact authored wiki-link source through clipboard DOM", () => {
    const source = "[[sample-interface-crosswalk\\|cross-project\ninterface crosswalk]]";
    const link = schema.nodes.doc_link.create({
      target: "sample-interface-crosswalk",
      anchor: null,
      label: "cross-project interface crosswalk",
      source,
    });
    const back = clipboardRoundTrip(schema.nodes.paragraph.create(null, link));
    expect(back.firstChild?.attrs).toMatchObject({
      target: "sample-interface-crosswalk",
      label: "cross-project interface crosswalk",
      source,
    });
  });

  it("still parses a plain pre as a code block", () => {
    const code = schema.nodes.code_block.create({ language: "ts" }, schema.text("let x = 1;"));
    const back = clipboardRoundTrip(code);
    expect(back.type.name).toBe("code_block");
    expect(back.textContent).toBe("let x = 1;");
  });

  it("keeps math_display's tag attribute", () => {
    const eq = schema.nodes.math_display.create({
      latex: "E = mc^2",
      label: "eq:emc",
      numbered: true,
      env: "equation",
      tag: "star",
    });
    const back = clipboardRoundTrip(eq);
    expect(back.type.name).toBe("math_display");
    expect(back.attrs.tag).toBe("star");
    expect(back.attrs.label).toBe("eq:emc");
  });

  it("preserves nested theorem fence identity through clipboard DOM", () => {
    const theorem = schema.nodes.theorem.create(
      {
        kind: "theorem",
        title: "Existence",
        id: "thm:existence",
        fenceLength: 4,
        closingFenceLength: 5,
      },
      schema.nodes.paragraph.create(null, schema.text("A solution exists.")),
    );
    const back = clipboardRoundTrip(theorem);
    expect(back.type.name).toBe("theorem");
    expect(back.attrs).toEqual(theorem.attrs);
    expect(back.textContent).toBe("A solution exists.");
  });
});
