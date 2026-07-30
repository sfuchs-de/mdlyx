// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolbarOverflow } from "./toolbar-overflow";
import { AnchoredPanelController } from "./anchored-panel";

function media(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "(max-width: 799px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}

describe("ToolbarOverflow", () => {
  beforeEach(() => document.body.replaceChildren());

  it("moves secondary actions into the narrow More menu", () => {
    const actions = document.createElement("div");
    const secondary = document.createElement("button");
    secondary.id = "secondary";
    const host = document.createElement("div");
    const trigger = document.createElement("button");
    const menu = document.createElement("div");
    menu.hidden = true;
    host.append(trigger, menu);
    actions.append(secondary, host);
    document.body.append(actions);

    const overflow = new ToolbarOverflow(
      trigger,
      host,
      menu,
      [{ button: secondary, label: "Secondary" }],
      () => media(true),
    );
    expect(menu.contains(secondary)).toBe(true);
    expect(host.hidden).toBe(false);
    expect(secondary.getAttribute("role")).toBe("menuitem");
    overflow.destroy();
  });

  it("opens and dismisses the menu with synchronized ARIA state", () => {
    const secondary = document.createElement("button");
    const host = document.createElement("div");
    const trigger = document.createElement("button");
    const menu = document.createElement("div");
    menu.hidden = true;
    host.append(trigger, menu);
    document.body.append(secondary, host);
    const overflow = new ToolbarOverflow(
      trigger,
      host,
      menu,
      [{ button: secondary, label: "Secondary" }],
      () => media(true),
    );

    trigger.click();
    expect(menu.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menu.hidden).toBe(true);
    overflow.destroy();
  });

  it("supports Arrow, Home, and End navigation between menu items", async () => {
    const first = document.createElement("button");
    const second = document.createElement("button");
    const host = document.createElement("div");
    const trigger = document.createElement("button");
    const menu = document.createElement("div");
    menu.hidden = true;
    host.append(trigger, menu);
    document.body.append(first, second, host);
    const overflow = new ToolbarOverflow(
      trigger,
      host,
      menu,
      [{ button: first, label: "First" }, { button: second, label: "Second" }],
      () => media(true),
    );

    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(second);
    second.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(first);

    overflow.destroy();
  });

  it("restores an overflowed panel to the visible More trigger", () => {
    const secondary = document.createElement("button");
    secondary.id = "secondary";
    const host = document.createElement("div");
    const trigger = document.createElement("button");
    trigger.id = "more";
    const menu = document.createElement("div");
    menu.hidden = true;
    const panel = document.createElement("div");
    panel.id = "secondary-panel";
    host.append(trigger, menu);
    document.body.append(secondary, host, panel);
    const panelController = new AnchoredPanelController(secondary, panel);
    const overflow = new ToolbarOverflow(
      trigger,
      host,
      menu,
      [{ button: secondary, label: "Secondary" }],
      () => media(true),
    );

    trigger.click();
    secondary.click();
    // Mirrors the real menu bubbling after the launcher's own click handler.
    menu.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu.hidden).toBe(true);
    panelController.close();
    expect(document.activeElement).toBe(trigger);

    panelController.destroy();
    overflow.destroy();
  });
});
