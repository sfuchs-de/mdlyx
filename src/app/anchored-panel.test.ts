// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnchoredPanelController } from "./anchored-panel";

function parts(id: string) {
  const launcher = document.createElement("button");
  const panel = document.createElement("section");
  panel.id = id;
  panel.setAttribute("role", "dialog");
  const input = document.createElement("input");
  panel.append(input);
  document.body.append(launcher, panel);
  return { launcher, panel, input };
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});

afterEach(() => {
  document.body.textContent = "";
  vi.restoreAllMocks();
});

describe("AnchoredPanelController", () => {
  it("coordinates panels, exposes ARIA state, and restores launcher focus", () => {
    const first = parts("first-panel");
    const second = parts("second-panel");
    const firstController = new AnchoredPanelController(first.launcher, first.panel);
    const secondController = new AnchoredPanelController(second.launcher, second.panel);

    firstController.open();
    expect(first.panel.hidden).toBe(false);
    expect(first.launcher.getAttribute("aria-controls")).toBe("first-panel");
    expect(first.launcher.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(first.input);

    secondController.open();
    expect(first.panel.hidden).toBe(true);
    expect(second.panel.hidden).toBe(false);
    secondController.close();
    expect(document.activeElement).toBe(second.launcher);
  });

  it("reveals before measuring and clamps desktop placement to the viewport", () => {
    const { launcher, panel } = parts("placed-panel");
    launcher.getBoundingClientRect = () => DOMRect.fromRect({ x: 4, y: 760, width: 24, height: 24 });
    panel.getBoundingClientRect = () => DOMRect.fromRect({ width: 400, height: 300 });
    const controller = new AnchoredPanelController(launcher, panel);
    controller.open();
    expect(panel.style.left).toBe("8px");
    expect(panel.style.top).toBe("454px");
    expect(panel.style.visibility).toBe("");
  });

  it("uses an inset sheet on narrow viewports", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 480 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 640 });
    const { launcher, panel } = parts("narrow-panel");
    const controller = new AnchoredPanelController(launcher, panel);
    controller.open();
    expect(panel.dataset.panelLayout).toBe("sheet");
    expect(panel.style.left).toBe("8px");
    expect(panel.style.width).toBe("463px");
    expect(panel.style.maxHeight).toBe("623px");
    const close = panel.querySelector<HTMLButtonElement>(".anchored-panel-mobile-close");
    expect(close?.tabIndex).toBe(0);
    launcher.focus();
    launcher.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(close);
    close?.click();
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(launcher);
  });

  it("retains its last visual anchor when an overflow-menu trigger becomes hidden", () => {
    const { launcher, panel } = parts("overflow-panel");
    let rect = DOMRect.fromRect({ x: 900, y: 20, width: 30, height: 30 });
    launcher.getBoundingClientRect = () => rect;
    panel.getBoundingClientRect = () => DOMRect.fromRect({ width: 200, height: 100 });
    const controller = new AnchoredPanelController(launcher, panel, {
      positioningAnchor: () => launcher,
    });
    controller.open();
    expect(panel.style.left).toBe("730px");
    rect = DOMRect.fromRect();
    controller.reposition();
    expect(panel.style.left).toBe("730px");
    expect(launcher.getAttribute("aria-controls")).toBe("overflow-panel");
  });

  it("leaves the parent open while a nested modal owns clicks and Escape", () => {
    const { launcher, panel } = parts("parent-panel");
    const controller = new AnchoredPanelController(launcher, panel);
    controller.open();
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    document.body.append(overlay);

    overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(false);

    overlay.remove();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true);
  });
});
