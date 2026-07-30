import { describe, expect, it } from "vitest";
import { authorizeCommenterSave, CommentAuthorizationError, stampEditorSave } from "./comment-authorization";

const actor = { principalId: "alice", displayName: "Alice Smith" };
const source = `---
library: {"id":"doc","projects":["sample-model"]}
comments: [{"id":"legacy","kind":"user","author":"owner","body":"Owner note","resolved":false,"createdAt":1,"replies":[]}]
custom: keep-me
---

# Body

Equation $x=1$.
`;

describe("commenter-only document saves", () => {
  it("stamps new comments and replies while preserving unrelated source", () => {
    const next = source.replace(
      '"replies":[]',
      '"replies":[{"kind":"user","author":"spoof","body":"Reply","createdAt":3}]',
    ).replace(
      "]\ncustom:",
      ',{"id":"new-comment","kind":"ai","author":"spoof","body":"Check this","resolved":false,"createdAt":2,"replies":[]}]\ncustom:',
    );
    const result = authorizeCommenterSave(source, next, actor, 100);
    expect(result).toContain('"author":"Alice Smith","body":"Reply","createdAt":100,"principalId":"alice"');
    expect(result).toContain('"id":"new-comment","kind":"user","author":"Alice Smith"');
    expect(result).toContain('"body":"Check this","resolved":false,"createdAt":100,"replies":[],"principalId":"alice"');
    expect(result).toContain("custom: keep-me");
    expect(result).toContain("Equation $x=1$.");
  });

  it("rejects prose and non-comment metadata changes", () => {
    expect(() => authorizeCommenterSave(source, source.replace("x=1", "x=2"), actor)).toThrow(
      /cannot edit document content/,
    );
    expect(() => authorizeCommenterSave(source, source.replace("keep-me", "changed"), actor)).toThrow(
      /cannot edit document metadata/,
    );
  });

  it("allows replies to legacy comments but not editing or deleting them", () => {
    expect(() => authorizeCommenterSave(
      source,
      source.replace("Owner note", "Changed owner note"),
      actor,
    )).toThrow(CommentAuthorizationError);
    expect(() => authorizeCommenterSave(
      source,
      source.replace('comments: [{"id":"legacy","kind":"user","author":"owner","body":"Owner note","resolved":false,"createdAt":1,"replies":[]}]\n', "comments: []\n"),
      actor,
    )).toThrow(/delete only their own/);
  });

  it("lets commenters edit, resolve, and delete only comments carrying their principal ID", () => {
    const own = source.replace(
      '"author":"owner"',
      '"author":"Alice Smith","principalId":"alice"',
    );
    const edited = authorizeCommenterSave(
      own,
      own.replace("Owner note", "Revised note").replace('"resolved":false', '"resolved":true'),
      actor,
    );
    expect(edited).toContain('"body":"Revised note","resolved":true');
    const removed = authorizeCommenterSave(
      own,
      own.replace(/comments: \[[^\n]+\]\n/, "comments: []\n"),
      actor,
    );
    expect(removed).toContain("comments: []");
  });

  it("stamps new editor comments while allowing document and legacy-comment edits", () => {
    const next = source
      .replace("Equation $x=1$.", "Equation $x=2$.")
      .replace("Owner note", "Editor revised owner note")
      .replace(
        "]\ncustom:",
        ',{"id":"editor-new","kind":"ai","author":"spoof","body":"New","createdAt":2,"replies":[]}]\ncustom:',
      );
    const result = stampEditorSave(source, next, actor, 200);
    expect(result).toContain("Equation $x=2$.");
    expect(result).toContain("Editor revised owner note");
    expect(result).toContain('"id":"editor-new","kind":"user","author":"Alice Smith"');
    expect(result).toContain('"createdAt":200,"replies":[],"principalId":"alice"');
  });
});
