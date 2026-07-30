// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parseMarkdown } from "../markdown/parse";
import { defaultPublication } from "../markdown/frontmatter";
import {
  ScholarlyTools,
  citationKeys,
  createReferenceLabel,
  nextFootnoteLabel,
  referenceKind,
  referenceTargets,
} from "./scholarly-tools";

const views: EditorView[] = [];

beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  document.body.replaceChildren();
});

function viewFor(markdown: string): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  const doc = parseMarkdown(markdown);
  const view = new EditorView(host, { state: EditorState.create({ doc }) });
  views.push(view);
  return view;
}

function launcher(): HTMLButtonElement {
  const button = document.createElement("button");
  document.body.append(button);
  return button;
}

function click(label: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`Missing ${label}`);
  button.click();
}

describe("scholarly authoring helpers", () => {
  it("collects unique citation keys from Pandoc clusters", () => {
    const doc = parseMarkdown("See [@smith2024, p. 3; -@jones2025] and [@smith2024].");
    expect(citationKeys(doc)).toEqual(["smith2024", "jones2025"]);
  });

  it("allocates stable, non-conflicting footnote labels", () => {
    const doc = parseMarkdown("Text[^note].\n\n[^note]: Existing.\n");
    expect(nextFootnoteLabel(doc)).toBe("note-2");
    expect(nextFootnoteLabel(doc, "author note")).toBe("author-note");
  });

  it("recognizes scholarly reference prefixes", () => {
    expect(referenceKind("fig:clock")).toBe("fig");
    expect(referenceKind("thm:existence")).toBe("thm");
    expect(referenceKind("custom:claim")).toBe("generic");
  });

  it("discovers unlabelled targets and generates stable collision-free labels", () => {
    const doc = parseMarkdown([
      "# Main result",
      "",
      "## Main result {#sec:main-result}",
      "",
      "$$\nx=1\n$$",
    ].join("\n"));
    const targets = referenceTargets(doc, { equations: "section" });
    expect(targets.map((target) => [target.kind, target.label])).toEqual([
      ["sec", undefined],
      ["sec", "sec:main-result"],
      ["eq", undefined],
    ]);
    expect(createReferenceLabel(doc, targets[0])).toBe("sec:main-result-2");
    expect(createReferenceLabel(doc, targets[2])).toBe("eq:display-equation");
  });
});

describe("ScholarlyTools", () => {
  it("loads bibliography previews and inserts a selected citation", async () => {
    const view = viewFor("# Note\n\nCitation: ");
    const readAsset = vi.fn(async () => ({
      asset: { path: "references/library.bib", mimeType: "application/x-bibtex", size: 50 },
      bytes: new TextEncoder().encode("@article{smith2024, author={Jane Smith}, year={2024}, title={A}}"),
    }));
    const trigger = launcher();
    new ScholarlyTools(trigger, view, {
      getPublication: () => ({ ...defaultPublication(), bibliography: ["references/library.bib"] }),
      getNumbering: () => ({ equations: "document" }),
      isReadOnly: () => false,
      listAssets: async () => [],
      readAsset,
      writeAsset: vi.fn(),
    });
    trigger.click();
    await vi.waitFor(() => expect(readAsset).toHaveBeenCalled());
    const citation = document.querySelector<HTMLInputElement>("[aria-label='Citation key']")!;
    citation.value = "smith2024";
    citation.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector(".scholarly-citation-preview")?.textContent).toBe("(Smith 2024)");
    const locator = document.querySelector<HTMLInputElement>("[aria-label='Citation locator']")!;
    locator.value = "p. 12";
    click("Insert citation");
    expect(view.state.doc.textContent).toContain("Citation:");
    let source = "";
    view.state.doc.descendants((node) => {
      if (node.type.name === "citation") source = String(node.attrs.source);
    });
    expect(source).toBe("@smith2024, p. 12");
    expect(document.querySelector("#scholarly-citation-options option")?.getAttribute("value"))
      .toBe("smith2024");
  });

  it("inserts a reference, footnote pair, and selected figure asset", async () => {
    const view = viewFor([
      "# Note {#sec:note}",
      "",
      "Text here.",
    ].join("\n"));
    const trigger = launcher();
    new ScholarlyTools(trigger, view, {
      getPublication: defaultPublication,
      getNumbering: () => ({ equations: "document" }),
      isReadOnly: () => false,
      listAssets: async () => [{
        path: "assets/clock.png",
        mimeType: "image/png",
        size: 4,
        sha: "old",
      }],
      readAsset: vi.fn(),
      writeAsset: vi.fn(),
    });
    trigger.click();
    await vi.waitFor(() => expect(
      document.querySelector<HTMLSelectElement>("[aria-label='Figure asset']")?.value,
    ).toBe("assets/clock.png"));

    click("Insert reference");
    const footnoteText = document.querySelector<HTMLTextAreaElement>("[aria-label='Footnote text']")!;
    footnoteText.value = "Supporting detail.";
    click("Insert footnote");
    const caption = document.querySelector<HTMLInputElement>("[aria-label='Figure caption']")!;
    caption.value = "Atlantic clock";
    const figureLabel = document.querySelector<HTMLInputElement>("[aria-label='Figure label']")!;
    figureLabel.value = "fig:clock";
    click("Insert figure");

    const types: string[] = [];
    view.state.doc.descendants((node) => {
      types.push(node.type.name);
    });
    expect(types).toContain("xref");
    expect(types).toContain("footnote_ref");
    expect(types).toContain("footnote_definition");
    expect(types).toContain("figure");
  });

  it("updates an existing figure without losing non-CSS source widths", async () => {
    const view = viewFor("![Old caption](assets/old.png){#fig:old width=0.7\\linewidth}");
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));
    const trigger = launcher();
    new ScholarlyTools(trigger, view, {
      getPublication: defaultPublication,
      getNumbering: () => ({ equations: "document" }),
      isReadOnly: () => false,
      listAssets: async () => [{
        path: "assets/new.png",
        mimeType: "image/png",
        size: 4,
      }],
      readAsset: vi.fn(),
      writeAsset: vi.fn(),
    });
    trigger.click();
    const tools = document.querySelector<HTMLElement>("#scholarly-tools")!;
    await vi.waitFor(() => expect(
      tools.querySelector<HTMLSelectElement>("[aria-label='Figure asset']")?.value,
    ).toBe("assets/old.png"));
    await vi.waitFor(() => expect(
      [...tools.querySelectorAll<HTMLOptionElement>("[aria-label='Figure asset'] option")]
        .map((option) => option.value),
    ).toContain("assets/new.png"));
    expect(tools.querySelector<HTMLInputElement>("[aria-label='Figure width']")?.value)
      .toBe("0.7\\linewidth");
    tools.querySelector<HTMLSelectElement>("[aria-label='Figure asset']")!.value = "assets/new.png";
    tools.querySelector<HTMLInputElement>("[aria-label='Figure caption']")!.value = "New caption";
    tools.querySelector<HTMLInputElement>("[aria-label='Figure label']")!.value = "fig:new";
    tools.querySelector<HTMLInputElement>("[aria-label='Figure width']")!.value = "65%";
    const update = [...tools.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Update selected figure")!;
    expect(update.disabled).toBe(false);
    update.click();
    expect(tools.querySelector(".scholarly-status")?.textContent)
      .toBe("Updated figure assets/new.png.");

    const figure = view.state.doc.firstChild!;
    expect(figure.attrs).toMatchObject({
      src: "assets/new.png",
      alt: "New caption",
      caption: "New caption",
      id: "fig:new",
      width: "65%",
    });
  });

  it("creates a missing target label while inserting its reference", () => {
    const view = viewFor("# Main result\n\nRefer here: \n");
    const paragraphPosition = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(
      TextSelection.near(view.state.doc.resolve(paragraphPosition)),
    ));
    const trigger = launcher();
    new ScholarlyTools(trigger, view, {
      getPublication: defaultPublication,
      getNumbering: () => ({ equations: "document" }),
      isReadOnly: () => false,
      listAssets: async () => [],
      readAsset: vi.fn(),
      writeAsset: vi.fn(),
    });
    trigger.click();
    click("Insert reference");
    const heading = view.state.doc.firstChild!;
    expect(heading.attrs.id).toBe("sec:main-result");
    let target = "";
    view.state.doc.descendants((node) => {
      if (node.type.name === "xref") target = String(node.attrs.target);
    });
    expect(target).toBe("sec:main-result");
    expect(document.querySelector(".scholarly-status")?.textContent)
      .toContain("Created sec:main-result");
  });

  it("inserts theorem-like and raw-LaTeX blocks from structured controls", () => {
    const view = viewFor("# Note\n\nSelected statement.\n");
    const trigger = launcher();
    new ScholarlyTools(trigger, view, {
      getPublication: defaultPublication,
      getNumbering: () => ({ equations: "document" }),
      isReadOnly: () => false,
      listAssets: async () => [],
      readAsset: vi.fn(),
      writeAsset: vi.fn(),
    });
    trigger.click();
    const kind = document.querySelector<HTMLSelectElement>("[aria-label='Structured block type']")!;
    kind.value = "proposition";
    document.querySelector<HTMLInputElement>("[aria-label='Structured block title']")!.value = "Existence";
    document.querySelector<HTMLInputElement>("[aria-label='Structured block label']")!.value = "prop:existence";
    click("Insert structured block");
    const raw = document.querySelector<HTMLTextAreaElement>("[aria-label='Raw LaTeX source']")!;
    raw.value = "\\clearpage";
    click("Insert raw LaTeX");
    const types: string[] = [];
    view.state.doc.descendants((node) => {
      types.push(node.type.name);
    });
    expect(types).toContain("theorem");
    expect(types).toContain("raw_latex");
    const theorem = view.state.doc.content.content.find((node) => node.type.name === "theorem")!;
    expect(theorem.attrs).toMatchObject({
      kind: "proposition",
      title: "Existence",
      id: "prop:existence",
    });
  });

  it("edits the kind, title, and label of the selected structured block", () => {
    const view = viewFor(
      ":::: theorem {Old title} {#thm:old}\nStatement.\n:::::\n",
    );
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)),
    );
    const trigger = launcher();
    new ScholarlyTools(trigger, view, {
      getPublication: defaultPublication,
      getNumbering: () => ({ equations: "document" }),
      isReadOnly: () => false,
      listAssets: async () => [],
      readAsset: vi.fn(),
      writeAsset: vi.fn(),
    });
    trigger.click();
    const kind = document.querySelector<HTMLSelectElement>(
      "[aria-label='Structured block type']",
    )!;
    const title = document.querySelector<HTMLInputElement>(
      "[aria-label='Structured block title']",
    )!;
    const label = document.querySelector<HTMLInputElement>(
      "[aria-label='Structured block label']",
    )!;
    expect(kind.value).toBe("theorem");
    expect(title.value).toBe("Old title");
    expect(label.value).toBe("thm:old");
    kind.value = "proposition";
    title.value = "Revised title";
    label.value = "prop:revised";
    click("Update selected block");
    expect(view.state.doc.firstChild?.attrs).toMatchObject({
      kind: "proposition",
      title: "Revised title",
      id: "prop:revised",
      fenceLength: 4,
      closingFenceLength: 5,
    });
  });

  it("keeps generated projections immutable", () => {
    const view = viewFor("# Read only {#sec:read-only}\n");
    const trigger = launcher();
    new ScholarlyTools(trigger, view, {
      getPublication: defaultPublication,
      getNumbering: () => ({ equations: "document" }),
      isReadOnly: () => true,
      listAssets: async () => [],
      readAsset: vi.fn(),
      writeAsset: vi.fn(),
    });
    trigger.click();
    const before = view.state.doc.toJSON();
    click("Insert reference");
    expect(view.state.doc.toJSON()).toEqual(before);
    expect(document.querySelector(".scholarly-status")?.textContent).toContain("read-only");
  });

  it("edits one bibliography entry with an asset SHA while preserving untouched source", async () => {
    const source = [
      "% Curator note",
      "@string{qje = \"The Quarterly Journal of Economics\"}",
      "",
      "@article{allen2014trade,",
      "  author = {Treb Allen and Costas Arkolakis},",
      "  title = {Trade and the Topography of the Spatial Economy},",
      "  journal = qje,",
      "  year = {2014},",
      "  note = {Keep this field},",
      "}",
      "",
    ].join("\n");
    const view = viewFor("# Note\n");
    const writeAsset = vi.fn(async (input) => ({
      path: input.path,
      mimeType: input.mimeType,
      size: input.bytes.byteLength,
      sha: "sha-new",
    }));
    const trigger = launcher();
    const tools = new ScholarlyTools(trigger, view, {
      getPublication: () => ({ ...defaultPublication(), bibliography: ["references/library.bib"] }),
      getNumbering: () => ({ equations: "document" }),
      isReadOnly: () => false,
      canEditBibliography: () => true,
      listAssets: async () => [{
        path: "references/library.bib",
        mimeType: "application/x-bibtex",
        size: source.length,
        sha: "sha-old",
      }],
      readAsset: async () => ({
        asset: {
          path: "references/library.bib",
          mimeType: "application/x-bibtex",
          size: source.length,
          sha: "sha-old",
        },
        bytes: new TextEncoder().encode(source),
      }),
      writeAsset,
    });
    tools.openBibliography();
    await vi.waitFor(() => expect(document.querySelector(".bibliography-entry-card")).not.toBeNull());
    document.querySelector<HTMLButtonElement>(".bibliography-entry-card")!.click();
    document.querySelector<HTMLInputElement>("[aria-label='Title']")!.value = "Trade and Spatial Topography";
    click("Save bibliography");
    await vi.waitFor(() => expect(writeAsset).toHaveBeenCalledTimes(1));
    const input = writeAsset.mock.calls[0][0];
    const written = new TextDecoder().decode(input.bytes);
    expect(input.ifMatch).toBe("sha-old");
    expect(written).toContain("% Curator note");
    expect(written).toContain("@string{qje = \"The Quarterly Journal of Economics\"}");
    expect(written).toContain("note = {Keep this field}");
    expect(written).toContain("title = {Trade and Spatial Topography}");
  });

  it("blocks deletion while a project citation still uses the key", async () => {
    const source = "@article{smith2024, author={Jane Smith}, title={Paper}, year={2024}}\n";
    const view = viewFor("# Note\n");
    const writeAsset = vi.fn();
    const trigger = launcher();
    const tools = new ScholarlyTools(trigger, view, {
      getPublication: () => ({ ...defaultPublication(), bibliography: ["references/library.bib"] }),
      getNumbering: () => ({ equations: "document" }),
      isReadOnly: () => false,
      canEditBibliography: () => true,
      citationUsages: async () => [{
        key: "smith2024",
        documentId: "note",
        documentTitle: "Note",
        documentPath: "note.md",
        occurrences: 1,
      }],
      listAssets: async () => [{
        path: "references/library.bib",
        mimeType: "application/x-bibtex",
        size: source.length,
        sha: "sha-old",
      }],
      readAsset: async () => ({
        asset: {
          path: "references/library.bib",
          mimeType: "application/x-bibtex",
          size: source.length,
          sha: "sha-old",
        },
        bytes: new TextEncoder().encode(source),
      }),
      writeAsset,
    });
    tools.openBibliography();
    await vi.waitFor(() => expect(document.querySelector(".bibliography-entry-card")).not.toBeNull());
    document.querySelector<HTMLButtonElement>(".bibliography-entry-card")!.click();
    const remove = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Delete entry")!;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toContain("Deletion is blocked");
    remove.click();
    expect(writeAsset).not.toHaveBeenCalled();
  });

  it("lets shared readers browse but not mutate a project bibliography", async () => {
    const source = "@article{smith2024, author={Jane Smith}, title={Paper}, year={2024}}\n";
    const view = viewFor("# Shared note\n");
    const writeAsset = vi.fn();
    const trigger = launcher();
    const tools = new ScholarlyTools(trigger, view, {
      getPublication: () => ({ ...defaultPublication(), bibliography: ["references/library.bib"] }),
      getNumbering: () => ({ equations: "document" }),
      isReadOnly: () => true,
      canEditBibliography: () => false,
      listAssets: async () => [{
        path: "references/library.bib",
        mimeType: "application/x-bibtex",
        size: source.length,
        sha: "sha-old",
      }],
      readAsset: async () => ({
        asset: {
          path: "references/library.bib",
          mimeType: "application/x-bibtex",
          size: source.length,
          sha: "sha-old",
        },
        bytes: new TextEncoder().encode(source),
      }),
      writeAsset,
    });
    tools.openBibliography();
    await vi.waitFor(() => expect(document.querySelector(".bibliography-entry-card")).not.toBeNull());
    document.querySelector<HTMLButtonElement>(".bibliography-entry-card")!.click();
    expect(document.querySelector<HTMLButtonElement>("button[type='submit']")).toBeNull();
    const save = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Save bibliography")!;
    expect(save.disabled).toBe(true);
    save.click();
    expect(writeAsset).not.toHaveBeenCalled();
  });
});
