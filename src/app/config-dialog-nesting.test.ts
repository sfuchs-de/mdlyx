// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initConfig,
  type LibrarySyncSettingsControl,
  type MathModeControl,
} from "./config";
import type { LibrarySyncSnapshot } from "./library-sync-controller";
import type {
  SoftwareUpdaterControl,
  SoftwareUpdateSnapshot,
} from "./software-updater";

const unsupportedUpdate: SoftwareUpdateSnapshot = {
  phase: "unsupported",
  currentVersion: null,
  availableVersion: null,
  publishedAt: null,
  notes: null,
  downloadedBytes: 0,
  totalBytes: null,
  checkedAt: null,
  error: null,
  errorStage: null,
};

function updater(): SoftwareUpdaterControl {
  return {
    snapshot: () => ({ ...unsupportedUpdate }),
    subscribe: (listener) => {
      listener({ ...unsupportedUpdate });
      return () => undefined;
    },
    setPrepareForRelaunch: vi.fn(),
    check: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined),
    installAndRelaunch: vi.fn(async () => undefined),
  };
}

function math(): MathModeControl {
  return { get: () => "elements", set: vi.fn() };
}

function settingsButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.title = "Settings";
  button.setAttribute("aria-label", "Settings");
  document.body.append(button);
  return button;
}

function syncControl(initial: LibrarySyncSnapshot) {
  let snapshot = initial;
  const listeners = new Set<(value: LibrarySyncSnapshot) => void>();
  const control: LibrarySyncSettingsControl = {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    cancel: vi.fn(),
    openVerification: vi.fn(async () => undefined),
    copyCode: vi.fn(async () => undefined),
    copyLink: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    pull: vi.fn(async () => true),
  };
  return {
    control,
    emit(next: LibrarySyncSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener(snapshot);
    },
  };
}

const ready = (
  authenticated: boolean,
  login?: string,
): LibrarySyncSnapshot => ({
  status: {
    state: "ready",
    authenticated,
    ...(login ? { login } : {}),
    serviceVersion: "0.3.3",
    serviceRevision: "abc123",
    releaseConfigured: true,
  },
  connected: authenticated,
  error: null,
  device: null,
});

beforeEach(() => localStorage.clear());

afterEach(() => {
  document.body.textContent = "";
  vi.restoreAllMocks();
});

describe("Settings nested dialogs", () => {
  it("keeps Settings open while a confirmation handles clicks and Escape", async () => {
    const button = settingsButton();
    const clear = vi.fn(async () => undefined);
    initConfig(
      button,
      math(),
      undefined,
      {
        exportBundle: vi.fn(async () => undefined),
        listRecoveries: vi.fn(async () => []),
        openRecovery: vi.fn(async () => false),
        deleteRecovery: vi.fn(async () => false),
        clear,
      },
      undefined,
      updater(),
    );
    button.click();
    const panel = document.querySelector<HTMLElement>("#config-panel")!;
    expect(panel.hidden).toBe(false);

    const clearButton = [...panel.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Clear local data")!;
    clearButton.click();
    const confirm = document.querySelector<HTMLButtonElement>(".dialog-confirm")!;
    confirm.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(panel.hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
    expect(document.querySelector(".dialog-overlay")).toBeNull();
    expect(panel.hidden).toBe(false);
    expect(clear).not.toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true);
  });
});

describe("Settings software identity", () => {
  it("rerenders authentication identity across ready-to-ready sync changes", () => {
    const button = settingsButton();
    const sync = syncControl(ready(false));
    initConfig(button, math(), sync.control, undefined, undefined, updater());
    const software = document.querySelector<HTMLElement>("#config-software")!;
    expect(software.textContent).toContain("GitHub authenticationSign-in required");

    sync.emit(ready(true, "example-owner"));
    expect(software.textContent).toContain("GitHub authenticationConnected as example-owner");

    sync.emit(ready(true, "another-owner"));
    expect(software.textContent).toContain("GitHub authenticationConnected as another-owner");

    sync.emit(ready(false));
    expect(software.textContent).toContain("GitHub authenticationSign-in required");
  });
});

describe("Settings sections", () => {
  it("uses keyboard-accessible tabs, persists selection, and maps legacy deep links", () => {
    const button = settingsButton();
    const handle = initConfig(button, math(), undefined, undefined, undefined, updater());
    handle.open("editor");

    const panel = document.querySelector<HTMLElement>("#config-panel")!;
    const tabs = [...panel.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .filter((tab) => !tab.hidden);
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Library", "Editor", "Software", "Data"]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector<HTMLElement>("#config-section-editor")!.hidden).toBe(false);

    tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[2]);
    expect(localStorage.getItem("mdlyx:settings-section:v1")).toBe("software");

    handle.open("local-data");
    expect(tabs[3].getAttribute("aria-selected")).toBe("true");
    handle.open("library-sync");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  });

  it("provides a labelled close control and restores focus to the launcher", () => {
    const button = settingsButton();
    initConfig(button, math(), undefined, undefined, undefined, updater());
    button.click();
    const close = document.querySelector<HTMLButtonElement>(".config-close")!;
    close.click();
    expect(document.querySelector<HTMLElement>("#config-panel")!.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("lists local recovery revisions and opens a selected revision as a copy", async () => {
    const button = settingsButton();
    const openRecovery = vi.fn(async () => true);
    const handle = initConfig(
      button,
      math(),
      undefined,
      {
        exportBundle: vi.fn(async () => undefined),
        listRecoveries: vi.fn(async () => [{
          id: "recovery-1",
          kind: "github-conflict" as const,
          name: "proof.md",
          path: "derivations/proof.md",
          createdAt: Date.UTC(2026, 6, 28, 12),
          documentRevision: 3,
        }]),
        openRecovery,
        deleteRecovery: vi.fn(async () => true),
        clear: vi.fn(async () => undefined),
      },
      undefined,
      updater(),
    );
    handle.open("data");
    await vi.waitFor(() => expect(
      document.querySelector(".config-recovery-list")?.textContent,
    ).toContain("proof.md"));
    expect(document.querySelector(".config-recovery-list")?.textContent)
      .toContain("GitHub conflict");

    const open = [...document.querySelectorAll<HTMLButtonElement>(".config-recovery-item button")]
      .find((candidate) => candidate.textContent === "Open copy")!;
    open.click();
    await vi.waitFor(() => expect(openRecovery).toHaveBeenCalledWith("recovery-1"));
    await vi.waitFor(() => expect(handle.isOpen).toBe(false));
  });

  it("shows sharing only to the owner and creates a one-time invitation", async () => {
    const button = settingsButton();
    const owner = ready(true, "example-owner");
    owner.status.capabilities = { canShare: true, canUseUpdater: true };
    const sync = syncControl(owner);
    const sharingAccess = vi.fn(async () => ({
      principals: [{
        id: "alice",
        displayName: "Alice Smith",
        authVersion: 1,
        grants: { "sample-model": "commenter" as const },
      }],
      invitations: [],
      policyRevision: "revision-1234567890",
      policySha: "policy-sha-1234567890",
      projects: [
        { key: "sample-model", title: "Sample Model" },
        { key: "example-logistics", title: "Example Logistics" },
      ],
    }));
    sync.control.sharingAccess = sharingAccess;
    sync.control.createInvitation = vi.fn(async () => ({
      id: "invite-1",
      principalId: "alice",
      createdAt: 1,
      expiresAt: 2,
      url: `https://mathdown.test/invite#token=${"A".repeat(43)}`,
    }));
    sync.control.revokeInvitation = vi.fn(async () => undefined);
    sync.control.createSharingPrincipal = vi.fn(async () => undefined);
    sync.control.updateSharingPrincipal = vi.fn(async () => undefined);
    sync.control.revokeSharingSessions = vi.fn(async () => undefined);
    sync.control.removeSharingPrincipal = vi.fn(async () => undefined);
    const handle = initConfig(button, math(), sync.control, undefined, undefined, updater());
    handle.open("sharing");
    await Promise.resolve();
    await Promise.resolve();

    const sharingTab = document.querySelector<HTMLButtonElement>("#config-tab-sharing")!;
    expect(sharingTab.hidden).toBe(false);
    await vi.waitFor(() => expect(sharingAccess).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(document.querySelector("#config-section-sharing")?.textContent).toContain("Alice Smith"));
    expect(document.querySelector("#config-section-sharing")?.textContent).toContain("Sample Model");

    const add = document.querySelector<HTMLDetailsElement>(".config-sharing-add")!;
    add.open = true;
    const addInputs = add.querySelectorAll<HTMLInputElement>("input");
    addInputs[0].value = "Bob Smith";
    addInputs[0].dispatchEvent(new Event("input"));
    expect(addInputs[1].value).toBe("bob-smith");
    const addPerson = [...add.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Add person")!;
    addPerson.click();
    await vi.waitFor(() => expect(sync.control.createSharingPrincipal).toHaveBeenCalledWith(
        "bob-smith",
        "Bob Smith",
        { "sample-model": "reader" },
        "policy-sha-1234567890",
      ));
    await vi.waitFor(() => expect(document.querySelector(".config-sharing-grant-row select")).not.toBeNull());

    const role = document.querySelector<HTMLSelectElement>(".config-sharing-grant-row select")!;
    role.value = "editor";
    role.dispatchEvent(new Event("change"));
    const save = [...document.querySelectorAll<HTMLButtonElement>("#config-section-sharing button")]
      .find((candidate) => candidate.textContent === "Save permissions")!;
    save.click();
    await vi.waitFor(() => expect(sync.control.updateSharingPrincipal).toHaveBeenCalledWith(
        "alice",
        "Alice Smith",
        { "sample-model": "editor" },
        "policy-sha-1234567890",
      ));
    await vi.waitFor(() => expect(document.querySelector("#config-section-sharing")?.textContent).toContain("Alice Smith"));

    const create = [...document.querySelectorAll<HTMLButtonElement>("#config-section-sharing button")]
      .find((candidate) => candidate.textContent === "Create invitation")!;
    create.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector<HTMLInputElement>(".config-issued-invite input")?.value)
      .toContain("/invite#token=");

    const shared = ready(true);
    shared.status.principal = { id: "alice", displayName: "Alice Smith", kind: "coauthor" };
    shared.status.capabilities = { canShare: false, canUseUpdater: false };
    sync.emit(shared);
    expect(sharingTab.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#config-section-library")?.hidden).toBe(false);
  });
});
