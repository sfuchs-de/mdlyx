// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { confirmDialog, promptDialog } from "./dialogs";

// window.confirm()/prompt() are dead in the desktop WebView (wry implements no
// JS dialog panels), so these in-DOM replacements are the only functional path
// for dirty-tab close, updater install, clear-local-data, and new-document
// naming. They must resolve exactly once and clean up after themselves.

afterEach(() => {
  document.body.textContent = "";
});

const overlay = () => document.querySelector<HTMLElement>(".dialog-overlay");
const click = (sel: string) =>
  document.querySelector<HTMLButtonElement>(sel)!.click();

describe("confirmDialog", () => {
  it("resolves true on confirm and removes the overlay", async () => {
    const p = confirmDialog("Discard changes?", { confirmLabel: "Discard", danger: true });
    expect(overlay()).not.toBeNull();
    expect(document.querySelector(".dialog-confirm")!.textContent).toBe("Discard");
    click(".dialog-confirm");
    await expect(p).resolves.toBe(true);
    expect(overlay()).toBeNull();
  });

  it("resolves false on cancel", async () => {
    const p = confirmDialog("Sure?");
    click(".dialog-cancel");
    await expect(p).resolves.toBe(false);
    expect(overlay()).toBeNull();
  });

  it("resolves false on Escape", async () => {
    const p = confirmDialog("Sure?");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(p).resolves.toBe(false);
    expect(overlay()).toBeNull();
  });

  it("treats a full click (down+up) on the backdrop as cancel", async () => {
    const p = confirmDialog("Sure?");
    overlay()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    overlay()!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await expect(p).resolves.toBe(false);
  });

  it("a mousedown alone (double-click spillover) does not dismiss", async () => {
    // A double-click on the triggering control lands its second press on the
    // freshly mounted backdrop; that alone must not flash-cancel the dialog.
    const p = confirmDialog("Sure?");
    overlay()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(overlay()).not.toBeNull(); // still open
    click(".dialog-confirm");
    await expect(p).resolves.toBe(true);
  });

  it("a complete second press from a real double-click does not dismiss", async () => {
    // The dialog can mount after click #1 while click #2 is already in flight.
    // Browsers mark the second mousedown/up with detail=2.
    const p = confirmDialog("Sure?");
    overlay()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 2 }));
    overlay()!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, detail: 2 }));
    overlay()!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    expect(overlay()).not.toBeNull();
    click(".dialog-confirm");
    await expect(p).resolves.toBe(true);
  });

  it("keeps keydown events from reaching app-level shortcut handlers", async () => {
    let leaked = 0;
    const spy = () => leaked++;
    window.addEventListener("keydown", spy);
    const p = confirmDialog("Sure?");
    document.querySelector(".dialog-confirm")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true }),
    );
    expect(leaked).toBe(0); // contained by the overlay
    click(".dialog-confirm");
    await p;
    window.removeEventListener("keydown", spy);
  });

  it("a click inside the dialog does not dismiss it", async () => {
    const p = confirmDialog("Sure?");
    document.querySelector(".dialog-message")!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );
    expect(overlay()).not.toBeNull(); // still open
    click(".dialog-confirm");
    await expect(p).resolves.toBe(true);
  });

  it("restores focus to the previously focused element", async () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    btn.focus();
    const p = confirmDialog("Sure?");
    expect(document.activeElement).toBe(document.querySelector(".dialog-confirm"));
    click(".dialog-confirm");
    await p;
    expect(document.activeElement).toBe(btn);
  });
});

describe("promptDialog", () => {
  it("returns the edited value on submit", async () => {
    const p = promptDialog("Name:", "untitled.md");
    const input = document.querySelector<HTMLInputElement>(".dialog-input")!;
    expect(input.value).toBe("untitled.md");
    input.value = "notes/idea.md";
    click(".dialog-confirm");
    await expect(p).resolves.toBe("notes/idea.md");
    expect(overlay()).toBeNull();
  });

  it("returns null on cancel and on Escape", async () => {
    const p1 = promptDialog("Name:");
    click(".dialog-cancel");
    await expect(p1).resolves.toBeNull();
    const p2 = promptDialog("Name:");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(p2).resolves.toBeNull();
  });

  it("submits via the form (Enter in the input)", async () => {
    const p = promptDialog("Name:", "a.md");
    document.querySelector("form.dialog")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await expect(p).resolves.toBe("a.md");
  });
});
