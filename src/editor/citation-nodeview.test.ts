// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor, type EditorHandle } from "./create-editor";
import { parseMarkdown } from "../markdown/parse";
import { CitationCatalog } from "../publication/citation-catalog";
import { serializeMarkdown } from "../markdown/serialize";

const editors: EditorHandle[] = [];

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.replaceChildren();
});

describe("live citation rendering", () => {
  it("formats a citation without changing or dirtying its exact Pandoc source", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const changed = vi.fn();
    const editor = createEditor(host, {
      doc: parseMarkdown("See [@allen2014trade, p. 12]."),
      onChange: changed,
    });
    editors.push(editor);
    const catalog = new CitationCatalog();
    catalog.addBibTeX("projects/p/references/library.bib", `
@article{allen2014trade,
  author = {Allen, Treb and Arkolakis, Costas},
  title = {Trade and the Topography of the Spatial Economy},
  year = {2014}
}`);
    editor.setCitationCatalog(catalog.resolve([]), "authoryear");
    const citation = host.querySelector<HTMLElement>("[data-citation]");
    expect(citation?.textContent).toBe("(Allen and Arkolakis 2014, p. 12)");
    expect(citation?.dataset.citation).toBe("@allen2014trade, p. 12");
    expect(serializeMarkdown(editor.view.state.doc)).toContain("[@allen2014trade, p. 12]");
    expect(changed).not.toHaveBeenCalled();
  });

  it("retains raw syntax and exposes a warning for a missing entry", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, {
      doc: parseMarkdown("See [@missing2024]."),
    });
    editors.push(editor);
    editor.setCitationCatalog(new CitationCatalog().resolve(["missing2024"]), "authoryear");
    const citation = host.querySelector<HTMLElement>("[data-citation]");
    expect(citation?.textContent).toBe("[@missing2024]");
    expect(citation?.classList.contains("citation-missing")).toBe(true);
    expect(citation?.getAttribute("aria-label")).toContain("Unresolved citation");
  });
});
