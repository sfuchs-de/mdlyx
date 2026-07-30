import type { Node as PMNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import type { CitationStyle } from "../markdown/frontmatter";
import {
  formatCitationCluster,
  type CitationCatalogSnapshot,
} from "../publication/citation-catalog";

export type CitationCatalogProvider = () => {
  snapshot: CitationCatalogSnapshot | null;
  style: CitationStyle;
};

/**
 * Live publication rendering for an atomic citation node. The ProseMirror node
 * stores only exact Pandoc source; catalog/style changes refresh this DOM view
 * and therefore never dirty or reserialize the document.
 */
export class CitationView implements NodeView {
  readonly dom: HTMLElement;
  private node: PMNode;

  constructor(
    node: PMNode,
    private readonly getCatalog: CitationCatalogProvider,
    private readonly onDestroy?: (view: CitationView) => void,
  ) {
    this.node = node;
    this.dom = document.createElement("span");
    this.dom.className = "citation";
    this.render();
  }

  refresh(): void {
    this.render();
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "citation") return false;
    this.node = node;
    this.render();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.onDestroy?.(this);
  }

  private render(): void {
    const source = String(this.node.attrs.source ?? "");
    const { snapshot, style } = this.getCatalog();
    const formatted = snapshot
      ? formatCitationCluster(source, snapshot, style)
      : {
          text: `[${source}]`,
          missingKeys: [] as string[],
          ariaLabel: `[${source}]. Bibliography is loading`,
        };
    this.dom.textContent = formatted.text;
    this.dom.dataset.citation = source;
    this.dom.dataset.citationStyle = style;
    this.dom.classList.toggle("citation-missing", formatted.missingKeys.length > 0);
    this.dom.setAttribute("role", "doc-biblioref");
    this.dom.setAttribute("aria-label", formatted.ariaLabel);
    this.dom.title = formatted.missingKeys.length
      ? `Unresolved citation: ${formatted.missingKeys.join(", ")}`
      : `Pandoc source: [${source}]`;
  }
}
