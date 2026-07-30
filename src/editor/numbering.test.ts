import { describe, it, expect } from "vitest";
import { parseMarkdown } from "../markdown/parse";
import { computeNumbering, refText } from "./numbering";

const doc = (md: string) => parseMarkdown(md);

describe("numbering", () => {
  it("numbers equations document-wide by default", () => {
    const d = doc(
      "$$\nx = 1\n$$ {#eq:a}\n\n$$\ny = 2\n$$ {#eq:b}",
    );
    const { labels } = computeNumbering(d, { equations: "document" });
    expect(labels.get("eq:a")?.number).toBe("1");
    expect(labels.get("eq:b")?.number).toBe("2");
  });

  it("numbers equations relative to the section", () => {
    const src = [
      "# First",
      "",
      "$$",
      "x = 1",
      "$$ {#eq:a}",
      "",
      "# Second",
      "",
      "$$",
      "y = 2",
      "$$ {#eq:b}",
      "",
      "$$",
      "z = 3",
      "$$ {#eq:c}",
    ].join("\n");
    const { labels } = computeNumbering(doc(src), { equations: "section" });
    expect(labels.get("eq:a")?.number).toBe("1.1");
    expect(labels.get("eq:b")?.number).toBe("2.1");
    expect(labels.get("eq:c")?.number).toBe("2.2");
  });

  it("numbers equations relative to subsections with a section fallback", () => {
    const src = [
      "# First",
      "",
      "$$\nx = 0\n$$ {#eq:section}",
      "",
      "## Detail",
      "",
      "$$\nx = 1\n$$ {#eq:a}",
      "",
      "$$\ny = 2\n$$ {#eq:b}",
      "",
      "## Other",
      "",
      "$$\nz = 3\n$$ {#eq:c}",
    ].join("\n");
    const { labels } = computeNumbering(doc(src), { equations: "subsection" });
    expect(labels.get("eq:section")?.number).toBe("1.1");
    expect(labels.get("eq:a")?.number).toBe("1.1.1");
    expect(labels.get("eq:b")?.number).toBe("1.1.2");
    expect(labels.get("eq:c")?.number).toBe("1.2.1");
  });

  it("skips unnumbered equations", () => {
    const d = doc(
      "$$\nx = 1\n$$ {#eq:a numbered=false}\n\n$$\ny = 2\n$$ {#eq:b}",
    );
    const { labels } = computeNumbering(d, { equations: "document" });
    expect(labels.has("eq:a")).toBe(false);
    expect(labels.get("eq:b")?.number).toBe("1");
  });

  it("assigns hierarchical section numbers to headings with ids", () => {
    const src = "# Intro {#sec:intro}\n\n## Details {#sec:details}";
    const { labels, headingPositions } = computeNumbering(doc(src), { equations: "document" });
    expect(labels.get("sec:intro")?.number).toBe("1");
    expect(labels.get("sec:details")?.number).toBe("1.1");
    expect(headingPositions.map((entry) => entry.num)).toEqual(["1", "1.1"]);
  });

  it("flags a duplicate label deterministically, keeping the first (#I47)", () => {
    const d = doc("$$\nx = 1\n$$ {#eq:dup}\n\n$$\ny = 2\n$$ {#eq:dup}");
    const { labels, duplicates } = computeNumbering(d, { equations: "document" });
    expect(duplicates.has("eq:dup")).toBe(true);
    // resolution is deterministic: the FIRST definition wins, not the later one
    expect(labels.get("eq:dup")?.number).toBe("1");
  });

  it("also flags a heading id that duplicates an equation label (#I47)", () => {
    const d = doc("# Title {#dup}\n\n$$\nx\n$$ {#dup}");
    const { duplicates } = computeNumbering(d, { equations: "document" });
    expect(duplicates.has("dup")).toBe(true);
  });

  it("numbers and resolves figures, tables, and theorem-like blocks", () => {
    const source = [
      "![Clock](assets/clock.png){#fig:clock}",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "{#tbl:values caption=\"Values\"}",
      "",
      "::: theorem {Existence} #thm:existence",
      "A solution exists.",
      ":::",
      "",
      "::: lemma #lem:bound",
      "The solution is bounded.",
      ":::",
    ].join("\n");
    const { labels } = computeNumbering(doc(source), { equations: "document" });
    expect(labels.get("fig:clock")).toEqual({ kind: "fig", number: "1" });
    expect(labels.get("tbl:values")).toEqual({ kind: "tbl", number: "1" });
    expect(labels.get("thm:existence")).toEqual({ kind: "thm", number: "1" });
    expect(labels.get("lem:bound")).toEqual({ kind: "lem", number: "1" });
  });

  it("does not assign a number to proof blocks", () => {
    const { labels } = computeNumbering(
      doc("::: proof #proof:claim\nDone.\n:::\n"),
      { equations: "document" },
    );
    expect(labels.has("proof:claim")).toBe(false);
  });

  it("spells out resolved and broken references", () => {
    expect(refText({ kind: "eq", number: "2.3" }, "eq")).toEqual({
      text: "Equation (2.3)",
      broken: false,
    });
    expect(refText(undefined, "eq")).toEqual({
      text: "Equation (??)",
      broken: true,
    });
    expect(refText({ kind: "thm", number: "4" }, "thm")).toEqual({
      text: "Theorem (4)",
      broken: false,
    });
  });
});
