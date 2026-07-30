import { isMap, isScalar, parseDocument } from "yaml";
import type { Pair } from "yaml";

export interface CommentActor {
  principalId: string;
  displayName: string;
}

export class CommentAuthorizationError extends Error {}

/**
 * Validate a commenter save and stamp newly-authored material without
 * reserializing unrelated YAML. Only the comments value range is replaced.
 */
export function authorizeCommenterSave(
  previous: string,
  next: string,
  actor: CommentActor,
  now = Date.now(),
): string {
  const before = markdownParts(previous);
  const after = markdownParts(next);
  if (before.body !== after.body) throw new CommentAuthorizationError("Commenters cannot edit document content");
  if (canonical(withoutComments(before.value)) !== canonical(withoutComments(after.value))) {
    throw new CommentAuthorizationError("Commenters cannot edit document metadata");
  }
  const oldComments = comments(before.value);
  const proposed = comments(after.value);
  const stamped = authorizeComments(oldComments, proposed, actor, now);
  return replaceCommentsValue(after, stamped);
}

/**
 * Editors may change the document and manage every comment, but new authored
 * material is still attributed by the server. Existing records are otherwise
 * left exactly as submitted so editors retain their broader moderation role.
 */
export function stampEditorSave(
  previous: string,
  next: string,
  actor: CommentActor,
  now = Date.now(),
): string {
  const before = markdownParts(previous);
  const after = markdownParts(next);
  if (before.value.comments === undefined && after.value.comments === undefined) return next;
  const oldById = uniqueComments(comments(before.value));
  const proposed = comments(after.value);
  const stamped = proposed.map((comment) => {
    const previousComment = oldById.get(commentId(comment));
    if (!previousComment) {
      return {
        ...comment,
        kind: "user",
        author: actor.displayName,
        principalId: actor.principalId,
        createdAt: now,
        replies: stampNewReplies([], comment.replies, actor, now),
      };
    }
    return {
      ...comment,
      replies: stampNewReplies(previousComment.replies, comment.replies, actor, now),
    };
  });
  return replaceCommentsValue(after, stamped);
}

function authorizeComments(
  oldComments: Record<string, unknown>[],
  proposed: Record<string, unknown>[],
  actor: CommentActor,
  now: number,
): Record<string, unknown>[] {
  const oldById = uniqueComments(oldComments);
  const nextById = uniqueComments(proposed);

  for (const [id, previous] of oldById) {
    const next = nextById.get(id);
    if (!next) {
      if (previous.principalId !== actor.principalId) {
        throw new CommentAuthorizationError("Commenters may delete only their own comments");
      }
      continue;
    }
    const own = previous.principalId === actor.principalId;
    const immutable = own
      ? ["id", "kind", "author", "principalId", "createdAt", "anchor", "start", "end", "quote", "orphanQuote"]
      : Object.keys(previous).filter((key) => key !== "replies");
    for (const key of immutable) {
      if (canonical(previous[key]) !== canonical(next[key])) {
        throw new CommentAuthorizationError(
          own ? "Comment identity and anchors cannot be changed" : "Commenters may edit only their own comments",
        );
      }
    }
    next.replies = authorizeReplies(previous.replies, next.replies, actor, now);
  }

  return proposed.map((comment) => {
    const id = commentId(comment);
    const previous = oldById.get(id);
    if (previous) return nextById.get(id) as Record<string, unknown>;
    return {
      ...comment,
      kind: "user",
      author: actor.displayName,
      principalId: actor.principalId,
      createdAt: now,
      replies: authorizeReplies([], comment.replies, actor, now),
    };
  });
}

function authorizeReplies(
  previousValue: unknown,
  nextValue: unknown,
  actor: CommentActor,
  now: number,
): Record<string, unknown>[] {
  const previous = recordArray(previousValue, "Existing replies are malformed");
  const next = recordArray(nextValue, "Replies are malformed");
  if (next.length < previous.length) throw new CommentAuthorizationError("Replies are append-only");
  for (let index = 0; index < previous.length; index++) {
    if (canonical(previous[index]) !== canonical(next[index])) {
      throw new CommentAuthorizationError("Existing replies cannot be changed");
    }
  }
  return [
    ...previous,
    ...next.slice(previous.length).map((reply) => ({
      ...reply,
      kind: "user",
      author: actor.displayName,
      principalId: actor.principalId,
      createdAt: now,
    })),
  ];
}

function stampNewReplies(
  previousValue: unknown,
  nextValue: unknown,
  actor: CommentActor,
  now: number,
): Record<string, unknown>[] {
  const previous = recordArray(previousValue, "Existing replies are malformed");
  const next = recordArray(nextValue, "Replies are malformed");
  return next.map((reply, index) => index < previous.length
    ? reply
    : {
        ...reply,
        kind: "user",
        author: actor.displayName,
        principalId: actor.principalId,
        createdAt: now,
      });
}

interface MarkdownParts {
  prefix: string;
  source: string;
  suffix: string;
  body: string;
  value: Record<string, unknown>;
  commentsPair: Pair | null;
}

function markdownParts(text: string): MarkdownParts {
  const match = /^(---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))([\s\S]*)/m.exec(text);
  if (!match) throw new CommentAuthorizationError("Comment saves require valid frontmatter");
  const source = match[2];
  const document = parseDocument(source, { merge: false });
  if (document.errors.length || !isMap(document.contents)) {
    throw new CommentAuthorizationError("Comment saves require unambiguous frontmatter");
  }
  const value = document.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CommentAuthorizationError("Comment saves require mapping frontmatter");
  }
  const pairs = document.contents.items.filter((pair) => isScalar(pair.key) && pair.key.value === "comments");
  if (pairs.length > 1) throw new CommentAuthorizationError("Duplicate comments fields are not allowed");
  return {
    prefix: match[1],
    source,
    suffix: match[3],
    body: match[4],
    value: value as Record<string, unknown>,
    commentsPair: pairs[0] ?? null,
  };
}

function replaceCommentsValue(parts: MarkdownParts, value: Record<string, unknown>[]): string {
  const encoded = JSON.stringify(value);
  const range = (parts.commentsPair?.value as { range?: [number, number, number] } | null)?.range;
  if (range) {
    const [start, end] = range;
    return `${parts.prefix}${parts.source.slice(0, start)}${encoded}${parts.source.slice(end)}${parts.suffix}${parts.body}`;
  }
  const newline = parts.source && !parts.source.endsWith("\n") ? "\n" : "";
  return `${parts.prefix}${parts.source}${newline}comments: ${encoded}\n${parts.suffix}${parts.body}`;
}

function comments(value: Record<string, unknown>): Record<string, unknown>[] {
  if (value.comments === undefined) return [];
  return recordArray(value.comments, "Comments are malformed");
}

function recordArray(value: unknown, message: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
    throw new CommentAuthorizationError(message);
  }
  return value as Record<string, unknown>[];
}

function uniqueComments(values: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const value of values) {
    const id = commentId(value);
    if (result.has(id)) throw new CommentAuthorizationError("Comment IDs must be unique");
    result.set(id, value);
  }
  return result;
}

function commentId(value: Record<string, unknown>): string {
  if (typeof value.id !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(value.id)) {
    throw new CommentAuthorizationError("Comments require a valid ID");
  }
  return value.id;
}

function withoutComments(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value };
  delete copy.comments;
  return copy;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
