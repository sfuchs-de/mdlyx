import { describe, it, expect } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../editor/schema";
import { parseMarkdown } from "./parse";
import { serializeMarkdown } from "./serialize";

// Phase-0 round-trip fuzz corpus (#I60). The true scenario: a user types literal
// prose in the editor (a plain text node), saves (serialize), and reopens
// (parse). The on-disk `.md` must round-trip that text back to the SAME plain
// text — never reinterpreted as math / a link / code / emphasis. We build the
// doc from the schema (so the "before" really is literal text), serialize it,
// reparse, and check:
//   1. the text is preserved (textContent unchanged);
//   2. no inline atoms (math/xref/document links) were conjured from the prose;
//   3. serialize→parse→serialize is idempotent.

const t = (text: string) => (text ? [schema.text(text)] : []);
const para = (text: string) => schema.nodes.paragraph.create(null, t(text));
const doc = (...blocks: PMNode[]) => schema.nodes.doc.create(null, blocks);

// Build a one-snippet doc in a given block context.
const CONTEXTS: Record<string, (s: string) => PMNode> = {
  paragraph: (s) => doc(para(s)),
  heading: (s) => doc(schema.nodes.heading.create({ level: 2 }, t(s))),
  bullet: (s) => doc(schema.nodes.bullet_list.create(null, [schema.nodes.list_item.create(null, [para(s)])])),
  ordered: (s) =>
    doc(schema.nodes.ordered_list.create({ start: 1 }, [schema.nodes.list_item.create(null, [para(s)])])),
  blockquote: (s) => doc(schema.nodes.blockquote.create(null, [para(s)])),
};

// Literal prose containing markdown/math trigger characters.
const PROSE: Record<string, string> = {
  "dollar amounts": "it costs $5 and $10 today",
  "single dollar": "the price is $5 per unit",
  "asterisk multiply": "compute a * b * c for the product",
  "double asterisk": "a ** b means power in some langs",
  "backtick word": "press the ` key to open the console",
  "square brackets": "the array element a[i] and b[j] here",
  "link-like literal": "see [the docs](not really) as text",
  "wiki-link-like literal": "write [[document-id|a label]] literally",
  "at mention": "ping @alice and @bob about this",
  "at eq literal": "the @eq marker is written verbatim",
  "windows path": "open C:\\Users\\me\\file for the data",
  "underscores": "the variable my_var_name is snake_case",
  "hash mid": "issue #42 and #43 are related",
  "leading hash": "# not a heading, just prose",
  "leading dash": "- not a bullet, just prose",
  "leading number": "1. not an ordered item, prose",
  "leading gt": "> not a quote, just prose",
  "triple dash": "--- not a rule, just prose",
  "dollar dollar": "$$ not display math, prose",
  "mixed": "cost $5, use * or [x], ping @sam, path C:\\a",
};

const roundTrip = (src: PMNode) => serializeMarkdown(src);

function atomCount(node: PMNode): number {
  let n = 0;
  node.descendants((c) => {
    if (
      c.type.name === "math_inline" ||
      c.type.name === "math_display" ||
      c.type.name === "xref" ||
      c.type.name === "doc_link"
    ) n++;
    return true;
  });
  return n;
}

function markedText(node: PMNode): string[] {
  const marked: string[] = [];
  node.descendants((c) => {
    if (c.isText && c.marks.length) marked.push(c.text ?? "");
    return true;
  });
  return marked;
}

describe("round-trip fuzz: literal prose is never reinterpreted (#I60)", () => {
  for (const [pname, snippet] of Object.entries(PROSE)) {
    for (const [cname, build] of Object.entries(CONTEXTS)) {
      it(`${pname} in ${cname}`, () => {
        const before = build(snippet);
        const md = roundTrip(before);
        const after = parseMarkdown(md);
        // 1. text preserved exactly
        expect(after.textContent).toBe(before.textContent);
        // 2. no atoms conjured from the prose
        expect(atomCount(after)).toBe(0);
        // 3. no stray inline marks (code/em/strong/link) invented from the prose
        expect(markedText(after)).toEqual([]);
        // 4. idempotent on disk
        expect(serializeMarkdown(after)).toBe(md);
      });
    }
  }
});
