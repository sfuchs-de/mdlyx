// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResponsiveLibraryShell } from "./responsive-library-shell";

interface ControlledMedia {
  query: MediaQueryList;
  setMatches(matches: boolean): void;
}

function media(initialMatches: boolean): ControlledMedia {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    get matches() {
      return matches;
    },
    media: "(max-width: 799px)",
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
      listeners.add(listener as (event: MediaQueryListEvent) => void),
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
      listeners.delete(listener as (event: MediaQueryListEvent) => void),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as MediaQueryList;
  return {
    query,
    setMatches(next) {
      matches = next;
      const event = { matches, media: query.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

function fixture(narrow: boolean, requestClose = vi.fn(), onLayoutChange = vi.fn()) {
  const workspace = document.createElement("div");
  const library = document.createElement("aside");
  const close = document.createElement("button");
  close.className = "lib-drawer-close";
  close.textContent = "Close";
  const second = document.createElement("button");
  second.textContent = "Second action";
  library.append(close, second);
  const trigger = document.createElement("button");
  const scrim = document.createElement("button");
  const editor = document.createElement("div");
  editor.id = "editor-pane";
  workspace.append(library, scrim, editor);
  document.body.append(trigger, workspace);
  const controlledMedia = media(narrow);
  const shell = new ResponsiveLibraryShell(
    workspace,
    library,
    trigger,
    scrim,
    { requestClose, onLayoutChange },
    () => controlledMedia.query,
  );
  return { workspace, library, close, second, trigger, scrim, editor, shell, controlledMedia, onLayoutChange };
}

describe("ResponsiveLibraryShell", () => {
  beforeEach(() => document.body.replaceChildren());

  it("turns a visible narrow Library into an inert-background drawer", () => {
    const { workspace, library, trigger, scrim, editor, shell, controlledMedia, onLayoutChange } = fixture(true);

    shell.sync(true);
    expect(workspace.classList.contains("library-drawer-open")).toBe(true);
    expect(library.classList.contains("is-drawer")).toBe(true);
    expect(scrim.hidden).toBe(false);
    expect(scrim.tabIndex).toBe(-1);
    expect(editor.hasAttribute("inert")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(library);
    expect(onLayoutChange).toHaveBeenLastCalledWith(true);
    controlledMedia.setMatches(false);
    expect(onLayoutChange).toHaveBeenLastCalledWith(false);
    shell.destroy();
  });

  it("focuses the close action when the drawer was opened from the keyboard", () => {
    const { close, shell } = fixture(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    shell.sync(true);

    expect(document.activeElement).toBe(close);
    shell.destroy();
  });

  it("requests close and restores launcher focus from the scrim", () => {
    const requestClose = vi.fn();
    const { trigger, scrim, shell } = fixture(true, requestClose);

    shell.sync(true);
    scrim.click();
    expect(requestClose).toHaveBeenCalledOnce();
    expect(requestClose).toHaveBeenCalledWith(true);
    expect(document.activeElement).toBe(trigger);
    shell.destroy();
  });

  it("dismisses from a toolbar outside click without stealing the requested action", () => {
    const requestClose = vi.fn();
    const { shell } = fixture(true, requestClose);
    const toolbarAction = document.createElement("button");
    toolbarAction.textContent = "Settings";
    document.body.prepend(toolbarAction);
    const activated = vi.fn();
    toolbarAction.addEventListener("click", activated);
    shell.sync(true);

    toolbarAction.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    toolbarAction.click();

    expect(requestClose).toHaveBeenCalledOnce();
    expect(requestClose).toHaveBeenCalledWith(false);
    expect(activated).toHaveBeenCalledOnce();
    shell.destroy();
  });

  it("keeps the drawer open for a nested dialog interaction", () => {
    const requestClose = vi.fn();
    const { shell } = fixture(true, requestClose);
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const confirm = document.createElement("button");
    confirm.textContent = "Confirm";
    dialog.append(confirm);
    overlay.append(dialog);
    document.body.append(overlay);
    shell.sync(true);

    confirm.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(requestClose).not.toHaveBeenCalled();
    shell.destroy();
  });

  it("does not use drawer chrome on wide layouts", () => {
    const { workspace, trigger, scrim, editor, shell } = fixture(false);

    shell.sync(true);
    expect(workspace.classList.contains("library-drawer-open")).toBe(false);
    expect(scrim.hidden).toBe(true);
    expect(editor.hasAttribute("inert")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    shell.destroy();
  });

  it("contains keyboard focus within the open drawer", () => {
    const { close, second, trigger, shell } = fixture(true);
    shell.sync(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(second);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(close);

    trigger.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(close);
    shell.destroy();
  });

  it("restores each background element's previous inert state on close", () => {
    const { workspace, editor, shell } = fixture(true);
    const alreadyInert = document.createElement("div");
    alreadyInert.setAttribute("inert", "");
    workspace.append(alreadyInert);

    shell.sync(true);
    expect(editor.hasAttribute("inert")).toBe(true);
    expect(alreadyInert.hasAttribute("inert")).toBe(true);
    shell.sync(false);
    expect(editor.hasAttribute("inert")).toBe(false);
    expect(alreadyInert.hasAttribute("inert")).toBe(true);
    shell.destroy();
  });

  it("restores the background when a visible drawer becomes a wide sidebar", () => {
    const { workspace, library, scrim, editor, shell, controlledMedia } = fixture(true);
    shell.sync(true);
    controlledMedia.setMatches(false);

    expect(editor.hasAttribute("inert")).toBe(false);
    expect(workspace.classList.contains("library-drawer-open")).toBe(false);
    expect(library.classList.contains("is-drawer")).toBe(false);
    expect(scrim.hidden).toBe(true);
    shell.destroy();
  });

  it("restores the background if the controller is destroyed while open", () => {
    const { workspace, library, scrim, editor, shell } = fixture(true);
    shell.sync(true);
    shell.destroy();

    expect(editor.hasAttribute("inert")).toBe(false);
    expect(workspace.classList.contains("library-drawer-open")).toBe(false);
    expect(library.classList.contains("is-drawer")).toBe(false);
    expect(scrim.hidden).toBe(true);
  });
});
