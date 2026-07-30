import { Schema } from "prosemirror-model";
import type { NodeSpec, MarkSpec } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";
import { isSafeLinkHref } from "../markdown/links";

// The document grammar. This is the "lightweight LyX" contract: math is
// represented as semantic atom nodes carrying their LaTeX body, never as
// plain text that has to be re-tokenized on every keystroke.

const nodes: Record<string, NodeSpec> = {
  doc: {
    content: "block+",
  },

  paragraph: {
    group: "block",
    content: "inline*",
    parseDOM: [{ tag: "p" }],
    toDOM() {
      return ["p", 0];
    },
  },

  heading: {
    group: "block",
    content: "inline*",
    attrs: {
      level: { default: 1 },
      id: { default: null },
    },
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
      tag: `h${level}`,
      getAttrs: (dom: HTMLElement) => ({
        level,
        id: dom.getAttribute("id") || null,
      }),
    })),
    toDOM(node) {
      const attrs: Record<string, string> = {};
      if (node.attrs.id) attrs.id = node.attrs.id as string;
      return [`h${node.attrs.level}`, attrs, 0];
    },
  },

  blockquote: {
    group: "block",
    content: "block+",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM() {
      return ["blockquote", 0];
    },
  },

  code_block: {
    group: "block",
    content: "text*",
    marks: "",
    code: true,
    defining: true,
    attrs: { language: { default: null } },
    parseDOM: [
      {
        tag: "pre",
        preserveWhitespace: "full",
        getAttrs: (dom: HTMLElement) => ({
          language: dom.getAttribute("data-language") || null,
        }),
      },
    ],
    toDOM(node) {
      const attrs = node.attrs.language
        ? { "data-language": node.attrs.language as string }
        : {};
      return ["pre", attrs, ["code", 0]];
    },
  },

  bullet_list: {
    group: "block",
    content: "list_item+",
    parseDOM: [{ tag: "ul" }],
    toDOM() {
      return ["ul", 0];
    },
  },

  ordered_list: {
    group: "block",
    content: "list_item+",
    attrs: { start: { default: 1 } },
    parseDOM: [
      {
        tag: "ol",
        getAttrs: (dom: HTMLElement) => ({
          start: dom.hasAttribute("start")
            ? Number(dom.getAttribute("start"))
            : 1,
        }),
      },
    ],
    toDOM(node) {
      return node.attrs.start === 1
        ? ["ol", 0]
        : ["ol", { start: node.attrs.start as number }, 0];
    },
  },

  list_item: {
    content: "paragraph block*",
    defining: true,
    parseDOM: [{ tag: "li" }],
    toDOM() {
      return ["li", 0];
    },
  },

  // --- Math ---------------------------------------------------------------
  // Inline math: an atom whose only state is its LaTeX body.
  math_inline: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { latex: { default: "" } },
    // Serialize LaTeX into the DOM so copy/paste yields Markdown-compatible
    // text; the NodeView owns the actual rendering.
    parseDOM: [
      {
        tag: "span[data-math-inline]",
        getAttrs: (dom: HTMLElement) => ({
          latex: dom.getAttribute("data-latex") || dom.textContent || "",
        }),
      },
    ],
    toDOM(node) {
      return [
        "span",
        { "data-math-inline": "", "data-latex": node.attrs.latex as string },
        `$${node.attrs.latex}$`,
      ];
    },
  },

  // Display math: a block atom carrying TeX-document semantics as attributes.
  math_display: {
    group: "block",
    atom: true,
    attrs: {
      latex: { default: "" },
      label: { default: null },
      numbered: { default: true },
      env: { default: "equation" }, // equation | align | gather | multline | none
      tag: { default: null },
    },
    parseDOM: [
      {
        tag: "div[data-math-display]",
        getAttrs: (dom: HTMLElement) => ({
          latex: dom.getAttribute("data-latex") || dom.textContent || "",
          label: dom.getAttribute("data-label") || null,
          numbered: dom.getAttribute("data-numbered") !== "false",
          env: dom.getAttribute("data-env") || "equation",
          tag: dom.getAttribute("data-tag") || null,
        }),
      },
    ],
    toDOM(node) {
      return [
        "div",
        {
          "data-math-display": "",
          "data-latex": node.attrs.latex as string,
          "data-label": (node.attrs.label as string) ?? "",
          "data-numbered": String(node.attrs.numbered),
          "data-env": node.attrs.env as string,
          // parseDOM reads data-tag; omitting it here silently dropped a manual
          // `tag=` on every copy/paste (clipboard re-parses this DOM).
          "data-tag": (node.attrs.tag as string) ?? "",
        },
        `$$${node.attrs.latex}$$`,
      ];
    },
  },

  // Cross-reference to a labeled target (equation, section, ...).
  xref: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: {
      target: { default: "" },
      kind: { default: "generic" }, // eq | sec | fig | tbl | theorem prefix | generic
    },
    parseDOM: [
      {
        tag: "a[data-xref]",
        getAttrs: (dom: HTMLElement) => ({
          target: dom.getAttribute("data-target") || "",
          kind: dom.getAttribute("data-kind") || "generic",
        }),
      },
    ],
    toDOM(node) {
      return [
        "a",
        {
          "data-xref": "",
          "data-target": node.attrs.target as string,
          "data-kind": node.attrs.kind as string,
        },
        `@${node.attrs.target}`,
      ];
    },
  },

  // Link to another document in the active Mathdown library. The target is the
  // document's stable frontmatter id rather than its path, so reorganising a
  // library never invalidates an existing link.
  doc_link: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: {
      target: { default: "" },
      anchor: { default: null },
      label: { default: null },
      source: { default: null },
    },
    parseDOM: [
      {
        tag: "span[data-doc-link]",
        getAttrs: (dom: HTMLElement) => ({
          target: dom.getAttribute("data-target") || "",
          anchor: dom.getAttribute("data-anchor") || null,
          label: dom.getAttribute("data-label") || null,
          source: dom.getAttribute("data-source") || null,
        }),
      },
    ],
    toDOM(node) {
      const target = node.attrs.target as string;
      const anchor = node.attrs.anchor as string | null;
      const label = (node.attrs.label as string | null) || target;
      const destination = anchor ? `${target}#${anchor}` : target;
      return [
        "span",
        {
          class: "doc-link",
          "data-doc-link": "",
          "data-target": target,
          "data-anchor": anchor ?? "",
          "data-label": (node.attrs.label as string | null) ?? "",
          "data-source": (node.attrs.source as string | null) ?? "",
          role: "link",
          "aria-label": `${label}, internal document link to ${destination}`,
          title: `Double-click, Cmd/Ctrl-click, or select and press Enter to open ${destination}`,
        },
        label,
      ];
    },
  },

  citation: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { source: { default: "" } },
    parseDOM: [
      {
        tag: "span[data-citation]",
        getAttrs: (dom: HTMLElement) => ({ source: dom.getAttribute("data-citation") || "" }),
      },
    ],
    toDOM(node) {
      const source = node.attrs.source as string;
      return ["span", { class: "citation", "data-citation": source }, `[${source}]`];
    },
  },

  footnote_ref: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { label: { default: "" } },
    // Without a parseDOM rule the clipboard (which re-parses toDOM output on
    // every paste) degraded the ref to literal text.
    parseDOM: [
      {
        tag: "sup[data-footnote-ref]",
        getAttrs: (dom: HTMLElement) => ({
          label: dom.getAttribute("data-footnote-ref") || "",
        }),
      },
    ],
    toDOM(node) {
      const label = node.attrs.label as string;
      return ["sup", { class: "footnote-ref", "data-footnote-ref": label }, `[${label}]`];
    },
  },

  text: {
    group: "inline",
  },

  hard_break: {
    group: "inline",
    inline: true,
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM() {
      return ["br"];
    },
  },

  // A source line-wrap inside a paragraph (a single "\n"). Rendered as a space so
  // the editor keeps flowing text, but kept as a real node so hand-wrapping
  // survives editing and round-trips to the same "\n" on save (#I02).
  soft_break: {
    group: "inline",
    inline: true,
    selectable: false,
    // A soft line-wrap reads as a space in flowed text, so `textContent` (and
    // anything counting characters) sees a space where the wrap was.
    leafText: () => " ",
    parseDOM: [{ tag: "span.soft-break" }],
    toDOM() {
      return ["span", { class: "soft-break" }, " "];
    },
  },

  // Source-only Mathdown directives such as
  // `<!-- mathdown-claim:R-EXAMPLE -->`. They are part of the scholarly audit
  // contract and must survive editing, but they are navigation anchors rather
  // than document prose. A zero-size block keeps a real scroll target at the
  // authored position without exposing the implementation marker to readers.
  mathdown_source_marker: {
    group: "block",
    atom: true,
    selectable: false,
    attrs: { directive: { default: "" } },
    parseDOM: [
      {
        tag: "div[data-mathdown-source-marker]",
        getAttrs: (dom: HTMLElement) => ({
          directive: dom.getAttribute("data-mathdown-source-marker") || "",
        }),
      },
    ],
    toDOM(node) {
      const directive = node.attrs.directive as string;
      return [
        "div",
        {
          id: directive,
          class: "mathdown-source-marker",
          "data-mathdown-source-marker": directive,
          "aria-hidden": "true",
          contenteditable: "false",
        },
      ];
    },
  },

  // Ordinary Markdown HTML comments are source annotations, not reader-facing
  // prose. Keep their exact source in the document model so save remains
  // lossless, while rendering a zero-size node in the editor. Mathdown's typed
  // markers keep their dedicated addressable node above.
  html_comment: {
    group: "block",
    atom: true,
    selectable: false,
    attrs: { source: { default: "<!-- -->" } },
    parseDOM: [
      {
        tag: "div[data-html-comment]",
        getAttrs: (dom: HTMLElement) => ({
          source: dom.getAttribute("data-html-comment") || "<!-- -->",
        }),
      },
    ],
    toDOM(node) {
      return [
        "div",
        {
          class: "html-comment-source",
          "data-html-comment": node.attrs.source as string,
          "aria-hidden": "true",
          contenteditable: "false",
          hidden: "hidden",
        },
      ];
    },
  },

  // GitHub-flavoured Markdown commonly uses a small raw-HTML disclosure for
  // long ledgers and appendices. Model the supported, bounded form
  // semantically so its tags never leak into the reader view, while retaining
  // the exact authored wrapper for lossless Markdown saves.
  details_disclosure: {
    group: "block",
    content: "block+",
    defining: true,
    attrs: {
      summary: { default: "Details" },
      openSource: { default: "<details>" },
      summarySource: { default: "<summary>Details</summary>" },
      closeSource: { default: "</details>" },
      initiallyOpen: { default: false },
    },
    parseDOM: [
      {
        tag: "details[data-markdown-details]",
        getAttrs: (dom: HTMLElement) => ({
          summary:
            dom.querySelector(":scope > summary")?.textContent?.trim() || "Details",
          openSource:
            dom.getAttribute("data-details-open-source") || "<details>",
          summarySource:
            dom.getAttribute("data-details-summary-source")
            || `<summary>${dom.querySelector(":scope > summary")?.textContent?.trim() || "Details"}</summary>`,
          closeSource:
            dom.getAttribute("data-details-close-source") || "</details>",
          initiallyOpen:
            dom.getAttribute("data-details-initially-open") === "true",
        }),
        contentElement: (dom) =>
          (dom as HTMLElement).querySelector(":scope > .markdown-details-body")
          ?? (dom as HTMLElement),
      },
    ],
    toDOM(node) {
      const initiallyOpen = node.attrs.initiallyOpen as boolean;
      const attrs: Record<string, string> = {
        class: "markdown-details",
        "data-markdown-details": "",
        "data-details-open-source": node.attrs.openSource as string,
        "data-details-summary-source": node.attrs.summarySource as string,
        "data-details-close-source": node.attrs.closeSource as string,
        "data-details-initially-open": String(initiallyOpen),
      };
      if (initiallyOpen) attrs.open = "";
      return [
        "details",
        attrs,
        ["summary", { contenteditable: "false" }, node.attrs.summary as string],
        ["div", { class: "markdown-details-body" }, 0],
      ];
    },
  },

  horizontal_rule: {
    group: "block",
    parseDOM: [{ tag: "hr" }],
    toDOM() {
      return ["hr"];
    },
  },

  figure: {
    group: "block",
    atom: true,
    attrs: {
      src: { default: "" },
      alt: { default: "" },
      caption: { default: "" },
      id: { default: null },
      width: { default: null },
    },
    toDOM(node) {
      const attrs = node.attrs as Record<string, string | null>;
      const source = attrs.src ?? "";
      const imageAttrs: Record<string, string> = {
        alt: attrs.alt ?? "",
        "data-asset-src": source,
      };
      // A schema DOM serializer has no provider context. Never assign `src`
      // here: the FigureView resolves same-library bytes through the active
      // GitHub/folder provider and external URLs remain source-only.
      const image: [string, Record<string, string>] = ["img", imageAttrs];
      if (attrs.width && /^\d+(?:\.\d+)?(?:%|px|rem|em|cm|mm|in|pt)$/.test(attrs.width)) {
        image[1].style = `max-width: ${attrs.width}`;
      }
      const children: unknown[] = ["figure", {
        class: "document-figure",
        id: attrs.id ?? "",
        "data-figure-id": attrs.id ?? "",
        // Widths such as `0.7\\linewidth` are meaningful source attributes but
        // invalid CSS. Keep the authored value independently of the preview.
        "data-width": attrs.width ?? "",
      }, image];
      if (attrs.caption) children.push(["figcaption", attrs.caption]);
      return children as never;
    },
    // Clipboard copies re-parse the toDOM output; without this rule a cut+paste
    // destroyed the figure. Attributes are recovered from the emitted markup.
    parseDOM: [
      {
        tag: "figure.document-figure",
        getAttrs: (dom: HTMLElement) => {
          const img = dom.querySelector("img");
          const width = /max-width:\s*([^;]+)/.exec(img?.getAttribute("style") ?? "");
          return {
            src: img?.getAttribute("data-asset-src") ?? "",
            alt: img?.getAttribute("alt") ?? "",
            caption: dom.querySelector("figcaption")?.textContent ?? "",
            id: dom.getAttribute("data-figure-id") || dom.id || null,
            width: dom.getAttribute("data-width") || (width ? width[1].trim() : null),
          };
        },
      },
    ],
  },

  footnote_definition: {
    group: "block",
    content: "block+",
    defining: true,
    attrs: { label: { default: "" } },
    parseDOM: [
      {
        tag: "aside[data-footnote-definition]",
        getAttrs: (dom: HTMLElement) => ({
          label: dom.getAttribute("data-footnote-definition") || "",
        }),
        // Content lives in the inner div; the label span is presentation only.
        // Function form: a selector string makes prosemirror-model crash with a
        // TypeError when crafted/external HTML has an aside WITHOUT the div.
        contentElement: (dom) => (dom as HTMLElement).querySelector(":scope > div") ?? (dom as HTMLElement),
      },
    ],
    toDOM(node) {
      return [
        "aside",
        { class: "footnote-definition", "data-footnote-definition": node.attrs.label as string },
        ["span", { class: "footnote-definition-label", contenteditable: "false" }, `[^${node.attrs.label}]`],
        ["div", 0],
      ];
    },
  },

  raw_latex: {
    group: "block",
    atom: true,
    attrs: { latex: { default: "" } },
    // Must outrank code_block's generic `pre` rule (default priority 50), or a
    // pasted raw-LaTeX block came back as a code block.
    parseDOM: [
      {
        tag: "pre[data-raw-latex]",
        priority: 60,
        getAttrs: (dom: HTMLElement) => ({ latex: dom.textContent ?? "" }),
      },
    ],
    toDOM(node) {
      return [
        "pre",
        { class: "raw-latex", "data-raw-latex": "" },
        ["code", node.attrs.latex as string],
      ];
    },
  },

  // A theorem-like environment (theorem / lemma / definition / proof / …). Fenced
  // in Markdown as `::: kind {title} #label … :::`; exported to amsthm on the TeX
  // side. Holds block content so it can contain prose, math, lists, etc. (#I23)
  theorem: {
    group: "block",
    content: "block+",
    defining: true,
    attrs: {
      kind: { default: "theorem" },
      title: { default: null },
      id: { default: null },
      // Preserve authored Pandoc fence widths so a no-op edit stays byte-stable.
      // The serializer widens an outer fence only when nested theorem blocks
      // require it.
      fenceLength: { default: null },
      closingFenceLength: { default: null },
    },
    parseDOM: [
      {
        tag: "div[data-theorem]",
        getAttrs: (dom: HTMLElement) => ({
          kind: dom.getAttribute("data-theorem") || "theorem",
          title: dom.getAttribute("data-title") || null,
          id: dom.getAttribute("id") || null,
          fenceLength: parseTheoremFenceAttribute(
            dom.getAttribute("data-theorem-fence"),
          ),
          closingFenceLength: parseTheoremFenceAttribute(
            dom.getAttribute("data-theorem-close-fence"),
          ),
        }),
      },
    ],
    toDOM(node) {
      const attrs: Record<string, string> = {
        "data-theorem": node.attrs.kind as string,
        class: `theorem theorem-${node.attrs.kind as string}`,
      };
      if (node.attrs.title) attrs["data-title"] = node.attrs.title as string;
      if (node.attrs.id) attrs.id = node.attrs.id as string;
      if (node.attrs.fenceLength) {
        attrs["data-theorem-fence"] = String(node.attrs.fenceLength);
      }
      if (node.attrs.closingFenceLength) {
        attrs["data-theorem-close-fence"] = String(
          node.attrs.closingFenceLength,
        );
      }
      // The kind/title label is rendered by a CSS ::before + a data-label attr so
      // it isn't part of the editable content.
      const label =
        (node.attrs.kind as string).charAt(0).toUpperCase() +
        (node.attrs.kind as string).slice(1) +
        (node.attrs.title ? ` (${node.attrs.title as string})` : "");
      return ["div", { ...attrs, "data-label": label }, 0];
    },
  },
};

function parseTheoremFenceAttribute(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 3 ? parsed : null;
}

// prosemirror-tables node specs. Cells hold block content so an equation (a
// paragraph containing math_inline / math_display) can live inside a cell.
const tableSpecs = tableNodes({
  tableGroup: "block",
  cellContent: "block+",
  // Per-column alignment from the GFM delimiter row (`:---`, `---:`, `:---:`), so
  // it round-trips instead of normalizing to `---` (#I15). Rendered as text-align
  // on the cell; null = default (left).
  cellAttributes: {
    align: {
      default: null,
      getFromDOM(dom) {
        return (dom as HTMLElement).style.textAlign || null;
      },
      setDOMAttr(value, attrs) {
        if (value) attrs.style = `${(attrs.style as string) ?? ""}text-align: ${value as string};`;
      },
    },
  },
});

// A table's rows remain ordinary prosemirror-tables content. Caption and label
// are attributes so they can round-trip through the compact Markdown wrapper
// without becoming an editable fake row.
tableSpecs.table = {
  ...tableSpecs.table,
  attrs: {
    ...(tableSpecs.table.attrs ?? {}),
    caption: { default: null },
    id: { default: null },
  },
  parseDOM: [{
    tag: "table",
    getAttrs: (dom) => ({
      caption: (dom as HTMLElement).getAttribute("data-caption") || null,
      id: (dom as HTMLElement).getAttribute("data-table-id") || (dom as HTMLElement).id || null,
    }),
  }],
  toDOM(node) {
    const attrs: Record<string, string> = {};
    if (node.attrs.caption) attrs["data-caption"] = node.attrs.caption as string;
    if (node.attrs.id) {
      attrs.id = node.attrs.id as string;
      attrs["data-table-id"] = node.attrs.id as string;
    }
    const body: unknown[] = ["tbody", 0];
    return node.attrs.caption
      ? ["table", attrs, ["caption", node.attrs.caption as string], body]
      : ["table", attrs, body];
  },
};

const marks: Record<string, MarkSpec> = {
  em: {
    parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }],
    toDOM() {
      return ["em", 0];
    },
  },
  strong: {
    parseDOM: [
      { tag: "strong" },
      { tag: "b" },
      { style: "font-weight", getAttrs: (v) => /^(bold|[5-9]\d{2})$/.test(v as string) && null },
    ],
    toDOM() {
      return ["strong", 0];
    },
  },
  code: {
    parseDOM: [{ tag: "code" }],
    toDOM() {
      return ["code", 0];
    },
  },
  link: {
    attrs: { href: {}, title: { default: null } },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (dom: HTMLElement) => {
          const href = dom.getAttribute("href");
          return isSafeLinkHref(href)
            ? { href, title: dom.getAttribute("title") }
            : false;
        },
      },
    ],
    toDOM(mark) {
      // Defense in depth for documents created through a non-Markdown path.
      return isSafeLinkHref(mark.attrs.href)
        ? [
            "a",
            {
              ...mark.attrs,
              "aria-description":
                "Double-click or Cmd/Ctrl-click to open while editing; click to open in read-only documents",
            },
            0,
          ]
        : ["span", 0];
    },
  },

  // A review comment anchor. Carries only an id; the comment body/author/state
  // lives in the comments plugin store (styling is applied via decorations).
  // Not emitted into the Markdown body — comments persist in frontmatter.
  comment: {
    attrs: { id: {} },
    inclusive: false,
    excludes: "", // comments may overlap other comments
    parseDOM: [
      {
        tag: "span[data-comment-id]",
        getAttrs: (dom: HTMLElement) => ({
          id: dom.getAttribute("data-comment-id"),
        }),
      },
    ],
    toDOM(mark) {
      return ["span", { "data-comment-id": mark.attrs.id as string }, 0];
    },
  },
};

export const schema = new Schema({
  nodes: { ...nodes, ...tableSpecs },
  marks,
});

export type EditorSchema = typeof schema;
