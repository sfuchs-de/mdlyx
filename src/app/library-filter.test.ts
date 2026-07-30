import { describe, it, expect } from "vitest";
import type { LibraryFile } from "./library";
import { emptyMeta, type DocMeta } from "../markdown/frontmatter";
import {
  entryPath,
  isReaderDocument,
  matchesDocumentVisibility,
  matchesQuery,
  matchesFilters,
  groupEntries,
  otherNotePath,
  OTHER_NOTES_LABEL,
} from "./library-filter";

function f(
  name: string,
  folder: string,
  meta: Partial<DocMeta> = {},
): LibraryFile {
  return {
    name,
    folder,
    meta: { ...emptyMeta(), ...meta },
    handle: {} as LibraryFile["handle"],
    openCommentCount: 0,
  };
}

const lib = [
  f("overview.md", "", { kind: "notes", tags: ["overview"], projects: ["gt"], status: "final" }),
  f("ot.md", "", { kind: "derivation", tags: ["ot", "flow"], projects: ["gt"], status: "review" }),
  f("prop2.md", "", { kind: "proof", tags: ["ot"], projects: ["gt"], status: "draft" }),
  f("intro.md", "drafts", { kind: "paper", tags: ["intro"], projects: ["p26"], status: "draft" }),
  f("cheatsheet.md", "references", { kind: "reference", tags: ["katex"] }),
  f("deprecated.md", "archive/old", { kind: "notes", status: "final" }),
];

describe("entryPath", () => {
  it("joins folder + name, or just name at root", () => {
    expect(entryPath(f("a.md", ""))).toBe("a.md");
    expect(entryPath(f("a.md", "sub/dir"))).toBe("sub/dir/a.md");
  });
});

describe("matchesQuery", () => {
  it("empty query matches everything", () => {
    expect(matchesQuery(lib[0], "")).toBe(true);
    expect(matchesQuery(lib[0], "   ")).toBe(true);
  });
  it("matches across title, tags, kind, folder, project (case-insensitive)", () => {
    expect(matchesQuery(lib[1], "DERIV")).toBe(true); // kind
    expect(matchesQuery(lib[1], "flow")).toBe(true); // tag
    expect(matchesQuery(lib[3], "drafts")).toBe(true); // folder
    expect(matchesQuery(lib[0], "gt")).toBe(true); // project
    expect(matchesQuery(lib[0], "overview.md")).toBe(true); // filename
  });
  it("returns false when nothing matches", () => {
    expect(matchesQuery(lib[4], "wasserstein")).toBe(false);
  });
  it("finds projectless documents through the Other notes collection label", () => {
    const note = f("idea.md", "other-notes");
    expect(matchesQuery(note, "other notes")).toBe(true);
    expect(matchesQuery(lib[4], "other notes")).toBe(false);
    expect(matchesQuery(lib[0], "other notes")).toBe(false);
  });
});

describe("reader/support visibility", () => {
  const support = f("legacy.md", "archive", {
    id: "legacy-proof",
    visibility: "support",
    title: "Legacy proof",
  });

  it("defaults ordinary metadata to reader visibility", () => {
    expect(isReaderDocument(lib[0])).toBe(true);
    expect(isReaderDocument(support)).toBe(false);
  });

  it("reveals support files only for an exact stable ID or path query", () => {
    expect(matchesDocumentVisibility(support, "")).toBe(false);
    expect(matchesDocumentVisibility(support, "legacy")).toBe(false);
    expect(matchesDocumentVisibility(support, "legacy-proof")).toBe(true);
    expect(matchesDocumentVisibility(support, "archive/legacy.md")).toBe(true);
    expect(matchesQuery(support, "legacy-proof")).toBe(true);
  });
});

describe("matchesFilters (ANDed)", () => {
  it("requires every selected label", () => {
    expect(matchesFilters(lib[1], ["tag:ot"])).toBe(true);
    expect(matchesFilters(lib[1], ["tag:ot", "project:gt"])).toBe(true);
    expect(matchesFilters(lib[1], ["tag:ot", "project:p26"])).toBe(false);
    expect(matchesFilters(lib[4], ["project:gt"])).toBe(false);
    expect(matchesFilters(f("idea.md", "other-notes"), ["collection:other-notes"])).toBe(true);
    expect(matchesFilters(lib[4], ["collection:other-notes"])).toBe(false);
    expect(matchesFilters(lib[0], ["collection:other-notes"])).toBe(false);
  });
  it("no filters matches everything", () => {
    expect(matchesFilters(lib[5], [])).toBe(true);
  });
});

describe("groupEntries", () => {
  it("by folder, with a (root) bucket sorted last", () => {
    const g = groupEntries(lib, "folder");
    expect(g.map((x) => x.key)).toEqual([
      "archive/old",
      "drafts",
      "references",
      "— (root)",
    ]);
    expect(g.find((x) => x.key === "— (root)")!.files).toHaveLength(3);
  });

  it("by tag, placing a file under each of its tags", () => {
    const g = groupEntries(lib, "tag");
    const byKey = Object.fromEntries(g.map((x) => [x.key, x.files.map((e) => e.name)]));
    expect(byKey["ot"].sort()).toEqual(["ot.md", "prop2.md"]); // multi-membership
    expect(byKey["flow"]).toEqual(["ot.md"]);
    expect(byKey["— untagged"]).toEqual(["deprecated.md"]);
  });

  it("by project, missing-project bucket last", () => {
    const note = f("idea.md", "other-notes");
    const g = groupEntries([...lib, note], "project");
    expect(g.map((group) => group.key)).toEqual(["gt", "p26", `— ${OTHER_NOTES_LABEL}`, "— no project"]);
    expect(g.find((x) => x.key === "gt")!.files).toHaveLength(3);
    expect(g.find((x) => x.key === `— ${OTHER_NOTES_LABEL}`)!.files).toEqual([note]);
    expect(g.find((x) => x.key === "— no project")!.files).toHaveLength(2);
  });

  it("puts standalone names and nested names in the physical collection folder", () => {
    expect(otherNotePath("idea.md")).toBe("other-notes/idea.md");
    expect(otherNotePath("reading/smith.md")).toBe("other-notes/reading/smith.md");
    expect(otherNotePath("other-notes/existing.md")).toBe("other-notes/existing.md");
    expect(otherNotePath("other-notes")).toBe("");
    expect(otherNotePath("other-notes/")).toBe("");
    expect(otherNotePath("  ")).toBe("");
  });

  it("keeps a real project named Other notes distinct from the collection", () => {
    const project = f("project.md", "projects/other", { projects: [OTHER_NOTES_LABEL] });
    const note = f("note.md", "other-notes");
    const groups = groupEntries([project, note], "project");
    expect(groups.map((group) => group.key)).toEqual([
      OTHER_NOTES_LABEL,
      `— ${OTHER_NOTES_LABEL}`,
    ]);
    expect(groups[0].files).toEqual([project]);
    expect(groups[1].files).toEqual([note]);
  });

  it("does not classify a project-assigned file as an Other note solely by path", () => {
    const misplaced = f("project.md", "other-notes", { projects: ["research"] });
    expect(matchesQuery(misplaced, "other notes")).toBe(false);
    expect(matchesFilters(misplaced, ["collection:other-notes"])).toBe(false);
    expect(groupEntries([misplaced], "project").map((group) => group.key)).toEqual(["research"]);
  });

  it("by kind and by status bucket the right counts", () => {
    const kinds = Object.fromEntries(
      groupEntries(lib, "kind").map((x) => [x.key, x.files.length]),
    );
    expect(kinds).toMatchObject({ notes: 2, derivation: 1, proof: 1, paper: 1, reference: 1 });
    const statuses = Object.fromEntries(
      groupEntries(lib, "status").map((x) => [x.key, x.files.length]),
    );
    expect(statuses).toMatchObject({ final: 2, review: 1, draft: 2 });
  });
});
