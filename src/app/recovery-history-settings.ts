import { confirmDialog } from "./dialogs";
import type {
  LocalDataSettingsControl,
  RecoveryRevisionSummary,
} from "./config";

export interface RecoveryHistorySettings {
  render(): Promise<void>;
}

export function initRecoveryHistorySettings(
  container: HTMLElement,
  localData: LocalDataSettingsControl,
  onOpen: () => void,
): RecoveryHistorySettings {
  const status = paragraph("", "config-desc config-recovery-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const list = document.createElement("div");
  list.className = "config-recovery-list";
  list.setAttribute("role", "list");
  let generation = 0;

  const render = async (): Promise<void> => {
    const current = ++generation;
    status.textContent = "Loading recovery history…";
    try {
      const revisions = await localData.listRecoveries();
      if (current !== generation) return;
      list.replaceChildren();
      if (!revisions.length) {
        status.textContent = "No separate recovery revisions are stored.";
        return;
      }
      status.textContent = `${revisions.length} recovery revision${revisions.length === 1 ? "" : "s"} stored on this device.`;
      for (const revision of revisions) {
        list.append(recoveryItem(revision, localData, status, render, onOpen));
      }
    } catch (error) {
      if (current !== generation) return;
      status.textContent = error instanceof Error
        ? error.message
        : "Recovery history is unavailable.";
    }
  };

  container.replaceChildren(status, list);
  return { render };
}

function recoveryItem(
  revision: RecoveryRevisionSummary,
  localData: LocalDataSettingsControl,
  status: HTMLElement,
  render: () => Promise<void>,
  onOpen: () => void,
): HTMLElement {
  const item = document.createElement("article");
  item.className = "config-recovery-item";
  item.setAttribute("role", "listitem");
  const heading = document.createElement("h4");
  heading.textContent = revision.name;
  const detail = paragraph(
    [
      new Date(revision.createdAt).toLocaleString(),
      recoveryKindLabel(revision.kind),
      revision.path,
    ].filter(Boolean).join(" · "),
    "config-recovery-detail",
  );
  const actions = document.createElement("div");
  actions.className = "config-actions";
  actions.append(
    action("Open copy", async () => {
      if (await localData.openRecovery(revision.id)) {
        status.textContent = `Opened ${revision.name} as a separate unsaved draft.`;
        onOpen();
      } else {
        status.textContent = "That recovery revision is no longer available.";
        await render();
      }
    }),
    action("Delete", async () => {
      const ok = await confirmDialog(
        `Delete the local recovery revision for ${revision.name}? The original library or local file is not changed.`,
        { confirmLabel: "Delete", danger: true },
      );
      if (!ok) return;
      await localData.deleteRecovery(revision.id);
      await render();
    }, true),
  );
  item.append(heading, detail, actions);
  return item;
}

function action(
  label: string,
  handler: () => void | Promise<void>,
  danger = false,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `config-action${danger ? " is-danger" : ""}`;
  button.textContent = label;
  button.addEventListener("click", () => void handler());
  return button;
}

function paragraph(value: string, className: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = value;
  return element;
}

function recoveryKindLabel(kind: RecoveryRevisionSummary["kind"]): string {
  switch (kind) {
    case "github-conflict": return "GitHub conflict";
    case "dirty-snapshot": return "Dirty snapshot";
    case "manual": return "Manual recovery";
  }
}
