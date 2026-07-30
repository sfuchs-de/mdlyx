import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseMarkdown } from "./parse";
import { serializeMarkdown } from "./serialize";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter";
import { exportLatex } from "../tex/export-latex";

// Golden fixtures (Phase 9): each fixture must (1) round-trip to a stable
// Markdown fixed point and (2) produce deterministic serialized + exported
// output, captured as snapshots. Regenerate intentionally with `vitest -u`.

const fixturesDir = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const files = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".md"))
  .sort();

function serializeDocument(md: string): string {
  const { frontmatter, body } = parseFrontmatter(md);
  return serializeFrontmatter(frontmatter) + serializeMarkdown(parseMarkdown(body));
}

describe("golden fixtures", () => {
  it("covers every fixture file", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of files) {
    describe(file, () => {
      const src = readFileSync(fixturesDir + file, "utf8");

      it("round-trips to a stable fixed point", () => {
        const once = serializeDocument(src);
        const twice = serializeDocument(once);
        expect(twice).toBe(once);
      });

      it("serializes deterministically (golden)", () => {
        expect(serializeDocument(src)).toMatchSnapshot();
      });

      it("exports to LaTeX deterministically (golden)", () => {
        const { frontmatter, body } = parseFrontmatter(src);
        expect(
          exportLatex(parseMarkdown(body), { frontmatter }),
        ).toMatchSnapshot();
      });
    });
  }
});
