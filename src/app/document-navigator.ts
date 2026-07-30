import { TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { Fragment } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { AnchoredPanelController } from "./anchored-panel";

export interface OutlineEntry {
  level: number;
  title: string;
  id?: string;
  position: number;
}

export interface TextMatch {
  from: number;
  to: number;
  text: string;
}

export function documentOutline(doc: PMNode): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  doc.forEach((node, position) => {
    if (node.type.name === "heading") entries.push({
      level: node.attrs.level as number,
      title: node.textContent || "Untitled heading",
      id: (node.attrs.id as string | null) ?? undefined,
      position,
    });
  });
  return entries;
}

export function findTextMatches(doc: PMNode, query: string): TextMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches: TextMatch[] = [];
  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    const haystack = node.text.toLocaleLowerCase();
    let from = 0;
    while ((from = haystack.indexOf(needle, from)) >= 0) {
      matches.push({
        from: position + from,
        to: position + from + needle.length,
        text: node.text.slice(from, from + needle.length),
      });
      from += Math.max(needle.length, 1);
    }
  });
  return matches;
}

export type OutlineSectionAction = "move-up" | "move-down" | "promote" | "demote";

interface OutlineSection extends OutlineEntry {
  end: number;
}

function outlineSections(doc: PMNode): OutlineSection[] {
  const entries = documentOutline(doc);
  return entries.map((entry, index) => {
    const next = entries.slice(index + 1).find((candidate) => candidate.level <= entry.level);
    return { ...entry, end: next?.position ?? doc.content.size };
  });
}

function previousSibling(sections: readonly OutlineSection[], index: number): OutlineSection | null {
  const current = sections[index];
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const candidate = sections[cursor];
    if (candidate.level < current.level) return null;
    if (candidate.level === current.level) return candidate;
  }
  return null;
}

function nextSibling(sections: readonly OutlineSection[], index: number): OutlineSection | null {
  const current = sections[index];
  for (let cursor = index + 1; cursor < sections.length; cursor++) {
    const candidate = sections[cursor];
    if (candidate.level < current.level) return null;
    if (candidate.level === current.level) return candidate;
  }
  return null;
}

export function outlineCommandAvailability(
  doc: PMNode,
  headingPosition: number,
): Record<OutlineSectionAction, boolean> {
  const sections = outlineSections(doc);
  const index = sections.findIndex((entry) => entry.position === headingPosition);
  if (index < 0) {
    return { "move-up": false, "move-down": false, promote: false, demote: false };
  }
  const section = sections[index];
  const subtree = sections.filter((entry) =>
    entry.position >= section.position && entry.position < section.end
  );
  return {
    "move-up": previousSibling(sections, index) !== null,
    "move-down": nextSibling(sections, index) !== null,
    promote: section.level > 1,
    demote:
      previousSibling(sections, index) !== null
      && subtree.every((entry) => entry.level < 6),
  };
}

export function transformOutlineSection(
  state: EditorState,
  headingPosition: number,
  action: OutlineSectionAction,
): { transaction: Transaction; headingPosition: number } | null {
  const sections = outlineSections(state.doc);
  const index = sections.findIndex((entry) => entry.position === headingPosition);
  if (index < 0 || !outlineCommandAvailability(state.doc, headingPosition)[action]) return null;
  const section = sections[index];
  let transaction = state.tr;
  let nextPosition = section.position;

  if (action === "move-up") {
    const sibling = previousSibling(sections, index)!;
    const siblingContent = state.doc.slice(sibling.position, section.position).content;
    const sectionContent = state.doc.slice(section.position, section.end).content;
    transaction = transaction.replaceWith(
      sibling.position,
      section.end,
      Fragment.fromArray([...sectionContent.content, ...siblingContent.content]),
    );
    nextPosition = sibling.position;
  } else if (action === "move-down") {
    const sibling = nextSibling(sections, index)!;
    const sectionContent = state.doc.slice(section.position, sibling.position).content;
    const siblingContent = state.doc.slice(sibling.position, sibling.end).content;
    transaction = transaction.replaceWith(
      section.position,
      sibling.end,
      Fragment.fromArray([...siblingContent.content, ...sectionContent.content]),
    );
    nextPosition = section.position + siblingContent.size;
  } else {
    const delta = action === "promote" ? -1 : 1;
    for (const entry of sections) {
      if (entry.position < section.position || entry.position >= section.end) continue;
      const node = transaction.doc.nodeAt(entry.position);
      if (!node || node.type.name !== "heading") continue;
      transaction = transaction.setNodeMarkup(entry.position, undefined, {
        ...node.attrs,
        level: (node.attrs.level as number) + delta,
      });
    }
  }

  transaction = transaction.setSelection(
    TextSelection.near(transaction.doc.resolve(nextPosition + 1)),
  ).scrollIntoView();
  return { transaction, headingPosition: nextPosition };
}

export class DocumentNavigator {
  private readonly panel = document.createElement("section");
  private readonly outline = document.createElement("nav");
  private readonly outlineControls = document.createElement("div");
  private readonly outlineStatus = document.createElement("span");
  private readonly query = document.createElement("input");
  private readonly replacement = document.createElement("input");
  private readonly result = document.createElement("span");
  private matches: TextMatch[] = [];
  private matchIndex = -1;
  private matchedDocument: PMNode | null = null;
  private selectedHeadingPosition: number | null = null;
  private readonly outlineActions = new Map<OutlineSectionAction, HTMLButtonElement>();

  constructor(
    button: HTMLButtonElement,
    private readonly view: EditorView,
  ) {
    this.panel.id = "document-navigator";
    this.panel.hidden = true;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "Document outline and find");

    const title = document.createElement("h2");
    title.className = "config-title";
    title.textContent = "Outline & find";
    this.outline.className = "document-outline";
    this.outline.setAttribute("aria-label", "Document outline");
    this.outlineControls.className = "outline-controls";
    this.outlineControls.setAttribute("role", "toolbar");
    this.outlineControls.setAttribute("aria-label", "Restructure selected section");
    for (const [command, label] of [
      ["move-up", "Move up"],
      ["move-down", "Move down"],
      ["promote", "Promote"],
      ["demote", "Demote"],
    ] as const) {
      const control = action(label, () => this.runOutlineCommand(command));
      this.outlineActions.set(command, control);
      this.outlineControls.append(control);
    }
    this.outlineStatus.className = "outline-status";
    this.outlineStatus.setAttribute("aria-live", "polite");

    this.query.type = "search";
    this.query.className = "navigator-input";
    this.query.placeholder = "Find in document…";
    this.query.setAttribute("aria-label", "Find in document");
    this.query.addEventListener("input", () => this.refreshMatches());
    this.query.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.selectRelative(event.shiftKey ? -1 : 1);
    });

    this.replacement.type = "text";
    this.replacement.className = "navigator-input";
    this.replacement.placeholder = "Replace with…";
    this.replacement.setAttribute("aria-label", "Replacement text");

    const controls = document.createElement("div");
    controls.className = "navigator-controls";
    controls.append(
      action("Previous", () => this.selectRelative(-1)),
      action("Next", () => this.selectRelative(1)),
      action("Replace", () => this.replaceCurrent()),
      action("All", () => this.replaceAll()),
    );
    this.result.className = "navigator-result";
    this.result.setAttribute("role", "status");
    this.result.setAttribute("aria-live", "polite");
    this.panel.append(
      title,
      this.outline,
      this.outlineControls,
      this.outlineStatus,
      this.query,
      this.replacement,
      controls,
      this.result,
    );
    document.body.append(this.panel);

    new AnchoredPanelController(button, this.panel, {
      beforeOpen: () => {
        this.renderOutline();
        this.refreshMatches();
      },
      initialFocus: () => this.query,
    });
  }

  private renderOutline(): void {
    this.outline.replaceChildren();
    const entries = outlineSections(this.view.state.doc);
    const selectionPosition = this.view.state.selection.from;
    if (
      this.selectedHeadingPosition === null
      || !entries.some((entry) => entry.position === this.selectedHeadingPosition)
    ) {
      this.selectedHeadingPosition =
        entries.find((entry) =>
          selectionPosition >= entry.position && selectionPosition < entry.end
        )?.position
        ?? entries[0]?.position
        ?? null;
    }
    for (const entry of entries) {
      const button = action(entry.title, () => {
        this.selectedHeadingPosition = entry.position;
        const selection = TextSelection.near(this.view.state.doc.resolve(entry.position + 1));
        this.view.dispatch(this.view.state.tr.setSelection(selection).scrollIntoView());
        this.renderOutline();
        this.view.focus();
      });
      button.className = "outline-entry";
      button.style.setProperty("--outline-level", String(Math.max(entry.level - 1, 0)));
      if (entry.id) button.title = `#${entry.id}`;
      if (entry.position === this.selectedHeadingPosition) {
        button.classList.add("is-selected");
        button.setAttribute("aria-current", "location");
      }
      this.outline.append(button);
    }
    if (!entries.length) this.outline.textContent = "No headings in this document.";
    this.renderOutlineControls();
  }

  private renderOutlineControls(): void {
    const availability = this.selectedHeadingPosition === null
      ? { "move-up": false, "move-down": false, promote: false, demote: false }
      : outlineCommandAvailability(this.view.state.doc, this.selectedHeadingPosition);
    for (const [command, button] of this.outlineActions) {
      button.disabled = !this.view.editable || !availability[command];
    }
    this.outlineControls.hidden = this.selectedHeadingPosition === null;
  }

  private runOutlineCommand(action: OutlineSectionAction): void {
    if (this.selectedHeadingPosition === null || !this.view.editable) return;
    const result = transformOutlineSection(
      this.view.state,
      this.selectedHeadingPosition,
      action,
    );
    if (!result) return;
    this.selectedHeadingPosition = result.headingPosition;
    this.view.dispatch(result.transaction);
    this.outlineStatus.textContent = {
      "move-up": "Section moved up.",
      "move-down": "Section moved down.",
      promote: "Section promoted.",
      demote: "Section demoted.",
    }[action];
    this.renderOutline();
    this.view.focus();
  }

  private refreshMatches(): void {
    this.matches = findTextMatches(this.view.state.doc, this.query.value);
    this.matchedDocument = this.view.state.doc;
    this.matchIndex = this.matches.length ? 0 : -1;
    this.renderResult();
  }

  private refreshIfDocumentChanged(): void {
    if (this.matchedDocument !== this.view.state.doc) this.refreshMatches();
  }

  private selectRelative(delta: number): void {
    this.refreshIfDocumentChanged();
    if (!this.matches.length) return;
    this.matchIndex = (this.matchIndex + delta + this.matches.length) % this.matches.length;
    const match = this.matches[this.matchIndex];
    this.view.dispatch(this.view.state.tr.setSelection(
      TextSelection.create(this.view.state.doc, match.from, match.to),
    ).scrollIntoView());
    this.view.focus();
    this.renderResult();
  }

  private replaceCurrent(): void {
    this.refreshIfDocumentChanged();
    if (this.matchIndex < 0) return;
    const match = this.matches[this.matchIndex];
    this.view.dispatch(this.view.state.tr.insertText(this.replacement.value, match.from, match.to));
    this.renderOutline();
    this.refreshMatches();
  }

  private replaceAll(): void {
    this.refreshIfDocumentChanged();
    if (!this.matches.length) return;
    let transaction = this.view.state.tr;
    for (const match of [...this.matches].reverse()) {
      transaction = transaction.insertText(this.replacement.value, match.from, match.to);
    }
    this.view.dispatch(transaction);
    this.renderOutline();
    this.refreshMatches();
  }

  private renderResult(): void {
    this.result.textContent = this.matches.length
      ? `${this.matchIndex + 1} of ${this.matches.length}`
      : this.query.value.trim() ? "No matches" : "";
  }
}

function action(label: string, handler: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}
