import { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../markdown/parse";
import { buildPlugins } from "./plugins";
import {
  buildResultReferences,
  findResultReferences,
  resultReferencesKey,
  type ResultReference,
} from "./result-references";
import { schema } from "./schema";

const overlap: ResultReference = {
  id: "R-DEMO-OVERLAP",
  title: "Pairwise port-route reliability overlap",
  ownerLabel: "Overlap, Concentration, and the Resilience Premium",
};

describe("catalog-backed result references", () => {
  it("matches known IDs in prose and inline code without guessing from their spelling", () => {
    const doc = parseMarkdown([
      "Use `R-DEMO-OVERLAP` and R-DEMO-OVERLAP here.",
      "",
      "Do not link R-DEMO-OVERLAP-X, UNKNOWN-R-RESULT, or [R-DEMO-OVERLAP](https://example.test).",
      "",
      "```text",
      "R-DEMO-OVERLAP",
      "```",
    ].join("\n"));

    const matches = findResultReferences(doc, [overlap]);
    expect(matches.map((match) => match.reference.id)).toEqual([
      "R-DEMO-OVERLAP",
      "R-DEMO-OVERLAP",
    ]);
    expect(matches.map((match) => doc.textBetween(match.from, match.to))).toEqual([
      "R-DEMO-OVERLAP",
      "R-DEMO-OVERLAP",
    ]);
  });

  it("uses longest exact catalog IDs and ignores token-adjacent substrings", () => {
    const references = [
      { ...overlap, id: "R-A", title: "A" },
      { ...overlap, id: "R-A-LONG", title: "A long" },
    ];
    const doc = parseMarkdown("R-A, R-A-LONG, XR-A, and R-A_2.\n");

    expect(findResultReferences(doc, references).map((match) => match.reference.id)).toEqual([
      "R-A",
      "R-A-LONG",
    ]);
  });

  it("derives accessible decorations without changing the document", () => {
    const doc = parseMarkdown("The formal result is `R-DEMO-OVERLAP`.\n");
    const state = EditorState.create({
      schema,
      doc,
      plugins: [
        ...buildPlugins(),
        buildResultReferences(() => [overlap]),
      ],
    });

    expect(state.doc.eq(doc)).toBe(true);
    expect(resultReferencesKey.getState(state)?.find()).toHaveLength(1);
  });
});
