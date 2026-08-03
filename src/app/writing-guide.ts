import { AnchoredPanelController } from "./anchored-panel";

export interface WritingGuideItem {
  title: string;
  description: string;
  syntax?: string;
  shortcut?: string;
  keywords?: readonly string[];
}

export interface WritingGuideSection {
  id: string;
  title: string;
  items: readonly WritingGuideItem[];
}

export const WRITING_GUIDE_SECTIONS: readonly WritingGuideSection[] = [
  {
    id: "markdown",
    title: "Markdown essentials",
    items: [
      {
        title: "Headings and stable anchors",
        syntax: "## Section title {#sec:results}",
        description: "Use one to six # characters. An optional stable ID makes the section linkable.",
        keywords: ["outline", "section", "label"],
      },
      {
        title: "Emphasis and inline code",
        syntax: "**strong** · *emphasis* · `code`",
        description: "Formatting remains ordinary, readable Markdown.",
        shortcut: "⌘/Ctrl-B · ⌘/Ctrl-I · ⌘/Ctrl-`",
        keywords: ["bold", "italic", "monospace"],
      },
      {
        title: "Lists and quotations",
        syntax: "- item\n1. numbered item\n> quoted text",
        description: "Start a line with -, a number and period, or >.",
        keywords: ["bullet", "ordered list", "blockquote"],
      },
      {
        title: "Tables",
        syntax: "| Object | Meaning |\n| --- | --- |\n| $x$ | Quantity |",
        description: "Use a GFM pipe table. Tab and Shift-Tab move between cells in the editor.",
        keywords: ["rows", "columns", "tabular"],
      },
      {
        title: "Line breaks inside tables",
        syntax: "first line<br>second line",
        description: "Use <br> where a physical newline would end the Markdown table row.",
        keywords: ["break", "multiline cell"],
      },
    ],
  },
  {
    id: "math",
    title: "Mathematics and numbering",
    items: [
      {
        title: "Inline mathematics",
        syntax: "$x^2 + y^2$",
        description: "Click or arrow into the rendered equation to edit it in place.",
        shortcut: "⌘/Ctrl-M",
        keywords: ["latex", "formula"],
      },
      {
        title: "Display mathematics",
        syntax: "$$\nF(x)=\\int_0^x f(t)\\,dt\n$$ {#eq:fundamental}",
        description: "A trailing ID numbers the display and provides a stable reference target.",
        shortcut: "⇧⌘/Ctrl-M",
        keywords: ["equation", "label", "number"],
      },
      {
        title: "Aligned systems",
        syntax: "$$\na &= b + c \\\\\nd &= e + f\n$$ {#eq:system env=align}",
        description: "Use alignment points and env=align for a multi-line system.",
        keywords: ["align", "array", "system"],
      },
      {
        title: "Cross-references",
        syntax: "See @eq:fundamental and @thm:existence.",
        description: "The same @label form works for equations, sections, figures, tables, and theorem-like blocks. References & publication can create a missing target label for you.",
        keywords: ["reference", "xref", "fig", "tbl", "prop", "lemma"],
      },
      {
        title: "Equation editing",
        description: "Click or use arrow keys for structural element editing; double-click opens the full MathLive field. Enter edits a selected equation.",
        keywords: ["mathlive", "cursor", "elements"],
      },
    ],
  },
  {
    id: "links",
    title: "Documents, results, and links",
    items: [
      {
        title: "Stable document link",
        syntax: "[[document-id|Visible label]]",
        description: "Targets the document’s stable frontmatter ID, so moving its file does not break the link. Inside a GFM table, escape the separator as \\|.",
        keywords: ["wiki", "internal"],
      },
      {
        title: "Document anchor link",
        syntax: "[[document-id#sec:results|Results section]]",
        description: "Open a specific heading, equation, theorem, or Mathdown source anchor in another document.",
        keywords: ["wiki", "section", "claim", "derivation"],
      },
      {
        title: "Repository-relative link",
        syntax: "[Appendix](../appendix/proofs.md#thm:existence)",
        description: "Relative .md and .markdown links resolve through the active GitHub or folder library.",
        keywords: ["path", "markdown link"],
      },
      {
        title: "Formal result ID",
        syntax: "R-DEMO-OVERLAP",
        description: "A catalog-known result ID becomes a live link to its declared owner and result anchor.",
        keywords: ["claim", "dependency graph", "owner"],
      },
      {
        title: "Lean certificate evidence",
        syntax: "L · full coverage   L◐ · partial coverage",
        description: "These read-only badges come from a governed, pinned Lean build. Open one to inspect the exact certified scope, assumptions, declarations, and exclusions; it never changes the result’s validation state.",
        keywords: ["lean", "kernel", "certificate", "proof", "formal verification"],
      },
      {
        title: "Open a link while editing",
        description: "Use double-click, Cmd/Ctrl-click, Enter on a selected link, or a second touch. A normal click keeps the caret in editable text.",
        shortcut: "⌘/Ctrl-click",
        keywords: ["navigate", "mobile", "read only"],
      },
    ],
  },
  {
    id: "scholarly",
    title: "Scholarly structures",
    items: [
      {
        title: "Citation",
        syntax: "[@smith2024, p. 12]",
        description: "Pandoc-style citation keys resolve against the project bibliography configured in publication settings.",
        keywords: ["bibtex", "bibliography", "reference"],
      },
      {
        title: "Footnote",
        syntax: "Claim text[^proof].\n\n[^proof]: Supporting detail.",
        description: "A reference and matching definition round-trip to Markdown and TeX.",
        keywords: ["note"],
      },
      {
        title: "Figure",
        syntax: "![Atlantic clock](assets/clock.pdf){#fig:clock width=70%}",
        description: "Use a project asset, caption, stable label, and optional width.",
        keywords: ["image", "caption", "asset"],
      },
      {
        title: "Theorem, proposition, or definition",
        syntax: ":::: theorem {Existence} {#thm:existence}\nA solution exists.\n\n::: proof\nApply the fixed-point theorem.\n:::\n::::",
        description: "Replace theorem with lemma, proposition, corollary, definition, result, or another theorem-like kind. Make an outer fence longer when it contains a nested proof or result.",
        keywords: ["fenced div", "proof", "claim"],
      },
      {
        title: "Proof",
        syntax: "::: proof\nApply the preceding proposition.\n:::",
        description: "Proof blocks use upright body text and export through the LaTeX proof environment.",
        keywords: ["qed", "theorem"],
      },
      {
        title: "Raw LaTeX",
        syntax: "```{=latex}\n\\clearpage\n```",
        description: "Use only for source-preserving publication commands that have no structured Markdown equivalent.",
        keywords: ["tex", "export"],
      },
    ],
  },
  {
    id: "workflows",
    title: "LyX-style workflows",
    items: [
      {
        title: "Outline, restructure, and find",
        description: "Use Outline & find to navigate headings, move complete sections, promote or demote their hierarchy, and search or replace within the active document.",
        keywords: ["structure", "toc", "navigation"],
      },
      {
        title: "References and publication",
        description: "Insert live cross-references, citations, footnotes, figures, theorem/proof blocks, raw LaTeX, and project assets without typing their source syntax.",
        keywords: ["toolbar", "bibliography"],
      },
      {
        title: "Document properties",
        description: "Set the stable document ID, project, tags, relations, equation scope, visible heading numbers, language, and publication profile.",
        keywords: ["frontmatter", "metadata", "class"],
      },
      {
        title: "Comments and review",
        description: "Select text to add an anchored comment. Comments reviews the active document; Comment inbox collects new replies and unresolved threads across the current library after Pull or Refresh.",
        keywords: ["annotation", "coauthor", "track changes"],
      },
      {
        title: "Project overview and dependency graph",
        description: "Open these from the Library to review curated results, tasks, evidence, validation status, and logical dependencies.",
        keywords: ["workspace", "research", "validation"],
      },
      {
        title: "TeX export",
        description: "File → Export TeX produces a standalone scholarly LaTeX document. PDF compilation is not yet available.",
        keywords: ["latex", "publication", "pdf"],
      },
    ],
  },
  {
    id: "shortcuts",
    title: "Keyboard quick reference",
    items: [
      {
        title: "Save, open, and undo",
        description: "Save, open a document, undo, or redo without leaving the editor.",
        shortcut: "⌘/Ctrl-S · ⌘/Ctrl-O · ⌘/Ctrl-Z · ⇧⌘/Ctrl-Z",
        keywords: ["file", "redo"],
      },
      {
        title: "Move through table cells",
        description: "Move to the next or previous table cell.",
        shortcut: "Tab · Shift-Tab",
        keywords: ["table", "cell"],
      },
      {
        title: "Navigate open tabs",
        description: "Use Arrow Left/Right, Home, and End in the tab strip; Delete or Backspace closes the focused tab.",
        shortcut: "← · → · Home · End",
        keywords: ["document", "close"],
      },
      {
        title: "Open this guide",
        description: "Toggle the Writing guide from anywhere in the application.",
        shortcut: "F1",
        keywords: ["help", "cheat sheet"],
      },
    ],
  },
];

export function filterWritingGuideSections(
  query: string,
  sections: readonly WritingGuideSection[] = WRITING_GUIDE_SECTIONS,
): WritingGuideSection[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return sections.map((section) => ({ ...section, items: [...section.items] }));
  const filtered: WritingGuideSection[] = [];
  for (const section of sections) {
    const items = section.items.filter((item) => {
      const haystack = [
        section.title,
        item.title,
        item.description,
        item.syntax ?? "",
        item.shortcut ?? "",
        ...(item.keywords ?? []),
      ].join("\n").toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    if (items.length) filtered.push({ ...section, items });
  }
  return filtered;
}

export class WritingGuide {
  private readonly panel = document.createElement("section");
  private readonly query = document.createElement("input");
  private readonly results = document.createElement("div");
  private readonly status = document.createElement("span");
  private readonly panelController: AnchoredPanelController;

  constructor(private readonly launcher: HTMLButtonElement) {
    this.panel.id = "writing-guide";
    this.panel.hidden = true;
    this.panel.className = "writing-guide";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "Writing guide");

    const header = document.createElement("header");
    header.className = "writing-guide-header";
    const title = document.createElement("h2");
    title.className = "config-title";
    title.textContent = "Writing guide";
    const introduction = document.createElement("p");
    introduction.id = "writing-guide-introduction";
    introduction.textContent = "Markdown source, mathematics, references, and research workflows.";
    header.append(title, introduction);

    this.query.type = "search";
    this.query.className = "writing-guide-search";
    this.query.placeholder = "Find syntax or a feature…";
    this.query.setAttribute("aria-label", "Search the writing guide");
    this.query.setAttribute("aria-describedby", introduction.id);
    this.query.addEventListener("input", () => this.render());

    this.results.className = "writing-guide-results";
    this.status.className = "writing-guide-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.panel.append(header, this.query, this.status, this.results);
    document.body.append(this.panel);

    this.render();
    this.panelController = new AnchoredPanelController(this.launcher, this.panel, {
      initialFocus: () => this.query,
      onOpen: () => this.query.select(),
    });
    window.addEventListener("keydown", this.onGlobalKey, true);
  }

  get isOpen(): boolean {
    return this.panelController.isOpen;
  }

  open(): void {
    this.panelController.open();
  }

  close(): void {
    this.panelController.close();
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onGlobalKey, true);
    this.panelController.destroy();
    this.panel.remove();
  }

  private render(): void {
    const sections = filterWritingGuideSections(this.query.value);
    this.results.replaceChildren();
    const itemCount = sections.reduce((sum, section) => sum + section.items.length, 0);
    this.status.textContent = itemCount
      ? `${itemCount} ${itemCount === 1 ? "topic" : "topics"}`
      : "No matching topics";
    if (!itemCount) {
      const empty = document.createElement("p");
      empty.className = "writing-guide-empty";
      empty.textContent = "Try a broader term such as math, link, theorem, or comment.";
      this.results.append(empty);
      return;
    }

    for (const section of sections) {
      const group = document.createElement("section");
      group.className = "writing-guide-section";
      const heading = document.createElement("h3");
      heading.textContent = section.title;
      group.append(heading);
      for (const item of section.items) group.append(this.renderItem(item));
      this.results.append(group);
    }
  }

  private renderItem(item: WritingGuideItem): HTMLElement {
    const article = document.createElement("article");
    article.className = "writing-guide-item";
    const heading = document.createElement("h4");
    heading.textContent = item.title;
    if (item.shortcut) {
      const shortcut = document.createElement("kbd");
      shortcut.textContent = item.shortcut;
      heading.append(shortcut);
    }
    const description = document.createElement("p");
    description.textContent = item.description;
    article.append(heading, description);
    if (item.syntax) {
      const snippet = document.createElement("div");
      snippet.className = "writing-guide-snippet";
      const code = document.createElement("code");
      code.textContent = item.syntax;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy";
      copy.setAttribute("aria-label", `Copy syntax for ${item.title}`);
      copy.addEventListener("click", () => void this.copy(item));
      snippet.append(code, copy);
      article.append(snippet);
    }
    return article;
  }

  private async copy(item: WritingGuideItem): Promise<void> {
    if (!item.syntax) return;
    try {
      await copyText(item.syntax);
      this.status.textContent = `Copied ${item.title}`;
    } catch {
      this.status.textContent = `Could not copy ${item.title}`;
    }
  }

  private readonly onGlobalKey = (event: KeyboardEvent) => {
    if (event.key !== "F1" || event.defaultPrevented) return;
    event.preventDefault();
    if (this.isOpen) this.close();
    else this.open();
  };
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Sandboxed WebKit/Tauri surfaces can expose the API while denying it.
      // Fall through to the user-gesture-backed DOM copy path.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}
