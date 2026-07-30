import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { parseMarkdown } from "../markdown/parse";
import { serializeMarkdown } from "../markdown/serialize";
import {
  documentOutline,
  findTextMatches,
  outlineCommandAvailability,
  transformOutlineSection,
} from "./document-navigator";

describe("document navigation", () => {
  it("derives a nested outline without storing duplicate content", () => {
    expect(documentOutline(parseMarkdown("# One {#one}\n\n### Three\n"))).toEqual([
      { level: 1, title: "One", id: "one", position: 0 },
      { level: 3, title: "Three", id: undefined, position: 5 },
    ]);
  });

  it("finds case-insensitive text matches at ProseMirror positions", () => {
    const matches = findTextMatches(parseMarkdown("Alpha beta alpha\n"), "alpha");
    expect(matches.map((match) => match.text)).toEqual(["Alpha", "alpha"]);
    expect(matches[0].from).toBeLessThan(matches[1].from);
  });

  it("moves complete sibling sections without separating their nested content", () => {
    const state = EditorState.create({
      doc: parseMarkdown([
        "# First",
        "",
        "First body.",
        "",
        "## First child",
        "",
        "Child body.",
        "",
        "# Second",
        "",
        "Second body.",
      ].join("\n")),
    });
    const second = documentOutline(state.doc).find((entry) => entry.title === "Second")!;
    expect(outlineCommandAvailability(state.doc, second.position)["move-up"]).toBe(true);
    const moved = transformOutlineSection(state, second.position, "move-up")!;
    const output = serializeMarkdown(moved.transaction.doc);
    expect(output.indexOf("# Second")).toBeLessThan(output.indexOf("# First"));
    expect(output.indexOf("First body.")).toBeLessThan(output.indexOf("## First child"));
    expect(output.indexOf("## First child")).toBeLessThan(output.indexOf("Child body."));
  });

  it("promotes and demotes a section subtree while preserving relative levels", () => {
    const doc = parseMarkdown([
      "# Parent",
      "",
      "## Previous",
      "",
      "## Selected",
      "",
      "### Child",
    ].join("\n"));
    const selected = documentOutline(doc).find((entry) => entry.title === "Selected")!;
    const state = EditorState.create({ doc });
    const demoted = transformOutlineSection(state, selected.position, "demote")!;
    expect(documentOutline(demoted.transaction.doc).map((entry) => [entry.title, entry.level]))
      .toEqual([
        ["Parent", 1],
        ["Previous", 2],
        ["Selected", 3],
        ["Child", 4],
      ]);
    const promoted = transformOutlineSection(
      EditorState.create({ doc: demoted.transaction.doc }),
      demoted.headingPosition,
      "promote",
    )!;
    expect(documentOutline(promoted.transaction.doc).map((entry) => [entry.title, entry.level]))
      .toEqual([
        ["Parent", 1],
        ["Previous", 2],
        ["Selected", 2],
        ["Child", 3],
      ]);
  });
});
