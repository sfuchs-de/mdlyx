import { describe, it, expect } from "vitest";
import { schema } from "../editor/schema";
import { parseMarkdown, parseInline } from "./parse";
import { serializeMarkdown } from "./serialize";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter";

// A serialize(parse(x)) that is stable under a second round means the on-disk
// format is a fixed point: open → save → open never damages the document.
function roundTrip(md: string): string {
  return serializeMarkdown(parseMarkdown(md));
}

// Mirrors app.serializeDocument: frontmatter + body, the actual on-disk form.
function roundTripDocument(md: string): string {
  const { frontmatter, body } = parseFrontmatter(md);
  return serializeFrontmatter(frontmatter) + serializeMarkdown(parseMarkdown(body));
}

describe("markdown round-trip", () => {
  it("is idempotent on a mixed document", () => {
    const src = [
      "# Introduction",
      "",
      "The relation is $E = mc^2$ and it is *famous*.",
      "",
      "$$",
      "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
      "$$ {#eq:integral}",
      "",
      "$$",
      "a &= b + c \\\\",
      "d &= e + f",
      "$$ {#eq:system env=align}",
      "",
      "See @eq:integral. Some `code` and a [link](https://ex.com).",
      "",
      "- one",
      "- two",
      "",
      "> quoted $\\pi$",
      "",
    ].join("\n");

    const once = roundTrip(src);
    const twice = roundTrip(once);
    // Second pass must not change anything the first pass produced.
    expect(twice).toBe(once);
  });

  it("is idempotent on a full document with frontmatter", () => {
    const src = [
      "---",
      "macros:",
      '  RR: "\\mathbb{R}"',
      "numbering:",
      "  equations: section",
      "---",
      "# First {#sec:first}",
      "",
      "Over $\\RR$ we have $x^2$.",
      "",
      "$$",
      "E = mc^2",
      "$$ {#eq:energy}",
      "",
      "See @eq:energy.",
      "",
    ].join("\n");
    const once = roundTripDocument(src);
    const twice = roundTripDocument(once);
    expect(twice).toBe(once);
    // Frontmatter and label attributes survive the round-trip.
    expect(once).toContain('RR: "\\mathbb{R}"');
    expect(once).toContain("equations: section");
    expect(once).toContain("$$ {#eq:energy}");
    expect(once).toContain("# First {#sec:first}");
  });

  it("preserves inline math", () => {
    const nodes = parseInline("before $x^2$ after");
    expect(nodes[1].type.name).toBe("math_inline");
    expect(nodes[1].attrs.latex).toBe("x^2");
  });

  it("keeps display-math attributes", () => {
    const doc = parseMarkdown("$$\nx = 1\n$$ {#eq:e env=align numbered=false}");
    const math = doc.firstChild!;
    expect(math.type.name).toBe("math_display");
    expect(math.attrs.label).toBe("eq:e");
    expect(math.attrs.env).toBe("align");
    expect(math.attrs.numbered).toBe(false);
    expect(math.attrs.latex).toBe("x = 1");
  });

  it("preserves Mathdown audit markers without exposing them as prose", () => {
    const source = [
      "Before.",
      "",
      "<!-- mathdown-derivation:R-DEMO-PRICE -->",
      "",
      "Derivation body.",
      "",
      "<!-- mathdown-claim:R-DEMO-PRICE -->",
      "",
      "After.",
      "",
    ].join("\n");
    const doc = parseMarkdown(source);
    expect(doc.child(1).type.name).toBe("mathdown_source_marker");
    expect(doc.child(1).attrs.directive).toBe("mathdown-derivation:R-DEMO-PRICE");
    expect(doc.child(3).type.name).toBe("mathdown_source_marker");
    expect(doc.textContent).toBe("Before.Derivation body.After.");
    expect(serializeMarkdown(doc)).toBe(source);
  });

  it("keeps compact synthesis-order marker runs compact", () => {
    const source = [
      "<!-- mathdown:synthesis-order-v2:start -->",
      "<!-- mathdown-result:R-DEMO-WELFARE -->",
      "<!-- mathdown-result:R-DEMO-PRICE -->",
      "<!-- mathdown:synthesis-order-v2:end -->",
      "",
    ].join("\n");
    expect(roundTrip(source)).toBe(source);
  });

  it("preserves ordinary HTML comments without exposing them as prose", () => {
    const ordinary = parseMarkdown("<!-- editorial note -->\n");
    const attributedMarker = parseMarkdown(
      "<!-- mathdown-formula:start id=R-DEMO-OVERLAP -->\n",
    );
    const multiline = parseMarkdown("<!-- first line\nsecond line -->\n");
    const unclosed = parseMarkdown("<!-- unclosed\n");
    expect(ordinary.firstChild?.type.name).toBe("html_comment");
    expect(ordinary.textContent).toBe("");
    expect(serializeMarkdown(ordinary)).toBe("<!-- editorial note -->\n");
    expect(attributedMarker.firstChild?.type.name).toBe("html_comment");
    expect(attributedMarker.textContent).toBe("");
    expect(serializeMarkdown(attributedMarker)).toBe(
      "<!-- mathdown-formula:start id=R-DEMO-OVERLAP -->\n",
    );
    expect(multiline.firstChild?.type.name).toBe("html_comment");
    expect(multiline.textContent).toBe("");
    expect(serializeMarkdown(multiline)).toBe("<!-- first line\nsecond line -->\n");
    expect(unclosed.firstChild?.type.name).toBe("paragraph");
    expect(unclosed.textContent).toBe("<!-- unclosed");
  });

  it("renders source-preserving details disclosures without leaking HTML tags", () => {
    const source = [
      "<details>",
      "<summary>Show the full derivation ledger</summary>",
      "",
      "A short introduction.",
      "",
      "| Result | State |",
      "| --- | --- |",
      "| `R-1` | validated |",
      "",
      "</details>",
      "",
    ].join("\n");
    const doc = parseMarkdown(source);
    const disclosure = doc.firstChild!;
    expect(disclosure.type.name).toBe("details_disclosure");
    expect(disclosure.attrs.summary).toBe("Show the full derivation ledger");
    expect(disclosure.textContent).not.toContain("<details>");
    expect(disclosure.textContent).not.toContain("</details>");
    expect(disclosure.child(0).textContent).toBe("A short introduction.");
    expect(disclosure.child(1).type.name).toBe("table");
    expect(serializeMarkdown(doc)).toBe(source);
    expect(roundTrip(roundTrip(source))).toBe(source);
  });

  it("supports nested and initially-open details disclosures", () => {
    const source = [
      "<details open>",
      "<summary>Outer</summary>",
      "",
      "Before.",
      "",
      "<details>",
      "<summary>Inner</summary>",
      "",
      "Inside.",
      "",
      "</details>",
      "",
      "After.",
      "",
      "</details>",
      "",
    ].join("\n");
    const doc = parseMarkdown(source);
    const outer = doc.firstChild!;
    expect(outer.type.name).toBe("details_disclosure");
    expect(outer.attrs.initiallyOpen).toBe(true);
    expect(outer.child(1).type.name).toBe("details_disclosure");
    expect(serializeMarkdown(doc)).toBe(source);
  });

  it("keeps malformed or unclosed details markup visible", () => {
    const malformed = parseMarkdown(
      "<details>\n<summary>Missing closer</summary>\n\nBody.\n",
    );
    expect(malformed.firstChild?.type.name).toBe("paragraph");
    expect(malformed.textContent).toContain("<details>");
    expect(malformed.textContent).toContain("<summary>Missing closer</summary>");

    const singularCloser = parseMarkdown("Before.\n</detail>\nAfter.\n");
    expect(singularCloser.textContent).toContain("</detail>");
  });

  it("merges an indented continuation line into its list item (#I03)", () => {
    const doc = parseMarkdown(
      "- first item that wraps\n  onto a second line\n- second item",
    );
    expect(doc.childCount).toBe(1); // one list, not fragmented
    const list = doc.firstChild!;
    expect(list.type.name).toBe("bullet_list");
    expect(list.childCount).toBe(2);
    expect(list.child(0).textContent).toBe("first item that wraps onto a second line");
  });

  it("parses a nested sub-list into the parent item (#I03b)", () => {
    const doc = parseMarkdown("- a\n  - b\n  - c\n- d");
    expect(doc.childCount).toBe(1);
    const list = doc.firstChild!;
    expect(list.type.name).toBe("bullet_list");
    expect(list.childCount).toBe(2); // a (with sub-list), d
    const itemA = list.child(0);
    expect(itemA.child(0).textContent).toBe("a"); // lead paragraph
    const sub = itemA.child(1);
    expect(sub.type.name).toBe("bullet_list");
    expect(sub.childCount).toBe(2); // b, c
    expect(sub.child(0).textContent).toBe("b");
  });

  it("round-trips a nested list to stable, tight Markdown (#I03b)", () => {
    const src = "- a\n  - b\n  - c\n- d\n";
    expect(roundTrip(src)).toBe(src);
    expect(roundTrip(roundTrip(src))).toBe(roundTrip(src));
  });

  it("round-trips a three-level and mixed ordered/bullet nesting (#I03b)", () => {
    const src = "1. first\n   - alpha\n     - deep\n   - beta\n2. second\n";
    expect(roundTrip(src)).toBe(src);
    const list = parseMarkdown(src).firstChild!;
    expect(list.type.name).toBe("ordered_list");
    const alpha = list.child(0).child(1); // nested bullet list under "first"
    expect(alpha.type.name).toBe("bullet_list");
    expect(alpha.child(0).child(1).type.name).toBe("bullet_list"); // "deep" level
  });

  it("keeps a wrapped continuation AND a nested list in one item (#I03b)", () => {
    const doc = parseMarkdown("- lead text\n  wrapped on\n  - sub");
    const itemA = doc.firstChild!.child(0);
    expect(itemA.child(0).textContent).toBe("lead text wrapped on"); // soft break = space
    expect(itemA.child(1).type.name).toBe("bullet_list");
  });

  it("represents a source line-wrap as a soft_break node (#I02)", () => {
    const p = parseMarkdown("line one\nline two\n").firstChild!;
    expect(p.type.name).toBe("paragraph");
    const kinds: string[] = [];
    p.forEach((c) => kinds.push(c.type.name));
    expect(kinds).toEqual(["text", "soft_break", "text"]); // a real node, not "\n" text
    expect(roundTrip("line one\nline two\n")).toBe("line one\nline two\n");
  });

  it("keeps a mark spanning a soft break as one run (#I02)", () => {
    // emphasis wrapping a line break must stay `*a\nb*`, not split into two.
    expect(roundTrip("*emphasis over\ntwo lines*\n")).toBe("*emphasis over\ntwo lines*\n");
  });

  it("parses and round-trips a theorem environment (#I23)", () => {
    const src = "::: theorem {Pythagoras} {#thm:pyth}\nThe square of the hypotenuse.\n:::\n";
    const t = parseMarkdown(src).firstChild!;
    expect(t.type.name).toBe("theorem");
    expect(t.attrs.kind).toBe("theorem");
    expect(t.attrs.title).toBe("Pythagoras");
    expect(t.attrs.id).toBe("thm:pyth");
    expect(roundTrip(src)).toBe(src);
  });

  it("a theorem can hold math + multiple blocks and round-trips (#I23)", () => {
    const src = "::: lemma\nWe have $x^2 \\ge 0$.\n\n- always\n:::\n";
    expect(roundTrip(src)).toBe(src);
  });

  it("parses nested theorem and proof fences without exposing fence text (#I23)", () => {
    const src = [
      ":::: theorem {Existence} {#thm:existence}",
      "A solution exists.",
      "",
      "::: proof",
      "Apply the fixed-point theorem.",
      ":::",
      "",
      "The solution is unique locally.",
      "::::",
      "",
    ].join("\n");
    const doc = parseMarkdown(src);
    const outer = doc.firstChild!;
    expect(outer.type.name).toBe("theorem");
    expect(outer.attrs.fenceLength).toBe(4);
    expect(outer.attrs.closingFenceLength).toBe(4);
    const nested = outer.content.content.find(
      (node) => node.type.name === "theorem",
    );
    expect(nested?.attrs.kind).toBe("proof");
    expect(nested?.attrs.fenceLength).toBe(3);
    expect(doc.textContent).not.toContain("::::");
    expect(roundTrip(src)).toBe(src);
    expect(parseMarkdown(roundTrip(src)).toJSON()).toEqual(doc.toJSON());
  });

  it("preserves authored longer theorem open and close fences (#I23)", () => {
    const src = ":::: theorem\nBody.\n:::::\n";
    const theorem = parseMarkdown(src).firstChild!;
    expect(theorem.attrs.fenceLength).toBe(4);
    expect(theorem.attrs.closingFenceLength).toBe(5);
    expect(roundTrip(src)).toBe(src);
  });

  it("widens programmatic outer fences around nested theorem blocks (#I23)", () => {
    const proof = schema.nodes.theorem.create(
      { kind: "proof" },
      schema.nodes.paragraph.create(null, schema.text("Proof body.")),
    );
    const theorem = schema.nodes.theorem.create(
      { kind: "theorem", title: "Nested result" },
      [schema.nodes.paragraph.create(null, schema.text("Claim.")), proof],
    );
    const markdown = serializeMarkdown(schema.nodes.doc.create(null, theorem));
    expect(markdown).toBe([
      ":::: theorem {Nested result}",
      "Claim.",
      "",
      "::: proof",
      "Proof body.",
      ":::",
      "::::",
      "",
    ].join("\n"));
    const reparsed = parseMarkdown(markdown);
    let count = 0;
    reparsed.descendants((node) => {
      if (node.type.name === "theorem") count++;
      return true;
    });
    expect(count).toBe(2);
  });

  it("parses cross-references with a kind prefix", () => {
    const nodes = parseInline("see @eq:euler here");
    const xref = nodes.find((n) => n.type.name === "xref")!;
    expect(xref.attrs.target).toBe("eq:euler");
    expect(xref.attrs.kind).toBe("eq");
    const theorem = parseInline("see @thm:existence").find((n) => n.type.name === "xref")!;
    expect(theorem.attrs.kind).toBe("thm");
  });

  it("uses a braced xref boundary before adjacent target characters", () => {
    const original = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.nodes.xref.create({ target: "eq:euler", kind: "eq" }),
        schema.text("-tail"),
      ]),
    ]);
    const markdown = serializeMarkdown(original);
    expect(markdown).toBe("@{eq:euler}-tail\n");
    expect(parseMarkdown(markdown).toJSON()).toEqual(original.toJSON());
    expect(parseInline("@eq:euler-tail")[0].attrs.target).toBe("eq:euler-tail");
  });

  it("parses and serializes stable internal wiki links", () => {
    const nodes = parseInline(
      "See [[sample-model:resolvent#proof:existence|the proof]] and [[ov1]].",
    );
    const links = nodes.filter((n) => n.type.name === "doc_link");
    expect(links).toHaveLength(2);
    expect(links[0].attrs).toMatchObject({
      target: "sample-model:resolvent",
      anchor: "proof:existence",
      label: "the proof",
    });
    expect(links[1].attrs).toMatchObject({ target: "ov1", anchor: null, label: null });
    expect(roundTrip(
      "See [[sample-model:resolvent#proof:existence|the proof]] and [[ov1]].\n",
    )).toBe(
      "See [[sample-model:resolvent#proof:existence|the proof]] and [[ov1]].\n",
    );
  });

  it("parses table-safe and soft-wrapped wiki links without changing their source", () => {
    const escaped = "[[sample-interface-crosswalk\\|cross-project interface crosswalk]]";
    const wrapped = "[[sample-interface-crosswalk\\|cross-project\ninterface crosswalk]]";
    for (const source of [escaped, wrapped]) {
      const link = parseInline(source)[0];
      expect(link.type.name).toBe("doc_link");
      expect(link.attrs).toMatchObject({
        target: "sample-interface-crosswalk",
        anchor: null,
        label: "cross-project interface crosswalk",
        source,
      });
      expect(roundTrip(`${source}\n`)).toBe(`${source}\n`);
    }
  });

  it("keeps escaped punctuation in a wiki label while preserving the author source", () => {
    const source = "[[target#proof\\:existence\\|Proof \\[revised\\]]]";
    const link = parseInline(source)[0];
    expect(link.attrs).toMatchObject({
      target: "target",
      anchor: "proof:existence",
      label: "Proof [revised]",
      source,
    });
    expect(roundTrip(`${source}\n`)).toBe(`${source}\n`);
  });

  it("keeps escaped and malformed wiki syntax as ordinary prose", () => {
    for (const source of [
      "\\[\\[ov1]]",
      "[[ov1|]]",
      "[[ov1#]]",
      "[[ov1#two#anchors]]",
      "[[not a valid id]]",
      "[[target|label\n\nnext paragraph]]",
    ]) {
      const nodes = parseInline(source);
      expect(nodes.some((n) => n.type.name === "doc_link")).toBe(false);
      expect(nodes.map((n) => n.text ?? "").join("")).toBe(source.replace(/\\/g, ""));
    }
  });
});

// Adversarial-review regressions: inputs that used to corrupt on save.
describe("overlapping and same-span emphasis (review s45)", () => {
  const em = () => schema.marks.em.create();
  const strong = () => schema.marks.strong.create();
  const doc = (nodes: ReturnType<typeof schema.text>[]) =>
    schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, nodes)]);
  const textOf = (md: string) => parseMarkdown(md).textContent;
  const markedRuns = (md: string) => {
    const runs: Array<{ text: string; marks: string[] }> = [];
    parseMarkdown(md).descendants((node) => {
      if (!node.isText || !node.text) return;
      runs.push({
        text: node.text,
        marks: node.marks.map((mark) => mark.type.name).sort(),
      });
    });
    return runs;
  };

  it("same-span strong+em round-trips as ***text*** without corrupting", () => {
    const src = doc([schema.text("both", [strong(), em()])]);
    const md = serializeMarkdown(src);
    expect(md).toBe("***both***\n");
    const back = parseMarkdown(md);
    expect(back.textContent).toBe("both"); // was "*both*" before the fix
    const marks = back.firstChild!.firstChild!.marks.map((m) => m.type.name).sort();
    expect(marks).toEqual(["em", "strong"]);
    expect(serializeMarkdown(back)).toBe(md); // idempotent
  });

  it("parses ***x*** inside prose and nested inside em", () => {
    expect(textOf("a ***b*** c\n")).toBe("a b c");
    expect(textOf("*x ***b*** y*\n")).toBe("x b y");
  });

  it("parses strong containing an inner em that closes at a *** run", () => {
    // `**a *b***` = strong("a " + em("b")) — the run's first star closes the em.
    const nodes = parseInline("**a *b***");
    expect(nodes.map((n) => n.text).join("")).toBe("a b");
    const last = nodes[nodes.length - 1];
    expect(last.marks.some((m) => m.type.name === "em")).toBe(true);
    expect(last.marks.some((m) => m.type.name === "strong")).toBe(true);
  });

  it("em overlapping strong (em first) preserves every mark", () => {
    const src = doc([
      schema.text("a ", [em()]),
      schema.text("b", [em(), strong()]),
      schema.text(" c", [strong()]),
    ]);
    const md = serializeMarkdown(src);
    const back = parseMarkdown(md);
    expect(back.toJSON()).toEqual(src.toJSON());
    expect(serializeMarkdown(back)).toBe(md);
  });

  it("strong overlapping em (strong first) preserves every mark", () => {
    const src = doc([
      schema.text("a ", [strong()]),
      schema.text("b", [strong(), em()]),
      schema.text(" c", [em()]),
    ]);
    const md = serializeMarkdown(src);
    const back = parseMarkdown(md);
    expect(back.toJSON()).toEqual(src.toJSON());
    expect(serializeMarkdown(back)).toBe(md);
  });

  it("resolves delimiter runs one through six without losing text or marks", () => {
    expect(markedRuns("*a*\n")).toEqual([{ text: "a", marks: ["em"] }]);
    expect(markedRuns("*a**b*\n")).toEqual([{ text: "ab", marks: ["em"] }]);
    expect(markedRuns("**a***b*\n")).toEqual([
      { text: "a", marks: ["strong"] },
      { text: "b", marks: ["em"] },
    ]);
    expect(markedRuns("**a *b****c*\n")).toEqual([
      { text: "a ", marks: ["strong"] },
      { text: "b", marks: ["em", "strong"] },
      { text: "c", marks: ["em"] },
    ]);
    expect(markedRuns("*a **b*****c**\n")).toEqual([
      { text: "a ", marks: ["em"] },
      { text: "b", marks: ["em", "strong"] },
      { text: "c", marks: ["strong"] },
    ]);
    expect(markedRuns("***a******b***\n")).toEqual([
      { text: "ab", marks: ["em", "strong"] },
    ]);
  });

  it("exhaustively round-trips every em/strong state sequence through length six", () => {
    const states = [
      [] as ReturnType<typeof em>[],
      [em()],
      [strong()],
      [em(), strong()],
    ];
    const chars = "abcdef";
    for (let length = 1; length <= 6; length++) {
      const cases = states.length ** length;
      for (let encoded = 0; encoded < cases; encoded++) {
        let value = encoded;
        const nodes: ReturnType<typeof schema.text>[] = [];
        for (let index = 0; index < length; index++) {
          const state = states[value % states.length];
          value = Math.floor(value / states.length);
          nodes.push(schema.text(chars[index], state));
        }
        const source = doc(nodes);
        const markdown = serializeMarkdown(source);
        expect(parseMarkdown(markdown).toJSON(), markdown).toEqual(source.toJSON());
      }
    }
  });

  it("keeps properly nested marks fully intact (no over-suppression)", () => {
    for (const src of ["*a **b** c*\n", "**a *b* c**\n", "*a* **b**\n", "*a* and *b*\n"]) {
      expect(roundTrip(src)).toBe(src);
    }
  });
});

describe("round-trip: adversarial regressions", () => {
  const IDENTITY: Record<string, string> = {
    "em around math (#I27)": "the value *a $x^2$ b* is set\n",
    "strong around math (#I27)": "note **bold $y$ end** here\n",
    "bold inside italic (#I06)": "outer *a **b** c* end\n",
    "italic inside bold (#I06)": "**a *b* c** end\n",
    // A literal `[` now serializes escaped (`\[`) so it never re-parses as a link
    // (#I60); the URL is still preserved as plain text (#I28).
    "empty link kept literal (#I28)": "see \\[](http://x.com) here\n",
    "normal link with title": 'a [link](http://y.com "t") here\n',
    "inline code containing a star": "use `co*de` span here\n",
    "hand-wrapped paragraph (#I02)": "line one of a paragraph\nline two same paragraph\n",
  };
  for (const [name, md] of Object.entries(IDENTITY)) {
    it(`${name} round-trips to identity`, () => {
      expect(roundTrip(md)).toBe(md);
      expect(roundTrip(roundTrip(md))).toBe(roundTrip(md));
    });
  }

  it("emphasis keeps the equation inside the delimiters (#I27)", () => {
    // Was corrupted to `*a *$x$* b*` (math fell outside the emphasis).
    expect(roundTrip("*a $x$ b*\n")).toBe("*a $x$ b*\n");
  });

  it("does not parse adjacent currency amounts as inline math", () => {
    const source = "It costs $5 and $10 today";
    const nodes = parseInline(source);
    expect(nodes.some((node) => node.type.name === "math_inline")).toBe(false);
    expect(nodes.map((node) => node.text ?? "").join("")).toBe(source);
    const saved = roundTrip(`${source}\n`);
    expect(saved).toContain("\\$5");
    expect(saved).toContain("\\$10");
    expect(roundTrip(saved)).toBe(saved);
    expect(parseInline("$5$")[0].type.name).toBe("math_inline");
  });

  it("an empty link never loses its URL (#I28)", () => {
    expect(roundTrip("[](http://x.com)\n")).toContain("http://x.com");
    const nodes = parseInline("[](@profile)");
    expect(nodes.some((node) => node.type.name === "xref")).toBe(false);
    expect(nodes.map((node) => node.text ?? "").join("")).toBe("[](@profile)");
  });

  it("keeps unsafe link schemes as literal text", () => {
    const src = "see [this](javascript:alert(1)) and [that](file:///secret)\n";
    const doc = parseMarkdown(src);
    expect(doc.textContent).toBe(src.trimEnd());
    expect(doc.firstChild!.firstChild!.marks).toHaveLength(0);
    expect(roundTrip(src)).toContain("\\[this](javascript:alert(1))");
  });

  it("accepts safe and relative link targets", () => {
    for (const href of ["https://example.com", "mailto:author@example.com", "docs/note.md", "#section"]) {
      const node = parseMarkdown(`[link](${href})\n`).firstChild!.firstChild!;
      expect(node.marks.some((m) => m.type.name === "link")).toBe(true);
    }
  });

  it("parses a link label beginning with @ as a link, not a citation", () => {
    const source = "[@profile](https://example.com/u)\n";
    const doc = parseMarkdown(source);
    let citations = 0;
    let links = 0;
    doc.descendants((node) => {
      if (node.type.name === "citation") citations++;
      links += node.marks.filter((mark) =>
        mark.type.name === "link" && mark.attrs.href === "https://example.com/u"
      ).length;
    });
    expect(citations).toBe(0);
    expect(links).toBeGreaterThan(0);
    expect(serializeMarkdown(doc)).toBe(source);
    expect(parseInline("[@smith2024]")[0].type.name).toBe("citation");
  });

  it("round-trips balanced link destinations and escaped titles semantically", () => {
    const href = "https://example.com/a_(b(c))/white space";
    const title = 'a "quoted" \\ title';
    const link = schema.marks.link.create({ href, title });
    const original = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("reference", [link])]),
    ]);
    const markdown = serializeMarkdown(original);
    const reparsed = parseMarkdown(markdown);
    expect(reparsed.toJSON()).toEqual(original.toJSON());
    expect(serializeMarkdown(reparsed)).toBe(markdown);
  });

  it("only consumes valid Markdown backslash escapes in links", () => {
    const source = String.raw`[a\q](docs\notes\q.md "title\q")`;
    const node = parseInline(source)[0];
    expect(node.text).toBe(String.raw`a\q`);
    const link = node.marks.find((mark) => mark.type.name === "link")!;
    expect(link.attrs.href).toBe(String.raw`docs\notes\q.md`);
    expect(link.attrs.title).toBe(String.raw`title\q`);

    const originalLink = schema.marks.link.create({
      href: String.raw`docs\notes\q file.md`,
      title: String.raw`title\q`,
    });
    const original = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text(String.raw`a\q`, [originalLink])]),
    ]);
    const markdown = serializeMarkdown(original);
    expect(markdown).toContain("(<");
    expect(parseMarkdown(markdown).toJSON()).toEqual(original.toJSON());
  });

  it("round-trips linked code and math containing a closing bracket", () => {
    const link = schema.marks.link.create({ href: "docs/detail.md", title: null });
    const original = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("a]b", [schema.marks.code.create(), link]),
        schema.text(" and "),
        schema.nodes.math_inline.create({ latex: "x]y" }, undefined, [link]),
      ]),
    ]);
    const markdown = serializeMarkdown(original);
    expect(parseMarkdown(markdown).toJSON()).toEqual(original.toJSON());
    expect(serializeMarkdown(parseMarkdown(markdown))).toBe(markdown);
  });

  it.each([" x]y", "x]y "])(
    "round-trips linked bracketed math with boundary whitespace: %s",
    (latex) => {
      const link = schema.marks.link.create({ href: "docs/detail.md", title: null });
      const original = schema.nodes.doc.create(null, [
        schema.nodes.paragraph.create(null, [
          schema.nodes.math_inline.create({ latex }, undefined, [link]),
        ]),
      ]);
      const markdown = serializeMarkdown(original);
      expect(parseMarkdown(markdown).toJSON()).toEqual(original.toJSON());
      expect(serializeMarkdown(parseMarkdown(markdown))).toBe(markdown);
    },
  );

  it("round-trips bounded linked math followed immediately by a digit", () => {
    const link = schema.marks.link.create({ href: "docs/detail.md", title: null });
    const original = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.nodes.math_inline.create({ latex: " x]y" }, undefined, [link]),
        schema.text("2", [link]),
      ]),
    ]);
    const markdown = serializeMarkdown(original);
    expect(markdown).toBe("[$ x]y$2](docs/detail.md)\n");
    expect(parseMarkdown(markdown).toJSON()).toEqual(original.toJSON());
    expect(serializeMarkdown(parseMarkdown(markdown))).toBe(markdown);
  });

  it("keeps boundary-whitespace dollar text literal outside the bounded linked-math case", () => {
    for (const source of ["$ text$", "$text $"]) {
      const nodes = parseInline(source);
      expect(nodes.some((node) => node.type.name === "math_inline")).toBe(false);
      expect(nodes.map((node) => node.text ?? "").join("")).toBe(source);
    }
    const linked = parseInline("[$ text$](docs/note.md)");
    expect(linked.some((node) => node.type.name === "math_inline")).toBe(false);
    expect(linked[0].text).toBe("$ text$");
    expect(linked[0].marks.some((mark) => mark.type.name === "link")).toBe(true);
  });

  it("preserves an explicitly empty link title", () => {
    const link = schema.marks.link.create({ href: "docs/note.md", title: "" });
    const original = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("note", [link])]),
    ]);
    expect(parseMarkdown(serializeMarkdown(original)).toJSON()).toEqual(original.toJSON());
  });

  it.each([
    "javascript:alert(1)",
    "file:///tmp/private",
    "data:text/html,x",
    "//evil.example/x",
  ])("never activates unsafe balanced href %s", (href) => {
    const source = `[x](${href})\n`;
    const doc = parseMarkdown(source);
    let links = 0;
    doc.descendants((node) => {
      links += node.marks.filter((mark) => mark.type.name === "link").length;
    });
    expect(links).toBe(0);
    expect(doc.textContent).toBe(source.trimEnd());
  });

  it.each([
    "::: theorem\nbody\n",
    "::: ???\nbody\n:::\n",
    "::: theorem {Unclosed\nbody\n:::\n",
    ":::: theorem\nbody\n",
    ":::: theorem\n:::: lemma\nnested\n::::\n::::\n",
  ])("keeps malformed or unclosed theorem source as prose", (source) => {
    const doc = parseMarkdown(source);
    let theorems = 0;
    doc.descendants((node) => {
      if (node.type.name === "theorem") theorems++;
    });
    expect(theorems).toBe(0);
    expect(serializeMarkdown(doc)).toBe(source);
  });

  // Review s37: a lone delimiter-shaped line used to hang parseBlocks (OOM).
  it("a delimiter-shaped prose line does not hang the parser (#I72)", () => {
    for (const src of ["---|---\n", "|---|---|\n", "-|-\n", "a|-\n"]) {
      const doc = parseMarkdown(src);
      expect(doc.childCount).toBe(1);
      expect(doc.firstChild!.type.name).toBe("paragraph");
      expect(doc.firstChild!.textContent).toBe(src.trimEnd());
    }
  });

  // Review s37: a code span containing a backtick used to corrupt on reopen (#I79).
  it("round-trips a code span containing a backtick (#I79)", () => {
    const code = schema.marks.code.create();
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("a`b", [code])]),
    ]);
    const md = serializeMarkdown(doc);
    expect(md).toBe("``a`b``\n"); // fence widened to two backticks
    const back = parseMarkdown(md);
    const text = back.firstChild!.firstChild!;
    expect(text.text).toBe("a`b");
    expect(text.marks.some((m) => m.type.name === "code")).toBe(true);
    expect(serializeMarkdown(back)).toBe(md); // idempotent
  });

  it("pads a code span that starts or ends with a backtick (#I79)", () => {
    const code = schema.marks.code.create();
    for (const content of ["`x", "x`", "`"]) {
      const doc = schema.nodes.doc.create(null, [
        schema.nodes.paragraph.create(null, [schema.text(content, [code])]),
      ]);
      const md = serializeMarkdown(doc);
      const back = parseMarkdown(md);
      expect(back.firstChild!.firstChild!.text).toBe(content);
      expect(serializeMarkdown(back)).toBe(md); // idempotent
    }
  });

  it.each(["``", "````", "before `` after"])(
    "keeps empty backtick run %s as literal text",
    (source) => {
      const nodes = parseInline(source);
      expect(nodes.map((node) => node.text ?? "").join("")).toBe(source);
      expect(nodes.every((node) => node.marks.every((mark) => mark.type.name !== "code"))).toBe(true);
    },
  );

  // Review s37: a literal trailing `{#word}` in heading text was swallowed as an
  // id on reopen (#I79). The brace is escaped so it stays literal text.
  it("keeps a literal trailing {#word} in a heading (#I79)", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.heading.create({ level: 2, id: null }, schema.text("See {#intro}")),
    ]);
    const md = serializeMarkdown(doc);
    expect(md).toBe("## See \\{#intro}\n");
    const back = parseMarkdown(md);
    expect(back.firstChild!.attrs.id).toBe(null);
    expect(back.firstChild!.textContent).toBe("See {#intro}");
    expect(serializeMarkdown(back)).toBe(md); // idempotent
  });

  it("still reads a real trailing {#id} as the heading id", () => {
    const doc = parseMarkdown("## Title {#sec:x}\n");
    expect(doc.firstChild!.attrs.id).toBe("sec:x");
    expect(doc.firstChild!.textContent).toBe("Title");
  });

  // Review s37: a `]` inside link text used to corrupt the link on reopen (#I73).
  it("preserves a link whose visible text contains brackets (#I73)", () => {
    const link = schema.marks.link.create({ href: "http://x.com", title: null });
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("a]b[c", [link])]),
    ]);
    const md = serializeMarkdown(doc);
    const back = parseMarkdown(md);
    const text = back.firstChild!.firstChild!;
    expect(text.marks.some((m) => m.type.name === "link")).toBe(true);
    expect(back.firstChild!.textContent).toBe("a]b[c");
    expect(serializeMarkdown(back)).toBe(md); // idempotent
  });
});

describe("frontmatter comments JSON (#I32)", () => {
  it("parses a pretty-printed (multi-line) comments array", () => {
    const md = `---
comments: [
  {
    "id": "c1",
    "body": "note",
    "quote": "hello"
  }
]
---

hello world
`;
    expect(parseFrontmatter(md).frontmatter.comments).toHaveLength(1);
  });

  it("still parses a single-line comments array", () => {
    const md = `---\ncomments: [{"id":"c2","body":"x","quote":"y"}]\n---\n\nbody\n`;
    expect(parseFrontmatter(md).frontmatter.comments[0].id).toBe("c2");
  });

  it("parses a fenced code block whose only content is a blank line (#I55)", () => {
    // `schema.text("")` throws — a blank-only fence used to crash the open.
    expect(() => parseMarkdown("```\n\n```\n")).not.toThrow();
    const doc = parseMarkdown("```\n\n```\n");
    expect(doc.firstChild!.type.name).toBe("code_block");
  });

  it("does not drop a macros block following the comments array", () => {
    const md = `---\ncomments: [{"id":"c3"}]\nmacros:\n  RR: "\\mathbb{R}"\n---\n\nbody\n`;
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.comments).toHaveLength(1);
    expect(frontmatter.macros.RR).toBe("\\mathbb{R}");
  });

  // #I78: the balance-based accumulator must ignore braces INSIDE a string value
  // and stop exactly at the closing brace, so a following block still parses.
  it("parses a pretty-printed library object with a brace inside a string (#I78)", () => {
    const md = `---
library: {
  "id": "d1",
  "title": "On {rings} and things}",
  "tags": ["algebra"]
}
comments: [{"id":"c1","body":"x","quote":"y"}]
---

body
`;
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.library.id).toBe("d1");
    expect(frontmatter.library.title).toBe("On {rings} and things}");
    expect(frontmatter.library.tags).toEqual(["algebra"]);
    expect(frontmatter.comments).toHaveLength(1); // block after the object survived
  });
});

describe("scholarly Markdown constructs", () => {
  it.each([
    "Evidence [@smith2024, p. 12] and [@doe2020; -@roe2019].\n",
    "A claim[^proof].\n\n[^proof]: Supporting detail.\n",
    "![Atlantic clock](assets/clock.pdf){#fig:clock width=70%}\n",
    "![Interval \\] estimate](assets/interval.pdf){#fig:interval}\n",
    "```{=latex}\n\\newcommand{\\specialcase}{1}\n```\n",
  ])("round-trips %s", (source) => {
    const once = serializeMarkdown(parseMarkdown(source));
    const twice = serializeMarkdown(parseMarkdown(once));
    expect(twice).toBe(once);
  });

  it("leaves malformed citation and footnote syntax as ordinary text", () => {
    const source = "Broken [@] and [^] remain prose.\n";
    const doc = parseMarkdown(source);
    expect(doc.descendants((node) => {
      expect(node.type.name).not.toBe("citation");
      expect(node.type.name).not.toBe("footnote_ref");
    })).toBeUndefined();
  });
});
