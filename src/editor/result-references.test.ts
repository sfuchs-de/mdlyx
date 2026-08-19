// @vitest-environment jsdom
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

  it("adds an actionable certificate widget at a matching claim marker", () => {
    const doc = parseMarkdown("<!-- mathdown-claim:R-CERT -->\n\nClaim text.\n");
    const certified: ResultReference = {
      ...overlap,
      id: "R-CERT",
      certificate: {
        resultId: "R-CERT",
        resultTitle: overlap.title,
        project: "sample-project",
        ownerDocumentId: "owner",
        ownerPath: "projects/sample-project/owner.md",
        coverage: "partial",
        status: "kernel-checked",
        declarations: ["Mathdown.overlap"],
        certifiedScope: ["finite identity"],
        assumptions: ["finite matrices"],
        excludedScope: ["empirical validity"],
        sourcePath: "formal/Mathdown/Proof.lean",
        sourceText: "theorem exact_result : True := by trivial",
        manifestPath: "formal/lake-manifest.json",
        leanVersion: "4.30.0",
        mathlibVersion: "4.30.0",
        buildState: "passed",
      },
    };
    const state = EditorState.create({
      schema,
      doc,
      plugins: [...buildPlugins(), buildResultReferences(() => [certified])],
    });

    const decorations = resultReferencesKey.getState(state)?.find() ?? [];
    expect(decorations).toHaveLength(1);
    expect(decorations[0].spec.key).toBe("lean-certificate:mathdown-claim:R-CERT");
  });

  it("adds claim-local public dependency context without inventing proof-use edges", () => {
    const doc = parseMarkdown("<!-- mathdown-claim:R-MAIN -->\n\nClaim text.\n");
    const references: ResultReference[] = [
      { ...overlap, id: "R-BASE", title: "Base", dependsOn: [] },
      { ...overlap, id: "R-MAIN", title: "Main", dependsOn: ["R-BASE"] },
      { ...overlap, id: "R-DOWN", title: "Downstream", dependsOn: ["R-MAIN"] },
    ];
    const state = EditorState.create({
      schema,
      doc,
      plugins: [...buildPlugins(), buildResultReferences(() => references)],
    });

    const decorations = resultReferencesKey.getState(state)?.find() ?? [];
    expect(decorations).toHaveLength(1);
    expect(decorations[0].spec.key).toBe("result-context:mathdown-claim:R-MAIN");
    const widget = (decorations[0] as unknown as { type: { toDOM: () => HTMLElement } }).type.toDOM();
    expect(widget.textContent).toBe("Public prereq 1 · Used by 1");
    expect(widget.querySelector(".result-dependency-context")?.getAttribute("aria-label"))
      .toContain("Imported and atomic proof obligations remain");
  });
});
