import type { Node as PMNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";

export interface FigureAssetResult {
  bytes: Uint8Array;
  mimeType: string;
}

export type FigureAssetReader = (path: string) => Promise<FigureAssetResult | null>;

type FigureDom = HTMLElement & { __figureView?: FigureView };

export function isLibraryFigurePath(path: string): boolean {
  return Boolean(path)
    && !path.startsWith("/")
    && !path.startsWith("//")
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
    && !path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."));
}

export class FigureView implements NodeView {
  readonly dom: FigureDom;
  private generation = 0;
  private objectUrl: string | null = null;
  private node: PMNode;

  constructor(node: PMNode, private readonly readAsset: FigureAssetReader) {
    this.node = node;
    this.dom = document.createElement("figure");
    this.dom.className = "document-figure";
    this.dom.contentEditable = "false";
    this.dom.__figureView = this;
    this.render();
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "figure") return false;
    if (node.eq(this.node)) return true;
    this.node = node;
    this.render();
    return true;
  }

  refresh(): void {
    this.render();
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.generation++;
    this.revokeObjectUrl();
    delete this.dom.__figureView;
  }

  private render(): void {
    const generation = ++this.generation;
    this.revokeObjectUrl();
    this.dom.replaceChildren();
    const source = String(this.node.attrs.src ?? "");
    const caption = String(this.node.attrs.caption ?? "");
    const label = String(this.node.attrs.id ?? "");
    const width = String(this.node.attrs.width ?? "");
    this.dom.id = label;
    this.dom.dataset.assetSrc = source;
    this.dom.dataset.figureId = label;
    this.dom.dataset.width = width;

    const placeholder = document.createElement("div");
    placeholder.className = "figure-asset-placeholder";
    placeholder.textContent = !source
      ? "Figure source is missing"
      : isLibraryFigurePath(source)
        ? `Loading ${source}…`
        : `External figure source: ${source}`;
    this.dom.append(placeholder);
    if (caption) {
      const figcaption = document.createElement("figcaption");
      figcaption.textContent = caption;
      this.dom.append(figcaption);
    }
    if (!isLibraryFigurePath(source)) return;

    void this.readAsset(source).then((asset) => {
      if (generation !== this.generation) return;
      if (!asset) {
        placeholder.textContent = `Open the containing library to preview ${source}`;
        return;
      }
      if (!asset.mimeType.startsWith("image/")) {
        placeholder.textContent = asset.mimeType === "application/pdf"
          ? `PDF figure: ${source}`
          : `Figure asset: ${source}`;
        return;
      }
      const blobBytes = Uint8Array.from(asset.bytes);
      const blob = new Blob([blobBytes.buffer as ArrayBuffer], { type: asset.mimeType });
      this.objectUrl = URL.createObjectURL(blob);
      const image = document.createElement("img");
      image.alt = String(this.node.attrs.alt ?? "");
      image.dataset.assetSrc = source;
      image.src = this.objectUrl;
      if (width && /^\d+(?:\.\d+)?(?:%|px|rem|em|cm|mm|in|pt)$/.test(width)) {
        image.style.maxWidth = width;
      }
      placeholder.replaceWith(image);
    }).catch((error: unknown) => {
      if (generation !== this.generation) return;
      placeholder.textContent = error instanceof Error
        ? `Could not preview ${source}: ${error.message}`
        : `Could not preview ${source}`;
    });
  }

  private revokeObjectUrl(): void {
    if (!this.objectUrl) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}
