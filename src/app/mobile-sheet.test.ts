// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileSheetController } from "./mobile-sheet";

afterEach(() => {
  document.body.textContent = "";
  vi.unstubAllGlobals();
});

describe("MobileSheetController", () => {
  it("places a modal sheet at the visual bottom and restores the background", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    const app = document.createElement("div");
    app.id = "app";
    const panel = document.createElement("section");
    panel.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 374, bottom: 200,
      width: 374, height: 200, toJSON: () => ({}),
    });
    document.body.append(app, panel);
    let controller!: MobileSheetController;
    const dismiss = vi.fn(() => controller.deactivate());
    controller = new MobileSheetController(panel, { onDismiss: dismiss, app });
    controller.activate();

    expect(panel.dataset.mobileSheet).toBe("true");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.style.left).toBe("8px");
    expect(panel.style.top).toBe("635px");
    expect(app.hasAttribute("inert")).toBe(true);
    document.querySelector<HTMLButtonElement>(".mobile-sheet-scrim")!.click();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(app.hasAttribute("inert")).toBe(false);
    controller.destroy();
  });

  it("contains keyboard focus and dismisses on Escape", () => {
    const app = document.createElement("div");
    app.id = "app";
    const panel = document.createElement("section");
    const first = document.createElement("button");
    const last = document.createElement("button");
    panel.append(first, last);
    document.body.append(app, panel);
    let controller!: MobileSheetController;
    const dismiss = vi.fn(() => controller.deactivate());
    controller = new MobileSheetController(panel, { onDismiss: dismiss, app });
    controller.activate();
    last.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(dismiss).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it("clamps fractional WebKit metrics to the layout viewport", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 481 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 541 });
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 480,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 540,
    });
    const panel = document.createElement("section");
    panel.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 465, bottom: 525.109375,
      width: 465, height: 525.109375, toJSON: () => ({}),
    });
    document.body.appendChild(panel);
    const controller = new MobileSheetController(panel, { onDismiss: vi.fn(), app: null });
    controller.activate();

    expect(panel.style.width).toBe("463px");
    expect(panel.style.maxHeight).toBe("523px");
    expect(panel.style.top).toBe("8px");
    controller.destroy();
  });

  it("repositions when asynchronous sheet content changes its height", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 390,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 844,
    });
    let resize: ResizeObserverCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    });
    let height = 200;
    const panel = document.createElement("section");
    panel.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 373, bottom: height,
      width: 373, height, toJSON: () => ({}),
    });
    document.body.appendChild(panel);
    const controller = new MobileSheetController(panel, { onDismiss: vi.fn(), app: null });
    controller.activate();
    expect(observe).toHaveBeenCalledWith(panel);
    expect(panel.style.top).toBe("635px");

    height = 360;
    resize!([], {} as ResizeObserver);
    expect(panel.style.top).toBe("475px");
    controller.deactivate();
    expect(disconnect).toHaveBeenCalled();
    controller.destroy();
  });
});
