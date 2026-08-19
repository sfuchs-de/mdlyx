import {
  buildDependencyCatalog,
  downstreamOf,
  parseDependencyManifest,
  resultClaimAnchors,
  resultDerivationAnchors,
  resultsForProject,
  upstreamOf,
  type DependencyCatalog,
  type DependencyManifestSource,
  type GraphDiagnostic,
  type ResultNode,
  type ValidationState,
} from "./dependency-graph";
import { DependencyGraphCanvas } from "./dependency-graph-canvas";
import type { ProjectCatalogLoadResult } from "./project-catalog-controller";
import { savedProjectSelection, saveProjectSelection } from "./project-selection";
import { MobileSheetController } from "./mobile-sheet";
import { createResultInspector } from "./result-inspector";

export interface ProjectGraphHandlers {
  sources: () => DependencyManifestSource[];
  documents: () => { id: string; title: string }[];
  loadCatalog?: (force?: boolean) => Promise<ProjectCatalogLoadResult>;
  openDocument: (id: string, anchor?: string) => Promise<boolean>;
  onModeChange: (open: boolean, restoreLauncherFocus?: boolean) => void;
  onProjectChange?: (project: string) => void;
}

export class ProjectGraphView {
  private readonly root: HTMLElement;
  private readonly handlers: ProjectGraphHandlers;
  private catalog: DependencyCatalog | null = null;
  private sources: DependencyManifestSource[] = [];
  private project = "";
  private query = "";
  private unresolvedOnly = false;
  private upstreamOnly = false;
  private downstreamOnly = false;
  private selectedId: string | null = null;
  private loadErrors: string[] = [];
  private canvas: DependencyGraphCanvas | null = null;
  private navigationError = "";
  private loadGeneration = 0;
  private readonly directionMedia: MediaQueryList | null;
  private readonly mobileSheetControllers: MobileSheetController[] = [];
  private readonly mobilePortals: HTMLElement[] = [];
  private detailsHost: HTMLElement | null = null;
  private detailsController: MobileSheetController | null = null;

  constructor(root: HTMLElement, handlers: ProjectGraphHandlers) {
    this.root = root;
    this.handlers = handlers;
    this.root.classList.add("project-graph");
    this.root.hidden = true;
    this.directionMedia = typeof matchMedia === "function"
      ? matchMedia("(max-width: 599px)")
      : null;
    this.directionMedia?.addEventListener?.("change", this.onDirectionChange);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  async open(preferredProject?: string): Promise<void> {
    const focusAtOpen = document.activeElement;
    this.root.hidden = false;
    this.handlers.onModeChange(true);
    await this.load(preferredProject);
    requestAnimationFrame(() => {
      // Loading and laying out a graph is asynchronous. A keyboard user can
      // reach a result as soon as it is rendered, before this frame runs. Do
      // not steal that deliberate focus just to complete the initial handoff.
      const active = document.activeElement;
      if (active !== focusAtOpen && active !== document.body) return;
      this.root.querySelector<HTMLElement>(".graph-title")?.focus();
    });
  }

  close(restoreLauncherFocus = true): void {
    this.loadGeneration++;
    this.destroyMobileSheets();
    this.root.hidden = true;
    this.handlers.onModeChange(false, restoreLauncherFocus);
  }

  async reload(force = false): Promise<void> {
    if (!this.isOpen) return;
    await this.load(this.project, force);
  }

  private async load(preferredProject?: string, force = false): Promise<void> {
    const generation = ++this.loadGeneration;
    this.renderLoading();
    const sources = this.handlers.sources();
    const loadErrors: string[] = [];
    let catalog: DependencyCatalog;
    if (this.handlers.loadCatalog) {
      const loaded = await this.handlers.loadCatalog(force);
      catalog = loaded.snapshot.dependencyCatalog;
      loadErrors.push(...loaded.errors);
      loadErrors.push(...(loaded.snapshot.certificateCatalog?.diagnostics ?? []));
    } else {
      const parsed = await Promise.all(sources.map(async (source) => {
        try {
          return parseDependencyManifest(await source.read(), source.path);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not read manifest";
          loadErrors.push(`${source.path}: ${message}`);
          return { manifest: null, diagnostics: [] };
        }
      }));
      catalog = buildDependencyCatalog(parsed, this.handlers.documents());
    }
    if (generation !== this.loadGeneration || !this.isOpen) return;
    this.sources = sources;
    this.loadErrors = loadErrors;
    this.catalog = catalog;
    const projects = this.projects();
    const saved = savedProjectSelection();
    this.project = [preferredProject, saved, this.project].find((candidate) =>
      !!candidate && projects.includes(candidate),
    ) ?? projects[0] ?? "";
    if (this.project) {
      saveProjectSelection(this.project);
      this.handlers.onProjectChange?.(this.project);
    }
    this.selectedId = null;
    this.navigationError = "";
    this.render();
  }

  private projects(): string[] {
    return [...new Set(this.catalog?.manifests.map((manifest) => manifest.project) ?? [])].sort();
  }

  private renderLoading(): void {
    this.destroyMobileSheets();
    this.root.textContent = "";
    this.root.append(el("div", "graph-loading", "Loading dependency manifests…"));
  }

  private render(): void {
    this.destroyMobileSheets();
    this.root.textContent = "";
    const header = el("header", "graph-header");
    const close = button("Back to document", "graph-back", () => this.close());
    const titleWrap = el("div", "graph-heading");
    const title = el("h1", "graph-title", "Project dependency graph");
    title.tabIndex = -1;
    const subtitle = el("p", "graph-subtitle", "Results, validation evidence, and logical prerequisites");
    titleWrap.append(title, subtitle);
    header.append(close, titleWrap);
    this.root.append(header);

    if (!this.catalog || !this.projects().length) {
      const empty = el("section", "graph-empty");
      empty.append(
        el("h2", "graph-empty-title", "No dependency manifest in this library"),
        el("p", "graph-empty-copy", "Mark one project document with contains: [\"dependency-graph\"] and add a table below a {#dependency-graph} heading."),
        button("Refresh", "graph-button", () => void this.load()),
      );
      if (this.loadErrors.length) empty.append(this.errorList(this.loadErrors));
      const diagnostics = this.catalog?.diagnostics ?? [];
      if (diagnostics.length) {
        empty.append(this.errorList(diagnostics.map((item) => item.message)));
      }
      this.root.append(empty);
      return;
    }

    const controls = el("div", "graph-controls");
    const projectSelect = document.createElement("select");
    projectSelect.className = "graph-select";
    projectSelect.setAttribute("aria-label", "Project");
    for (const project of this.projects()) projectSelect.add(new Option(project, project, false, project === this.project));
    projectSelect.addEventListener("change", () => {
      this.project = projectSelect.value;
      saveProjectSelection(this.project);
      this.handlers.onProjectChange?.(this.project);
      this.selectedId = null;
      this.navigationError = "";
      this.render();
      this.root.querySelector<HTMLSelectElement>(".graph-select")?.focus({ preventScroll: true });
    });
    const search = document.createElement("input");
    search.className = "graph-search";
    search.type = "search";
    search.placeholder = "Search results…";
    search.setAttribute("aria-label", "Search dependency graph");
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderGraphArea();
    });
    const projectControl = label("Project", projectSelect);
    const unresolved = toggle("Unresolved only", this.unresolvedOnly, (value) => {
      this.unresolvedOnly = value;
      this.renderGraphArea();
    });
    const upstream = toggle("Upstream", this.upstreamOnly, (value) => {
      this.upstreamOnly = value;
      this.renderGraphArea();
    }, () => !this.selectedId);
    const downstream = toggle("Downstream", this.downstreamOnly, (value) => {
      this.downstreamOnly = value;
      this.renderGraphArea();
    }, () => !this.selectedId);
    const zoomOut = button("−", "graph-button graph-zoom", () => this.canvas?.zoomOut(), "Zoom out");
    const zoomIn = button("+", "graph-button graph-zoom", () => this.canvas?.zoomIn(), "Zoom in");
    const fit = button("Fit", "graph-button graph-fit", () => this.fit());
    const refresh = button("Refresh", "graph-button graph-refresh", () => void this.load(this.project, true));
    const manifest = button("Open manifest", "graph-button graph-open-manifest", () => void this.openManifest());
    if (this.isPhone()) {
      const filterButton = button("Filters", "graph-button graph-filters-button", () => undefined);
      const filterBody = el("div", "graph-sheet-content");
      filterBody.append(search, unresolved, upstream, downstream);
      this.createPhoneSheet("Graph filters", filterBody, filterButton);
      const moreButton = button("More", "graph-button graph-more-button", () => undefined);
      const moreBody = el("div", "graph-sheet-content graph-sheet-actions");
      moreBody.append(zoomOut, zoomIn, manifest);
      this.createPhoneSheet("Graph actions", moreBody, moreButton);
      controls.append(projectControl, filterButton, fit, refresh, moreButton);
    } else {
      controls.append(
        projectControl,
        search,
        unresolved,
        upstream,
        downstream,
        zoomOut,
        zoomIn,
        fit,
        refresh,
        manifest,
      );
    }
    this.root.append(controls);

    const summary = el("div", "graph-summary");
    summary.setAttribute("aria-live", "polite");
    this.root.append(summary);
    const body = el("div", "graph-body");
    const canvas = el("div", "graph-canvas");
    const details = el("aside", "graph-details");
    details.setAttribute("aria-label", "Selected result details");
    this.detailsHost = details;
    if (this.isPhone()) {
      const detailsLauncher = button("Details", "graph-button graph-details-launcher", () => undefined);
      detailsLauncher.hidden = true;
      const controller = this.createPhoneSheet("Result details", details, detailsLauncher);
      this.detailsController = controller;
      body.append(canvas);
    } else {
      body.append(canvas, details);
    }
    this.root.append(body);
    const diagnostics = el("section", "graph-diagnostics");
    this.root.append(diagnostics);
    this.renderGraphArea();
  }

  private renderGraphArea(): void {
    if (!this.catalog) return;
    const summary = this.root.querySelector<HTMLElement>(".graph-summary");
    const canvas = this.root.querySelector<HTMLElement>(".graph-canvas");
    const details = this.detailsHost ?? this.root.querySelector<HTMLElement>(".graph-details");
    const diagnosticHost = this.root.querySelector<HTMLElement>(".graph-diagnostics");
    if (!summary || !canvas || !details || !diagnosticHost) return;
    const projectResults = this.catalog.results.filter((result) => result.project === this.project);
    const counts = new Map<ValidationState, number>();
    for (const result of projectResults) counts.set(result.validation, (counts.get(result.validation) ?? 0) + 1);
    summary.textContent = `${projectResults.length} results · ${counts.get("validated") ?? 0} validated · ${counts.get("partial") ?? 0} partial · ${counts.get("unvalidated") ?? 0} unvalidated · ${counts.get("disputed") ?? 0} disputed`;

    const visible = this.visibleResults();
    const visibleIds = new Set(visible.map((result) => result.id));
    if (this.selectedId && !visibleIds.has(this.selectedId)) this.selectedId = null;
    canvas.textContent = "";
    if (!visible.length) {
      canvas.append(el("div", "graph-empty-inline", "No results match the current view."));
      this.canvas = null;
    } else {
      this.canvas = new DependencyGraphCanvas({
        project: this.project,
        catalog: this.catalog,
        results: visible,
        direction: this.directionMedia?.matches ? "TB" : "LR",
        selectedId: this.selectedId,
        onSelect: (result) => this.select(result.id),
        onOpen: (result) => this.openResult(result),
      });
      canvas.append(this.canvas.element);
    }
    this.renderDetails(details);
    if (this.isPhone() && this.detailsController) {
      const detailsPanel = details.closest<HTMLElement>(".graph-mobile-sheet");
      if (this.selectedId) {
        details.hidden = false;
        if (detailsPanel) detailsPanel.hidden = false;
        this.detailsController.activate();
        queueMicrotask(() => details.querySelector<HTMLElement>(".graph-detail-open, button")?.focus({ preventScroll: true }));
      } else {
        this.detailsController.deactivate();
        details.hidden = true;
        if (detailsPanel) detailsPanel.hidden = true;
      }
    }
    this.renderDiagnostics(diagnosticHost);
    this.syncToggleAvailability();
  }

  private visibleResults(): ResultNode[] {
    if (!this.catalog) return [];
    let results = resultsForProject(this.catalog, this.project);
    const query = this.query.trim().toLowerCase();
    if (query) {
      results = results.filter((result) =>
        [result.id, result.title, result.ownerId, result.ownerLabel, result.evidence, result.condition]
          .some((value) => value.toLowerCase().includes(query)),
      );
    }
    if (this.unresolvedOnly) {
      const unresolved = new Set(results.filter((result) => result.validation !== "validated").map((result) => result.id));
      for (const id of [...unresolved]) {
        for (const dependency of this.catalog.byId.get(id)?.dependsOn ?? []) unresolved.add(dependency);
      }
      results = results.filter((result) => unresolved.has(result.id));
    }
    if (this.selectedId && (this.upstreamOnly || this.downstreamOnly)) {
      const focused = new Set([this.selectedId]);
      if (this.upstreamOnly) for (const id of upstreamOf(this.catalog, this.selectedId)) focused.add(id);
      if (this.downstreamOnly) for (const id of downstreamOf(this.catalog, this.selectedId)) focused.add(id);
      results = results.filter((result) => focused.has(result.id));
    }
    return results;
  }

  private select(id: string): void {
    this.selectedId = this.selectedId === id ? null : id;
    this.navigationError = "";
    this.renderGraphArea();
  }

  private renderDetails(host: HTMLElement): void {
    host.textContent = "";
    if (!this.catalog || !this.selectedId) {
      host.append(
        el("h2", "graph-details-title", "Result details"),
        el("p", "graph-details-empty", "Select a result to inspect its evidence, conditions, and dependency chain."),
      );
      return;
    }
    const result = this.catalog.byId.get(this.selectedId);
    if (!result) return;
    host.append(createResultInspector(result, this.catalog, {
      openStatement: (selected) => void this.openResultAt(selected, resultClaimAnchors(selected), false, "statement"),
      openDerivation: (selected) => void this.openResultAt(selected, resultDerivationAnchors(selected), false, "derivation"),
      openRelated: (related) => this.select(related.id),
    }));
    if (this.navigationError) {
      const notice = el("p", "result-inspector-navigation-error", this.navigationError);
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      host.append(notice);
    }
  }

  private renderDiagnostics(host: HTMLElement): void {
    host.textContent = "";
    const diagnostics = this.projectDiagnostics();
    if (!diagnostics.length && !this.loadErrors.length) return;
    const errors = diagnostics.filter((item) => item.severity === "error").length + this.loadErrors.length;
    const warnings = diagnostics.filter((item) => item.severity === "warning").length;
    const disclosure = document.createElement("details");
    disclosure.className = "graph-diagnostic-disclosure";
    const summary = document.createElement("summary");
    summary.textContent = `${errors} graph error${errors === 1 ? "" : "s"} · ${warnings} warning${warnings === 1 ? "" : "s"}`;
    disclosure.append(summary);
    if (this.loadErrors.length) disclosure.append(this.errorList(this.loadErrors));
    const list = el("ul", "graph-diagnostic-list");
    for (const item of diagnostics) {
      const row = el("li", `graph-diagnostic graph-diagnostic-${item.severity}`);
      row.append(el("strong", "graph-diagnostic-code", item.severity === "error" ? "Error" : "Warning"));
      row.append(document.createTextNode(` ${item.message}`));
      list.append(row);
    }
    disclosure.append(list);
    host.append(disclosure);
  }

  private projectDiagnostics(): GraphDiagnostic[] {
    if (!this.catalog) return [];
    const projectIds = new Set(resultsForProject(this.catalog, this.project).map((result) => result.id));
    const paths = new Set(this.catalog.manifests.filter((manifest) => manifest.project === this.project).map((manifest) => manifest.path));
    const selectableProjects = new Set(this.projects());
    return this.catalog.diagnostics.filter((item) =>
      item.project === this.project
      || (!!item.resultId && projectIds.has(item.resultId))
      || (!!item.path && paths.has(item.path))
      || !item.project
      || !selectableProjects.has(item.project),
    );
  }

  private errorList(messages: string[]): HTMLElement {
    const list = el("ul", "graph-diagnostic-list");
    for (const message of messages) list.append(el("li", "graph-diagnostic graph-diagnostic-error", message));
    return list;
  }

  private async openResult(result: ResultNode): Promise<void> {
    await this.openResultAt(result, resultClaimAnchors(result), true, "owner");
  }

  private async openResultAt(
    result: ResultNode,
    anchors: string[],
    fallbackToOwner = false,
    destination: "statement" | "derivation" | "owner" = "statement",
  ): Promise<void> {
    this.navigationError = "";
    for (const anchor of anchors) {
      if (await this.handlers.openDocument(result.ownerId, anchor)) {
        this.close(false);
        return;
      }
    }
    // External libraries may declare an owner without an addressable result
    // anchor. Opening the owner top is still preferable to a dead graph node.
    if (fallbackToOwner && await this.handlers.openDocument(result.ownerId)) {
      this.close(false);
      return;
    }
    this.navigationError = destination === "derivation"
      ? `The detailed derivation anchor for ${result.id} was not found. The owner document was not opened as a substitute.`
      : destination === "statement"
        ? `The registered-statement anchor for ${result.id} was not found.`
        : `The owner document for ${result.id} was not found.`;
    const details = this.detailsHost;
    if (details?.isConnected) this.renderDetails(details);
  }

  private async openManifest(): Promise<void> {
    const source = this.sources.find((candidate) => candidate.project === this.project);
    if (!source) return;
    await source.open();
    this.close(false);
  }

  private syncToggleAvailability(): void {
    for (const input of this.root.querySelectorAll<HTMLInputElement>('[data-needs-selection="true"]')) {
      input.disabled = !this.selectedId;
    }
  }

  private fit(): void {
    this.canvas?.fit();
  }

  private readonly onDirectionChange = () => {
    if (this.isOpen && this.catalog) this.render();
  };

  private isPhone(): boolean {
    return this.directionMedia?.matches ?? window.innerWidth < 600;
  }

  private createPhoneSheet(
    title: string,
    content: HTMLElement,
    launcher: HTMLButtonElement,
  ): MobileSheetController {
    const panel = el("section", "graph-mobile-sheet");
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    const panelId = `graph-sheet-${this.mobilePortals.length + 1}`;
    const headingId = `${panelId}-title`;
    panel.id = panelId;
    panel.setAttribute("aria-labelledby", headingId);
    const header = el("header", "graph-mobile-sheet-header");
    const heading = el("h2", "graph-mobile-sheet-title", title);
    heading.id = headingId;
    const dismiss = button("×", "graph-mobile-sheet-close", () => close());
    dismiss.setAttribute("aria-label", `Close ${title.toLocaleLowerCase()}`);
    header.append(heading, dismiss);
    panel.append(header, content);
    document.body.append(panel);
    let controller: MobileSheetController;
    const close = () => {
      controller.deactivate();
      panel.hidden = true;
      if (launcher.isConnected && !launcher.hidden) launcher.focus({ preventScroll: true });
    };
    controller = new MobileSheetController(panel, { onDismiss: close });
    launcher.setAttribute("aria-haspopup", "dialog");
    launcher.setAttribute("aria-controls", panelId);
    launcher.addEventListener("click", () => {
      panel.hidden = false;
      controller.activate();
      queueMicrotask(() => content.querySelector<HTMLElement>("input, button, select, [href]")?.focus({ preventScroll: true }));
    });
    this.mobilePortals.push(panel);
    this.mobileSheetControllers.push(controller);
    return controller;
  }

  private destroyMobileSheets(): void {
    for (const controller of this.mobileSheetControllers.splice(0)) controller.destroy();
    for (const portal of this.mobilePortals.splice(0)) portal.remove();
    this.detailsHost = null;
    this.detailsController = null;
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(
  text: string,
  className: string,
  onClick: () => void,
  ariaLabel?: string,
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = text;
  if (ariaLabel) element.setAttribute("aria-label", ariaLabel);
  element.addEventListener("click", onClick);
  return element;
}

function label(text: string, control: HTMLElement): HTMLLabelElement {
  const element = document.createElement("label");
  element.className = "graph-control-label";
  element.append(document.createTextNode(text), control);
  return element;
}

function toggle(
  text: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
  disabled?: () => boolean,
): HTMLLabelElement {
  const element = document.createElement("label");
  element.className = "graph-toggle";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.disabled = disabled?.() ?? false;
  if (disabled) input.dataset.needsSelection = "true";
  input.addEventListener("change", () => onChange(input.checked));
  element.append(input, document.createTextNode(text));
  return element;
}
