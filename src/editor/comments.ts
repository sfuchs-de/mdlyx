import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";

export type CommentKind = "user" | "ai";
export type Priority = "P0" | "P1" | "P2" | "P3";
// Verdict on an (AI) suggestion: undecided, accepted, or rejected.
export type ReviewStatus = "open" | "accepted" | "rejected";
// Cosmetic highlight colour (Paperpile-style). Kind (you/AI) is tracked
// separately; colour carries no semantics — it's the reader's own coding.
export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "orange";
export const HIGHLIGHT_COLORS: HighlightColor[] = [
  "yellow",
  "green",
  "blue",
  "pink",
  "orange",
];
export const DEFAULT_COLOR: HighlightColor = "yellow";

export interface Reply {
  kind: CommentKind;
  author: string;
  /** Server-stamped internal identity for shared-library collaborators. */
  principalId?: string;
  body: string;
  createdAt: number;
}

export interface Comment {
  id: string;
  kind: CommentKind;
  author: string;
  /** Server-stamped internal identity for shared-library collaborators. */
  principalId?: string;
  body: string; // may be "" — a bare highlight with no note yet
  resolved: boolean;
  createdAt: number;
  replies: Reply[];
  priority?: Priority;
  status?: ReviewStatus;
  color?: HighlightColor;
  /** Present only while an imported anchor cannot currently be resolved. */
  orphaned?: boolean;
  anchor?: CommentAnchor;
  orphanQuote?: string;
}

export type CommentAnchor = CommentAnchorV2 | CommentAnchorV3;

export interface CommentAnchorV2 {
  version: 2;
  block: { type: string; ordinal: number; id?: string };
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export interface CommentAnchorV3Segment {
  block: { type: string; ordinal: number; id?: string };
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export interface CommentAnchorV3 {
  version: 3;
  /** Human-readable passage; block boundaries are explicit. */
  quote: string;
  segments: CommentAnchorV3Segment[];
}

// Persisted form: comment data + a plain-text anchor. `start`/`end` are offsets
// into the document's concatenated text; `quote` is the anchored passage itself,
// which makes the .md self-describing (an AI reviewer sees what each comment
// refers to) and lets a comment be re-anchored by matching text if the offsets
// drift or are omitted (an AI can add a comment by quote alone).
export interface StoredComment extends Comment {
  start?: number;
  end?: number;
  quote?: string;
}

export const commentsKey = new PluginKey<CommentsState>("comments");

interface CommentsState {
  comments: Map<string, Comment>;
  decorations: DecorationSet;
  /** Live add-comment transactions that can still be undone in this editor. */
  runtimeAdded: Set<string>;
}

type CommentsMeta =
  | { type: "add"; comment: Comment }
  | { type: "addMany"; comments: Comment[] }
  | { type: "update"; id: string; patch: Partial<Comment> }
  | { type: "remove"; id: string };

// --- text-offset ↔ document-position mapping ------------------------------
function leafPlainText(node: PMNode): string {
  const leafText = node.type.spec.leafText;
  return typeof leafText === "function" ? leafText(node) : "";
}

function anchorLeafText(node: PMNode): string {
  if (node.type === schema.nodes.math_inline) {
    return `$${String(node.attrs.latex ?? "")}$`;
  }
  return leafPlainText(node);
}

function nodeTextOffset(
  node: PMNode,
  pos: number,
  leaf: (node: PMNode) => string,
): number {
  let offset = 0;
  node.nodesBetween(0, pos, (child, childPos) => {
    if (child.isText) {
      const end = Math.min(pos, childPos + child.nodeSize);
      offset += Math.max(0, end - childPos);
    } else if (child.isLeaf && childPos < pos) {
      offset += leaf(child).length;
    }
    return true;
  });
  return offset;
}

function nodePosAtTextOffset(
  node: PMNode,
  offset: number,
  leaf: (node: PMNode) => string,
): number {
  let acc = 0;
  let found: number | null = null;
  node.descendants((child, pos) => {
    if (found != null) return false;
    if (child.isText) {
      const len = child.text?.length ?? 0;
      if (acc + len >= offset) {
        found = pos + (offset - acc);
        return false;
      }
      acc += len;
    } else if (child.isLeaf) {
      const len = leaf(child).length;
      if (len && acc + len >= offset) {
        found = offset <= acc ? pos : pos + child.nodeSize;
        return false;
      }
      acc += len;
    }
    return true;
  });
  return found ?? node.content.size;
}

function plainTextBetween(doc: PMNode, from: number, to: number): string {
  return doc.textBetween(from, to, "", leafPlainText);
}

export function posToTextOffset(doc: PMNode, pos: number): number {
  let offset = 0;
  doc.nodesBetween(0, pos, (node, nodePos) => {
    if (node.isText) {
      const end = Math.min(pos, nodePos + node.nodeSize);
      offset += Math.max(0, end - nodePos);
    } else if (node.isLeaf && nodePos < pos) {
      // Soft breaks (and any future leaf node with a leafText serializer) are
      // part of the persisted anchor text. Treat the leaf atomically: document
      // positions can only land immediately before or after it.
      offset += leafPlainText(node).length;
    }
    return true;
  });
  return offset;
}

export function textOffsetToPos(doc: PMNode, offset: number): number {
  let acc = 0;
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.isText) {
      const len = node.text?.length ?? 0;
      if (acc + len >= offset) {
        found = pos + (offset - acc);
        return false;
      }
      acc += len;
    } else if (node.isLeaf) {
      const len = leafPlainText(node).length;
      if (len && acc + len >= offset) {
        found = offset <= acc ? pos : pos + node.nodeSize;
        return false;
      }
      acc += len;
    }
    return true;
  });
  return found ?? doc.content.size;
}

// The document's concatenated text-node content — the string that
// posToTextOffset / textOffsetToPos index into (no block separators).
function docPlainText(doc: PMNode): string {
  return plainTextBetween(doc, 0, doc.content.size);
}

// Find a quoted passage in the document and return its position range.
function findQuoteRange(
  doc: PMNode,
  quote: string,
  hint?: number,
  prefix = "",
  suffix = "",
): { from: number; to: number } | null {
  if (!quote) return null;
  const text = docPlainText(doc);
  // Choose the occurrence nearest the stored offset, so a quote that appears
  // more than once (e.g. "the bound") re-anchors to the intended one rather
  // than always the first match. With no hint, take the first.
  let best = -1;
  let bestScore = -Infinity;
  for (let idx = text.indexOf(quote); idx !== -1; idx = text.indexOf(quote, idx + 1)) {
    const contextScore = (prefix && text.slice(Math.max(0, idx - prefix.length), idx) === prefix ? 10_000 : 0)
      + (suffix && text.slice(idx + quote.length, idx + quote.length + suffix.length) === suffix ? 10_000 : 0);
    const distance = hint == null ? idx : Math.abs(idx - hint);
    const score = contextScore - distance;
    if (score > bestScore) {
      bestScore = score;
      best = idx;
    }
    if (hint == null) break;
  }
  if (best < 0) return null;
  return {
    from: textOffsetToPos(doc, best),
    to: textOffsetToPos(doc, best + quote.length),
  };
}

interface BlockLocation {
  node: PMNode;
  ordinal: number;
  textStart: number;
  from: number;
  to: number;
}

function topLevelBlocks(doc: PMNode): BlockLocation[] {
  const blocks: BlockLocation[] = [];
  let textStart = 0;
  doc.forEach((node, offset, ordinal) => {
    const text = docPlainText(node);
    blocks.push({
      node,
      ordinal,
      textStart,
      from: offset + 1,
      to: offset + node.nodeSize - 1,
    });
    textStart += text.length;
  });
  return blocks;
}

function anchorBlocks(doc: PMNode): BlockLocation[] {
  const blocks: BlockLocation[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    blocks.push({
      node,
      ordinal: blocks.length,
      textStart: 0,
      from: pos + 1,
      to: pos + node.nodeSize - 1,
    });
    return false;
  });
  return blocks;
}

function blockIdentity(block: BlockLocation): CommentAnchorV3Segment["block"] {
  const id = typeof block.node.attrs.id === "string" && block.node.attrs.id
    ? block.node.attrs.id as string
    : undefined;
  return {
    type: block.node.type.name,
    ordinal: block.ordinal,
    ...(id ? { id } : {}),
  };
}

function blockAnchorText(block: BlockLocation): string {
  return block.node.textBetween(0, block.node.content.size, "", anchorLeafText);
}

function anchorV3(doc: PMNode, range: { from: number; to: number }): CommentAnchorV3 {
  const segments = anchorBlocks(doc).flatMap((block): CommentAnchorV3Segment[] => {
    const from = Math.max(range.from, block.from);
    const to = Math.min(range.to, block.to);
    if (from >= to) return [];
    const localFrom = from - block.from;
    const localTo = to - block.from;
    const text = blockAnchorText(block);
    const start = nodeTextOffset(block.node, localFrom, anchorLeafText);
    const end = nodeTextOffset(block.node, localTo, anchorLeafText);
    return [{
      block: blockIdentity(block),
      quote: text.slice(start, end).slice(0, 500),
      prefix: text.slice(Math.max(0, start - 32), start),
      suffix: text.slice(end, end + 32),
      start,
      end,
    }];
  });
  return {
    version: 3,
    quote: segments.map((segment) => segment.quote).join("\n\n").slice(0, 500),
    segments,
  };
}

function rangeFromV2(doc: PMNode, anchor: CommentAnchorV2): { from: number; to: number } | null {
  const blocks = topLevelBlocks(doc);
  const block = anchor.block.id
    ? blocks.find((candidate) => candidate.node.attrs.id === anchor.block.id)
    : blocks.find((candidate) =>
        candidate.ordinal === anchor.block.ordinal && candidate.node.type.name === anchor.block.type
      );
  if (!block || anchor.start < 0 || anchor.end <= anchor.start) return null;
  const globalStart = block.textStart + anchor.start;
  const globalEnd = block.textStart + anchor.end;
  const range = { from: textOffsetToPos(doc, globalStart), to: textOffsetToPos(doc, globalEnd) };
  const text = plainTextBetween(doc, range.from, range.to).slice(0, anchor.quote.length);
  return range.from < range.to && text === anchor.quote ? range : null;
}

function validV2Anchor(value: unknown): value is CommentAnchorV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const anchor = value as Partial<CommentAnchorV2>;
  const block = anchor.block as Partial<CommentAnchorV2["block"]> | undefined;
  return anchor.version === 2
    && !!block
    && typeof block.type === "string"
    && typeof block.ordinal === "number"
    && Number.isSafeInteger(block.ordinal)
    && (block.id === undefined || typeof block.id === "string")
    && typeof anchor.quote === "string"
    && typeof anchor.prefix === "string"
    && typeof anchor.suffix === "string"
    && typeof anchor.start === "number"
    && Number.isFinite(anchor.start)
    && typeof anchor.end === "number"
    && Number.isFinite(anchor.end);
}

function validV3Segment(value: unknown): value is CommentAnchorV3Segment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const segment = value as Partial<CommentAnchorV3Segment>;
  const block = segment.block as Partial<CommentAnchorV3Segment["block"]> | undefined;
  return !!block
    && typeof block.type === "string"
    && typeof block.ordinal === "number"
    && Number.isSafeInteger(block.ordinal)
    && (block.id === undefined || typeof block.id === "string")
    && typeof segment.quote === "string"
    && typeof segment.prefix === "string"
    && typeof segment.suffix === "string"
    && typeof segment.start === "number"
    && Number.isFinite(segment.start)
    && typeof segment.end === "number"
    && Number.isFinite(segment.end);
}

function validV3Anchor(value: unknown): value is CommentAnchorV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const anchor = value as Partial<CommentAnchorV3>;
  return anchor.version === 3
    && typeof anchor.quote === "string"
    && Array.isArray(anchor.segments)
    && anchor.segments.length > 0
    && anchor.segments.every(validV3Segment);
}

function blockForIdentity(
  blocks: BlockLocation[],
  identity: CommentAnchorV3Segment["block"],
): BlockLocation | undefined {
  return identity.id
    ? blocks.find((candidate) => candidate.node.attrs.id === identity.id)
    : blocks.find((candidate) =>
        candidate.ordinal === identity.ordinal && candidate.node.type.name === identity.type
      );
}

function rangeFromV3(doc: PMNode, anchor: CommentAnchorV3): { from: number; to: number } | null {
  const blocks = anchorBlocks(doc);
  const ranges: Array<{ from: number; to: number }> = [];
  for (const segment of anchor.segments) {
    const block = blockForIdentity(blocks, segment.block);
    if (!block || segment.start < 0 || segment.end <= segment.start) return null;
    const text = blockAnchorText(block);
    let start = segment.start;
    let end = segment.end;
    if (text.slice(start, end).slice(0, segment.quote.length) !== segment.quote) {
      let best = -1;
      let bestScore = -Infinity;
      for (
        let index = text.indexOf(segment.quote);
        index >= 0;
        index = text.indexOf(segment.quote, index + 1)
      ) {
        const contextScore =
          (segment.prefix && text.slice(Math.max(0, index - segment.prefix.length), index) === segment.prefix
            ? 10_000
            : 0)
          + (segment.suffix && text.slice(index + segment.quote.length, index + segment.quote.length + segment.suffix.length) === segment.suffix
            ? 10_000
            : 0);
        const score = contextScore - Math.abs(index - segment.start);
        if (score > bestScore) {
          best = index;
          bestScore = score;
        }
      }
      if (best < 0) return null;
      start = best;
      end = best + segment.quote.length;
    }
    const from = block.from + nodePosAtTextOffset(block.node, start, anchorLeafText);
    const to = block.from + nodePosAtTextOffset(block.node, end, anchorLeafText);
    if (from >= to) return null;
    ranges.push({ from, to });
  }
  return ranges.length
    ? { from: ranges[0].from, to: ranges[ranges.length - 1].to }
    : null;
}

// The [min, max] doc range currently covered by a comment mark, or null.
function commentRange(doc: PMNode, id: string): { from: number; to: number } | null {
  // Collect the marked leaf runs (text or atom). A single comment is normally one
  // contiguous run; it can split into several only when something is inserted
  // between them (e.g. pasting a block into the middle of a marked word). We keep
  // the leading run and merge in later runs ONLY across gaps that hold no leaf
  // content (block boundaries — a genuine cross-paragraph comment) so a paste
  // can't stretch the anchor over the inserted equations/headings.
  const runs: Array<[number, number]> = [];
  doc.descendants((node, pos) => {
    const marked =
      (node.isText || node.isAtom) &&
      node.marks.some((m) => m.type === schema.marks.comment && m.attrs.id === id);
    if (marked) {
      const last = runs[runs.length - 1];
      if (last && pos === last[1]) last[1] = pos + node.nodeSize;
      else runs.push([pos, pos + node.nodeSize]);
    }
    return true;
  });
  if (!runs.length) return null;
  let [from, to] = runs[0];
  for (let i = 1; i < runs.length; i++) {
    let hasContent = false;
    doc.nodesBetween(to, runs[i][0], (node) => {
      if ((node.isText && !!node.text?.length) || (node.isAtom && node.type !== schema.nodes.soft_break)) {
        hasContent = true;
      }
      return !hasContent;
    });
    if (hasContent) break;
    to = runs[i][1];
  }
  return { from, to };
}

// --- decorations ----------------------------------------------------------
function buildDecorations(state: EditorState, comments: Map<string, Comment>): DecorationSet {
  const decos: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type !== schema.marks.comment) continue;
      const c = comments.get(mark.attrs.id as string);
      if (!c) continue;
      const color = c.color ?? DEFAULT_COLOR;
      const cls =
        `comment comment-${c.kind} comment-color-${color}` +
        (c.resolved ? " comment-resolved" : "") +
        (c.body.trim() ? " comment-has-note" : "");
      decos.push(
        Decoration.inline(pos, pos + node.nodeSize, {
          class: cls,
          "data-comment-id": c.id,
        }),
      );
    }
    return true;
  });
  return DecorationSet.create(state.doc, decos);
}

// --- plugin ---------------------------------------------------------------
export function buildComments(onChange?: (comments: Comment[]) => void): Plugin<CommentsState> {
  return new Plugin<CommentsState>({
    key: commentsKey,
    state: {
      init: (_config, state) => ({
        comments: new Map(),
        decorations: buildDecorations(state, new Map()),
        runtimeAdded: new Set(),
      }),
      apply(tr, prev, _old, newState) {
        let comments = prev.comments;
        let runtimeAdded = prev.runtimeAdded;
        const meta = tr.getMeta(commentsKey) as CommentsMeta | undefined;
        if (meta) {
          comments = new Map(comments);
          runtimeAdded = new Set(runtimeAdded);
          if (meta.type === "add") {
            comments.set(meta.comment.id, meta.comment);
            runtimeAdded.add(meta.comment.id);
          } else if (meta.type === "addMany") {
            for (const c of meta.comments) {
              comments.set(c.id, c);
              runtimeAdded.delete(c.id);
            }
          } else if (meta.type === "remove") {
            comments.delete(meta.id);
            runtimeAdded.delete(meta.id);
          } else if (meta.type === "update") {
            const c = comments.get(meta.id);
            if (c) comments.set(meta.id, { ...c, ...meta.patch });
          }
        }
        if (meta || tr.docChanged) {
          if (tr.docChanged && !meta) {
            const retained = new Map(comments);
            const pending = new Set(runtimeAdded);
            for (const [id, comment] of retained) {
              if (!pending.has(id)) continue;
              if (commentRange(newState.doc, id)) continue;
              const resolvable = comment.anchor?.version === 3
                ? rangeFromV3(newState.doc, comment.anchor)
                : comment.anchor?.version === 2
                  ? rangeFromV2(newState.doc, comment.anchor)
                  : null;
              // Undoing a just-added highlight removes its mark while leaving
              // the selected text intact. Drop that transient thread instead of
              // displaying a ghost orphan; genuine deleted-text orphans remain.
              if (resolvable) {
                retained.delete(id);
                pending.delete(id);
              } else {
                // The selected passage itself was deleted. It is a genuine
                // orphan and must survive; it is no longer an undo candidate.
                pending.delete(id);
              }
            }
            comments = retained;
            runtimeAdded = pending;
          }
          return { comments, decorations: buildDecorations(newState, comments), runtimeAdded };
        }
        return prev;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations;
      },
    },
    view() {
      return {
        update: (view) => {
          if (onChange) onChange(getComments(view.state));
        },
      };
    },
  });
}

// --- queries & mutations --------------------------------------------------
export function getComments(state: EditorState): Comment[] {
  const s = commentsKey.getState(state);
  if (!s) return [];
  // Sort by document position (top to bottom), unresolved-first within ties.
  return [...s.comments.values()].sort((a, b) => {
    const ra = commentRange(state.doc, a.id)?.from ?? Infinity;
    const rb = commentRange(state.doc, b.id)?.from ?? Infinity;
    return ra - rb || a.createdAt - b.createdAt;
  });
}

let counter = 0;
function newId(): string {
  counter += 1;
  // Random suffix so a fresh page's reset counter can't collide with an id
  // already loaded from a saved doc (which would merge/overwrite that comment).
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `c${counter}-${rand}`;
}

// Add a comment/highlight over the current selection (or a given range). The
// body may be empty — a bare highlight the reader can annotate later.
export function addComment(
  view: EditorView,
  fields: { kind: CommentKind; author: string; principalId?: string; body: string; color?: HighlightColor },
  range?: { from: number; to: number },
): string | null {
  const { from, to } = range ?? view.state.selection;
  if (from >= to) return null; // need a non-empty range to anchor
  const comment: Comment = {
    id: newId(),
    kind: fields.kind,
    author: fields.author,
    ...(fields.principalId ? { principalId: fields.principalId } : {}),
    body: fields.body,
    resolved: false,
    createdAt: Date.now(),
    replies: [],
    status: "open",
    color: fields.color ?? DEFAULT_COLOR,
    anchor: anchorV3(view.state.doc, { from, to }),
  };
  const tr = view.state.tr
    .addMark(from, to, schema.marks.comment.create({ id: comment.id }))
    .setMeta(commentsKey, { type: "add", comment } satisfies CommentsMeta)
    .setMeta("addToHistory", true);
  view.dispatch(tr);
  return comment.id;
}

export function setResolved(view: EditorView, id: string, resolved: boolean) {
  view.dispatch(
    view.state.tr.setMeta(commentsKey, {
      type: "update",
      id,
      patch: { resolved },
    } satisfies CommentsMeta),
  );
}

export function setPriority(view: EditorView, id: string, priority?: Priority) {
  view.dispatch(
    view.state.tr.setMeta(commentsKey, {
      type: "update",
      id,
      patch: { priority },
    } satisfies CommentsMeta),
  );
}

export function setStatus(view: EditorView, id: string, status: ReviewStatus) {
  view.dispatch(
    view.state.tr.setMeta(commentsKey, {
      type: "update",
      id,
      patch: { status },
    } satisfies CommentsMeta),
  );
}

export function setColor(view: EditorView, id: string, color: HighlightColor) {
  view.dispatch(
    view.state.tr.setMeta(commentsKey, {
      type: "update",
      id,
      patch: { color },
    } satisfies CommentsMeta),
  );
}

// Set/replace a comment's note body (used to annotate a bare highlight).
export function setBody(view: EditorView, id: string, body: string) {
  view.dispatch(
    view.state.tr.setMeta(commentsKey, {
      type: "update",
      id,
      patch: { body },
    } satisfies CommentsMeta),
  );
}

// Append a reply to a comment's thread.
export function addReply(
  view: EditorView,
  id: string,
  reply: { kind: CommentKind; author: string; principalId?: string; body: string },
) {
  const c = commentsKey.getState(view.state)?.comments.get(id);
  if (!c) return;
  const replies = [...c.replies, { ...reply, createdAt: Date.now() }];
  view.dispatch(
    view.state.tr.setMeta(commentsKey, {
      type: "update",
      id,
      patch: { replies },
    } satisfies CommentsMeta),
  );
}

export function removeComment(view: EditorView, id: string) {
  const range = commentRange(view.state.doc, id);
  let tr = view.state.tr;
  if (range) {
    tr = tr.removeMark(range.from, range.to, schema.marks.comment);
  }
  tr.setMeta(commentsKey, { type: "remove", id } satisfies CommentsMeta);
  view.dispatch(tr);
}

// Select a comment's anchored range and scroll to it ("jump to" in the sidebar).
export function selectComment(view: EditorView, id: string) {
  const range = commentRange(view.state.doc, id);
  if (!range) return;
  const sel = TextSelection.create(view.state.doc, range.from, range.to);
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
  view.focus();
}

// --- persistence ----------------------------------------------------------
export function exportComments(state: EditorState): StoredComment[] {
  const s = commentsKey.getState(state);
  if (!s) return [];
  const out: StoredComment[] = [];
  for (const c of s.comments.values()) {
    const range = commentRange(state.doc, c.id);
    const { orphanQuote, ...storedComment } = c;
    if (!range) {
      out.push({
        ...storedComment,
        orphaned: true,
        quote: orphanQuote ?? c.anchor?.quote ?? "",
      });
      continue;
    }
    const anchor = anchorV3(state.doc, range);
    out.push({
      ...storedComment,
      orphaned: false,
      anchor,
      start: posToTextOffset(state.doc, range.from),
      end: posToTextOffset(state.doc, range.to),
      // The anchored passage — makes the .md self-describing for a reviewer.
      quote: plainTextBetween(state.doc, range.from, range.to).slice(0, 500),
    });
  }
  return out;
}

export function importComments(view: EditorView, stored: StoredComment[]) {
  if (!Array.isArray(stored) || !stored.length) return;
  let tr: Transaction = view.state.tr;
  const doc = view.state.doc;
  const added: Comment[] = [];
  for (const raw of stored as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const sc = raw as Partial<StoredComment>;
    const storedId = typeof sc.id === "string" ? sc.id : undefined;
    const quote = typeof sc.quote === "string" ? sc.quote : "";
    const start = typeof sc.start === "number" && Number.isFinite(sc.start) ? sc.start : undefined;
    const end = typeof sc.end === "number" && Number.isFinite(sc.end) ? sc.end : undefined;
    const anchor = validV3Anchor(sc.anchor)
      ? sc.anchor
      : validV2Anchor(sc.anchor)
        ? sc.anchor
        : undefined;
    // Keep our id counter ahead of any loaded `cN-…` id so newly-added comments
    // never reuse (and overwrite) a loaded one.
    const m = /^c(\d+)-/.exec(storedId ?? "");
    if (m) counter = Math.max(counter, Number(m[1]));
    // Prefer the text-offset anchor when it still lands on the stored quote;
    // otherwise (drift, or an AI-added comment with a quote but no offsets)
    // re-anchor by finding the quoted passage.
    let range: { from: number; to: number } | null = null;
    if (anchor?.version === 3) range = rangeFromV3(doc, anchor);
    else if (anchor?.version === 2) range = rangeFromV2(doc, anchor);
    if (!range && start != null && end != null) {
      const r = { from: textOffsetToPos(doc, start), to: textOffsetToPos(doc, end) };
      // Compare against the quote's length only — the stored quote is capped at
      // 500 chars, so a longer anchor's textBetween won't equal it exactly.
      const at = quote ? plainTextBetween(doc, r.from, r.to).slice(0, quote.length) : "";
      if (r.from < r.to && (!quote || at === quote)) {
        range = r;
      }
    }
    if (!range) {
      range = findQuoteRange(
        doc,
        quote || anchor?.quote || "",
        start,
        anchor?.version === 2 ? anchor.prefix : undefined,
        anchor?.version === 2 ? anchor.suffix : undefined,
      );
    }
    // Tolerate agent-authored entries: fill in id/defaults if omitted.
    const id = storedId ?? newId();
    if (range && range.from < range.to) {
      tr = tr.addMark(range.from, range.to, schema.marks.comment.create({ id }));
    }
    added.push({
      id,
      kind: sc.kind === "ai" ? "ai" : "user",
      author: typeof sc.author === "string" ? sc.author : sc.kind === "ai" ? "AI reviewer" : "reviewer",
      ...(typeof sc.principalId === "string" && sc.principalId
        ? { principalId: sc.principalId }
        : {}),
      body: typeof sc.body === "string" ? sc.body : "",
      resolved: sc.resolved === true,
      createdAt: typeof sc.createdAt === "number" && Number.isFinite(sc.createdAt) ? sc.createdAt : 0,
      replies: (Array.isArray(sc.replies) ? sc.replies : []).flatMap((rawReply) => {
        if (!rawReply || typeof rawReply !== "object" || Array.isArray(rawReply)) return [];
        const r = rawReply as Partial<Reply>;
        return [{
        kind: r.kind === "ai" ? "ai" : "user",
        author: typeof r.author === "string" ? r.author : r.kind === "ai" ? "AI reviewer" : "reviewer",
        ...(typeof r.principalId === "string" && r.principalId
          ? { principalId: r.principalId }
          : {}),
        body: typeof r.body === "string" ? r.body : "",
        createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : 0,
        }];
      }),
      // Validate enums from (possibly hand/AI-edited) frontmatter — an unknown
      // value would leak into a CSS class and can throw in classList.add,
      // aborting the whole margin render.
      priority: (["P0", "P1", "P2", "P3"] as const).includes(sc.priority as never)
        ? sc.priority
        : undefined,
      status: (["open", "accepted", "rejected"] as const).includes(sc.status as never)
        ? sc.status
        : "open",
      color: HIGHLIGHT_COLORS.includes(sc.color as HighlightColor)
        ? sc.color
        : DEFAULT_COLOR,
      ...(range && range.from < range.to
        ? { orphaned: false, anchor }
        : { orphaned: true, anchor, orphanQuote: quote || anchor?.quote || "" }),
    });
  }
  // One meta for the whole batch — setMeta with the same key doesn't accumulate.
  tr.setMeta(commentsKey, { type: "addMany", comments: added } satisfies CommentsMeta);
  tr.setMeta("addToHistory", false);
  view.dispatch(tr);
}
