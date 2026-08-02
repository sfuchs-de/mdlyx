import {
  DEPENDENCY_STATUS,
  DependencyGraphCanvas,
} from "./dependency-graph-canvas";
import {
  resultOwnerAnchors,
  type ResultNode,
  type ValidationState,
} from "./dependency-graph";
import type {
  ProjectCatalogLoadResult,
} from "./project-catalog-controller";
import {
  commentedDocumentsForProject,
  graphDiagnosticsForProject,
  keyDocumentsForProject,
  keyResultsForProject,
  nextActionsForProject,
  openQuestionDocumentsForProject,
  projectProjectionIsDirty,
  projectStatusCounts,
  resultsNeedingAttention,
  type ProjectCatalogSnapshot,
  type ProjectDocumentSummary,
  type ProjectResultAttention,
  type ProjectTask,
  type TaskState,
} from "./project-overview";
import { savedProjectSelection, saveProjectSelection } from "./project-selection";
import { openExternalUrl } from "./tauri-bridge";
import { createLeanCertificateBadge } from "./lean-certificate-ui";

export interface ProjectOverviewHandlers {
  loadCatalog(force?: boolean): Promise<ProjectCatalogLoadResult>;
  openDocument(id: string, anchor?: string): Promise<boolean>;
  openGraph(project: string): void;
  openBibliography?(project: string): void;
  refreshLibrary(): Promise<boolean>;
  usesGitHub(): boolean;
  onModeChange(open: boolean, restoreLauncherFocus?: boolean): void;
}

const TASK_SYMBOL: Record<TaskState, string> = {
  blocked: "!",
  "in-progress": "→",
  next: "○",
  later: "·",
  done: "✓",
};

export class ProjectOverviewView {
  private readonly root: HTMLElement;
  private readonly handlers: ProjectOverviewHandlers;
  private loaded: ProjectCatalogLoadResult | null = null;
  private project = "";
  private selectedResultId: string | null = null;
  private canvas: DependencyGraphCanvas | null = null;
  private refreshError = "";
  private loadGeneration = 0;

  constructor(root: HTMLElement, handlers: ProjectOverviewHandlers) {
    this.root = root;
    this.handlers = handlers;
    this.root.classList.add("project-overview");
    this.root.hidden = true;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  async open(preferredProject?: string): Promise<void> {
    this.root.hidden = false;
    this.handlers.onModeChange(true);
    await this.load(preferredProject);
    requestAnimationFrame(() => this.root.querySelector<HTMLElement>(".overview-title")?.focus());
  }

  close(restoreLauncherFocus = true): void {
    this.loadGeneration++;
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
    this.refreshError = "";
    const loaded = await this.handlers.loadCatalog(force);
    if (generation !== this.loadGeneration || !this.isOpen) return;
    this.loaded = loaded;
    const projects = loaded.snapshot.projects;
    this.project = [preferredProject, savedProjectSelection(), this.project].find((candidate) =>
      !!candidate && projects.includes(candidate),
    ) ?? projects[0] ?? "";
    if (this.project) saveProjectSelection(this.project);
    this.selectedResultId = null;
    this.render();
  }

  private renderLoading(): void {
    this.root.textContent = "";
    this.root.append(el("div", "overview-loading", "Loading project overview…"));
  }

  private render(): void {
    this.root.textContent = "";
    const snapshot = this.loaded?.snapshot;
    const overview = snapshot?.overviewByProject.get(this.project);
    const header = el("header", "overview-header");
    header.append(button("Back to document", "overview-back", () => this.close()));
    const heading = el("div", "overview-heading");
    const title = el("h1", "overview-title", overview?.title ?? "Project overview");
    title.tabIndex = -1;
    heading.append(
      title,
      el(
        "p",
        "overview-subtitle",
        overview?.summary
          || (overview?.taskAuthority
            ? `Task state is managed in ${overview.taskAuthority.system}; verification evidence and project documents remain here.`
            : "Declared tasks, verification evidence, and project documents"),
      ),
    );
    header.append(heading);
    this.root.append(header);

    if (!snapshot || !snapshot.projects.length || !overview) {
      const empty = el("section", "overview-empty");
      empty.append(
        el("h2", "overview-empty-title", "No valid project overview in this library"),
        el("p", "overview-empty-copy", "Mark one document with contains: [\"project-overview\"] and add a project summary plus either a priorities table or external task_authority metadata."),
        button("Refresh", "overview-button", () => void this.load(undefined, true)),
      );
      this.appendLoadMessages(empty);
      if (snapshot?.diagnostics.length) empty.append(this.diagnosticList(snapshot.diagnostics.map((item) => item.message)));
      this.root.append(empty);
      return;
    }

    const controls = el("div", "overview-controls");
    const select = document.createElement("select");
    select.className = "overview-select";
    select.setAttribute("aria-label", "Overview project");
    for (const project of snapshot.projects) {
      select.add(new Option(project, project, false, project === this.project));
    }
    select.addEventListener("change", () => {
      this.project = select.value;
      saveProjectSelection(this.project);
      this.selectedResultId = null;
      this.render();
      this.root.querySelector<HTMLSelectElement>(".overview-select")?.focus({ preventScroll: true });
    });
    const manifestAvailable = snapshot.dependencyCatalog.manifests.some((item) => item.project === this.project);
    const edit = button(
      "Edit overview",
      "overview-button",
      () => void this.openDocument(
        overview.documentId,
        overview.taskAuthority ? "project-summary" : "project-priorities",
      ),
    );
    const graph = button("Full graph", "overview-button", () => this.handlers.openGraph(this.project));
    graph.disabled = !manifestAvailable;
    if (!manifestAvailable) graph.title = "This project has no dependency manifest";
    const refresh = button(
      this.handlers.usesGitHub() ? "Pull & refresh" : "Refresh",
      "overview-button overview-refresh",
      () => void this.refresh(),
    );
    controls.append(label("Project", select));
    const secondary = el("div", "overview-mobile-actions-body");
    secondary.append(edit);
    if (overview.taskAuthority) {
      secondary.append(createExternalLink(
        `Open ${overview.taskAuthority.system}`,
        overview.taskAuthority.url,
        "overview-button",
      ));
    }
    if (this.handlers.openBibliography) {
      secondary.append(
        button("Bibliography", "overview-button", () => this.handlers.openBibliography?.(this.project)),
      );
    }
    secondary.append(graph);
    const more = document.createElement("details");
    more.className = "overview-mobile-actions";
    more.open = !isPhoneViewport();
    const moreSummary = document.createElement("summary");
    moreSummary.textContent = "More";
    more.append(moreSummary, secondary);
    controls.append(more, refresh);
    this.root.append(controls);

    this.renderNotices(snapshot);
    this.root.append(this.statusStrip(snapshot));

    const keyResults = this.keyResultsPanel(snapshot);
    if (keyResults) this.root.append(keyResults);

    const attention = resultsNeedingAttention(snapshot, this.project);
    const main = el("div", "overview-primary");
    main.append(
      mobileDisclosure("Validation frontier", this.frontierPanel(snapshot, attention), false),
      this.actionsPanel(snapshot),
    );
    this.root.append(
      main,
      mobileDisclosure("Results needing attention", this.attentionPanel(attention), false),
      this.evidencePanel(snapshot),
      this.diagnosticsPanel(snapshot),
    );
  }

  private renderNotices(snapshot: ProjectCatalogSnapshot): void {
    const messages: string[] = [];
    if (this.refreshError) messages.push(this.refreshError);
    if (this.loaded?.state === "stale") messages.push("Refresh failed; showing the previous complete snapshot.");
    else if (this.loaded?.state === "incomplete") messages.push("Some project sources could not be read; this first snapshot is incomplete.");
    if (projectProjectionIsDirty(snapshot, this.project)) {
      messages.push("This projection uses the last saved overview and dependency manifest. Save the open document, then Refresh.");
    }
    if (!messages.length) return;
    const notice = el("div", "overview-notice");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    notice.setAttribute("aria-atomic", "true");
    for (const message of messages) notice.append(el("p", "overview-notice-line", message));
    this.root.append(notice);
  }

  private statusStrip(snapshot: ProjectCatalogSnapshot): HTMLElement {
    const counts = projectStatusCounts(snapshot, this.project);
    const taskAuthority = snapshot.overviewByProject.get(this.project)?.taskAuthority;
    const total = Object.values(counts.results).reduce((sum, value) => sum + value, 0);
    const section = el("section", "overview-status");
    section.setAttribute("aria-label", "Project status summary");
    section.append(
      el("p", "overview-status-line", `${total} ${plural(total, "result")} · ${counts.results.validated} validated · ${counts.results.partial} partial · ${counts.results.unvalidated} unvalidated · ${counts.results.disputed} disputed`),
      el("p", "overview-status-line", `${counts.graphErrors} graph error${counts.graphErrors === 1 ? "" : "s"} · ${counts.graphWarnings} warning${counts.graphWarnings === 1 ? "" : "s"}`),
      el(
        "p",
        "overview-status-line",
        taskAuthority
          ? `Tasks · managed in ${taskAuthority.system}`
          : `${counts.activeTasks} active ${plural(counts.activeTasks, "task")} · ${counts.blockedTasks} blocked · ${counts.laterTasks} later · ${counts.doneTasks} done`,
      ),
      el("p", "overview-status-line", `${counts.documents} project ${plural(counts.documents, "document")} · ${counts.unresolvedComments} unresolved ${plural(counts.unresolvedComments, "comment")}`),
      this.validationBar(counts.results),
    );
    return section;
  }

  private validationBar(counts: Record<ValidationState, number>): HTMLElement {
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const bar = el("div", "overview-validation-bar");
    const description = `${counts.validated} validated, ${counts.partial} partial, ${counts.unvalidated} unvalidated, ${counts.disputed} disputed`;
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `Validation distribution: ${description}`);
    if (!total) {
      bar.append(el("span", "overview-validation-empty", "No result manifest"));
      return bar;
    }
    for (const state of ["validated", "partial", "unvalidated", "disputed"] as ValidationState[]) {
      if (!counts[state]) continue;
      const segment = el("span", `overview-validation-segment state-${state}`, `${DEPENDENCY_STATUS[state].symbol} ${counts[state]} ${state}`);
      segment.title = `${counts[state]} ${state}`;
      segment.style.flexBasis = `${(counts[state] / total) * 100}%`;
      bar.append(segment);
    }
    return bar;
  }

  private frontierPanel(
    snapshot: ProjectCatalogSnapshot,
    attention: ProjectResultAttention[],
  ): HTMLElement {
    const panel = el("section", "overview-panel overview-frontier");
    const head = el("div", "overview-panel-head");
    head.append(el("h2", "overview-section-title", "Validation frontier"));
    const fit = button("Fit", "overview-mini-button", () => this.canvas?.fit());
    head.append(fit);
    panel.append(head);

    if (!attention.length) {
      panel.append(el("p", "overview-empty-copy", "No unresolved results in this project."));
      return panel;
    }
    const seeds = attention.slice(0, 6).map((item) => item.result);
    const visible = frontierResults(snapshot, seeds);
    const visibleIds = new Set(visible.map((result) => result.id));
    const seedIds = new Set(seeds.map((result) => result.id));
    const prerequisiteCount = visible.filter((result) => !seedIds.has(result.id)).length;
    const hiddenCount = attention.filter((item) => !visibleIds.has(item.result.id)).length;
    const caption = [
      `Showing ${seeds.length} highest-exposure unresolved ${plural(seeds.length, "result")}`,
      prerequisiteCount
        ? ` and ${prerequisiteCount} direct ${plural(prerequisiteCount, "prerequisite")}`
        : "",
      hiddenCount
        ? `; ${hiddenCount} other unresolved ${plural(hiddenCount, "result")} ${hiddenCount === 1 ? "is" : "are"} hidden. Open Full graph to view ${hiddenCount === 1 ? "it" : "them"}.`
        : "; no unresolved results are hidden.",
    ].join("");
    panel.append(el(
      "p",
      "overview-panel-caption",
      caption,
    ));
    const host = el("div", "overview-frontier-canvas");
    this.canvas = new DependencyGraphCanvas({
      project: this.project,
      catalog: snapshot.dependencyCatalog,
      results: visible,
      mode: "compact",
      selectedId: this.selectedResultId,
      ariaLabel: `Validation frontier for ${this.project}`,
      onSelect: (result) => {
        this.selectedResultId = this.selectedResultId === result.id ? null : result.id;
        this.renderSelection(result.id, "frontier");
      },
      onOpen: (result) => this.openResult(result),
    });
    host.append(this.canvas.element);
    panel.append(host);
    const selected = this.selectedResultId ? snapshot.dependencyCatalog.byId.get(this.selectedResultId) : undefined;
    if (selected) {
      const detail = el("div", "overview-frontier-detail");
      detail.append(
        el("strong", "overview-frontier-detail-title", `${selected.id} · ${selected.title}`),
        el("span", "overview-frontier-detail-copy", `Evidence: ${selected.evidence || "not recorded"}`),
        el("span", "overview-frontier-detail-copy", `Remaining: ${selected.condition || "none recorded"}`),
      );
      if (selected.certificate) {
        detail.append(createLeanCertificateBadge(selected.certificate, () => void this.openResult(selected)));
      }
      panel.append(detail);
    }
    return panel;
  }

  private actionsPanel(snapshot: ProjectCatalogSnapshot): HTMLElement {
    const panel = el("section", "overview-panel overview-actions");
    panel.append(el("h2", "overview-section-title", "Next actions"));
    const taskAuthority = snapshot.overviewByProject.get(this.project)?.taskAuthority;
    if (taskAuthority) {
      const copy = el("p", "overview-empty-copy");
      copy.append(
        document.createTextNode("Current tasks are managed in "),
        createExternalLink(taskAuthority.system, taskAuthority.url, "overview-document-link"),
        document.createTextNode("."),
      );
      panel.append(copy);
      return panel;
    }
    const tasks = nextActionsForProject(snapshot, this.project);
    if (!tasks.length) {
      panel.append(el("p", "overview-empty-copy", "No blocked, in-progress, or next tasks are declared."));
      return panel;
    }
    const list = el("div", "overview-task-list");
    for (const task of tasks) list.append(this.taskRow(task));
    panel.append(list);
    return panel;
  }

  private keyResultsPanel(snapshot: ProjectCatalogSnapshot): HTMLElement | null {
    const declared = keyResultsForProject(snapshot, this.project);
    if (!declared.length) return null;
    const section = el("section", "overview-section overview-key-results");
    const heading = el("div", "overview-key-results-heading");
    heading.append(
      el("h2", "overview-section-title", "Key results"),
      el("span", "overview-key-results-count", `${declared.length} curated`),
    );
    section.append(
      heading,
      el(
        "p",
        "overview-panel-caption",
        "Editorially selected contributions across the project. Validation remains independently evidence-based.",
      ),
    );

    const cards = el("div", "overview-key-result-grid");
    for (const item of declared.slice(0, 6)) {
      cards.append(this.keyResultCard(item.result!, item.significance, item.readingDocumentLabel));
    }
    section.append(cards);

    if (declared.length > 6) {
      const more = document.createElement("details");
      more.className = "overview-key-results-more";
      const summary = document.createElement("summary");
      summary.textContent = `Show all ${declared.length} key results`;
      const rest = el("div", "overview-key-result-grid");
      for (const item of declared.slice(6)) {
        rest.append(this.keyResultCard(item.result!, item.significance, item.readingDocumentLabel));
      }
      more.append(summary, rest);
      section.append(more);
    }

    const selected = this.selectedResultId
      ? declared.find((item) => item.resultId === this.selectedResultId)?.result
      : undefined;
    if (selected) {
      const detail = el("div", "overview-key-result-detail");
      detail.setAttribute("role", "region");
      detail.setAttribute("aria-label", `Evidence for ${selected.id}`);
      detail.append(
        el("strong", "overview-key-result-detail-title", `${selected.id} · ${selected.title}`),
        el("p", "overview-key-result-detail-copy", `Evidence · ${selected.evidence || "Not recorded"}`),
        el("p", "overview-key-result-detail-copy", `Remaining · ${selected.condition || "None recorded"}`),
        button("Open owner", "overview-mini-button", () => void this.openResult(selected)),
      );
      if (selected.certificate) {
        detail.append(createLeanCertificateBadge(selected.certificate, () => void this.openResult(selected)));
      }
      section.append(detail);
    }
    return section;
  }

  private keyResultCard(
    result: ResultNode,
    significance: string,
    readingDocumentLabel?: string,
  ): HTMLElement {
    const card = el("article", `overview-key-result-card state-${result.validation}`);
    if (result.id === this.selectedResultId) card.classList.add("is-selected");
    const select = button(`${result.id} · ${result.title}`, "overview-key-result-title", () => {
      this.selectedResultId = result.id;
      this.renderSelection(result.id, "key");
    });
    select.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void this.openResult(result);
    });
    select.dataset.resultId = result.id;
    select.setAttribute("aria-pressed", String(result.id === this.selectedResultId));
    const titleRow = el("div", "overview-key-result-title-row");
    titleRow.append(select);
    if (result.certificate) {
      titleRow.append(createLeanCertificateBadge(result.certificate, () => void this.openResult(result)));
    }
    const owner = el("p", "overview-key-result-owner");
    owner.append(
      document.createTextNode("Read · "),
      button(
        readingDocumentLabel || result.ownerLabel,
        "overview-table-link",
        () => void this.openResult(result),
      ),
    );
    card.append(
      titleRow,
      el(
        "p",
        "overview-key-result-state",
        `${DEPENDENCY_STATUS[result.validation].symbol} ${result.validation}`,
      ),
      el("p", "overview-key-result-significance", significance || "No significance note recorded."),
      owner,
    );
    return card;
  }

  private taskRow(task: ProjectTask): HTMLElement {
    const row = el("article", `overview-task state-${task.state}`);
    const meta = el("div", "overview-task-meta");
    meta.append(
      el("span", "overview-task-state", `${TASK_SYMBOL[task.state]} ${task.state}`),
      el("span", "overview-task-priority", task.priority),
      el("code", "overview-task-id", task.id),
    );
    const title = el("h3", "overview-task-title", task.title);
    const owner = el("p", "overview-task-line");
    owner.append(document.createTextNode("Owner · "), button(task.ownerLabel, "overview-table-link", () => void this.openDocument(task.ownerId)));
    const results = el("p", "overview-task-line", `Related results · ${task.relatedResultIds.join(", ") || "—"}`);
    const exit = el("p", "overview-task-exit", `Exit · ${task.exitCriterion}`);
    row.append(meta, title, owner, results, exit);
    return row;
  }

  private attentionPanel(attention: ProjectResultAttention[]): HTMLElement {
    const panel = el("section", "overview-section overview-attention");
    panel.append(el("h2", "overview-section-title", "Results needing attention"));
    if (!attention.length) {
      panel.append(el("p", "overview-empty-copy", "Every declared result is validated."));
      return panel;
    }
    const table = document.createElement("table");
    table.className = "overview-table overview-results-table";
    table.append(tableHead(["Result", "State", "Owner", "Downstream exposure", "Remaining condition"]));
    const body = document.createElement("tbody");
    const cards = el("div", "overview-result-cards");
    for (const item of attention) {
      const result = item.result;
      const row = document.createElement("tr");
      row.className = result.id === this.selectedResultId ? "is-selected" : "";
      row.append(
        buttonCell(`${result.id} · ${result.title}`, () => {
          this.selectedResultId = result.id;
          this.renderSelection(result.id, "attention");
        }, result.id),
        cell(`${DEPENDENCY_STATUS[result.validation].symbol} ${result.validation}`),
        buttonCell(result.ownerLabel, () => void this.openResult(result)),
        cell(String(item.downstreamExposure), "overview-number-cell"),
        cell(result.condition || "None recorded"),
      );
      body.append(row);
      const card = el("article", `overview-result-card state-${result.validation}`);
      const cardTitle = button(`${result.id} · ${result.title}`, "overview-result-card-title", () => {
        this.selectedResultId = result.id;
        this.renderSelection(result.id, "attention");
      });
      cardTitle.dataset.resultId = result.id;
      const cardHeading = el("div", "overview-result-card-heading");
      cardHeading.append(cardTitle);
      if (result.certificate) {
        cardHeading.append(createLeanCertificateBadge(result.certificate, () => void this.openResult(result)));
      }
      const cardMeta = el("p", "overview-result-card-meta", `${DEPENDENCY_STATUS[result.validation].symbol} ${result.validation} · ${item.downstreamExposure} downstream`);
      const cardOwner = el("p", "overview-result-card-line");
      cardOwner.append(
        document.createTextNode("Owner · "),
        button(result.ownerLabel, "overview-table-link", () => void this.openResult(result)),
      );
      card.append(
        cardHeading,
        cardMeta,
        cardOwner,
        el("p", "overview-result-card-condition", `Remaining · ${result.condition || "None recorded"}`),
      );
      cards.append(card);
    }
    table.append(body);
    panel.append(cards, scrollTable(table, "Results needing attention table"));
    return panel;
  }

  private evidencePanel(snapshot: ProjectCatalogSnapshot): HTMLElement {
    const panel = el("section", "overview-evidence");
    panel.append(
      this.documentList("Key documents", keyDocumentsForProject(snapshot, this.project), false),
      this.documentList("Open questions", openQuestionDocumentsForProject(snapshot, this.project), false),
      this.documentList("Unresolved comments", commentedDocumentsForProject(snapshot, this.project), true),
    );
    return panel;
  }

  private documentList(title: string, documents: ProjectDocumentSummary[], comments: boolean): HTMLElement {
    const section = el("section", "overview-document-group");
    section.append(el("h2", "overview-section-title", title));
    if (!documents.length) {
      section.append(el("p", "overview-empty-copy", comments ? "No unresolved comments." : "None declared."));
      return mobileDisclosure(title, section, false, "overview-document-disclosure");
    }
    const list = el("ul", "overview-document-list");
    for (const summary of documents) {
      const item = document.createElement("li");
      const open = button(summary.title, "overview-document-link", () => void this.openDocument(summary.id));
      open.title = summary.path;
      item.append(open);
      if (comments) {
        const count = el("span", "overview-document-count", String(summary.unresolvedCommentCount));
        count.setAttribute(
          "aria-label",
          `${summary.unresolvedCommentCount} unresolved ${plural(summary.unresolvedCommentCount, "comment")}`,
        );
        item.append(count);
      }
      list.append(item);
    }
    section.append(list);
    return mobileDisclosure(title, section, false, "overview-document-disclosure");
  }

  private diagnosticsPanel(snapshot: ProjectCatalogSnapshot): HTMLElement {
    const projectPaths = new Set([
      snapshot.overviewByProject.get(this.project)?.path,
      ...snapshot.dependencyCatalog.manifests.filter((item) => item.project === this.project).map((item) => item.path),
    ].filter((path): path is string => !!path));
    const selectableProjects = new Set(snapshot.projects);
    const projectDiagnostics = snapshot.diagnostics.filter((item) =>
      item.project === this.project
      || (!!item.path && projectPaths.has(item.path))
      || !item.project
      || !selectableProjects.has(item.project),
    );
    const graphDiagnostics = graphDiagnosticsForProject(
      snapshot.dependencyCatalog,
      this.project,
      snapshot.projects,
    );
    const messages = [
      ...(this.loaded?.errors ?? []),
      ...(snapshot.certificateCatalog?.diagnostics ?? []),
      ...projectDiagnostics.map((item) => item.message),
      ...graphDiagnostics.map((item) => item.message),
    ];
    const section = el("section", "overview-diagnostics");
    if (!messages.length) return section;
    const details = document.createElement("details");
    details.className = "overview-diagnostic-disclosure";
    const summary = document.createElement("summary");
    const errors = projectDiagnostics.filter((item) => item.severity === "error").length
      + graphDiagnostics.filter((item) => item.severity === "error").length
      + (this.loaded?.errors.length ?? 0);
    const warnings = projectDiagnostics.filter((item) => item.severity === "warning").length
      + graphDiagnostics.filter((item) => item.severity === "warning").length
      + (snapshot.certificateCatalog?.diagnostics.length ?? 0);
    summary.textContent = `${errors} project error${errors === 1 ? "" : "s"} · ${warnings} warning${warnings === 1 ? "" : "s"}`;
    details.append(summary, this.diagnosticList(messages));
    section.append(details);
    return section;
  }

  private diagnosticList(messages: string[]): HTMLElement {
    const list = el("ul", "overview-diagnostic-list");
    for (const message of messages) list.append(el("li", "overview-diagnostic", message));
    return list;
  }

  private appendLoadMessages(host: HTMLElement): void {
    const messages = this.loaded?.errors ?? [];
    if (messages.length) host.append(this.diagnosticList(messages));
  }

  private async refresh(): Promise<void> {
    this.refreshError = "";
    const ok = await this.handlers.refreshLibrary();
    if (!ok) {
      this.refreshError = "Pull or folder refresh failed; showing the previous snapshot.";
      this.render();
      return;
    }
    await this.load(this.project);
  }

  private async openResult(result: ResultNode): Promise<void> {
    try {
      for (const anchor of resultOwnerAnchors(result)) {
        if (await this.handlers.openDocument(result.ownerId, anchor)) {
          this.close(false);
          return;
        }
      }
    } catch (error) {
      console.warn("[project overview] could not open result owner anchor", error);
    }
    // Preserve compatibility with project manifests that identify the owner
    // but do not yet expose any addressable result marker.
    await this.openDocument(result.ownerId);
  }

  private async openDocument(id: string, anchor?: string): Promise<void> {
    try {
      if (await this.handlers.openDocument(id, anchor)) {
        this.close(false);
        return;
      }
      this.showNavigationError(
        `Document “${id}” was not found in the current library. The cached project overview remains available.`,
      );
    } catch {
      this.showNavigationError(
        `Could not open “${id}” because the library is unavailable. The cached project overview remains available.`,
      );
    }
  }

  private showNavigationError(message: string): void {
    this.refreshError = message;
    this.rerenderKeepingScroll();
    const notice = this.root.querySelector<HTMLElement>(".overview-notice");
    if (notice) {
      // The activated document link was replaced by the rerender. Move focus
      // to the announced error so keyboard users stay within the workspace.
      notice.tabIndex = -1;
      notice.focus({ preventScroll: true });
    }
  }

  private renderSelection(id: string, source: "frontier" | "attention" | "key"): void {
    const scrollTop = this.root.scrollTop;
    this.render();
    this.root.scrollTop = scrollTop;
    this.restoreResultFocus(id, source);
    // WebKit can update the compact SVG's intrinsic size one frame after the
    // DOM replacement. Reassert the user's position after that layout pass.
    requestAnimationFrame(() => {
      if (!this.isOpen) return;
      this.root.scrollTop = scrollTop;
      this.restoreResultFocus(id, source);
    });
  }

  private rerenderKeepingScroll(): void {
    const scrollTop = this.root.scrollTop;
    this.render();
    this.root.scrollTop = scrollTop;
    requestAnimationFrame(() => {
      if (this.isOpen) this.root.scrollTop = scrollTop;
    });
  }

  private restoreResultFocus(id: string, source: "frontier" | "attention" | "key"): void {
    const selector = source === "frontier"
      ? ".overview-frontier [data-result-id]"
      : source === "key"
        ? ".overview-key-results [data-result-id]"
      : isPhoneViewport()
        ? ".overview-result-cards [data-result-id]"
        : ".overview-results-table [data-result-id]";
    const target = [...this.root.querySelectorAll<HTMLElement>(selector)]
      .find((item) => item.dataset.resultId === id);
    target?.focus({ preventScroll: true });
  }
}

function isPhoneViewport(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 599px)").matches
    : window.innerWidth < 600;
}

function mobileDisclosure(
  title: string,
  content: HTMLElement,
  phoneOpen = false,
  className = "",
): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = `overview-mobile-disclosure ${className}`.trim();
  details.open = !isPhoneViewport() || phoneOpen;
  const summary = document.createElement("summary");
  summary.textContent = title;
  details.append(summary, content);
  return details;
}

function frontierResults(
  snapshot: ProjectCatalogSnapshot,
  seeds: ResultNode[],
): ResultNode[] {
  const ids = new Set(seeds.map((result) => result.id));
  for (const seed of seeds) {
    for (const dependency of seed.dependsOn) {
      if (snapshot.dependencyCatalog.byId.has(dependency)) ids.add(dependency);
    }
  }
  return [...ids].flatMap((id) => {
    const result = snapshot.dependencyCatalog.byId.get(id);
    return result ? [result] : [];
  });
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = text;
  element.addEventListener("click", onClick);
  return element;
}

export function createExternalLink(
  text: string,
  url: string,
  className: string,
  openUrl: (url: string) => Promise<void> = openExternalUrl,
): HTMLAnchorElement {
  const element = document.createElement("a");
  element.className = className;
  element.href = url;
  element.target = "_blank";
  element.rel = "noopener noreferrer";
  element.textContent = text;
  element.addEventListener("click", (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    // The shared opener launches the operating-system browser in Tauri and a
    // normal new browser tab on the web. Retain a best-effort browser fallback
    // if the native opener plugin is unavailable or rejects the URL.
    void openUrl(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  });
  return element;
}

function label(text: string, control: HTMLElement): HTMLLabelElement {
  const element = document.createElement("label");
  element.className = "overview-control-label";
  element.append(document.createTextNode(text), control);
  return element;
}

function tableHead(labels: string[]): HTMLTableSectionElement {
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  for (const label of labels) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    row.append(cell);
  }
  head.append(row);
  return head;
}

function cell(text: string, className = ""): HTMLTableCellElement {
  const element = document.createElement("td");
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function buttonCell(text: string, onClick: () => void, resultId?: string): HTMLTableCellElement {
  const element = document.createElement("td");
  const control = button(text, "overview-table-link", onClick);
  if (resultId) control.dataset.resultId = resultId;
  element.append(control);
  return element;
}

function scrollTable(table: HTMLTableElement, ariaLabel: string): HTMLElement {
  const wrap = el("div", "overview-table-scroll");
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", ariaLabel);
  wrap.tabIndex = 0;
  wrap.append(table);
  return wrap;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
