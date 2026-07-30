import { describe, it, expect } from "vitest";
import { EditorState, type Transaction } from "prosemirror-state";
import { schema } from "./schema";
import { parseMarkdown } from "../markdown/parse";
import {
  buildComments,
  commentsKey,
  getComments,
  exportComments,
  posToTextOffset,
  textOffsetToPos,
  importComments,
  addComment,
  type Comment,
} from "./comments";
import type { EditorView } from "prosemirror-view";

function stateWith(text: string) {
  return EditorState.create({
    schema,
    doc: parseMarkdown(text),
    plugins: [buildComments()],
  });
}

// Apply a comment mark + store entry over a text-offset range, headlessly.
function addAt(
  state: EditorState,
  startOff: number,
  endOff: number,
  comment: Comment,
) {
  const from = textOffsetToPos(state.doc, startOff);
  const to = textOffsetToPos(state.doc, endOff);
  return state.apply(
    state.tr
      .addMark(from, to, schema.marks.comment.create({ id: comment.id }))
      .setMeta(commentsKey, { type: "add", comment }),
  );
}

const sample: Comment = {
  id: "c1",
  kind: "user",
  author: "me",
  body: "check this",
  resolved: false,
  createdAt: 1,
  replies: [],
};

describe("comments", () => {
  it("maps document positions to text offsets and back", () => {
    const doc = parseMarkdown("hello brave world");
    for (const off of [0, 6, 11, 17]) {
      expect(posToTextOffset(doc, textOffsetToPos(doc, off))).toBe(off);
    }
    const from = textOffsetToPos(doc, 6);
    const to = textOffsetToPos(doc, 11);
    expect(doc.textBetween(from, to)).toBe("brave");
  });

  it("round-trips anchors that cross a soft break", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("alpha"),
        schema.nodes.soft_break.create(),
        schema.text("beta"),
      ]),
    ]);
    let state = EditorState.create({ schema, doc, plugins: [buildComments()] });
    state = addAt(state, 2, 8, sample);

    const [stored] = exportComments(state);
    expect(stored.quote).toBe("pha be");
    expect(stored.anchor?.quote).toBe("pha be");

    let restored = EditorState.create({ schema, doc, plugins: [buildComments()] });
    const view = {
      get state() { return restored; },
      dispatch(tr: Transaction) { restored = restored.apply(tr); },
    } as unknown as EditorView;
    importComments(view, [stored]);

    expect(exportComments(restored)[0]).toMatchObject({
      quote: "pha be",
      orphaned: false,
    });
  });

  it("stores an added comment and anchors it to its text range", () => {
    const state = addAt(stateWith("hello brave world"), 6, 11, sample);
    const comments = getComments(state);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("check this");

    const [stored] = exportComments(state);
    expect(stored.start).toBe(6);
    expect(stored.end).toBe(11);
    expect(stored.kind).toBe("user");
    // Self-describing anchor: the quoted passage is stored for AI review.
    expect(stored.quote).toBe("brave");
    expect(stored.anchor).toMatchObject({
      version: 3,
      quote: "brave",
      segments: [{
        block: { type: "paragraph", ordinal: 0 },
        quote: "brave",
        start: 6,
        end: 11,
      }],
    });
  });

  it("stores explicit block boundaries for a cross-paragraph anchor", () => {
    const state = addAt(stateWith("alpha beta\n\ngamma delta"), 6, 15, sample);
    const [stored] = exportComments(state);
    expect(stored.anchor).toMatchObject({
      version: 3,
      quote: "beta\n\ngamma",
      segments: [
        { block: { ordinal: 0 }, quote: "beta" },
        { block: { ordinal: 1 }, quote: "gamma" },
      ],
    });
  });

  it("segments nested theorem paragraphs instead of gluing their text", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.theorem.create(
        { kind: "theorem", title: null, id: "nested-result" },
        [
          schema.nodes.paragraph.create(null, schema.text("alpha beta")),
          schema.nodes.paragraph.create(null, schema.text("gamma delta")),
        ],
      ),
    ]);
    let first = 0;
    let second = 0;
    doc.descendants((node, pos) => {
      if (node.isText && node.text === "alpha beta") first = pos;
      if (node.isText && node.text === "gamma delta") second = pos;
    });
    let state = EditorState.create({ schema, doc, plugins: [buildComments()] });
    state = state.apply(
      state.tr
        .addMark(first + 6, second + 5, schema.marks.comment.create({ id: sample.id }))
        .setMeta(commentsKey, { type: "add", comment: sample }),
    );
    expect(exportComments(state)[0].anchor).toMatchObject({
      version: 3,
      quote: "beta\n\ngamma",
      segments: [
        { block: { ordinal: 0 }, quote: "beta" },
        { block: { ordinal: 1 }, quote: "gamma" },
      ],
    });
  });

  it("includes inline-math source in v3 anchor quotations", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("alpha"),
        schema.nodes.math_inline.create({ latex: "x_i" }),
        schema.text("beta"),
      ]),
    ]);
    let state = EditorState.create({ schema, doc, plugins: [buildComments()] });
    state = state.apply(
      state.tr
        .addMark(3, 9, schema.marks.comment.create({ id: sample.id }))
        .setMeta(commentsKey, { type: "add", comment: sample }),
    );
    expect(exportComments(state)[0].anchor).toMatchObject({
      version: 3,
      quote: "pha$x_i$be",
    });
  });

  it("removes a newly added comment when its highlight addition is undone", () => {
    let state = stateWith("hello brave world");
    const view = {
      get state() { return state; },
      dispatch(tr: Transaction) { state = state.apply(tr); },
    } as unknown as EditorView;
    const from = textOffsetToPos(state.doc, 6);
    const to = textOffsetToPos(state.doc, 11);
    const id = addComment(view, {
      kind: "user",
      author: "me",
      body: "temporary",
    }, { from, to });
    expect(id).toBeTruthy();
    expect(getComments(state)).toHaveLength(1);

    view.dispatch(state.tr.removeMark(from, to, schema.marks.comment));
    expect(getComments(state)).toHaveLength(0);
  });

  it("preserves coauthor identity on imported comments and replies", () => {
    let restored = stateWith("hello brave world");
    const view = {
      get state() { return restored; },
      dispatch(tr: Transaction) { restored = restored.apply(tr); },
    } as unknown as EditorView;
    importComments(view, [{
      ...sample,
      principalId: "alice",
      quote: "brave",
      start: 6,
      end: 11,
      replies: [{
        kind: "user",
        author: "Alice Smith",
        principalId: "alice",
        body: "reply",
        createdAt: 2,
      }],
    }]);
    expect(exportComments(restored)[0]).toMatchObject({
      principalId: "alice",
      replies: [{ principalId: "alice", body: "reply" }],
    });
  });

  it("appends replies to a comment's thread", () => {
    let state = addAt(stateWith("hello brave world"), 6, 11, sample);
    state = state.apply(
      state.tr.setMeta(commentsKey, {
        type: "update",
        id: "c1",
        patch: {
          replies: [
            { kind: "ai", author: "AI", body: "agreed", createdAt: 2 },
          ],
        },
      }),
    );
    const [c] = getComments(state);
    expect(c.replies).toHaveLength(1);
    expect(c.replies[0].kind).toBe("ai");
    expect(exportComments(state)[0].replies[0].body).toBe("agreed");
  });

  it("marks a comment resolved via a meta update", () => {
    let state = addAt(stateWith("hello brave world"), 6, 11, sample);
    state = state.apply(
      state.tr.setMeta(commentsKey, {
        type: "update",
        id: "c1",
        patch: { resolved: true },
      }),
    );
    expect(getComments(state)[0].resolved).toBe(true);
  });

  it("retains an unresolved orphan diagnostic when its anchor is deleted", () => {
    let state = addAt(stateWith("hello brave world"), 6, 11, sample);
    const from = textOffsetToPos(state.doc, 6);
    const to = textOffsetToPos(state.doc, 11);
    state = state.apply(state.tr.delete(from, to)); // remove "brave"
    expect(exportComments(state)).toEqual([
      expect.objectContaining({ id: "c1", orphaned: true }),
    ]);
  });

  it("uses v2 block context to disambiguate repeated quotations", () => {
    let state = stateWith("first repeated phrase\n\nsecond repeated phrase");
    const view = {
      get state() { return state; },
      dispatch(tr: Transaction) { state = state.apply(tr); },
    } as unknown as EditorView;
    importComments(view, [{
      ...sample,
      anchor: {
        version: 2,
        block: { type: "paragraph", ordinal: 1 },
        quote: "repeated",
        prefix: "second ",
        suffix: " phrase",
        start: 7,
        end: 15,
      },
    }]);

    const [stored] = exportComments(state);
    expect(stored.anchor).toMatchObject({
      version: 3,
      segments: [{ block: { ordinal: 1 }, quote: "repeated" }],
    });
    expect(stored.orphaned).toBe(false);
  });

  it("keeps an imported orphan instead of silently discarding review work", () => {
    let state = stateWith("current text");
    const view = {
      get state() { return state; },
      dispatch(tr: Transaction) { state = state.apply(tr); },
    } as unknown as EditorView;
    importComments(view, [{ ...sample, id: "missing", quote: "deleted text" }]);
    expect(getComments(state)).toEqual([expect.objectContaining({ id: "missing", orphaned: true })]);
    expect(exportComments(state)).toEqual([
      expect.objectContaining({ id: "missing", quote: "deleted text", orphaned: true }),
    ]);
  });

  it("imports valid comments while ignoring malformed records and replies", () => {
    let state = stateWith("hello world");
    const view = {
      get state() { return state; },
      dispatch(tr: Transaction) { state = state.apply(tr); },
    } as unknown as EditorView;

    importComments(view, [
      null,
      "bad",
      { id: "safe", quote: "hello", replies: "bad" },
      { id: "reply", quote: "world", replies: [null, { body: "ok" }] },
    ] as unknown as Parameters<typeof importComments>[1]);

    expect(getComments(state).map((comment) => comment.id)).toEqual(["safe", "reply"]);
    expect(getComments(state)[0].replies).toEqual([]);
    expect(getComments(state)[1].replies[0].body).toBe("ok");
  });
});
