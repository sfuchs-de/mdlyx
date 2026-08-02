import {
  leanCertificateBadgeText,
  leanCertificateDescription,
  type LeanCertificateEvidence,
} from "./lean-certificates";

export function createLeanCertificateBadge(
  evidence: LeanCertificateEvidence,
  onOpenOwner?: () => void,
): HTMLButtonElement {
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = `lean-certificate-badge coverage-${evidence.coverage}`;
  badge.textContent = leanCertificateBadgeText(evidence);
  badge.title = leanCertificateDescription(evidence);
  badge.setAttribute(
    "aria-label",
    `Lean kernel certificate for ${evidence.resultId}, ${evidence.coverage} coverage. Open proof evidence.`,
  );
  badge.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openLeanCertificateEvidence(evidence, onOpenOwner);
  });
  return badge;
}

export function openLeanCertificateEvidence(
  evidence: LeanCertificateEvidence,
  onOpenOwner?: () => void,
): void {
  const dialog = document.createElement("dialog");
  dialog.className = "lean-certificate-dialog";
  dialog.setAttribute("aria-labelledby", "lean-certificate-dialog-title");
  const header = element("header", "lean-certificate-dialog-header");
  const heading = element(
    "h2",
    "lean-certificate-dialog-title",
    `${leanCertificateBadgeText(evidence)} · Lean certificate`,
  );
  heading.id = "lean-certificate-dialog-title";
  const close = button("Close", "lean-certificate-dialog-close", () => closeDialog(dialog));
  header.append(heading, close);

  const lead = element(
    "p",
    "lean-certificate-dialog-lead",
    `${evidence.resultId} · ${evidence.resultTitle}`,
  );
  const state = element(
    "p",
    `lean-certificate-coverage coverage-${evidence.coverage}`,
    evidence.coverage === "full"
      ? "Lean kernel checked · full declared-result coverage"
      : "Lean kernel checked · partial coverage",
  );
  const body = element("div", "lean-certificate-dialog-body");
  body.append(
    evidenceSection("Certified scope", evidence.certifiedScope),
    evidenceSection("Assumptions", evidence.assumptions),
  );
  if (evidence.excludedScope.length) {
    body.append(evidenceSection("Not certified", evidence.excludedScope, "is-excluded"));
  }
  body.append(
    evidenceSection("Lean declarations", evidence.declarations),
    metadataTable(evidence),
    sourceDisclosure(evidence),
  );

  const footer = element("footer", "lean-certificate-dialog-footer");
  if (onOpenOwner) {
    footer.append(button("Open owning result", "lean-certificate-owner", () => {
      closeDialog(dialog);
      onOpenOwner();
    }));
  }
  footer.append(button("Done", "lean-certificate-done", () => closeDialog(dialog)));
  dialog.append(header, lead, state, body, footer);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  if (typeof dialog.showModal === "function") dialog.showModal();
  else {
    dialog.setAttribute("open", "");
    close.focus();
  }
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") dialog.close();
  else {
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
  }
}

function evidenceSection(title: string, values: readonly string[], extra = ""): HTMLElement {
  const section = element("section", `lean-certificate-section ${extra}`.trim());
  section.append(element("h3", "lean-certificate-section-title", title));
  const list = element("ul", "lean-certificate-list");
  for (const value of values) list.append(element("li", "lean-certificate-list-item", value));
  section.append(list);
  return section;
}

function metadataTable(evidence: LeanCertificateEvidence): HTMLElement {
  const dl = element("dl", "lean-certificate-metadata");
  for (const [label, value] of [
    ["Build", evidence.buildState],
    ["Lean", evidence.leanVersion],
    ["Mathlib", evidence.mathlibVersion],
    ["Owner", evidence.ownerPath],
    ["Certificate source", evidence.sourcePath],
    ["Pinned manifest", evidence.manifestPath],
  ]) {
    dl.append(element("dt", "", label), element("dd", "", value));
  }
  return dl;
}

function sourceDisclosure(evidence: LeanCertificateEvidence): HTMLElement {
  const disclosure = document.createElement("details");
  disclosure.className = "lean-certificate-source";
  const summary = document.createElement("summary");
  summary.textContent = `View certificate source · ${evidence.sourcePath}`;
  const code = document.createElement("code");
  code.textContent = evidence.sourceText;
  const pre = document.createElement("pre");
  pre.append(code);
  disclosure.append(summary, pre);
  return disclosure;
}

function button(label: string, className: string, action: () => void): HTMLButtonElement {
  const value = document.createElement("button");
  value.type = "button";
  value.className = className;
  value.textContent = label;
  value.addEventListener("click", action);
  return value;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}
