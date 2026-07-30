import { describe, it, expect } from "vitest";
import { EditorState } from "prosemirror-state";
import { schema } from "./schema";
import { inlineMathRule } from "./inputrules";

// Drive the rule's handler exactly the way prosemirror-inputrules does: the
// match is run against the text before the cursor PLUS the just-typed closing
// `$` (not yet in the document), and `end` is the current cursor position.
function fireRule(paragraphText: string) {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, paragraphText ? schema.text(paragraphText) : undefined),
  ]);
  const state = EditorState.create({ schema, doc });
  const end = 1 + paragraphText.length; // cursor at end of the paragraph text
  const typed = paragraphText + "$";
  const match = /(?:^|[^$])\$([^$\n]+)\$$/.exec(typed);
  expect(match).not.toBeNull();
  const handler = (inlineMathRule as unknown as {
    handler: (s: EditorState, m: RegExpExecArray, a: number, b: number) => unknown;
  }).handler;
  const tr = handler(state, match!, end - match![0].length + 1, end);
  return state.apply(tr as never);
}

describe("inline math input rule (review s45)", () => {
  it("does not eat the character before the opening $ ", () => {
    // Typing `x$abc$`: before the fix the leading "x" was deleted.
    const next = fireRule("x$abc");
    const para = next.doc.firstChild!;
    expect(para.childCount).toBe(2);
    expect(para.child(0).text).toBe("x");
    expect(para.child(1).type.name).toBe("math_inline");
    expect(para.child(1).attrs.latex).toBe("abc");
  });

  it("converts $…$ at the very start of a paragraph", () => {
    const next = fireRule("$abc");
    const para = next.doc.firstChild!;
    expect(para.childCount).toBe(1);
    expect(para.child(0).type.name).toBe("math_inline");
    expect(para.child(0).attrs.latex).toBe("abc");
  });

  it("preserves longer prose before the equation", () => {
    const next = fireRule("energy is $E=mc^2");
    const para = next.doc.firstChild!;
    expect(para.child(0).text).toBe("energy is ");
    expect(para.child(1).attrs.latex).toBe("E=mc^2");
  });

  it("replaces the right range when the closing $ is typed over a selection", () => {
    // Doc "x$abcdef", selection covers "def" (6..9); typing `$` fires the rule
    // with textBefore up to the selection start plus the typed char. An
    // end-anchored offset shifted the range right and kept "ab" as prose.
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, schema.text("x$abcdef")),
    ]);
    const state = EditorState.create({ schema, doc });
    const from = 6;
    const to = 9;
    const typed = "x$abc" + "$"; // text before `from` + typed char
    const match = /(?:^|[^$])\$([^$\n]+)\$$/.exec(typed)!;
    const start = from - (match[0].length - 1); // how prosemirror-inputrules computes it
    const handler = (inlineMathRule as unknown as {
      handler: (s: EditorState, m: RegExpExecArray, a: number, b: number) => unknown;
    }).handler;
    const next = state.apply(handler(state, match, start, to) as never);
    const para = next.doc.firstChild!;
    expect(para.childCount).toBe(2);
    expect(para.child(0).text).toBe("x"); // "ab" not stranded, "def" consumed
    expect(para.child(1).type.name).toBe("math_inline");
    expect(para.child(1).attrs.latex).toBe("abc");
  });
});
