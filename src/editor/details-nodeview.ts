import type { Node as PMNode } from "prosemirror-model";
import type { ViewMutationRecord } from "prosemirror-view";

export class DetailsView {
  readonly dom: HTMLDetailsElement;
  readonly contentDOM: HTMLDivElement;
  private readonly summary: HTMLElement;
  private node: PMNode;

  constructor(node: PMNode) {
    this.node = node;
    this.dom = document.createElement("details");
    this.dom.className = "markdown-details";
    this.dom.dataset.markdownDetails = "";

    this.summary = document.createElement("summary");
    this.summary.contentEditable = "false";
    this.summary.addEventListener("click", this.toggle);

    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "markdown-details-body";
    this.dom.append(this.summary, this.contentDOM);
    this.renderAttributes(true);
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const initialStateChanged =
      node.attrs.initiallyOpen !== this.node.attrs.initiallyOpen;
    this.node = node;
    this.renderAttributes(initialStateChanged);
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.summary.contains(event.target);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    // Expanding a disclosure is ephemeral view state. ProseMirror must not
    // interpret the native `open` attribute mutation as document content.
    return (
      mutation.type === "attributes"
      && mutation.target === this.dom
      && mutation.attributeName === "open"
    );
  }

  destroy(): void {
    this.summary.removeEventListener("click", this.toggle);
  }

  private readonly toggle = (event: MouseEvent): void => {
    event.preventDefault();
    this.dom.open = !this.dom.open;
  };

  private renderAttributes(resetOpen: boolean): void {
    const attrs = this.node.attrs;
    this.dom.dataset.detailsOpenSource = attrs.openSource as string;
    this.dom.dataset.detailsSummarySource = attrs.summarySource as string;
    this.dom.dataset.detailsCloseSource = attrs.closeSource as string;
    this.dom.dataset.detailsInitiallyOpen = String(attrs.initiallyOpen as boolean);
    this.summary.textContent = attrs.summary as string;
    if (resetOpen) this.dom.open = attrs.initiallyOpen as boolean;
  }
}
