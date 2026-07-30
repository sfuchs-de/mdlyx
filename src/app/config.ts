// User preferences, persisted to localStorage and applied to :root. The
// Settings panel edits them live.

import {
  formatRemaining,
  sameSyncStructure,
  type LibrarySyncSnapshot,
} from "./library-sync-controller";
import {
  buildSoftwareStatus,
  packagedSoftwareIdentity,
  resolveSoftwareIdentity,
  type SoftwareIdentity,
} from "./software-status";
import {
  softwareUpdater,
  type SoftwareUpdaterControl,
  type SoftwareUpdateSnapshot,
} from "./software-updater";
import { openExternalUrl } from "./tauri-bridge";
import { confirmDialog } from "./dialogs";
import { AnchoredPanelController } from "./anchored-panel";
import type { SharingSettingsControl } from "./sharing-settings";
import {
  applyTheme,
  isThemePreference,
  watchSystemTheme,
  type ThemePreference,
} from "./theme";

export interface EditorConfig {
  /** Application and document color theme. */
  theme: ThemePreference;
  /** Body/prose text size, in rem. */
  bodySize: number;
  /** Display-equation size, in rem (independent of the body). */
  displaySize: number;
  /** Use the browser/WebKit spellchecker for prose. */
  spellcheck: boolean;
  /** BCP-47 language exposed to the native spellchecker. */
  language: string;
}

const KEY = "mdlyx:config";
const SETTINGS_SECTION_KEY = "mdlyx:settings-section:v1";
const TYPOGRAPHY_DEFAULTS_VERSION = 2;

const DEFAULTS: EditorConfig = {
  theme: "system",
  bodySize: 0.86,
  displaySize: 0.95,
  spellcheck: true,
  language: "en",
};

// Slider bounds (rem). Kept sane so the layout never breaks.
const BODY = { min: 0.8, max: 1.4, step: 0.02, def: DEFAULTS.bodySize };
const DISPLAY = { min: 0.85, max: 1.7, step: 0.02, def: DEFAULTS.displaySize };

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function loadConfig(): EditorConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<EditorConfig> & {
      typographyDefaultsVersion?: number;
    };
    // Earlier versions saved the former defaults (1rem/1.1rem) whenever an
    // unrelated preference such as spellcheck changed. Migrate that exact pair
    // once; preserve every genuinely customized size.
    const legacyDefaultSizes = p.typographyDefaultsVersion === undefined
      && p.bodySize === 1.0
      && p.displaySize === 1.1;
    const config = {
      theme: isThemePreference(p.theme) ? p.theme : DEFAULTS.theme,
      bodySize:
        legacyDefaultSizes
          ? DEFAULTS.bodySize
          : typeof p.bodySize === "number"
          ? clamp(p.bodySize, BODY.min, BODY.max)
          : DEFAULTS.bodySize,
      displaySize:
        legacyDefaultSizes
          ? DEFAULTS.displaySize
          : typeof p.displaySize === "number"
          ? clamp(p.displaySize, DISPLAY.min, DISPLAY.max)
          : DEFAULTS.displaySize,
      spellcheck: typeof p.spellcheck === "boolean" ? p.spellcheck : DEFAULTS.spellcheck,
      language: typeof p.language === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(p.language)
        ? p.language
        : DEFAULTS.language,
    };
    if (legacyDefaultSizes) saveConfig(config);
    return config;
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(c: EditorConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      ...c,
      typographyDefaultsVersion: TYPOGRAPHY_DEFAULTS_VERSION,
    }));
  } catch {
    /* best-effort */
  }
}

function applyConfig(c: EditorConfig): void {
  applyTheme(c.theme);
  const s = document.documentElement.style;
  s.setProperty("--body-size", `${c.bodySize}rem`);
  s.setProperty("--display-math-size", `${c.displaySize}rem`);
  for (const editor of document.querySelectorAll<HTMLElement>(".ProseMirror")) {
    editor.spellcheck = c.spellcheck;
    editor.lang = c.language;
  }
}

// Apply saved config as early as possible (before first paint) to avoid a flash
// at the default size. Safe to call again; initConfig re-reads and re-applies.
export function applySavedConfig(): void {
  applyConfig(loadConfig());
}

function pct(value: number, def: number): string {
  return `${Math.round((value / def) * 100)}%`;
}

interface Bounds {
  min: number;
  max: number;
  step: number;
  def: number;
}

// Build one labelled slider row; calls onInput live as the user drags.
function sliderRow(
  labelText: string,
  bounds: Bounds,
  value: number,
  onInput: (v: number) => void,
): { row: HTMLElement; set: (v: number) => void } {
  const row = document.createElement("label");
  row.className = "config-row";

  const label = document.createElement("span");
  label.className = "config-label";
  label.textContent = labelText;

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(bounds.min);
  input.max = String(bounds.max);
  input.step = String(bounds.step);
  input.value = String(value);

  const readout = document.createElement("span");
  readout.className = "config-value";
  readout.textContent = pct(value, bounds.def);

  input.addEventListener("input", () => {
    const v = Number(input.value);
    readout.textContent = pct(v, bounds.def);
    onInput(v);
  });

  row.append(label, input, readout);
  return {
    row,
    set: (v: number) => {
      input.value = String(v);
      readout.textContent = pct(v, bounds.def);
    },
  };
}

// A labelled two-option segmented control.
function segmentedRow(
  labelText: string,
  options: { value: string; label: string }[],
  current: string,
  onSelect: (v: string) => void,
): { row: HTMLElement; set: (v: string) => void } {
  const row = document.createElement("div");
  row.className = "config-seg-row";
  const label = document.createElement("span");
  label.className = "config-label";
  label.textContent = labelText;
  const group = document.createElement("div");
  group.className = "config-seg";
  const buttons = new Map<string, HTMLButtonElement>();
  const set = (v: string) => {
    for (const [val, b] of buttons) {
      const selected = val === v;
      b.classList.toggle("is-on", selected);
      b.setAttribute("aria-pressed", String(selected));
    }
  };
  for (const o of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "config-seg-btn";
    b.textContent = o.label;
    b.setAttribute("aria-label", `${labelText}: ${o.label}`);
    b.addEventListener("click", () => {
      set(o.value);
      onSelect(o.value);
    });
    group.append(b);
    buttons.set(o.value, b);
  }
  set(current);
  row.append(label, group);
  return { row, set };
}

export interface MathModeControl {
  get: () => "elements" | "mathlive";
  set: (m: "elements" | "mathlive") => void;
}

export interface LibrarySyncSettingsControl extends SharingSettingsControl {
  snapshot: () => LibrarySyncSnapshot;
  subscribe: (listener: (snapshot: LibrarySyncSnapshot) => void) => () => void;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  cancel: () => void;
  openVerification: () => Promise<void>;
  copyCode: () => Promise<void>;
  copyLink: () => Promise<void>;
  logout: () => Promise<void>;
  pull: () => Promise<boolean>;
}

export type SettingsSection = "library" | "sharing" | "editor" | "software" | "data";
export type SettingsOpenTarget = SettingsSection | "library-sync" | "local-data";

export interface SettingsHandle {
  readonly isOpen: boolean;
  open(section?: SettingsOpenTarget): void;
  close(): void;
}

export interface LocalDataSettingsControl {
  exportBundle: () => Promise<void>;
  listRecoveries: () => Promise<RecoveryRevisionSummary[]>;
  openRecovery: (id: string) => Promise<boolean>;
  deleteRecovery: (id: string) => Promise<boolean>;
  clear: () => Promise<void>;
}

export interface RecoveryRevisionSummary {
  id: string;
  kind: "github-conflict" | "dirty-snapshot" | "manual";
  name: string;
  path?: string;
  createdAt: number;
  documentRevision?: number;
}

export interface DiagnosticsSettingsControl {
  eventCount: () => number;
  exportBundle: () => Promise<void>;
  clear: () => void;
}

// Wire up the Config button: apply saved settings, and toggle a live-editing
// panel that persists on change. Closes on outside-click or Escape.
export function initConfig(
  button: HTMLButtonElement,
  math: MathModeControl,
  sync?: LibrarySyncSettingsControl,
  localData?: LocalDataSettingsControl,
  diagnostics?: DiagnosticsSettingsControl,
  updates: SoftwareUpdaterControl = softwareUpdater,
): SettingsHandle {
  let cfg = loadConfig();
  applyConfig(cfg);
  void watchSystemTheme(() => {
    if (cfg.theme === "system") applyConfig(cfg);
  });
  const defaultButtonTitle = button.title || "Settings";
  const defaultButtonLabel = button.getAttribute("aria-label") || "Settings";

  const panel = document.createElement("div");
  panel.id = "config-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "config-title");

  const header = document.createElement("header");
  header.className = "config-header";
  const title = document.createElement("h2");
  title.id = "config-title";
  title.className = "config-title";
  title.textContent = "Settings";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "config-close";
  closeButton.setAttribute("aria-label", "Close Settings");
  closeButton.textContent = "×";
  header.append(title, closeButton);

  const tabList = document.createElement("div");
  tabList.className = "config-tabs";
  tabList.setAttribute("role", "tablist");
  tabList.setAttribute("aria-label", "Settings sections");
  const content = document.createElement("div");
  content.className = "config-content";

  const commit = () => {
    saveConfig(cfg);
    applyConfig(cfg);
  };

  const themeRow = segmentedRow(
    "Theme",
    [
      { value: "system", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
    cfg.theme,
    (value) => {
      if (!isThemePreference(value)) return;
      cfg = { ...cfg, theme: value };
      commit();
    },
  );

  const body = sliderRow("Text size", BODY, cfg.bodySize, (v) => {
    cfg = { ...cfg, bodySize: v };
    commit();
  });
  const display = sliderRow("Equation size", DISPLAY, cfg.displaySize, (v) => {
    cfg = { ...cfg, displaySize: v };
    commit();
  });

  // Math editor mode (moved here from the toolbar — it's a preference, not an
  // action). Not part of the CSS `cfg`; it drives the editor directly via `math`.
  const sep = document.createElement("div");
  sep.className = "config-sep";
  const mathRow = segmentedRow(
    "Math editor",
    [
      { value: "elements", label: "Elements" },
      { value: "mathlive", label: "MathLive" },
    ],
    math.get(),
    (v) => math.set(v as "elements" | "mathlive"),
  );
  const mathDesc = document.createElement("p");
  mathDesc.className = "config-desc";
  mathDesc.textContent =
    "Elements edits each symbol in place (arrow between them, KaTeX stays live). " +
    "MathLive is a full visual equation editor. Double-clicking an equation always " +
    "opens MathLive.";

  const spellcheckRow = segmentedRow(
    "Spellcheck",
    [
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ],
    cfg.spellcheck ? "on" : "off",
    (value) => {
      cfg = { ...cfg, spellcheck: value === "on" };
      commit();
    },
  );
  const languageRow = document.createElement("label");
  languageRow.className = "config-row";
  const languageLabel = document.createElement("span");
  languageLabel.className = "config-label";
  languageLabel.textContent = "Language";
  const language = document.createElement("input");
  language.type = "text";
  language.value = cfg.language;
  language.placeholder = "en";
  language.setAttribute("aria-label", "Document spellcheck language");
  language.addEventListener("change", () => {
    const next = language.value.trim();
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(next)) {
      language.value = cfg.language;
      return;
    }
    cfg = { ...cfg, language: next };
    commit();
  });
  languageRow.append(languageLabel, language);

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "config-reset";
  reset.textContent = "Reset to defaults";
  reset.addEventListener("click", () => {
    cfg = { ...DEFAULTS };
    themeRow.set(cfg.theme);
    body.set(cfg.bodySize);
    display.set(cfg.displaySize);
    spellcheckRow.set(cfg.spellcheck ? "on" : "off");
    language.value = cfg.language;
    commit();
  });

  const softwareSection = document.createElement("section");
  softwareSection.id = "config-software";
  softwareSection.className = "config-software";
  let softwareIdentity: SoftwareIdentity = packagedSoftwareIdentity;
  let softwareChecking = false;
  let lastSoftwareCheck: Date | null = null;
  let updateSnapshot = updates.snapshot();

  const renderSoftware = (snapshot = sync?.snapshot()) => {
    softwareSection.textContent = "";
    const status = buildSoftwareStatus(softwareIdentity, snapshot);
    const headingRow = document.createElement("div");
    headingRow.className = "config-software-heading";
    const heading = document.createElement("h3");
    heading.className = "config-subtitle";
    heading.textContent = "Software & Updates";
    const badge = document.createElement("span");
    badge.className = `config-update-badge mode-${status.updateMode}`;
    badge.textContent = status.identity.runtime === "desktop"
      ? status.distributionLabel
      : "Hosted auto-update";
    headingRow.append(heading, badge);

    const grid = document.createElement("dl");
    grid.className = "config-software-grid";
    grid.append(
      softwareRow("Version", status.identity.version, "config-version"),
      softwareRow("Build", status.identity.runtimeLabel),
      softwareRow("Distribution", status.distributionLabel),
      softwareRow("Channel", "Stable · semantic versioning"),
      softwareRow("Revision", status.identity.revision ?? "Local/package build", "config-revision"),
      softwareRow(snapshot?.status.principal?.kind === "coauthor" ? "Library authentication" : "GitHub authentication", status.githubAuthentication),
      softwareRow("Library service", status.serviceLabel, `state-${status.serviceState}`),
    );
    if (status.serviceVersion || status.serviceRevision) {
      const serviceBuild = [status.serviceVersion, status.serviceRevision].filter(Boolean).join(" · ");
      grid.append(softwareRow("Service build", serviceBuild, "config-service-build"));
    }
    grid.append(softwareRow("App updates", status.updateLabel));
    if (status.identity.runtime === "desktop") {
      grid.append(softwareRow(
        "Release feed",
        status.releaseConfigured === true
          ? "Online and configured"
          : status.releaseConfigured === false ? "Setup incomplete" : "Not reported by service",
        status.releaseConfigured === false ? "state-setup" : "",
      ));
      grid.append(softwareRow("Update status", updatePhaseLabel(updateSnapshot), `update-${updateSnapshot.phase}`));
    }

    softwareSection.append(
      headingRow,
      grid,
      text(status.distributionDetail, "config-desc config-distribution-detail"),
      text(status.updateDetail, "config-desc config-update-detail"),
    );
    if (status.serviceVersion && status.serviceVersion !== status.identity.version) {
      softwareSection.append(text(
        `Version mismatch: app ${status.identity.version}, service ${status.serviceVersion}. ` +
        (status.identity.runtime === "web" ? "Reload the hosted app." : "Install the matching desktop release when available."),
        "config-sync-message config-version-warning",
      ));
    }
    const actions: Array<[string, () => void | Promise<void>]> = [];
    if (status.identity.runtime === "web") {
      actions.push([
        softwareChecking ? "Checking…" : "Check software status",
        async () => {
          if (softwareChecking) return;
          softwareChecking = true;
          renderSoftware();
          try {
            await sync?.refresh();
            lastSoftwareCheck = new Date();
          } finally {
            softwareChecking = false;
            renderSoftware();
          }
        },
      ]);
      actions.push(["Reload latest build", () => window.location.reload()]);
    } else {
      appendDesktopUpdateDetails(softwareSection, updateSnapshot);
      const phase = updateSnapshot.phase;
      if (phase === "available" || (phase === "error" && updateSnapshot.errorStage === "download")) {
        actions.push([`Download ${updateSnapshot.availableVersion ?? "update"}`, async () => {
          // In-DOM confirm — window.confirm() always returns false in the
          // desktop WebView, which silently disabled the whole update flow.
          const ok = await confirmDialog(
            `Download MdLyx ${updateSnapshot.availableVersion ?? "update"}? Installation will still require a separate confirmation.`,
            { confirmLabel: "Download" },
          );
          if (!ok) return;
          await updates.download();
        }]);
      } else if (
        phase === "downloaded" ||
        phase === "restart-required" ||
        (phase === "error" && (updateSnapshot.errorStage === "install" || updateSnapshot.errorStage === "relaunch"))
      ) {
        const restartOnly = phase === "restart-required" || updateSnapshot.errorStage === "relaunch";
        actions.push([restartOnly ? "Relaunch now" : "Install and relaunch", async () => {
          const message = restartOnly
            ? "The update is installed. Relaunch MdLyx now?"
            : "Install the verified update and relaunch MdLyx now? Open documents and recovery state will be preserved.";
          const ok = await confirmDialog(message, {
            confirmLabel: restartOnly ? "Relaunch" : "Install",
          });
          if (!ok) return;
          await updates.installAndRelaunch();
        }]);
      }
      if (desktopUpdateCanCheck(updateSnapshot)) {
        actions.push([softwareChecking ? "Checking…" : "Check now", async () => {
          if (softwareChecking) return;
          softwareChecking = true;
          renderSoftware();
          try {
            await Promise.all([sync?.refresh(), updates.check()]);
            lastSoftwareCheck = new Date();
          } finally {
            softwareChecking = false;
            renderSoftware();
          }
        }]);
      }
      if (phase === "auth-required" && sync) {
        actions.push(["Manage GitHub sign-in", () => open("library")]);
      }
      actions.push(["Open project releases", () => openExternalUrl("https://github.com/sfuchs-de/mdlyx/releases")]);
    }
    softwareSection.append(actionRow(actions));
    const checkedAt = updateSnapshot.checkedAt ? new Date(updateSnapshot.checkedAt) : lastSoftwareCheck;
    if (checkedAt) {
      softwareSection.append(text(`Last checked ${checkedAt.toLocaleTimeString()}`, "config-desc config-software-checked"));
    }
  };

  renderSoftware();
  updates.subscribe((snapshot) => {
    updateSnapshot = snapshot;
    reflectSoftwareUpdateAvailability(button, snapshot, defaultButtonTitle, defaultButtonLabel);
    renderSoftware();
  });
  void resolveSoftwareIdentity().then((identity) => {
    softwareIdentity = identity;
    renderSoftware();
    if (identity.runtime === "desktop" && updateSnapshot.phase === "idle") {
      // Check once after startup. An update is never downloaded or installed
      // without the separate confirmations rendered above.
      void updates.check();
    }
  });

  const syncSection = document.createElement("section");
  syncSection.id = "config-library-sync";
  syncSection.className = "config-sync";
  let lastPull: string | null = null;
  let lastSyncSnapshot = sync?.snapshot();

  const renderSync = (snapshot = sync?.snapshot()) => {
    syncSection.textContent = "";
    if (!sync || !snapshot) return;
    const heading = document.createElement("h3");
    heading.className = "config-subtitle";
    const shared = snapshot.status.principal?.kind === "coauthor";
    heading.textContent = shared ? "Shared Library" : "Library & GitHub Sync";
    const repo = text(
      shared
        ? `Private project access · ${snapshot.status.principal?.displayName ?? "Coauthor"}`
        : "Repository configured by this deployment",
      "config-desc config-repo",
    );
    const state = snapshot.status.state === "ready"
      ? snapshot.connected
        ? shared
          ? `Shared access as ${snapshot.status.principal?.displayName ?? "coauthor"}`
          : `Connected as @${snapshot.status.login ?? "GitHub user"}`
        : "GitHub sign-in or invitation needed"
      : snapshot.status.state === "offline" ? "Library service offline"
        : snapshot.status.state === "setup" ? "Render setup pending"
          : "Library sync unavailable";
    const status = text(state, `config-sync-state state-${snapshot.status.state}`);
    syncSection.append(heading, repo, status);
    if (shared && snapshot.status.expiresAt) {
      syncSection.append(text(
        `Session expires ${new Date(snapshot.status.expiresAt).toLocaleString()}`,
        "config-desc",
      ));
    }

    if (snapshot.device) {
      syncSection.append(
        text(`Code: ${snapshot.device.userCode}`, "config-sync-code"),
        text(`Expires in ${formatRemaining(snapshot.device.remainingSeconds)}`, "config-desc config-sync-countdown"),
        actionRow([
          ["Open GitHub verification", () => void sync.openVerification()],
          ["Copy code", () => void sync.copyCode()],
          ["Copy link", () => void sync.copyLink()],
          ["Cancel", () => sync.cancel()],
        ]),
      );
    } else if (snapshot.connected) {
      syncSection.append(actionRow([
        ["Pull latest", async () => {
          lastPull = await sync.pull() ? `Pulled ${new Date().toLocaleTimeString()}` : "Pull failed";
          renderSync();
        }],
        ["Sign out", () => void sync.logout()],
      ]));
    } else if (snapshot.status.state === "ready") {
      syncSection.append(actionRow([["Connect GitHub", () => void sync.start()]]));
    } else {
      syncSection.append(actionRow([["Check status", () => void sync.refresh()]]));
    }
    if (lastPull) syncSection.append(text(lastPull, "config-desc"));
    if (snapshot.error) syncSection.append(text(snapshot.error, "config-sync-message"));
    syncSection.append(text(
      shared
        ? "Repository storage and credentials remain private. Your access is limited to the projects listed above."
        : "GitHub App credentials and Render secrets remain on the server and are never stored in MdLyx.",
      "config-desc",
    ));
    if (shared && snapshot.status.grants?.length) {
      const grants = document.createElement("ul");
      grants.className = "config-shared-grants";
      for (const grant of snapshot.status.grants) {
        const item = document.createElement("li");
        item.textContent = `${grant.project} · ${grant.role}`;
        grants.append(item);
      }
      syncSection.append(grants);
    }
  };

  if (sync) {
    renderSync();
    sync.subscribe((snapshot) => {
      const previous = lastSyncSnapshot;
      lastSyncSnapshot = snapshot;
      // Software status includes the authenticated identity and release-service
      // metadata, not only the coarse service state. A ready -> ready sign-in
      // (or sign-out/account change) must therefore refresh this section too.
      if (!previous || softwareStatusChanged(previous, snapshot)) {
        lastSoftwareCheck = new Date();
        renderSoftware(snapshot);
      }
      if (
        snapshot.connected &&
        softwareIdentity.runtime === "desktop" &&
        updateSnapshot.phase === "auth-required"
      ) {
        void updates.check();
      }
      if (previous && sameSyncStructure(previous, snapshot) && snapshot.device) {
        const countdown = syncSection.querySelector<HTMLElement>(".config-sync-countdown");
        if (countdown) countdown.textContent = `Expires in ${formatRemaining(snapshot.device.remainingSeconds)}`;
      } else {
        renderSync(snapshot);
      }
    });
  }

  const localDataSection = document.createElement("section");
  localDataSection.id = "config-local-data";
  const localDataHeading = document.createElement("h3");
  localDataHeading.className = "config-subtitle";
  localDataHeading.textContent = "Local Recovery";
  localDataSection.append(
    localDataHeading,
    text(
      "MdLyx keeps open tabs, dirty revisions, recovery drafts, and supported browser file handles in this device's IndexedDB.",
      "config-desc",
    ),
  );
  let recoveryHistory: { render(): Promise<void> } | null = null;
  let recoveryHistoryLoading: Promise<void> | null = null;
  let loadRecoveryHistory: (() => Promise<void>) | null = null;
  if (localData) {
    const recoveryContainer = document.createElement("div");
    recoveryContainer.className = "config-recovery-history";
    loadRecoveryHistory = async () => {
      if (recoveryHistory) return recoveryHistory.render();
      if (recoveryHistoryLoading) return recoveryHistoryLoading;
      recoveryContainer.replaceChildren(text("Loading recovery history…", "config-desc"));
      const request = import("./recovery-history-settings").then(({ initRecoveryHistorySettings }) => {
        recoveryHistory = initRecoveryHistorySettings(
          recoveryContainer,
          localData,
          () => closeButton.click(),
        );
        return recoveryHistory.render();
      }).finally(() => {
        if (recoveryHistoryLoading === request) recoveryHistoryLoading = null;
      });
      recoveryHistoryLoading = request;
      return request;
    };
    const localActions = actionRow([
      ["Refresh history", () => loadRecoveryHistory?.()],
      ["Export recovery bundle", () => localData.exportBundle()],
      ["Clear local data", async () => {
        const ok = await confirmDialog(
          "Clear MdLyx tabs and recovery drafts stored on this device? GitHub and local files are not deleted.",
          { confirmLabel: "Clear", danger: true },
        );
        if (!ok) return;
        await localData.clear();
        window.location.reload();
      }],
    ]);
    localActions.lastElementChild?.classList.add("is-danger");
    localDataSection.append(recoveryContainer, localActions);
  }

  const sharingPanel = settingsPanel("sharing");
  let sharingLoaded = false;
  let sharingLoading: Promise<void> | null = null;
  let sharingLoadGeneration = 0;
  const loadSharingPanel = (): Promise<void> => {
    if (sharingLoaded) return Promise.resolve();
    if (sharingLoading) return sharingLoading;
    const generation = sharingLoadGeneration;
    sharingPanel.replaceChildren(text("Loading sharing controls…", "config-sync-state"));
    const request = import("./sharing-settings")
      .then(async ({ initSharingSettings }) => {
        if (generation !== sharingLoadGeneration) return;
        const controller = initSharingSettings(sharingPanel, sync);
        await controller.load();
        if (generation === sharingLoadGeneration) sharingLoaded = true;
        else sharingPanel.textContent = "";
      })
      .catch((error: unknown) => {
        if (generation !== sharingLoadGeneration) return;
        sharingPanel.replaceChildren(text(
          error instanceof Error ? error.message : "Could not load sharing controls.",
          "config-sync-message",
        ));
      })
      .finally(() => {
        if (sharingLoading === request) sharingLoading = null;
      });
    sharingLoading = request;
    return request;
  };

  const appearanceHeading = document.createElement("h3");
  appearanceHeading.className = "config-subtitle config-appearance-heading";
  appearanceHeading.textContent = "Editor Appearance";
  const libraryPanel = settingsPanel("library");
  if (sync) libraryPanel.append(syncSection);
  else libraryPanel.append(text("Library sync controls are unavailable in this context.", "config-desc"));

  const editorPanel = settingsPanel("editor");
  editorPanel.append(
    appearanceHeading,
    themeRow.row,
    body.row,
    display.row,
    sep,
    mathRow.row,
    mathDesc,
    spellcheckRow.row,
    languageRow,
    reset,
  );

  const softwarePanel = settingsPanel("software");
  softwarePanel.append(softwareSection);

  const dataPanel = settingsPanel("data");
  if (localData) dataPanel.append(localDataSection);
  else dataPanel.append(text("No local recovery controls are available in this context.", "config-desc"));
  if (diagnostics) {
    const diagnosticsSep = document.createElement("div");
    diagnosticsSep.className = "config-sep";
    const diagnosticsSection = document.createElement("section");
    diagnosticsSection.id = "config-diagnostics";
    const diagnosticsHeading = document.createElement("h3");
    diagnosticsHeading.className = "config-subtitle";
    diagnosticsHeading.textContent = "Diagnostics";
    diagnosticsSection.append(
      diagnosticsHeading,
      text(
        `${diagnostics.eventCount()} recent sanitized error${diagnostics.eventCount() === 1 ? "" : "s"}. Nothing is transmitted automatically.`,
        "config-desc",
      ),
      actionRow([
        ["Export diagnostic bundle", () => diagnostics.exportBundle()],
        ["Clear diagnostics", () => diagnostics.clear()],
      ]),
    );
    dataPanel.append(diagnosticsSep, diagnosticsSection);
  }
  const panels: Record<SettingsSection, HTMLElement> = {
    library: libraryPanel,
    sharing: sharingPanel,
    editor: editorPanel,
    software: softwarePanel,
    data: dataPanel,
  };
  const sections: SettingsSection[] = ["library", "sharing", "editor", "software", "data"];
  const tabs = new Map<SettingsSection, HTMLButtonElement>();
  let selectedSection = loadSettingsSection();
  const selectSection = (section: SettingsSection, focus = false, persist = true) => {
    if (section === "sharing" && tabs.get("sharing")?.hidden) section = "library";
    selectedSection = section;
    for (const candidate of sections) {
      const selected = candidate === section;
      const tab = tabs.get(candidate);
      if (tab) {
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
      panels[candidate].hidden = !selected;
    }
    if (persist) saveSettingsSection(section);
    if (section === "sharing") void loadSharingPanel();
    if (section === "data" && localData) {
      void loadRecoveryHistory?.();
    }
    if (focus) tabs.get(section)?.focus();
  };
  for (const section of sections) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.id = `config-tab-${section}`;
    tab.className = "config-tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panels[section].id);
    tab.textContent = settingsSectionLabel(section);
    if (section === "sharing") tab.hidden = true;
    tab.addEventListener("click", () => selectSection(section));
    tab.addEventListener("keydown", (event) => {
      const available = sections.filter((candidate) => !tabs.get(candidate)?.hidden);
      const current = available.indexOf(section);
      let next: number | null = null;
      if (event.key === "ArrowRight") next = (current + 1) % available.length;
      else if (event.key === "ArrowLeft") next = (current - 1 + available.length) % available.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = available.length - 1;
      if (next == null) return;
      event.preventDefault();
      selectSection(available[next], true);
    });
    tabs.set(section, tab);
    tabList.append(tab);
  }
  content.append(...sections.map((section) => panels[section]));
  panel.append(header, tabList, content);
  document.body.appendChild(panel);
  selectSection(selectedSection, false, false);
  if (sync) {
    sync.subscribe((snapshot) => {
      const visible = snapshot.status.capabilities?.canShare === true;
      const sharingTab = tabs.get("sharing");
      if (sharingTab) sharingTab.hidden = !visible;
      if (!visible) {
        sharingLoadGeneration++;
        sharingLoaded = false;
        sharingLoading = null;
        sharingPanel.textContent = "";
        if (selectedSection === "sharing") selectSection("library", false, false);
      }
    });
  }

  const panelController = new AnchoredPanelController(button, panel, {
    beforeOpen: () => mathRow.set(math.get()),
    initialFocus: () => tabs.get(selectedSection) ?? null,
  });
  closeButton.addEventListener("click", () => panelController.close());
  const open = (target?: SettingsOpenTarget) => {
    if (target) selectSection(normalizeSettingsSection(target));
    panelController.open();
    // Calling a deep link while Settings is already open still moves focus to
    // the selected tab instead of silently changing content behind the user.
    if (target) tabs.get(selectedSection)?.focus();
  };
  const close = () => panelController.close();
  return {
    get isOpen() { return panelController.isOpen; },
    open,
    close,
  };
}

function settingsPanel(section: SettingsSection): HTMLElement {
  const panel = document.createElement("section");
  panel.id = `config-section-${section}`;
  panel.className = "config-section";
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", `config-tab-${section}`);
  return panel;
}

function settingsSectionLabel(section: SettingsSection): string {
  return section[0].toUpperCase() + section.slice(1);
}

function normalizeSettingsSection(target: SettingsOpenTarget): SettingsSection {
  if (target === "library-sync") return "library";
  if (target === "local-data") return "data";
  return target;
}

function loadSettingsSection(): SettingsSection {
  try {
    const stored = localStorage.getItem(SETTINGS_SECTION_KEY);
    if (stored === "library" || stored === "sharing" || stored === "editor" || stored === "software" || stored === "data") {
      return stored;
    }
  } catch {
    // Preferences are best-effort in private/quota-constrained contexts.
  }
  return "library";
}

function saveSettingsSection(section: SettingsSection): void {
  try {
    localStorage.setItem(SETTINGS_SECTION_KEY, section);
  } catch {
    // Preferences are best-effort in private/quota-constrained contexts.
  }
}

function softwareStatusChanged(
  previous: LibrarySyncSnapshot,
  next: LibrarySyncSnapshot,
): boolean {
  return previous.status.state !== next.status.state
    || previous.status.authenticated !== next.status.authenticated
    || previous.status.login !== next.status.login
    || previous.status.principal?.id !== next.status.principal?.id
    || previous.status.principal?.kind !== next.status.principal?.kind
    || previous.status.serviceVersion !== next.status.serviceVersion
    || previous.status.serviceRevision !== next.status.serviceRevision
    || previous.status.releaseConfigured !== next.status.releaseConfigured
    || previous.connected !== next.connected;
}

function text(value: string, className: string): HTMLElement {
  const el = document.createElement("p");
  el.className = className;
  el.textContent = value;
  return el;
}

function actionRow(
  actions: Array<[string, () => void | Promise<void>]>,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "config-actions";
  for (const [label, action] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "config-action";
    button.textContent = label;
    button.addEventListener("click", () => void action());
    row.append(button);
  }
  return row;
}

function softwareRow(label: string, value: string, valueClass = ""): HTMLElement {
  const row = document.createElement("div");
  row.className = "config-software-row";
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.className = valueClass;
  detail.textContent = value;
  row.append(term, detail);
  return row;
}

function updatePhaseLabel(snapshot: SoftwareUpdateSnapshot): string {
  switch (snapshot.phase) {
    case "unsupported": return "Unavailable in this build";
    case "idle": return "Automatic check pending";
    case "checking": return "Checking private stable channel…";
    case "up-to-date": return "Up to date";
    case "available": return `${snapshot.availableVersion ?? "New version"} available`;
    case "downloading": return downloadProgressLabel(snapshot);
    case "downloaded": return `${snapshot.availableVersion ?? "Update"} ready to install`;
    case "installing": return "Installing verified update…";
    case "restart-required": return "Installed · relaunch required";
    case "relaunching": return "Relaunching…";
    case "auth-required": return "GitHub sign-in required";
    case "error": return "Update action failed";
  }
}

function downloadProgressLabel(snapshot: SoftwareUpdateSnapshot): string {
  if (snapshot.totalBytes && snapshot.totalBytes > 0) {
    const percent = Math.min(100, Math.round((snapshot.downloadedBytes / snapshot.totalBytes) * 100));
    return `Downloading ${percent}%`;
  }
  return snapshot.downloadedBytes > 0
    ? `Downloading ${formatBytes(snapshot.downloadedBytes)}`
    : "Starting download…";
}

function appendDesktopUpdateDetails(section: HTMLElement, snapshot: SoftwareUpdateSnapshot): void {
  if (snapshot.phase === "downloading") {
    const progress = document.createElement("progress");
    progress.className = "config-update-progress";
    progress.setAttribute("aria-label", "Desktop update download progress");
    if (snapshot.totalBytes && snapshot.totalBytes > 0) {
      progress.max = snapshot.totalBytes;
      progress.value = Math.min(snapshot.downloadedBytes, snapshot.totalBytes);
    }
    section.append(progress);
  }
  if (snapshot.publishedAt && snapshot.availableVersion) {
    const published = new Date(snapshot.publishedAt);
    const date = Number.isNaN(published.valueOf()) ? snapshot.publishedAt : published.toLocaleDateString();
    section.append(text(`MdLyx ${snapshot.availableVersion} · published ${date}`, "config-desc config-update-release"));
  }
  if (snapshot.notes) {
    const notes = snapshot.notes.length > 420 ? `${snapshot.notes.slice(0, 417)}…` : snapshot.notes;
    section.append(text(notes, "config-desc config-update-notes"));
  }
  if (snapshot.error) {
    section.append(text(snapshot.error, "config-sync-message config-update-error"));
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function desktopUpdateCanCheck(snapshot: SoftwareUpdateSnapshot): boolean {
  return snapshot.phase === "idle"
    || snapshot.phase === "up-to-date"
    || snapshot.phase === "available"
    || snapshot.phase === "auth-required"
    || (snapshot.phase === "error" && snapshot.errorStage === "check");
}

export function reflectSoftwareUpdateAvailability(
  button: HTMLButtonElement,
  snapshot: SoftwareUpdateSnapshot,
  defaultTitle = "Settings",
  defaultLabel = "Settings",
): void {
  const discovered = Boolean(snapshot.availableVersion) && (
    snapshot.phase === "available"
    || snapshot.phase === "downloading"
    || snapshot.phase === "downloaded"
    || snapshot.phase === "restart-required"
    || (snapshot.phase === "error" && snapshot.errorStage !== "check")
  );
  button.classList.toggle("update-available", discovered);
  if (discovered) {
    const state = snapshot.phase === "restart-required"
      ? "installed; relaunch required"
      : snapshot.phase === "downloaded"
        ? "ready to install"
        : "available";
    const label = `Settings — MdLyx ${snapshot.availableVersion} ${state}`;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.dataset.updateAvailable = snapshot.availableVersion ?? "true";
    return;
  }
  button.title = defaultTitle;
  button.setAttribute("aria-label", defaultLabel);
  delete button.dataset.updateAvailable;
}
