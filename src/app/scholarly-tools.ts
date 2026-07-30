import { NodeSelection, TextSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { schema } from "../editor/schema";
import { computeNumbering, type NumberingConfig } from "../editor/numbering";
import type { EffectivePublicationSettings } from "../publication/project-publication";
import type { PublicationSettings } from "../markdown/frontmatter";
import {
  addBibTeXEntry,
  createCitationKey,
  deleteBibTeXEntry,
  formatCitationCluster,
  parseBibTeXDocument,
  updateBibTeXEntry,
  type BibliographySource,
  type CitationCatalogSnapshot,
  type CitationDiagnostic,
  type CitationUsage,
} from "../publication/citation-catalog";
import {
  CitationCatalogCache,
} from "../publication/citation-catalog-cache";
import type { LibraryAsset, LibraryAssetWrite } from "./library-assets";
import { AnchoredPanelController } from "./anchored-panel";

export interface ScholarlyToolsHandlers {
  getPublication(projects?: readonly string[]): Promise<EffectivePublicationSettings | PublicationSettings>
    | EffectivePublicationSettings
    | PublicationSettings;
  getNumbering(): NumberingConfig;
  isReadOnly(): boolean;
  catalogIdentity?(): { providerIdentity: string; revision: string };
  citationUsages?(projects: readonly string[]): Promise<CitationUsage[]>;
  canEditBibliography?(projects: readonly string[]): boolean;
  onCitationCatalog?(snapshot: CitationCatalogSnapshot, publication: EffectivePublicationSettings): void;
  listAssets(): Promise<LibraryAsset[]>;
  readAsset(path: string): Promise<{ asset: LibraryAsset; bytes: Uint8Array }>;
  writeAsset(input: LibraryAssetWrite): Promise<LibraryAsset>;
}

interface CitationOption {
  key: string;
  preview: string;
}

const FIGURE_EXTENSIONS = /\.(?:avif|gif|jpe?g|pdf|png|svg|webp)$/i;
const REFERENCE_LABEL = /^[A-Za-z][\w:.-]*$/;
const THEOREM_PREFIX: Record<string, string> = {
  theorem: "thm",
  lemma: "lem",
  proposition: "prop",
  corollary: "cor",
  definition: "def",
};

export interface ReferenceTarget {
  key: string;
  position: number;
  kind: string;
  prefix: string;
  attr: "id" | "label";
  label?: string;
  title: string;
  number?: string;
  duplicate: boolean;
}

export function referenceTargets(doc: PMNode, config: NumberingConfig): ReferenceTarget[] {
  const numbering = computeNumbering(doc, config);
  const headingNumbers = new Map(numbering.headingPositions.map((entry) => [entry.pos, entry.num]));
  const equationNumbers = new Map(numbering.eqPositions.map((entry) => [entry.pos, entry.num]));
  const targets: ReferenceTarget[] = [];
  let figureNumber = 0;
  let tableNumber = 0;
  const theoremNumbers = new Map<string, number>();

  doc.descendants((node, position) => {
    let target: Omit<ReferenceTarget, "key" | "duplicate"> | null = null;
    if (node.type === schema.nodes.heading) {
      const label = (node.attrs.id as string | null) ?? undefined;
      target = {
        position,
        kind: "sec",
        prefix: "sec",
        attr: "id",
        label,
        title: node.textContent || "Untitled heading",
        number: headingNumbers.get(position),
      };
    } else if (node.type === schema.nodes.math_display && node.attrs.numbered) {
      const label = (node.attrs.label as string | null) ?? undefined;
      target = {
        position,
        kind: "eq",
        prefix: "eq",
        attr: "label",
        label,
        title: "Display equation",
        number: equationNumbers.get(position),
      };
    } else if (node.type === schema.nodes.figure) {
      figureNumber++;
      const label = (node.attrs.id as string | null) ?? undefined;
      target = {
        position,
        kind: "fig",
        prefix: "fig",
        attr: "id",
        label,
        title: String(node.attrs.caption || node.attrs.alt || node.attrs.src || "Figure"),
        number: String(figureNumber),
      };
    } else if (node.type === schema.nodes.table) {
      tableNumber++;
      const label = (node.attrs.id as string | null) ?? undefined;
      target = {
        position,
        kind: "tbl",
        prefix: "tbl",
        attr: "id",
        label,
        title: String(node.attrs.caption || "Table"),
        number: String(tableNumber),
      };
    } else if (node.type === schema.nodes.theorem && node.attrs.kind !== "proof") {
      const theoremKind = String(node.attrs.kind || "theorem").toLowerCase();
      const theoremNumber = (theoremNumbers.get(theoremKind) ?? 0) + 1;
      theoremNumbers.set(theoremKind, theoremNumber);
      const label = (node.attrs.id as string | null) ?? undefined;
      target = {
        position,
        kind: THEOREM_PREFIX[theoremKind] ?? "generic",
        prefix: THEOREM_PREFIX[theoremKind] ?? "ref",
        attr: "id",
        label,
        title: String(node.attrs.title || theoremKind),
        number: String(theoremNumber),
      };
    }
    if (!target) return true;
    targets.push({
      ...target,
      key: target.label ?? `auto:${position}`,
      duplicate: !!target.label && numbering.duplicates.has(target.label),
    });
    return true;
  });
  return targets;
}

export function createReferenceLabel(
  doc: PMNode,
  target: Pick<ReferenceTarget, "prefix" | "title">,
): string {
  const used = new Set<string>();
  doc.descendants((node) => {
    for (const key of ["id", "label"] as const) {
      const value = node.attrs[key];
      if (typeof value === "string" && value) used.add(value);
    }
  });
  const slug = target.title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/-+$/g, "") || target.prefix;
  const base = `${target.prefix}:${slug}`;
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

export function citationKeys(doc: PMNode): string[] {
  const keys = new Set<string>();
  doc.descendants((node) => {
    if (node.type !== schema.nodes.citation) return;
    for (const match of String(node.attrs.source).matchAll(/-?@([A-Za-z0-9_.:/-]+)/g)) {
      keys.add(match[1]);
    }
  });
  return [...keys];
}

export function nextFootnoteLabel(doc: PMNode, preferred = "note"): string {
  const base = preferred.trim().replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "note";
  const used = new Set<string>();
  doc.descendants((node) => {
    if (node.type === schema.nodes.footnote_ref || node.type === schema.nodes.footnote_definition) {
      used.add(String(node.attrs.label));
    }
  });
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

export function referenceKind(target: string): string {
  const prefix = target.includes(":") ? target.slice(0, target.indexOf(":")) : "";
  return new Set(["eq", "sec", "fig", "tbl", "thm", "lem", "prop", "cor", "def"]).has(prefix)
    ? prefix
    : "generic";
}

export class ScholarlyTools {
  private readonly panel = document.createElement("section");
  private readonly authoringView = document.createElement("div");
  private readonly bibliographyView = document.createElement("div");
  private readonly panelTabs = document.createElement("div");
  private readonly referenceSelect = document.createElement("select");
  private readonly referenceTargetsByKey = new Map<string, ReferenceTarget>();
  private readonly citationInput = document.createElement("input");
  private readonly citationList = document.createElement("datalist");
  private readonly locatorInput = document.createElement("input");
  private readonly citationPreview = document.createElement("div");
  private readonly citationDiagnostics = document.createElement("div");
  private readonly footnoteLabel = document.createElement("input");
  private readonly footnoteText = document.createElement("textarea");
  private readonly assetSelect = document.createElement("select");
  private readonly assetFile = document.createElement("input");
  private readonly assetPath = document.createElement("input");
  private readonly figureCaption = document.createElement("input");
  private readonly figureLabel = document.createElement("input");
  private readonly figureWidth = document.createElement("input");
  private readonly figureUpdate = action(
    "Update selected figure",
    () => this.updateSelectedFigure(),
  );
  private readonly theoremKind = document.createElement("select");
  private readonly theoremTitle = document.createElement("input");
  private readonly theoremLabel = document.createElement("input");
  private readonly theoremUpdate = action(
    "Update selected block",
    () => this.updateSelectedTheorem(),
  );
  private readonly rawLatex = document.createElement("textarea");
  private readonly status = document.createElement("div");
  private readonly bibliographySearch = document.createElement("input");
  private readonly bibliographyPath = document.createElement("select");
  private readonly bibliographyList = document.createElement("div");
  private readonly bibliographyForm = document.createElement("form");
  private readonly bibliographyKey = document.createElement("input");
  private readonly bibliographyType = document.createElement("select");
  private readonly bibliographyAuthor = document.createElement("input");
  private readonly bibliographyTitle = document.createElement("input");
  private readonly bibliographyYear = document.createElement("input");
  private readonly bibliographyVenue = document.createElement("input");
  private readonly bibliographyDoi = document.createElement("input");
  private readonly bibliographyUrl = document.createElement("input");
  private readonly bibliographyRaw = document.createElement("textarea");
  private readonly bibliographyUsage = document.createElement("div");
  private readonly bibliographySave = action("Save bibliography", () => void this.saveBibliography());
  private readonly bibliographyDelete = action("Delete entry", () => void this.deleteBibliographyEntry());
  private readonly catalogCache = new CitationCatalogCache();
  private assets: LibraryAsset[] = [];
  private readonly citationPreviews = new Map<string, string>();
  private catalogSnapshot: CitationCatalogSnapshot | null = null;
  private effectivePublication: EffectivePublicationSettings | null = null;
  private bibliographySources = new Map<string, BibliographySource>();
  private selectedBibliographyKey: string | null = null;
  private preferredProjects: readonly string[] | undefined;
  private refreshGeneration = 0;
  private readonly panelController: AnchoredPanelController;

  constructor(
    launcher: HTMLButtonElement,
    private readonly view: EditorView,
    private readonly handlers: ScholarlyToolsHandlers,
  ) {
    this.panel.id = "scholarly-tools";
    this.panel.hidden = true;
    this.panel.className = "scholarly-tools";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "References and publication tools");

    const title = document.createElement("h2");
    title.className = "config-title";
    title.textContent = "References & publication";
    this.buildPanelTabs();
    this.buildReferences();
    this.buildCitations();
    this.buildFootnotes();
    this.buildFigures();
    this.buildStructuredBlocks();
    this.buildBibliographyWorkspace();
    this.status.className = "scholarly-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.panel.prepend(title, this.panelTabs);
    const compileNote = document.createElement("p");
    compileNote.className = "scholarly-note";
    compileNote.textContent = "Publication settings affect TeX export. PDF compilation is not available yet.";
    this.panel.append(this.authoringView, this.bibliographyView, this.status, compileNote);
    document.body.append(this.panel);

    this.panelController = new AnchoredPanelController(launcher, this.panel, {
      beforeOpen: () => {
        this.renderReferences();
        this.renderSelectedFigure();
        this.renderSelectedTheorem();
        void this.refreshProjectSources();
      },
      initialFocus: () => this.bibliographyView.hidden
        ? this.referenceSelect
        : this.bibliographySearch,
      onClose: () => {
        this.preferredProjects = undefined;
      },
    });
    this.showPanelView("authoring");
  }

  openBibliography(project?: string): void {
    this.preferredProjects = project ? [project] : undefined;
    this.showPanelView("bibliography");
    this.panelController.open();
    void this.refreshProjectSources();
  }

  open(): void {
    this.showPanelView("authoring");
    this.panelController.open();
  }

  invalidateCatalog(): void {
    this.catalogCache.invalidate();
  }

  refreshCatalog(): Promise<void> {
    return this.refreshProjectSources();
  }

  private buildReferences(): void {
    const section = toolSection("Cross-reference");
    this.referenceSelect.setAttribute("aria-label", "Reference target");
    const insert = action("Insert reference", () => this.insertReference());
    section.append(this.referenceSelect, insert);
    this.authoringView.append(section);
  }

  private buildCitations(): void {
    const section = toolSection("Citation");
    this.citationList.id = "scholarly-citation-options";
    this.citationInput.type = "search";
    this.citationInput.placeholder = "Citation key";
    this.citationInput.setAttribute("aria-label", "Citation key");
    this.citationInput.setAttribute("list", this.citationList.id);
    this.citationInput.addEventListener("input", () => this.renderCitationPreview());
    this.locatorInput.placeholder = "Locator, for example p. 12";
    this.locatorInput.setAttribute("aria-label", "Citation locator");
    this.citationDiagnostics.className = "scholarly-diagnostics";
    this.citationPreview.className = "scholarly-citation-preview";
    this.citationPreview.setAttribute("aria-live", "polite");
    const insert = action("Insert citation", () => this.insertCitation());
    const refresh = action("Refresh bibliography", () => void this.refreshProjectSources());
    section.append(
      this.citationList,
      this.citationInput,
      this.citationPreview,
      this.locatorInput,
      row(insert, refresh),
      this.citationDiagnostics,
    );
    this.authoringView.append(section);
  }

  private buildFootnotes(): void {
    const section = toolSection("Footnote");
    this.footnoteLabel.placeholder = "Optional label";
    this.footnoteLabel.setAttribute("aria-label", "Footnote label");
    this.footnoteText.placeholder = "Footnote text";
    this.footnoteText.rows = 3;
    this.footnoteText.setAttribute("aria-label", "Footnote text");
    section.append(
      this.footnoteLabel,
      this.footnoteText,
      action("Insert footnote", () => this.insertFootnote()),
    );
    this.authoringView.append(section);
  }

  private buildFigures(): void {
    const section = toolSection("Figure & assets");
    this.assetSelect.setAttribute("aria-label", "Figure asset");
    this.figureCaption.placeholder = "Caption";
    this.figureCaption.setAttribute("aria-label", "Figure caption");
    this.figureLabel.placeholder = "Label, for example fig:clock";
    this.figureLabel.setAttribute("aria-label", "Figure label");
    this.figureWidth.placeholder = "Width, for example 70%";
    this.figureWidth.setAttribute("aria-label", "Figure width");
    this.assetFile.type = "file";
    this.assetFile.setAttribute("aria-label", "Choose asset file");
    this.assetFile.addEventListener("change", () => {
      const file = this.assetFile.files?.[0];
      if (file && !this.assetPath.value.trim()) this.assetPath.value = `assets/${file.name}`;
    });
    this.assetPath.placeholder = "Library path, for example assets/figure.png";
    this.assetPath.setAttribute("aria-label", "Asset library path");
    section.append(
      this.assetSelect,
      this.figureCaption,
      this.figureLabel,
      this.figureWidth,
      row(
        action("Insert figure", () => this.insertFigure()),
        this.figureUpdate,
      ),
      divider(),
      this.assetFile,
      this.assetPath,
      action("Add or replace asset", () => void this.uploadAsset()),
    );
    this.authoringView.append(section);
  }

  private buildStructuredBlocks(): void {
    const theoremSection = toolSection("Theorem, proof & definition");
    for (const kind of [
      "theorem",
      "lemma",
      "proposition",
      "corollary",
      "definition",
      "proof",
    ]) {
      this.theoremKind.add(new Option(kind.charAt(0).toUpperCase() + kind.slice(1), kind));
    }
    this.theoremKind.setAttribute("aria-label", "Structured block type");
    this.theoremTitle.placeholder = "Optional title";
    this.theoremTitle.setAttribute("aria-label", "Structured block title");
    this.theoremLabel.placeholder = "Optional label, for example thm:existence";
    this.theoremLabel.setAttribute("aria-label", "Structured block label");
    theoremSection.append(
      this.theoremKind,
      this.theoremTitle,
      this.theoremLabel,
      row(
        action("Insert structured block", () => this.insertTheorem()),
        this.theoremUpdate,
      ),
    );

    const rawSection = toolSection("Raw LaTeX");
    this.rawLatex.rows = 4;
    this.rawLatex.placeholder = "\\clearpage";
    this.rawLatex.setAttribute("aria-label", "Raw LaTeX source");
    const rawNote = document.createElement("p");
    rawNote.className = "scholarly-note";
    rawNote.textContent = "Export-only source is preserved in a fenced {=latex} block.";
    rawSection.append(
      this.rawLatex,
      action("Insert raw LaTeX", () => this.insertRawLatex()),
      rawNote,
    );
    this.authoringView.append(theoremSection, rawSection);
  }

  private buildPanelTabs(): void {
    this.panelTabs.className = "scholarly-tabs";
    this.panelTabs.setAttribute("role", "tablist");
    for (const [key, label] of [["authoring", "Insert"], ["bibliography", "Bibliography"]] as const) {
      const tab = action(label, () => this.showPanelView(key));
      tab.dataset.scholarlyTab = key;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", `scholarly-${key}-view`);
      this.panelTabs.append(tab);
    }
    this.authoringView.id = "scholarly-authoring-view";
    this.authoringView.className = "scholarly-view";
    this.authoringView.setAttribute("role", "tabpanel");
    this.bibliographyView.id = "scholarly-bibliography-view";
    this.bibliographyView.className = "scholarly-view scholarly-bibliography";
    this.bibliographyView.setAttribute("role", "tabpanel");
  }

  private showPanelView(view: "authoring" | "bibliography"): void {
    this.panel.classList.toggle("is-bibliography", view === "bibliography");
    this.authoringView.hidden = view !== "authoring";
    this.bibliographyView.hidden = view !== "bibliography";
    for (const tab of this.panelTabs.querySelectorAll<HTMLButtonElement>("[data-scholarly-tab]")) {
      const selected = tab.dataset.scholarlyTab === view;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    if (view === "bibliography" && this.panelController?.isOpen) {
      this.bibliographySearch.focus();
    }
  }

  private buildBibliographyWorkspace(): void {
    const toolbar = document.createElement("div");
    toolbar.className = "bibliography-toolbar";
    this.bibliographySearch.type = "search";
    this.bibliographySearch.placeholder = "Search key, author, title, year, DOI, or type";
    this.bibliographySearch.setAttribute("aria-label", "Search bibliography");
    this.bibliographySearch.addEventListener("input", () => this.renderBibliographyEntries());
    this.bibliographyPath.setAttribute("aria-label", "Bibliography file");
    this.bibliographyPath.addEventListener("change", () => {
      this.selectedBibliographyKey = null;
      this.renderBibliographyEntries();
      this.renderBibliographyEditor();
    });
    const add = action("Add entry", () => {
      this.selectedBibliographyKey = null;
      this.renderBibliographyEditor(true);
    });
    toolbar.append(this.bibliographySearch, this.bibliographyPath, add);

    this.bibliographyList.className = "bibliography-entry-list";
    this.bibliographyList.setAttribute("role", "list");
    this.bibliographyUsage.className = "bibliography-usage";

    this.bibliographyForm.className = "bibliography-editor";
    this.bibliographyForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.saveBibliography();
    });
    this.bibliographyKey.readOnly = true;
    this.bibliographyKey.setAttribute("aria-label", "Selected bibliography key");
    for (const type of ["article", "book", "incollection", "inproceedings", "techreport", "unpublished", "misc"]) {
      this.bibliographyType.add(new Option(type, type));
    }
    this.bibliographyType.setAttribute("aria-label", "Entry type");
    const fields: Array<[string, HTMLInputElement, string]> = [
      ["Author", this.bibliographyAuthor, "Smith, Jane and Doe, John"],
      ["Title", this.bibliographyTitle, "Publication title"],
      ["Year", this.bibliographyYear, "2024"],
      ["Venue", this.bibliographyVenue, "Journal, book title, or institution"],
      ["DOI", this.bibliographyDoi, "10.xxxx/…"],
      ["URL", this.bibliographyUrl, "https://…"],
    ];
    const grid = document.createElement("div");
    grid.className = "bibliography-form-grid";
    grid.append(field("Key", this.bibliographyKey), field("Type", this.bibliographyType));
    for (const [label, input, placeholder] of fields) {
      input.placeholder = placeholder;
      input.setAttribute("aria-label", label);
      grid.append(field(label, input));
    }
    this.bibliographyRaw.rows = 10;
    this.bibliographyRaw.setAttribute("aria-label", "Advanced raw BibTeX source");
    const rawDetails = document.createElement("details");
    rawDetails.className = "bibliography-raw";
    const rawSummary = document.createElement("summary");
    rawSummary.textContent = "Advanced raw-source repair";
    rawDetails.append(
      rawSummary,
      this.bibliographyRaw,
      action("Validate and save raw source", () => void this.saveRawBibliography()),
    );
    this.bibliographyDelete.classList.add("is-danger");
    this.bibliographyForm.append(
      grid,
      this.bibliographyUsage,
      rawDetails,
      row(this.bibliographySave, this.bibliographyDelete),
    );

    const body = document.createElement("div");
    body.className = "bibliography-workspace-body";
    body.append(this.bibliographyList, this.bibliographyForm);
    this.bibliographyView.append(toolbar, body);
  }

  private renderReferences(): void {
    this.referenceSelect.replaceChildren();
    this.referenceTargetsByKey.clear();
    for (const target of referenceTargets(this.view.state.doc, this.handlers.getNumbering())) {
      this.referenceTargetsByKey.set(target.key, target);
      const kind = target.kind === "sec"
        ? "Section"
        : target.kind === "eq"
          ? "Equation"
          : target.kind === "fig"
            ? "Figure"
            : target.kind === "tbl"
              ? "Table"
              : target.kind === "generic"
                ? "Result"
                : target.kind.charAt(0).toUpperCase() + target.kind.slice(1);
      const identity = target.label
        ? target.label
        : `Create label · ${kind}${target.number ? ` ${target.number}` : ""}`;
      const option = new Option(`${identity} — ${target.title}`, target.key);
      option.disabled = target.duplicate;
      this.referenceSelect.add(option);
    }
    if (!this.referenceSelect.options.length) {
      this.referenceSelect.add(new Option("No labelled targets", ""));
      this.referenceSelect.disabled = true;
    } else {
      this.referenceSelect.disabled = false;
    }
  }

  private async refreshProjectSources(): Promise<void> {
    const generation = ++this.refreshGeneration;
    this.setStatus("Loading project bibliography and assets…");
    const publication = asEffectivePublication(
      await this.handlers.getPublication(this.preferredProjects),
      this.preferredProjects,
    );
    let assets: LibraryAsset[] = [];
    try {
      assets = await this.handlers.listAssets();
      const identity = this.handlers.catalogIdentity?.() ?? {
        providerIdentity: "standalone",
        revision: publication.bibliography.join("|"),
      };
      const usages = await this.handlers.citationUsages?.(publication.projects) ?? [];
      const loaded = await this.catalogCache.load({
        providerIdentity: identity.providerIdentity,
        libraryRevision: identity.revision,
        publication,
        assets,
        read: (path) => this.handlers.readAsset(path),
        usages,
        citedKeys: citationKeys(this.view.state.doc),
      });
      this.catalogSnapshot = loaded.snapshot;
      this.effectivePublication = publication;
      this.handlers.onCitationCatalog?.(loaded.snapshot, publication);
      this.bibliographySources = new Map(loaded.snapshot.sources);
    } catch (error) {
      if (generation !== this.refreshGeneration) return;
      this.setStatus(error instanceof Error ? error.message : "Project assets are unavailable", true);
      this.renderCitations([], []);
      this.renderAssets([]);
      return;
    }
    if (generation !== this.refreshGeneration) return;
    this.assets = assets;
    const snapshot = this.catalogSnapshot!;
    const options: CitationOption[] = [...snapshot.entries].map(([key]) => ({
      key,
      preview: formatCitationCluster(`@${key}`, snapshot, publication.citationStyle).text,
    }));
    this.renderCitations(options, snapshot.diagnostics);
    this.renderAssets(assets.filter((asset) => FIGURE_EXTENSIONS.test(asset.path)));
    this.renderBibliographyWorkspace();
    const errors = snapshot.diagnostics.filter((item) => item.severity === "error").length;
    const warnings = snapshot.diagnostics.filter((item) => item.severity === "warning").length;
    this.setStatus(
      `${options.length} citations and ${assets.length} assets loaded${errors || warnings ? `; ${errors} errors, ${warnings} warnings` : ""}.`,
      errors > 0,
    );
  }

  private renderCitations(options: CitationOption[], diagnostics: readonly CitationDiagnostic[]): void {
    this.citationList.replaceChildren();
    this.citationPreviews.clear();
    for (const item of options.sort((a, b) => a.key.localeCompare(b.key))) {
      this.citationPreviews.set(item.key, item.preview);
      const option = document.createElement("option");
      option.value = item.key;
      option.label = item.preview;
      this.citationList.append(option);
    }
    this.citationDiagnostics.replaceChildren();
    for (const diagnostic of diagnostics.slice(0, 20)) {
      const item = document.createElement("div");
      item.className = `scholarly-diagnostic is-${diagnostic.severity}`;
      item.textContent = diagnostic.message;
      this.citationDiagnostics.append(item);
    }
    if (diagnostics.length > 20) {
      const more = document.createElement("div");
      more.textContent = `${diagnostics.length - 20} more diagnostics`;
      this.citationDiagnostics.append(more);
    }
    this.renderCitationPreview();
  }

  private renderCitationPreview(): void {
    const key = this.citationInput.value.trim().replace(/^@/, "");
    this.citationPreview.textContent = key
      ? this.citationPreviews.get(key) ?? "Citation key is not present in the configured bibliography."
      : "";
  }

  private renderBibliographyWorkspace(): void {
    const selectedPath = this.bibliographyPath.value;
    this.bibliographyPath.replaceChildren();
    for (const path of this.effectivePublication?.bibliography ?? []) {
      const source = this.bibliographySources.get(path);
      const label = `${path}${source ? ` · ${source.entries.length} entries` : " · unavailable"}`;
      this.bibliographyPath.add(new Option(label, path));
    }
    if (!this.bibliographyPath.options.length) {
      this.bibliographyPath.add(new Option("No project bibliography configured", ""));
      this.bibliographyPath.disabled = true;
    } else {
      this.bibliographyPath.disabled = false;
      if ([...this.bibliographyPath.options].some((option) => option.value === selectedPath)) {
        this.bibliographyPath.value = selectedPath;
      }
    }
    const selectedSource = this.bibliographySources.get(this.bibliographyPath.value);
    if (
      this.selectedBibliographyKey
      && !selectedSource?.entries.some((entry) => entry.key === this.selectedBibliographyKey)
    ) this.selectedBibliographyKey = null;
    this.renderBibliographyEntries();
    this.renderBibliographyEditor();
  }

  private renderBibliographyEntries(): void {
    this.bibliographyList.replaceChildren();
    const source = this.bibliographySources.get(this.bibliographyPath.value);
    const query = this.bibliographySearch.value.trim().toLowerCase();
    const entries = source?.entries.filter((entry) => {
      const haystack = [
        entry.key,
        entry.type,
        entry.fields.author,
        entry.fields.title,
        entry.fields.year,
        entry.fields.doi,
      ].filter(Boolean).join(" ").toLowerCase();
      return !query || haystack.includes(query);
    }) ?? [];
    for (const entry of entries) {
      const usages = this.catalogSnapshot?.usages.get(entry.key) ?? [];
      const card = action("", () => {
        this.selectedBibliographyKey = entry.key;
        this.renderBibliographyEntries();
        this.renderBibliographyEditor();
      });
      card.className = "bibliography-entry-card";
      card.setAttribute("role", "listitem");
      card.classList.toggle("is-selected", entry.key === this.selectedBibliographyKey);
      const title = document.createElement("strong");
      title.textContent = entry.fields.title || entry.key;
      const metadata = document.createElement("span");
      metadata.textContent = `${entry.key} · ${entry.fields.author || "Unknown author"}${entry.fields.year ? ` · ${entry.fields.year}` : ""}`;
      const count = document.createElement("span");
      const total = usages.reduce((sum, usage) => sum + usage.occurrences, 0);
      count.textContent = total ? `${total} ${total === 1 ? "use" : "uses"}` : "Unused";
      count.className = "bibliography-entry-count";
      card.append(title, metadata, count);
      this.bibliographyList.append(card);
    }
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "scholarly-note";
      empty.textContent = source
        ? "No entries match this search."
        : "Choose a configured bibliography file.";
      this.bibliographyList.append(empty);
    }
  }

  private renderBibliographyEditor(newEntry = false): void {
    const source = this.bibliographySources.get(this.bibliographyPath.value);
    const entry = !newEntry && this.selectedBibliographyKey
      ? source?.entries.find((candidate) => candidate.key === this.selectedBibliographyKey)
      : undefined;
    this.bibliographyForm.hidden = !source;
    if (!source) return;
    const fields = entry?.fields ?? {};
    this.bibliographyKey.value = entry?.key ?? "Generated when saved";
    this.bibliographyType.value = entry?.type ?? "article";
    this.bibliographyAuthor.value = fields.author ?? "";
    this.bibliographyTitle.value = fields.title ?? "";
    this.bibliographyYear.value = fields.year ?? "";
    this.bibliographyVenue.value = fields.journal ?? fields.booktitle ?? fields.institution ?? "";
    this.bibliographyDoi.value = fields.doi ?? "";
    this.bibliographyUrl.value = fields.url ?? "";
    this.bibliographyRaw.value = entry?.raw ?? source.source;
    const usages = entry ? this.catalogSnapshot?.usages.get(entry.key) ?? [] : [];
    const total = usages.reduce((sum, usage) => sum + usage.occurrences, 0);
    this.bibliographyUsage.replaceChildren();
    const summary = document.createElement("p");
    summary.textContent = entry
      ? `${total} project-wide ${total === 1 ? "citation" : "citations"}${entry.key ? ` for ${entry.key}` : ""}.`
      : "Create a curated project entry. Its stable key is generated from author, year, and title.";
    this.bibliographyUsage.append(summary);
    for (const usage of usages.slice(0, 12)) {
      const item = document.createElement("span");
      item.textContent = `${usage.documentTitle} · ${usage.occurrences}`;
      item.title = usage.documentPath;
      this.bibliographyUsage.append(item);
    }
    this.bibliographySave.disabled = !(this.handlers.canEditBibliography?.(
      this.effectivePublication?.projects ?? [],
    ) ?? !this.handlers.isReadOnly());
    this.bibliographyDelete.hidden = !entry;
    this.bibliographyDelete.disabled = total > 0
      || !(this.handlers.canEditBibliography?.(
        this.effectivePublication?.projects ?? [],
      ) ?? !this.handlers.isReadOnly());
    this.bibliographyDelete.title = total > 0
      ? `Deletion is blocked while ${total} project citation${total === 1 ? "" : "s"} use this key`
      : "";
  }

  private async saveBibliography(): Promise<void> {
    const path = this.bibliographyPath.value;
    const source = this.bibliographySources.get(path);
    if (!path || !source || !this.effectivePublication) {
      this.setStatus("Choose a configured bibliography first.", true);
      return;
    }
    if (!(this.handlers.canEditBibliography?.(this.effectivePublication.projects) ?? !this.handlers.isReadOnly())) {
      this.setStatus("This shared role may browse but not edit the project bibliography.", true);
      return;
    }
    const fields: Record<string, string> = {
      author: this.bibliographyAuthor.value.trim(),
      title: this.bibliographyTitle.value.trim(),
      year: this.bibliographyYear.value.trim(),
      doi: this.bibliographyDoi.value.trim(),
      url: this.bibliographyUrl.value.trim(),
    };
    const existing = this.selectedBibliographyKey
      ? source.entries.find((entry) => entry.key === this.selectedBibliographyKey)
      : undefined;
    const venue = this.bibliographyVenue.value.trim();
    const venueField = existing?.fields.journal !== undefined || this.bibliographyType.value === "article"
      ? "journal"
      : existing?.fields.booktitle !== undefined || this.bibliographyType.value === "incollection"
        ? "booktitle"
        : "institution";
    if (venue) fields[venueField] = venue;
    for (const [key, value] of Object.entries(existing?.fields ?? {})) {
      if (!(key in fields) && !["journal", "booktitle", "institution"].includes(key)) fields[key] = value;
    }
    if (!fields.author || !fields.title || !fields.year) {
      this.setStatus("Author, title, and year are required for a curated entry.", true);
      return;
    }
    const input = { type: this.bibliographyType.value, fields };
    const key = existing?.key ?? createCitationKey(input, this.catalogSnapshot?.entries.keys());
    const next = existing
      ? updateBibTeXEntry(source, existing.key, input)
      : addBibTeXEntry(source, key, input);
    await this.persistBibliography(path, next, key);
  }

  private async deleteBibliographyEntry(): Promise<void> {
    const path = this.bibliographyPath.value;
    const source = this.bibliographySources.get(path);
    const key = this.selectedBibliographyKey;
    if (!source || !key || !this.effectivePublication) return;
    const usages = this.catalogSnapshot?.usages.get(key) ?? [];
    if (usages.some((usage) => usage.occurrences > 0)) {
      this.setStatus(`Delete blocked: ${key} is still cited in this project.`, true);
      return;
    }
    if (!(this.handlers.canEditBibliography?.(this.effectivePublication.projects) ?? !this.handlers.isReadOnly())) {
      this.setStatus("This shared role may browse but not edit the project bibliography.", true);
      return;
    }
    await this.persistBibliography(path, deleteBibTeXEntry(source, key), null);
  }

  private async saveRawBibliography(): Promise<void> {
    const path = this.bibliographyPath.value;
    const source = this.bibliographySources.get(path);
    if (!path || !source || !this.effectivePublication) return;
    if (!(this.handlers.canEditBibliography?.(this.effectivePublication.projects) ?? !this.handlers.isReadOnly())) {
      this.setStatus("This shared role may browse but not edit the project bibliography.", true);
      return;
    }
    const selected = this.selectedBibliographyKey
      ? source.entries.find((entry) => entry.key === this.selectedBibliographyKey)
      : undefined;
    const raw = this.bibliographyRaw.value;
    const next = selected
      ? source.source.slice(0, selected.start) + raw.trim() + source.source.slice(selected.end)
      : raw;
    const parsed = parseBibTeXDocument(path, next);
    if (parsed.diagnostics.some((item) => item.severity === "error")) {
      this.setStatus(parsed.diagnostics.map((item) => item.message).join(" "), true);
      return;
    }
    if (selected && !parsed.entries.some((entry) => entry.key === selected.key)) {
      this.setStatus("Raw repair cannot rename or remove the selected citation key.", true);
      return;
    }
    await this.persistBibliography(path, next, selected?.key ?? null);
  }

  private async persistBibliography(
    path: string,
    next: string,
    selectedKey: string | null,
  ): Promise<void> {
    const asset = this.assets.find((candidate) => candidate.path === path);
    if (!asset) {
      this.setStatus(`Bibliography asset ${path} is missing.`, true);
      return;
    }
    this.setStatus(`Saving ${path}…`);
    try {
      await this.handlers.writeAsset({
        path,
        bytes: new TextEncoder().encode(next),
        mimeType: "application/x-bibtex",
        ...(asset.sha ? { ifMatch: asset.sha } : {}),
      });
      this.catalogCache.invalidate();
      this.selectedBibliographyKey = selectedKey;
      await this.refreshProjectSources();
      this.setStatus(`Saved ${path}.`);
    } catch (error) {
      const recovered = preserveBibliographyRecovery(path, next);
      try {
        const remote = await this.handlers.readAsset(path);
        this.bibliographySources.set(path, parseBibTeXDocument(path, new TextDecoder().decode(remote.bytes)));
        this.renderBibliographyWorkspace();
      } catch {
        // Keep the last readable source if the conflict refresh is also offline.
      }
      this.setStatus(
        `${error instanceof Error ? error.message : `Could not save ${path}`}. ${
          recovered
            ? "Local bibliography recovery was preserved"
            : "Local recovery storage was unavailable"
        } and the remote file was reloaded.`,
        true,
      );
    }
  }

  private renderAssets(assets: LibraryAsset[]): void {
    const selectedFigure = this.selectedFigure();
    const selected = selectedFigure
      ? String(selectedFigure.node.attrs.src ?? "")
      : this.assetSelect.value;
    this.assetSelect.replaceChildren();
    for (const asset of assets.sort((a, b) => a.path.localeCompare(b.path))) {
      this.assetSelect.add(new Option(asset.path, asset.path));
    }
    if (selected && !assets.some((asset) => asset.path === selected)) {
      this.assetSelect.add(new Option(`${selected} (current figure)`, selected));
    }
    if (!assets.length) this.assetSelect.add(new Option("No figure assets", ""));
    this.assetSelect.disabled = assets.length === 0 && !selected;
    if (selected) this.assetSelect.value = selected;
  }

  private insertReference(): void {
    const target = this.referenceTargetsByKey.get(this.referenceSelect.value);
    if (!target || target.duplicate || !this.canEdit()) return;
    const currentNode = this.view.state.doc.nodeAt(target.position);
    if (!currentNode) {
      this.setStatus("The selected reference target is no longer present.", true);
      this.renderReferences();
      return;
    }
    const label = target.label ?? createReferenceLabel(this.view.state.doc, target);
    let transaction = this.view.state.tr;
    if (!target.label) {
      transaction = transaction.setNodeMarkup(target.position, undefined, {
        ...currentNode.attrs,
        [target.attr]: label,
      });
    }
    transaction = this.insertInlineNode(
      // Markdown stores `@label` only, so its durable kind is necessarily the
      // label-prefix kind used again on parse. Auto-created labels always carry
      // the appropriate prefix; legacy unprefixed ids remain generic.
      schema.nodes.xref.create({ target: label, kind: referenceKind(label) }),
      transaction,
    );
    this.view.dispatch(transaction.scrollIntoView());
    this.view.focus();
    this.renderReferences();
    this.setStatus(
      target.label
        ? `Inserted reference to ${label}.`
        : `Created ${label} and inserted its reference.`,
    );
  }

  private insertCitation(): void {
    const key = this.citationInput.value.trim().replace(/^@/, "");
    if (!key || !/^[A-Za-z0-9_.:/-]+$/.test(key)) {
      this.setStatus("Choose a valid citation key.", true);
      return;
    }
    if (!this.canEdit()) return;
    const locator = this.locatorInput.value.trim();
    const transaction = this.insertInlineNode(
      schema.nodes.citation.create({ source: `@${key}${locator ? `, ${locator}` : ""}` }),
    );
    this.view.dispatch(transaction.scrollIntoView());
    this.view.focus();
    this.citationInput.value = "";
    this.locatorInput.value = "";
    this.setStatus(`Inserted citation ${key}.`);
  }

  private insertFootnote(): void {
    if (!this.canEdit()) return;
    const text = this.footnoteText.value.trim();
    if (!text) {
      this.setStatus("Enter footnote text before inserting it.", true);
      return;
    }
    const label = nextFootnoteLabel(this.view.state.doc, this.footnoteLabel.value);
    const reference = schema.nodes.footnote_ref.create({ label });
    const definition = schema.nodes.footnote_definition.create(
      { label },
      schema.nodes.paragraph.create(null, schema.text(text)),
    );
    let transaction = this.view.state.tr.replaceSelectionWith(reference, false);
    const caret = transaction.selection.from;
    transaction = transaction.insert(transaction.doc.content.size, definition);
    transaction = transaction.setSelection(TextSelection.near(transaction.doc.resolve(caret)));
    this.view.dispatch(transaction.scrollIntoView());
    this.view.focus();
    this.footnoteLabel.value = "";
    this.footnoteText.value = "";
    this.setStatus(`Inserted footnote ${label}.`);
  }

  private insertFigure(): void {
    if (!this.canEdit()) return;
    const src = this.assetSelect.value;
    if (!src) {
      this.setStatus("Choose or add a figure asset first.", true);
      return;
    }
    const id = this.figureLabel.value.trim();
    if (id && !/^[A-Za-z][\w:.-]*$/.test(id)) {
      this.setStatus("Figure labels must start with a letter and contain no spaces.", true);
      return;
    }
    const figure = schema.nodes.figure.create({
      src,
      alt: this.figureCaption.value.trim(),
      caption: this.figureCaption.value.trim(),
      id: id || null,
      width: this.figureWidth.value.trim() || null,
    });
    this.view.dispatch(this.view.state.tr.replaceSelectionWith(figure, false).scrollIntoView());
    this.view.focus();
    this.setStatus(`Inserted figure ${src}.`);
  }

  private selectedFigure(): { node: PMNode; position: number } | null {
    const selection = this.view.state.selection;
    if (
      selection instanceof NodeSelection
      && selection.node.type === schema.nodes.figure
    ) {
      return { node: selection.node, position: selection.from };
    }
    const nodeAfter = selection.$from.nodeAfter;
    if (nodeAfter?.type === schema.nodes.figure) {
      return { node: nodeAfter, position: selection.from };
    }
    return null;
  }

  private renderSelectedFigure(): void {
    const selected = this.selectedFigure();
    this.figureUpdate.disabled = !selected || this.handlers.isReadOnly();
    if (!selected) return;
    const src = String(selected.node.attrs.src ?? "");
    if (src && ![...this.assetSelect.options].some((option) => option.value === src)) {
      this.assetSelect.add(new Option(`${src} (current figure)`, src));
    }
    this.assetSelect.disabled = false;
    this.assetSelect.value = src;
    this.figureCaption.value = String(selected.node.attrs.caption ?? selected.node.attrs.alt ?? "");
    this.figureLabel.value = String(selected.node.attrs.id ?? "");
    this.figureWidth.value = String(selected.node.attrs.width ?? "");
  }

  private updateSelectedFigure(): void {
    const selected = this.selectedFigure();
    if (!selected || !this.canEdit()) {
      this.setStatus("Select a figure to update it.", true);
      return;
    }
    const src = this.assetSelect.value;
    if (!src) {
      this.setStatus("Choose a figure asset first.", true);
      return;
    }
    const id = this.figureLabel.value.trim();
    if (id && !REFERENCE_LABEL.test(id)) {
      this.setStatus("Figure labels must start with a letter and contain no spaces.", true);
      return;
    }
    const caption = this.figureCaption.value.trim();
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(selected.position, undefined, {
        ...selected.node.attrs,
        src,
        alt: caption,
        caption,
        id: id || null,
        width: this.figureWidth.value.trim() || null,
      }),
    );
    this.renderReferences();
    this.renderSelectedFigure();
    this.setStatus(`Updated figure ${src}.`);
  }

  private insertTheorem(): void {
    if (!this.canEdit()) return;
    const label = this.theoremLabel.value.trim();
    if (label && !REFERENCE_LABEL.test(label)) {
      this.setStatus("Structured-block labels must start with a letter and contain no spaces.", true);
      return;
    }
    const selection = this.view.state.selection;
    const selectedText = selection.empty
      ? ""
      : this.view.state.doc.textBetween(selection.from, selection.to, " ").trim();
    const paragraph = schema.nodes.paragraph.create(
      null,
      selectedText ? schema.text(selectedText) : undefined,
    );
    const theorem = schema.nodes.theorem.create({
      kind: this.theoremKind.value,
      title: this.theoremTitle.value.trim() || null,
      id: label || null,
    }, paragraph);
    this.view.dispatch(
      this.view.state.tr.replaceSelectionWith(theorem, false).scrollIntoView(),
    );
    this.view.focus();
    this.theoremTitle.value = "";
    this.theoremLabel.value = "";
    this.renderReferences();
    this.setStatus(`Inserted ${this.theoremKind.value}.`);
  }

  private selectedTheorem(): { node: PMNode; position: number } | null {
    const selection = this.view.state.selection;
    if (
      selection instanceof NodeSelection
      && selection.node.type === schema.nodes.theorem
    ) {
      return { node: selection.node, position: selection.from };
    }
    const $from = selection.$from;
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth);
      if (node.type === schema.nodes.theorem) {
        return { node, position: $from.before(depth) };
      }
    }
    return null;
  }

  private renderSelectedTheorem(): void {
    const selected = this.selectedTheorem();
    this.theoremUpdate.disabled = !selected || this.handlers.isReadOnly();
    if (!selected) return;
    const kind = String(selected.node.attrs.kind || "theorem");
    if (![...this.theoremKind.options].some((option) => option.value === kind)) {
      this.theoremKind.add(
        new Option(kind.charAt(0).toUpperCase() + kind.slice(1), kind),
      );
    }
    this.theoremKind.value = kind;
    this.theoremTitle.value = String(selected.node.attrs.title ?? "");
    this.theoremLabel.value = String(selected.node.attrs.id ?? "");
  }

  private updateSelectedTheorem(): void {
    const selected = this.selectedTheorem();
    if (!selected || !this.canEdit()) {
      this.setStatus("Place the caret inside a structured block to update it.", true);
      return;
    }
    const label = this.theoremLabel.value.trim();
    if (label && !REFERENCE_LABEL.test(label)) {
      this.setStatus("Structured-block labels must start with a letter and contain no spaces.", true);
      return;
    }
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(selected.position, undefined, {
        ...selected.node.attrs,
        kind: this.theoremKind.value,
        title: this.theoremTitle.value.trim() || null,
        id: label || null,
      }),
    );
    this.renderReferences();
    this.setStatus(`Updated ${this.theoremKind.value}.`);
  }

  private insertRawLatex(): void {
    if (!this.canEdit()) return;
    const latex = this.rawLatex.value.trim();
    if (!latex) {
      this.setStatus("Enter LaTeX source before inserting the block.", true);
      return;
    }
    this.view.dispatch(
      this.view.state.tr.replaceSelectionWith(
        schema.nodes.raw_latex.create({ latex }),
        false,
      ).scrollIntoView(),
    );
    this.view.focus();
    this.rawLatex.value = "";
    this.setStatus("Inserted raw LaTeX block.");
  }

  private async uploadAsset(): Promise<void> {
    if (!this.canEdit()) return;
    const file = this.assetFile.files?.[0];
    if (!file) {
      this.setStatus("Choose a file to add.", true);
      return;
    }
    const path = this.assetPath.value.trim();
    if (!path) {
      this.setStatus("Enter a library-relative asset path.", true);
      return;
    }
    this.setStatus(`Saving ${path}…`);
    try {
      const existing = this.assets.find((asset) => asset.path === path);
      await this.handlers.writeAsset({
        path,
        bytes: new Uint8Array(await file.arrayBuffer()),
        mimeType: file.type || "application/octet-stream",
        ...(existing?.sha ? { ifMatch: existing.sha } : {}),
      });
      this.assetFile.value = "";
      await this.refreshProjectSources();
      this.assetSelect.value = path;
      this.setStatus(`Saved ${path}.`);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : `Could not save ${path}`, true);
    }
  }

  private insertInlineNode(node: PMNode, transaction = this.view.state.tr) {
    const selection = transaction.selection;
    if (selection instanceof NodeSelection || !selection.$from.parent.inlineContent) {
      return transaction.insert(
        selection.to,
        schema.nodes.paragraph.create(null, node),
      );
    }
    return transaction.replaceSelectionWith(node, false);
  }

  private canEdit(): boolean {
    if (!this.handlers.isReadOnly()) return true;
    this.setStatus("This generated document is read-only.", true);
    return false;
  }

  private setStatus(message: string, error = false): void {
    this.status.textContent = message;
    this.status.classList.toggle("is-error", error);
  }
}

function toolSection(title: string): HTMLElement {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "scholarly-section";
  const legend = document.createElement("legend");
  legend.textContent = title;
  fieldset.append(legend);
  return fieldset;
}

function action(label: string, handler: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function row(...children: HTMLElement[]): HTMLElement {
  const element = document.createElement("div");
  element.className = "scholarly-actions";
  element.append(...children);
  return element;
}

function divider(): HTMLElement {
  const element = document.createElement("hr");
  element.className = "scholarly-divider";
  return element;
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const wrapper = document.createElement("label");
  wrapper.className = "bibliography-field";
  const text = document.createElement("span");
  text.textContent = label;
  wrapper.append(text, control);
  return wrapper;
}

function preserveBibliographyRecovery(path: string, source: string): boolean {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    localStorage.setItem(
      `mdlyx:bibliography-recovery:${path}:${timestamp}`,
      source,
    );
    return true;
  } catch {
    // Save failure remains visible. Quota denial must not hide the remote
    // conflict, even though the local recovery could not be retained.
    return false;
  }
}

function asEffectivePublication(
  publication: EffectivePublicationSettings | PublicationSettings,
  projects: readonly string[] | undefined,
): EffectivePublicationSettings {
  if ("bibliographySources" in publication) return publication;
  return {
    ...publication,
    projects: [...(projects ?? [])],
    bibliographySources: publication.bibliography.map((path) => ({
      project: projects?.[0] ?? "",
      path,
    })),
    diagnostics: [],
    inheritedFields: [],
    overriddenFields: [],
  };
}
