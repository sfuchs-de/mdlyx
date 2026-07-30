// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initApp } from "./app";
import type { FileRef } from "./file-adapter";

const apps: Array<ReturnType<typeof initApp>> = [];

function setupApp() {
  const host = document.createElement("main");
  host.id = "editor-host";
  const status = document.createElement("div");
  const workspace = document.createElement("div");
  const button = () => document.createElement("button");
  document.body.append(host, status, workspace);
  const app = initApp(host, {
    status,
    workspace,
    authorName: "Test author",
    buttons: {
      new: button(),
      open: button(),
      save: button(),
      saveAs: button(),
      exportTex: button(),
      comments: button(),
    },
  });
  apps.push(app);
  return app;
}

function editActive(app: ReturnType<typeof initApp>, text = "changed") {
  const view = app.editor.view;
  view.dispatch(view.state.tr.insertText(text));
}

function confirmButton(): HTMLButtonElement {
  const control = document.querySelector<HTMLButtonElement>(".dialog-confirm");
  if (!control) throw new Error("Expected a confirmation dialog");
  return control;
}

function cancelButton(): HTMLButtonElement {
  const control = document.querySelector<HTMLButtonElement>(".dialog-cancel");
  if (!control) throw new Error("Expected a confirmation dialog");
  return control;
}

beforeEach(() => {
  apps.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  // ProseMirror asks a DOM Range for geometry while restoring editor focus.
  // jsdom intentionally has no layout engine, so provide neutral geometry.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => {
  apps.forEach((app) => app.editor.view.destroy());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.textContent = "";
});

describe("bulk tab close revision safety", () => {
  it("asks again when a formerly clean tab becomes dirty after aggregate confirmation", async () => {
    const app = setupApp();
    app.load("first\n", "first.md", null);
    editActive(app);
    const firstId = app.getTabs()[0].id;
    app.newTab();
    app.load("second\n", "second.md", null);
    const secondId = app.getTabs().find((tab) => tab.active)!.id;

    const closing = app.closeTabs([firstId, secondId], true);
    expect(document.querySelector(".dialog-message")?.textContent).toContain("first.md");

    // This edit was not part of the dirty snapshot represented by the
    // aggregate dialog and therefore needs its own confirmation.
    editActive(app, "late edit");
    confirmButton().click();
    await vi.waitFor(() => {
      expect(document.querySelector(".dialog-message")?.textContent).toContain("second.md");
    });
    expect(app.getTabs().some((tab) => tab.id === secondId && tab.dirty)).toBe(true);

    cancelButton().click();
    await closing;
    expect(app.getTabs().map((tab) => tab.id)).toEqual([secondId]);
    expect(app.getTabs()[0].dirty).toBe(true);
  });

  it("does not let Close all saved discard a tab dirtied while earlier tabs close", async () => {
    const app = setupApp();
    app.load("first\n", "first.md", null);
    const firstId = app.getTabs()[0].id;
    app.newTab();
    app.load("second\n", "second.md", null);
    const secondId = app.getTabs().find((tab) => tab.active)!.id;

    const closing = app.closeTabs([firstId, secondId], false);
    editActive(app, "late edit");

    await vi.waitFor(() => {
      expect(document.querySelector(".dialog-message")?.textContent).toContain("second.md");
    });
    cancelButton().click();
    await closing;

    expect(app.getTabs().map((tab) => tab.id)).toEqual([secondId]);
    expect(app.getTabs()[0].dirty).toBe(true);
  });
});

describe("provider-bound document opens", () => {
  it("does not create a tab after an asynchronous identity check is superseded", async () => {
    const app = setupApp();
    let settleIdentity!: (same: boolean) => void;
    const identity = new Promise<boolean>((resolve) => {
      settleIdentity = resolve;
    });
    const isSameEntry = vi.fn(() => identity);
    const retained = { kind: "file", name: "first.md", isSameEntry } as unknown as FileRef;
    const incoming = { kind: "file", name: "second.md" } as unknown as FileRef;
    app.load("first\n", "first.md", retained);

    let current = true;
    const opening = app.open("second\n", "second.md", incoming, "notes/second.md", () => current);
    await vi.waitFor(() => expect(isSameEntry).toHaveBeenCalledOnce());
    current = false;
    settleIdentity(false);
    await opening;

    expect(app.getTabs()).toHaveLength(1);
    expect(app.getTabs()[0].name).toBe("first.md");
  });
});

describe("Contract v2 generated projections", () => {
  it("opens projections as selectable read-only documents", () => {
    const host = document.createElement("main");
    const status = document.createElement("div");
    const workspace = document.createElement("div");
    const save = document.createElement("button");
    const saveAs = document.createElement("button");
    document.body.append(host, status, workspace);
    const app = initApp(host, {
      status,
      workspace,
      authorName: "Test author",
      buttons: {
        new: document.createElement("button"),
        open: document.createElement("button"),
        save,
        saveAs,
        exportTex: document.createElement("button"),
        comments: document.createElement("button"),
      },
    });
    apps.push(app);
    const digest = `sha256:${"c".repeat(64)}`;
    app.load(`---\nlibrary: {"id":"claims","title":"Claims","tags":[],"contains":["dependency-graph"],"projects":["p"],"related":[],"projection":{"kind":"generated-result-manifest","schema_version":"2.0","sources":["results.yaml","graph.json"],"digest":"${digest}","read_only":true,"acknowledged_warnings":[]}}\n---\n\n# Claims\n`, "claims.md", null);

    expect(app.isReadOnly()).toBe(true);
    expect(app.editor.view.editable).toBe(false);
    expect(save.disabled).toBe(true);
    expect(saveAs.disabled).toBe(true);
    expect(status.textContent).toBe("Read-only projection");
    app.updateMeta({ title: "Changed" });
    expect(app.getMeta().title).toBe("Claims");
    const before = app.serialize();
    app.editor.view.dispatch(app.editor.view.state.tr.insertText("blocked edit"));
    expect(app.serialize()).toBe(before);
  });
});
