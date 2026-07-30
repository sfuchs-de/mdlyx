// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { DependencyCatalog, GraphDiagnostic, ResultNode } from "./dependency-graph";
import { DependencyGraphCanvas } from "./dependency-graph-canvas";

function result(
  id: string,
  project: string,
  validation: ResultNode["validation"],
  dependsOn: string[] = [],
): ResultNode {
  return {
    id,
    title: `${id} result`,
    ownerId: `${id}-owner`,
    ownerLabel: `${id} owner`,
    validation,
    dependsOn,
    evidence: `${id} evidence`,
    condition: `${id} condition`,
    project,
    manifestDocumentId: `${project}-manifest`,
    manifestPath: `${project}/manifest.md`,
    row: 2,
  };
}

function catalog(): DependencyCatalog {
  const results = [
    result("R-A", "project-one", "validated"),
    result("R-B", "project-one", "partial", ["R-A", "R-X"]),
    result("R-C", "project-one", "unvalidated"),
    result("R-X", "project-two", "unvalidated"),
  ];
  const risk: GraphDiagnostic = {
    code: "validated-on-unresolved",
    severity: "warning",
    message: "R-A has unresolved prerequisites.",
    resultId: "R-A",
  };
  return { manifests: [], results, byId: new Map(results.map((item) => [item.id, item])), diagnostics: [risk] };
}

describe("DependencyGraphCanvas", () => {
  it("preserves full graph status, boundary, risk, focus, and keyboard interactions", () => {
    const data = catalog();
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const canvas = new DependencyGraphCanvas({
      project: "project-one",
      catalog: data,
      results: data.results,
      selectedId: "R-B",
      onSelect,
      onOpen,
    });

    expect(canvas.element.classList.contains("graph-svg-full")).toBe(true);
    expect(canvas.element.querySelectorAll(".graph-node")).toHaveLength(4);
    expect(canvas.element.querySelector('[data-result-id="R-X"]')?.classList.contains("is-external")).toBe(true);
    expect(canvas.element.querySelector('[data-result-id="R-A"]')?.classList.contains("has-risk")).toBe(true);
    expect(canvas.element.querySelector('[data-result-id="R-B"]')?.classList.contains("is-selected")).toBe(true);
    expect(canvas.element.querySelector('[data-result-id="R-B"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(canvas.element.querySelector('[data-result-id="R-C"]')?.classList.contains("is-muted")).toBe(true);
    expect(canvas.element.textContent).toContain("✓ validated");
    expect(canvas.element.textContent).toContain("◐ partial");
    expect(canvas.element.textContent).toContain("project-two · R-X owner");

    const selected = canvas.element.querySelector<SVGGElement>('[data-result-id="R-B"]')!;
    selected.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith(data.byId.get("R-B"));
    selected.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onOpen).toHaveBeenCalledWith(data.byId.get("R-B"));
    selected.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(2);
    selected.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("lays out only the supplied compact result subset and exposes Fit", () => {
    const data = catalog();
    const subset = [data.byId.get("R-B")!, data.byId.get("R-X")!];
    const canvas = new DependencyGraphCanvas({
      project: "project-one",
      catalog: data,
      results: subset,
      mode: "compact",
      direction: "TB",
      ariaLabel: "Validation frontier",
    });
    expect(canvas.element.classList.contains("graph-svg-compact")).toBe(true);
    expect(canvas.element.getAttribute("aria-label")).toBe("Validation frontier");
    expect(canvas.element.dataset.direction).toBe("TB");
    expect([...canvas.element.querySelectorAll<SVGGElement>(".graph-node")].map((node) => node.dataset.resultId))
      .toEqual(["R-B", "R-X"]);

    const natural = canvas.element.getAttribute("viewBox");
    Object.defineProperty(canvas.element, "getBoundingClientRect", {
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400, toJSON: () => ({}) }),
    });
    canvas.element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 400, clientY: 200 }));
    expect(canvas.element.getAttribute("viewBox")).not.toBe(natural);
    canvas.fit();
    expect(canvas.element.getAttribute("viewBox")).toBe(natural);
    canvas.zoomIn();
    expect(canvas.element.getAttribute("viewBox")).not.toBe(natural);
    canvas.zoomOut();
    canvas.fit();
    expect(canvas.element.getAttribute("viewBox")).toBe(natural);
  });

  it("supports genuine two-pointer pinch zoom without turning it into a node click", () => {
    const data = catalog();
    const onSelect = vi.fn();
    const canvas = new DependencyGraphCanvas({
      project: "project-one",
      catalog: data,
      results: data.results,
      onSelect,
    });
    Object.defineProperty(canvas.element, "getBoundingClientRect", {
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => ({}) }),
    });
    Object.defineProperty(canvas.element, "setPointerCapture", { value: vi.fn() });
    const dispatch = (type: string, pointerId: number, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
      Object.defineProperty(event, "pointerId", { value: pointerId });
      canvas.element.dispatchEvent(event);
    };
    const before = canvas.element.getAttribute("viewBox");
    dispatch("pointerdown", 1, 120, 150);
    dispatch("pointerdown", 2, 280, 150);
    dispatch("pointermove", 1, 80, 150);
    dispatch("pointermove", 2, 320, 150);
    expect(canvas.element.getAttribute("viewBox")).not.toBe(before);
    dispatch("pointerup", 1, 80, 150);
    dispatch("pointerup", 2, 320, 150);
    canvas.element.querySelector<SVGGElement>('[data-result-id="R-A"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
