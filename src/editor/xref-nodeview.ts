import type { Node as PMNode } from "prosemirror-model";
import type { Decoration, NodeView } from "prosemirror-view";

// Renders a cross-reference using the number resolved by the numbering plugin
// (delivered via decoration spec). Falls back to the raw `@target` before the
// first numbering pass, and flags broken references.
export class XRefView implements NodeView {
  dom: HTMLElement;
  private decorations: readonly Decoration[];

  constructor(node: PMNode, decorations: readonly Decoration[]) {
    this.dom = document.createElement("span");
    this.dom.className = "xref";
    this.dom.dataset.xrefTarget = String(node.attrs.target ?? "");
    this.dom.setAttribute("role", "link");
    this.decorations = decorations;
    this.render(node);
  }

  private render(node: PMNode) {
    let text = `@${node.attrs.target}`;
    let broken = false;
    for (const d of this.decorations) {
      const spec = d.spec as { refText?: string; broken?: boolean };
      if (spec.refText != null) {
        text = spec.refText;
        broken = !!spec.broken;
      }
    }
    this.dom.textContent = text;
    this.dom.dataset.xrefTarget = String(node.attrs.target ?? "");
    this.dom.classList.toggle("xref-broken", broken);
    this.dom.setAttribute(
      "aria-label",
      `${text}, reference to ${node.attrs.target}${broken ? ", unresolved" : ""}`,
    );
    this.dom.title = broken
      ? `Reference target ${node.attrs.target} is unresolved`
      : `Double-click, Cmd/Ctrl-click, or select and press Enter to open ${node.attrs.target}`;
  }

  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (node.type.name !== "xref") return false;
    this.decorations = decorations;
    this.render(node);
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
}
