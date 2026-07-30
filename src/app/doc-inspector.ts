import type { DocMeta, PublicationSettings } from "../markdown/frontmatter";
import type { NumberingConfig } from "../editor/numbering";
import {
  KINDS,
  STATUSES,
  REL_TYPES,
  relForward,
  relReverse,
  labelColor,
  parseList,
} from "./doc-meta";
import { AnchoredPanelController } from "./anchored-panel";

export interface InspectorHandlers {
  getMeta: () => DocMeta;
  updateMeta: (patch: Partial<DocMeta>) => void;
  getPublication: () => PublicationSettings;
  updatePublication: (patch: Partial<PublicationSettings>) => void;
  getNumbering: () => NumberingConfig;
  updateNumbering: (patch: Partial<NumberingConfig>) => void;
  isReadOnly: () => boolean;
  getFilename: () => string;
  // Known labels across the library, for input suggestions.
  getKnown: () => { projects: string[]; tags: string[] };
  // Library docs (id→title) for relation targets, computed backlinks, and
  // navigation. Empty when there is no folder library (#I70).
  getDocs: () => { id: string; title: string }[];
  getBacklinks: (id: string) => { id: string; title: string; rel: string }[];
  openDoc: (id: string) => void;
}

// A popover (same pattern as the Config panel) that edits the active document's
// library properties — title, kind, status, projects, tags, "contains". Writes
// straight to frontmatter via updateMeta (which dirties + autosaves the doc).
export class DocInspector {
  private readonly handlers: InspectorHandlers;
  private readonly panel: HTMLElement;
  private meta: DocMeta;
  private applying = false; // guard: ignore the onMeta echo of our own edit

  private titleInput!: HTMLInputElement;
  private kindInput!: HTMLInputElement;
  private statusInput!: HTMLInputElement;
  private projectsInput!: HTMLInputElement;
  private tagsInput!: HTMLInputElement;
  private containsInput!: HTMLInputElement;
  private projectsChips!: HTMLElement;
  private tagsChips!: HTMLElement;
  private containsChips!: HTMLElement;
  private relatedBox!: HTMLElement;
  private bibliographyInput!: HTMLInputElement;
  private documentClassInput!: HTMLSelectElement;
  private citationStyleInput!: HTMLSelectElement;
  private languageInput!: HTMLInputElement;
  private equationNumberingInput!: HTMLSelectElement;
  private headingNumberingInput!: HTMLSelectElement;

  constructor(button: HTMLButtonElement, handlers: InspectorHandlers) {
    this.handlers = handlers;
    this.meta = handlers.getMeta();

    this.panel = document.createElement("div");
    this.panel.id = "doc-inspector";
    this.panel.hidden = true;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "Document properties");
    this.build();
    document.body.appendChild(this.panel);
    new AnchoredPanelController(button, this.panel, {
      beforeOpen: () => {
        this.meta = this.handlers.getMeta();
        this.renderFields();
      },
      initialFocus: () => this.titleInput,
    });
  }

  // Called when metadata changes externally (a doc load, or the echo of our own
  // edit). We ignore our own edits so the field the user is typing in isn't reset.
  onExternalMeta(meta: DocMeta) {
    this.meta = meta;
    if (!this.applying && !this.panel.hidden) this.renderFields();
  }

  // --- build --------------------------------------------------------------
  private build() {
    const title = document.createElement("h2");
    title.className = "config-title";
    title.textContent = "Document properties";
    this.panel.append(title);

    const datalist = (id: string, opts: readonly string[]) => {
      const dl = document.createElement("datalist");
      dl.id = id;
      for (const o of opts) {
        const opt = document.createElement("option");
        opt.value = o;
        dl.append(opt);
      }
      return dl;
    };
    this.panel.append(datalist("insp-kinds", KINDS), datalist("insp-statuses", STATUSES));

    this.titleInput = this.textRow("Title", "");
    this.kindInput = this.textRow("Kind", "e.g. derivation", "insp-kinds");
    this.statusInput = this.textRow("Status", "e.g. draft", "insp-statuses");

    const projects = this.listRow("Projects", "add a project…");
    this.projectsInput = projects.input;
    this.projectsChips = projects.chips;

    const tags = this.listRow("Tags", "add a tag…");
    this.tagsInput = tags.input;
    this.tagsChips = tags.chips;

    const contains = this.listRow("Contains", "e.g. theorems, code");
    this.containsInput = contains.input;
    this.containsChips = contains.chips;

    // Commit scalar fields on change (blur/Enter) — avoids churn while typing.
    this.titleInput.addEventListener("change", () =>
      this.commit({ title: this.titleInput.value.trim() || undefined }),
    );
    this.kindInput.addEventListener("change", () =>
      this.commit({ kind: this.kindInput.value.trim() || undefined }),
    );
    this.statusInput.addEventListener("change", () =>
      this.commit({ status: this.statusInput.value.trim() || undefined }),
    );
    // List fields: append the typed items to the existing list.
    this.projectsInput.addEventListener("change", () => this.addTo("projects", this.projectsInput));
    this.tagsInput.addEventListener("change", () => this.addTo("tags", this.tagsInput));
    this.containsInput.addEventListener("change", () => this.addTo("contains", this.containsInput));

    const structureSep = document.createElement("div");
    structureSep.className = "config-sep";
    const structureLabel = document.createElement("div");
    structureLabel.className = "insp-section-label";
    structureLabel.textContent = "Structure & numbering";
    this.panel.append(structureSep, structureLabel);
    this.equationNumberingInput = this.selectRow(
      "Equation numbering",
      ["document", "section", "subsection"],
    );
    this.headingNumberingInput = this.selectRow(
      "Heading numbers",
      ["hidden", "shown"],
    );
    this.equationNumberingInput.addEventListener("change", () =>
      this.handlers.updateNumbering({
        equations: this.equationNumberingInput.value as NumberingConfig["equations"],
      }),
    );
    this.headingNumberingInput.addEventListener("change", () =>
      this.handlers.updateNumbering({
        headings: this.headingNumberingInput.value === "shown",
      }),
    );

    // Related documents (typed links + computed backlinks), rebuilt on render.
    const sep = document.createElement("div");
    sep.className = "config-sep";
    const relLabel = document.createElement("div");
    relLabel.className = "insp-section-label";
    relLabel.textContent = "Related";
    this.relatedBox = document.createElement("div");
    this.relatedBox.className = "insp-related";
    this.panel.append(sep, relLabel, this.relatedBox);

    const publicationSep = document.createElement("div");
    publicationSep.className = "config-sep";
    const publicationLabel = document.createElement("div");
    publicationLabel.className = "insp-section-label";
    publicationLabel.textContent = "Publication";
    this.panel.append(publicationSep, publicationLabel);
    this.bibliographyInput = this.textRow("Bibliography", "references/library.bib");
    this.documentClassInput = this.selectRow("Document class", ["article", "amsart"]);
    this.citationStyleInput = this.selectRow("Citation style", ["authoryear", "numeric"]);
    this.languageInput = this.textRow("Language", "en");
    const commitPublication = () => this.handlers.updatePublication({
      bibliography: parseList(this.bibliographyInput.value),
      documentClass: this.documentClassInput.value,
      citationStyle: this.citationStyleInput.value === "numeric" ? "numeric" : "authoryear",
      language: this.languageInput.value.trim() || "en",
      engine: "tectonic",
    });
    this.bibliographyInput.addEventListener("change", commitPublication);
    this.documentClassInput.addEventListener("change", commitPublication);
    this.citationStyleInput.addEventListener("change", commitPublication);
    this.languageInput.addEventListener("change", commitPublication);
  }

  private selectRow(label: string, values: string[]): HTMLSelectElement {
    const row = document.createElement("label");
    row.className = "insp-row";
    const text = document.createElement("span");
    text.className = "insp-label";
    text.textContent = label;
    const select = document.createElement("select");
    select.className = "insp-input";
    for (const value of values) select.add(new Option(value, value));
    row.append(text, select);
    this.panel.append(row);
    return select;
  }

  private textRow(label: string, placeholder: string, listId?: string): HTMLInputElement {
    const row = document.createElement("label");
    row.className = "insp-row";
    const l = document.createElement("span");
    l.className = "insp-label";
    l.textContent = label;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "insp-input";
    input.placeholder = placeholder;
    if (listId) input.setAttribute("list", listId);
    row.append(l, input);
    this.panel.append(row);
    return input;
  }

  private listRow(
    label: string,
    placeholder: string,
  ): { input: HTMLInputElement; chips: HTMLElement } {
    const wrap = document.createElement("div");
    wrap.className = "insp-listrow";
    const l = document.createElement("span");
    l.className = "insp-label";
    l.textContent = label;
    const chips = document.createElement("div");
    chips.className = "insp-chips";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "insp-input";
    input.placeholder = placeholder;
    wrap.append(l, chips, input);
    this.panel.append(wrap);
    return { input, chips };
  }

  // --- editing ------------------------------------------------------------
  private commit(patch: Partial<DocMeta>) {
    if (this.handlers.isReadOnly()) return;
    this.applying = true;
    this.handlers.updateMeta(patch);
    this.meta = this.handlers.getMeta();
    this.applying = false;
    this.renderChips();
    this.renderRelated();
  }

  private addTo(field: "projects" | "tags" | "contains", input: HTMLInputElement) {
    const added = parseList(input.value);
    if (!added.length) return;
    const existing = this.meta[field];
    const merged = [...existing];
    const lower = new Set(existing.map((s) => s.toLowerCase()));
    for (const a of added) {
      if (!lower.has(a.toLowerCase())) {
        lower.add(a.toLowerCase());
        merged.push(a);
      }
    }
    input.value = "";
    this.commit({ [field]: merged } as Partial<DocMeta>);
  }

  private removeFrom(field: "projects" | "tags" | "contains", value: string) {
    this.commit({
      [field]: this.meta[field].filter((v) => v !== value),
    } as Partial<DocMeta>);
  }

  // --- rendering ----------------------------------------------------------
  private renderFields() {
    this.titleInput.value = this.meta.title ?? "";
    this.titleInput.placeholder = this.handlers.getFilename().replace(/\.(md|markdown)$/i, "");
    this.kindInput.value = this.meta.kind ?? "";
    this.statusInput.value = this.meta.status ?? "";
    this.projectsInput.value = "";
    this.tagsInput.value = "";
    this.containsInput.value = "";
    const publication = this.handlers.getPublication();
    const numbering = this.handlers.getNumbering();
    this.equationNumberingInput.value = numbering.equations;
    this.headingNumberingInput.value = numbering.headings ? "shown" : "hidden";
    this.bibliographyInput.value = publication.bibliography.join(", ");
    this.documentClassInput.value = publication.documentClass;
    this.citationStyleInput.value = publication.citationStyle;
    this.languageInput.value = publication.language;
    this.refreshSuggestions();
    this.renderChips();
    this.renderRelated();
    const readOnly = this.handlers.isReadOnly();
    this.panel.classList.toggle("is-read-only", readOnly);
    this.panel.setAttribute("aria-readonly", String(readOnly));
    for (const control of this.panel.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea")) {
      control.disabled = readOnly;
    }
    for (const control of this.panel.querySelectorAll<HTMLButtonElement>("button")) {
      control.disabled = readOnly && !control.classList.contains("insp-rel-link");
    }
  }

  // Related documents: outgoing typed links (this doc → other), computed backlinks
  // (other → this doc, read-only), and a control to add a new link (#I70).
  private renderRelated() {
    const box = this.relatedBox;
    box.textContent = "";
    const docs = this.handlers.getDocs();
    const titleOf = (id: string) => docs.find((d) => d.id === id)?.title ?? id;
    const myId = this.meta.id;

    const linkRow = (text: string, id: string, removable?: () => void) => {
      const row = document.createElement("div");
      row.className = "insp-rel";
      const link = document.createElement("button");
      link.type = "button";
      link.className = "insp-rel-link";
      link.textContent = text;
      link.title = "Open this document";
      link.addEventListener("click", () => this.handlers.openDoc(id));
      row.append(link);
      if (removable) {
        const x = document.createElement("button");
        x.type = "button";
        x.className = "insp-chip-x";
        x.textContent = "×";
        x.title = "Remove link";
        x.addEventListener("click", removable);
        row.append(x);
      }
      box.append(row);
    };

    for (const r of this.meta.related) {
      linkRow(`${relForward(r.rel)} → ${titleOf(r.id)}`, r.id, () =>
        this.commit({
          related: this.meta.related.filter((o) => !(o.id === r.id && o.rel === r.rel)),
        }),
      );
    }
    if (myId) {
      for (const b of this.handlers.getBacklinks(myId)) {
        const row = document.createElement("div");
        row.className = "insp-rel insp-rel-back";
        const link = document.createElement("button");
        link.type = "button";
        link.className = "insp-rel-link";
        link.textContent = `${relReverse(b.rel)} ← ${b.title}`;
        link.addEventListener("click", () => this.handlers.openDoc(b.id));
        row.append(link);
        box.append(row);
      }
    }

    // Add control: pick a relation type + a target doc not already linked / self.
    const targets = docs.filter(
      (d) => d.id !== myId && !this.meta.related.some((r) => r.id === d.id),
    );
    if (targets.length) {
      const add = document.createElement("div");
      add.className = "insp-rel-add";
      const relSel = document.createElement("select");
      relSel.className = "insp-rel-sel";
      for (const rt of REL_TYPES) relSel.add(new Option(relForward(rt), rt));
      const tgtSel = document.createElement("select");
      tgtSel.className = "insp-rel-sel insp-rel-target";
      for (const d of targets) tgtSel.add(new Option(d.title, d.id));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "insp-rel-addbtn";
      btn.textContent = "Link";
      btn.addEventListener("click", () =>
        this.commit({ related: [...this.meta.related, { id: tgtSel.value, rel: relSel.value }] }),
      );
      add.append(relSel, tgtSel, btn);
      box.append(add);
    } else if (!this.meta.related.length && !(myId && this.handlers.getBacklinks(myId).length)) {
      const empty = document.createElement("div");
      empty.className = "insp-rel-empty";
      empty.textContent = docs.length
        ? "No related documents."
        : "Open a folder library to link documents.";
      box.append(empty);
    }
  }

  private refreshSuggestions() {
    // A datalist for project suggestions (tags reuse none for now — free text).
    const known = this.handlers.getKnown();
    let dl = document.getElementById("insp-projects") as HTMLDataListElement | null;
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = "insp-projects";
      this.panel.append(dl);
      this.projectsInput.setAttribute("list", "insp-projects");
    }
    dl.textContent = "";
    for (const p of known.projects) {
      const o = document.createElement("option");
      o.value = p;
      dl.append(o);
    }
  }

  private renderChips() {
    const fill = (
      host: HTMLElement,
      field: "projects" | "tags" | "contains",
      coloured: boolean,
    ) => {
      host.textContent = "";
      for (const v of this.meta[field]) {
        const chip = document.createElement("span");
        chip.className = `insp-chip${coloured ? " insp-chip-project" : ""}`;
        if (coloured) chip.style.setProperty("--chip", labelColor(v));
        const text = document.createElement("span");
        text.textContent = v;
        const x = document.createElement("button");
        x.type = "button";
        x.className = "insp-chip-x";
        x.textContent = "×";
        x.title = `Remove ${v}`;
        x.addEventListener("click", () => this.removeFrom(field, v));
        chip.append(text, x);
        host.append(chip);
      }
    };
    fill(this.projectsChips, "projects", true);
    fill(this.tagsChips, "tags", false);
    fill(this.containsChips, "contains", false);
  }

}
