// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileChromeController } from "./mobile-chrome";

function media(matches = true): MediaQueryList {
  return {
    matches,
    media: "(max-width: 599px)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
}

function fixture() {
  const app = document.createElement("div");
  app.id = "app";
  const toolbar = document.createElement("header");
  toolbar.id = "toolbar";
  const status = document.createElement("span");
  status.id = "file-status";
  status.textContent = "Saved";
  const control = document.createElement("button");
  toolbar.append(status, control);
  const scroller = document.createElement("main");
  app.append(toolbar, scroller);
  document.body.append(app);
  const phone = media(true);
  const controller = new MobileChromeController(app, toolbar, scroller, {
    matchMedia: () => phone,
  });
  return { app, toolbar, status, control, scroller, controller };
}

afterEach(() => {
  document.body.textContent = "";
});

describe("MobileChromeController", () => {
  it("collapses after 48px down and reveals after 16px up", () => {
    const { app, toolbar, scroller, controller } = fixture();
    scroller.scrollTop = 47;
    scroller.dispatchEvent(new Event("scroll"));
    expect(app.classList.contains("mobile-chrome-collapsed")).toBe(false);
    scroller.scrollTop = 49;
    scroller.dispatchEvent(new Event("scroll"));
    expect(controller.isCollapsed).toBe(true);
    expect(toolbar.hasAttribute("inert")).toBe(true);

    scroller.scrollTop = 34;
    scroller.dispatchEvent(new Event("scroll"));
    expect(controller.isCollapsed).toBe(true);
    scroller.scrollTop = 33;
    scroller.dispatchEvent(new Event("scroll"));
    expect(controller.isCollapsed).toBe(false);
    expect(toolbar.hasAttribute("inert")).toBe(false);
    controller.destroy();
  });

  it("stays visible for overlays, toolbar focus, explicit tools, and failures", () => {
    const { app, toolbar, status, control, scroller, controller } = fixture();
    const collapse = () => {
      scroller.scrollTop += 50;
      scroller.dispatchEvent(new Event("scroll"));
    };
    collapse();
    expect(controller.isCollapsed).toBe(true);
    app.dispatchEvent(new CustomEvent("mathdown:reveal-mobile-tools", { bubbles: true }));
    expect(controller.isCollapsed).toBe(false);
    collapse();
    control.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(controller.isCollapsed).toBe(false);
    document.body.classList.add("mobile-sheet-open");
    collapse();
    expect(controller.isCollapsed).toBe(false);
    document.body.classList.remove("mobile-sheet-open");
    status.textContent = "Sync failed";
    collapse();
    expect(controller.isCollapsed).toBe(false);
    toolbar.blur();
    controller.destroy();
  });
});
