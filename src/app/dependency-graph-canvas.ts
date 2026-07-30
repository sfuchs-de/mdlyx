import dagre from "@dagrejs/dagre";
import {
  downstreamOf,
  upstreamOf,
  type DependencyCatalog,
  type ResultNode,
  type ValidationState,
} from "./dependency-graph";

export type DependencyGraphCanvasMode = "full" | "compact";

export interface DependencyGraphCanvasOptions {
  project: string;
  catalog: DependencyCatalog;
  /** The exact result subset to lay out, including any desired boundary nodes. */
  results: readonly ResultNode[];
  mode?: DependencyGraphCanvasMode;
  selectedId?: string | null;
  ariaLabel?: string;
  direction?: "LR" | "TB";
  onSelect?: (result: ResultNode) => void;
  onOpen?: (result: ResultNode) => void | Promise<void>;
}

export const DEPENDENCY_STATUS: Readonly<Record<ValidationState, { symbol: string; label: string }>> = {
  validated: { symbol: "✓", label: "validated" },
  partial: { symbol: "◐", label: "partial" },
  unvalidated: { symbol: "○", label: "unvalidated" },
  disputed: { symbol: "×", label: "disputed" },
};

const SVG_NS = "http://www.w3.org/2000/svg";
const FULL_NODE_WIDTH = 232;
const FULL_NODE_HEIGHT = 92;
let canvasSequence = 0;

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Dagre-backed dependency canvas shared by the full graph workspace and compact
 * project summaries. The caller owns filtering and selection state; rebuilding
 * a canvas from new options is intentionally cheap and deterministic.
 */
export class DependencyGraphCanvas {
  readonly element: SVGSVGElement;

  private readonly naturalBox: ViewBox;
  private viewBox: ViewBox;
  private panStart: { clientX: number; clientY: number; box: ViewBox } | null = null;
  private readonly pointers = new Map<number, { clientX: number; clientY: number }>();
  private pinchStart: {
    distance: number;
    centerX: number;
    centerY: number;
    box: ViewBox;
  } | null = null;
  private suppressClick = false;

  constructor(options: DependencyGraphCanvasOptions) {
    const mode = options.mode ?? "full";
    const direction = options.direction ?? "LR";
    const nodeWidth = mode === "compact" ? 196 : FULL_NODE_WIDTH;
    const nodeHeight = mode === "compact" ? 82 : FULL_NODE_HEIGHT;
    const graph = new dagre.graphlib.Graph()
      .setGraph({
        rankdir: direction,
        nodesep: mode === "compact" ? 18 : 24,
        ranksep: mode === "compact" ? 40 : 64,
        marginx: mode === "compact" ? 16 : 32,
        marginy: mode === "compact" ? 16 : 32,
      })
      .setDefaultEdgeLabel(() => ({}));
    const ids = new Set(options.results.map((result) => result.id));
    for (const result of options.results) {
      graph.setNode(result.id, { width: nodeWidth, height: nodeHeight });
    }
    for (const result of options.results) {
      for (const dependency of result.dependsOn) {
        if (ids.has(dependency)) graph.setEdge(dependency, result.id);
      }
    }
    dagre.layout(graph);
    const dimensions = graph.graph() as { width?: number; height?: number };
    const width = Math.max(1, dimensions.width ?? 1);
    const height = Math.max(1, dimensions.height ?? 1);
    this.naturalBox = { x: 0, y: 0, width, height };
    this.viewBox = { ...this.naturalBox };

    const svg = svgEl("svg", `graph-svg graph-svg-${mode}`);
    svg.setAttribute("role", "group");
    svg.setAttribute("aria-label", options.ariaLabel ?? `Dependency graph for ${options.project}`);
    svg.dataset.direction = direction;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    this.element = svg;

    const markerSuffix = mode === "full" ? "" : `-compact-${++canvasSequence}`;
    const arrowId = `graph-arrow${markerSuffix}`;
    const activeArrowId = `graph-arrow-active${markerSuffix}`;
    const defs = svgEl("defs");
    defs.append(
      arrowMarker(arrowId, "#aeb5bc"),
      arrowMarker(activeArrowId, "#425466"),
    );
    svg.append(defs);

    const selectedId = options.selectedId ?? null;
    const focus = selectedId && ids.has(selectedId)
      ? new Set([
          selectedId,
          ...upstreamOf(options.catalog, selectedId),
          ...downstreamOf(options.catalog, selectedId),
        ])
      : null;
    const edgeLayer = svgEl("g", "graph-edges");
    for (const edge of graph.edges()) {
      const layout = graph.edge(edge) as { points?: Array<{ x: number; y: number }> };
      if (!layout.points?.length) continue;
      const path = svgEl("path", "graph-edge");
      path.setAttribute(
        "d",
        layout.points.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" "),
      );
      path.setAttribute("marker-end", `url(#${arrowId})`);
      if (focus?.has(edge.v) && focus.has(edge.w)) {
        path.classList.add("is-focused");
        path.setAttribute("marker-end", `url(#${activeArrowId})`);
      } else if (focus) {
        path.classList.add("is-muted");
      }
      edgeLayer.append(path);
    }
    svg.append(edgeLayer);

    const risk = new Set(options.catalog.diagnostics
      .filter((item) => item.code === "validated-on-unresolved")
      .map((item) => item.resultId));
    const nodeLayer = svgEl("g", "graph-nodes");
    for (const result of options.results) {
      const position = graph.node(result.id) as { x: number; y: number };
      const node = svgEl("g", `graph-node state-${result.validation}`);
      node.dataset.resultId = result.id;
      node.setAttribute(
        "transform",
        `translate(${position.x - nodeWidth / 2},${position.y - nodeHeight / 2})`,
      );
      node.setAttribute("role", "button");
      node.setAttribute("tabindex", "0");
      node.setAttribute("aria-pressed", String(result.id === selectedId));
      node.setAttribute(
        "aria-label",
        `${result.id}, ${result.title}, ${result.validation}, owner ${result.ownerLabel}`,
      );
      if (result.project !== options.project) node.classList.add("is-external");
      if (result.id === selectedId) node.classList.add("is-selected");
      else if (focus && !focus.has(result.id)) node.classList.add("is-muted");
      if (risk.has(result.id)) node.classList.add("has-risk");

      const box = svgEl("rect", "graph-node-box");
      box.setAttribute("width", String(nodeWidth));
      box.setAttribute("height", String(nodeHeight));
      box.setAttribute("rx", "5");
      node.append(box);
      addText(node, result.id, 12, 19, "graph-node-id");
      wrapTitle(result.title, mode === "compact" ? 25 : 30).forEach((line, index) => {
        addText(node, line, 12, 39 + index * 15, "graph-node-title");
      });
      addText(
        node,
        `${DEPENDENCY_STATUS[result.validation].symbol} ${DEPENDENCY_STATUS[result.validation].label}`,
        12,
        mode === "compact" ? 70 : 77,
        "graph-node-status",
      );
      const owner = result.project === options.project
        ? result.ownerLabel
        : `${result.project} · ${result.ownerLabel}`;
      addText(node, owner, nodeWidth - 10, mode === "compact" ? 70 : 77, "graph-node-owner", "end");

      node.addEventListener("click", () => options.onSelect?.(result));
      node.addEventListener("dblclick", () => void options.onOpen?.(result));
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void options.onOpen?.(result);
        else if (event.key === " ") {
          event.preventDefault();
          options.onSelect?.(result);
        }
      });
      nodeLayer.append(node);
    }
    svg.append(nodeLayer);
    this.attachViewport();
  }

  fit(): void {
    this.viewBox = { ...this.naturalBox };
    this.applyViewBox();
  }

  zoomIn(): void {
    this.zoomAt(0.78, 0.5, 0.5);
  }

  zoomOut(): void {
    this.zoomAt(1.28, 0.5, 0.5);
  }

  private attachViewport(): void {
    const svg = this.element;
    svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const scale = event.deltaY < 0 ? 0.84 : 1.19;
      const px = (event.clientX - rect.left) / rect.width;
      const py = (event.clientY - rect.top) / rect.height;
      this.zoomAt(scale, px, py);
    }, { passive: false });
    svg.addEventListener("pointerdown", (event) => {
      this.pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      if (this.pointers.size >= 2) {
        for (const pointerId of this.pointers.keys()) {
          try { svg.setPointerCapture(pointerId); } catch { /* pointer may already have ended */ }
        }
        this.beginPinch();
        this.panStart = null;
        svg.classList.add("is-panning");
        return;
      }
      if ((event.target as Element).closest("[data-result-id]")) return;
      try { svg.setPointerCapture(event.pointerId); } catch { /* synthetic/test pointer */ }
      this.panStart = {
        clientX: event.clientX,
        clientY: event.clientY,
        box: { ...this.viewBox },
      };
      svg.classList.add("is-panning");
    });
    svg.addEventListener("pointermove", (event) => {
      if (this.pointers.has(event.pointerId)) {
        this.pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      }
      if (this.pointers.size >= 2 && this.pinchStart) {
        const points = [...this.pointers.values()].slice(0, 2);
        const distance = pointDistance(points[0], points[1]);
        if (distance <= 0) return;
        const rect = svg.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const centerX = (points[0].clientX + points[1].clientX) / 2;
        const centerY = (points[0].clientY + points[1].clientY) / 2;
        const width = this.boundedWidth(this.pinchStart.box.width * (this.pinchStart.distance / distance));
        const height = this.pinchStart.box.height * (width / this.pinchStart.box.width);
        const px = (this.pinchStart.centerX - rect.left) / rect.width;
        const py = (this.pinchStart.centerY - rect.top) / rect.height;
        this.viewBox = {
          x: this.pinchStart.box.x + (this.pinchStart.box.width - width) * px
            - (centerX - this.pinchStart.centerX) * (this.pinchStart.box.width / rect.width),
          y: this.pinchStart.box.y + (this.pinchStart.box.height - height) * py
            - (centerY - this.pinchStart.centerY) * (this.pinchStart.box.height / rect.height),
          width,
          height,
        };
        this.suppressClick = true;
        this.applyViewBox();
        return;
      }
      if (!this.panStart) return;
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      this.viewBox.x = this.panStart.box.x
        - (event.clientX - this.panStart.clientX) * (this.panStart.box.width / rect.width);
      this.viewBox.y = this.panStart.box.y
        - (event.clientY - this.panStart.clientY) * (this.panStart.box.height / rect.height);
      if (Math.abs(event.clientX - this.panStart.clientX) + Math.abs(event.clientY - this.panStart.clientY) > 4) {
        this.suppressClick = true;
      }
      this.applyViewBox();
    });
    const finish = (event: PointerEvent) => {
      this.pointers.delete(event.pointerId);
      this.pinchStart = null;
      const remaining = [...this.pointers.values()][0];
      this.panStart = remaining
        ? { clientX: remaining.clientX, clientY: remaining.clientY, box: { ...this.viewBox } }
        : null;
      if (!remaining) {
        svg.classList.remove("is-panning");
        // A browser click generated by this same pointer gesture still reaches
        // the capture listener before the next task. Clear the guard afterward
        // so a later, deliberate node click is never swallowed.
        if (this.suppressClick) setTimeout(() => { this.suppressClick = false; }, 0);
      }
    };
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointercancel", finish);
    svg.addEventListener("click", (event) => {
      if (!this.suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      this.suppressClick = false;
    }, true);
  }

  private applyViewBox(): void {
    this.element.setAttribute(
      "viewBox",
      `${this.viewBox.x} ${this.viewBox.y} ${this.viewBox.width} ${this.viewBox.height}`,
    );
  }

  private zoomAt(scale: number, px: number, py: number): void {
    const width = this.boundedWidth(this.viewBox.width * scale);
    const height = this.viewBox.height * (width / this.viewBox.width);
    this.viewBox = {
      x: this.viewBox.x + (this.viewBox.width - width) * px,
      y: this.viewBox.y + (this.viewBox.height - height) * py,
      width,
      height,
    };
    this.applyViewBox();
  }

  private boundedWidth(width: number): number {
    return Math.min(
      this.naturalBox.width * 5,
      Math.max(this.naturalBox.width / 15, width),
    );
  }

  private beginPinch(): void {
    const points = [...this.pointers.values()].slice(0, 2);
    if (points.length < 2) return;
    this.pinchStart = {
      distance: Math.max(1, pointDistance(points[0], points[1])),
      centerX: (points[0].clientX + points[1].clientX) / 2,
      centerY: (points[0].clientY + points[1].clientY) / 2,
      box: { ...this.viewBox },
    };
  }
}

function pointDistance(
  first: { clientX: number; clientY: number },
  second: { clientX: number; clientY: number },
): number {
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function arrowMarker(id: string, fill: string): SVGMarkerElement {
  const marker = svgEl("marker");
  marker.id = id;
  marker.setAttribute("viewBox", "0 0 8 8");
  marker.setAttribute("refX", "7");
  marker.setAttribute("refY", "4");
  marker.setAttribute("markerWidth", "7");
  marker.setAttribute("markerHeight", "7");
  marker.setAttribute("orient", "auto-start-reverse");
  const path = svgEl("path");
  path.setAttribute("d", "M0,0 L8,4 L0,8 z");
  path.setAttribute("fill", fill);
  marker.append(path);
  return marker;
}

function wrapTitle(title: string, lineLength: number): string[] {
  const words = title.split(/\s+/);
  const lines = [""];
  for (const word of words) {
    const index = lines.length - 1;
    const candidate = `${lines[index]} ${word}`.trim();
    if (candidate.length > lineLength && lines[index] && lines.length < 2) lines.push(word);
    else lines[index] = candidate;
  }
  if (lines.length === 2 && lines[1].length > lineLength + 2) {
    lines[1] = `${lines[1].slice(0, lineLength + 1)}…`;
  }
  return lines;
}

function addText(
  parent: SVGElement,
  value: string,
  x: number,
  y: number,
  className: string,
  anchor: "start" | "end" = "start",
): void {
  const text = svgEl("text", className);
  text.textContent = value;
  text.setAttribute("x", String(x));
  text.setAttribute("y", String(y));
  text.setAttribute("text-anchor", anchor);
  parent.append(text);
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  className?: string,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  if (className) element.setAttribute("class", className);
  return element;
}
