import {
  searchProjectDocuments,
  type ProjectSearchResult,
  type SearchIndexSnapshot,
} from "./project-search-engine";
import { persistenceStore, type PersistenceStore } from "./persistence-store";
import { AnchoredPanelController } from "./anchored-panel";

const SEARCH_INDEX_KEY = "search-index:v1";

interface SearchCache extends SearchIndexSnapshot {
  savedAt: number;
}

export interface ProjectSearchHandlers {
  revision: () => string;
  index: () => Promise<SearchIndexSnapshot>;
  openPath: (path: string) => Promise<boolean>;
}

export class ProjectSearch {
  private readonly panel = document.createElement("section");
  private readonly query = document.createElement("input");
  private readonly project = document.createElement("select");
  private readonly results = document.createElement("div");
  private readonly status = document.createElement("span");
  private readonly panelController: AnchoredPanelController;
  private worker: Worker | null;
  private snapshot: SearchIndexSnapshot | null = null;
  private requestId = 0;
  private debounce = 0;

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly handlers: ProjectSearchHandlers,
    private readonly store: PersistenceStore = persistenceStore,
  ) {
    try {
      this.worker = typeof Worker === "undefined"
        ? null
        : new Worker(new URL("./project-search.worker.ts", import.meta.url), { type: "module" });
    } catch {
      this.worker = null;
    }
    this.worker?.addEventListener("message", (event: MessageEvent) => this.onWorkerMessage(event.data));
    this.worker?.addEventListener("error", () => {
      this.worker?.terminate();
      this.worker = null;
      this.status.textContent = "Search worker failed; using the foreground fallback";
      this.search();
    });

    this.panel.id = "project-search";
    this.panel.hidden = true;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "Search project documents");
    const title = document.createElement("h2");
    title.className = "config-title";
    title.textContent = "Search projects";

    this.query.type = "search";
    this.query.className = "navigator-input";
    this.query.placeholder = "Search every document…";
    this.query.setAttribute("aria-label", "Project search query");
    this.query.addEventListener("input", () => this.scheduleSearch());
    this.project.className = "navigator-input";
    this.project.setAttribute("aria-label", "Project search scope");
    this.project.addEventListener("change", () => this.search());

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "Refresh index";
    refresh.addEventListener("click", () => void this.load(true));
    const controls = document.createElement("div");
    controls.className = "navigator-controls";
    controls.append(refresh);
    this.status.className = "navigator-result";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.results.className = "project-search-results";
    this.panel.append(title, this.query, this.project, controls, this.status, this.results);
    document.body.append(this.panel);
    this.panelController = new AnchoredPanelController(this.button, this.panel, {
      initialFocus: () => this.query,
      onOpen: () => {
        if (!this.snapshot) void this.load(false);
      },
    });
  }

  invalidate(): void {
    this.snapshot = null;
    void this.store.delete(SEARCH_INDEX_KEY).catch(() => undefined);
    if (!this.panel.hidden) void this.load(true);
  }

  private close(): void {
    this.panelController.close();
  }

  private async load(force: boolean): Promise<void> {
    this.status.textContent = "Indexing project documents…";
    this.results.textContent = "";
    try {
      const revision = this.handlers.revision();
      const cached = force ? undefined : await this.store.get<SearchCache>(SEARCH_INDEX_KEY).catch(() => undefined);
      const live = cached?.revision === revision ? null : await this.handlers.index();
      this.snapshot = live ?? cached ?? await this.handlers.index();
      if (live || !cached) {
        void this.store.set<SearchCache>(SEARCH_INDEX_KEY, { ...this.snapshot, savedAt: Date.now() }).catch(() => undefined);
      }
      this.populateProjects();
      this.worker?.postMessage({ type: "index", ...this.snapshot });
      this.status.textContent = this.indexStatus();
      this.search();
    } catch (error) {
      this.status.textContent = error instanceof Error ? error.message : "Could not build the search index";
    }
  }

  private populateProjects(): void {
    const current = this.project.value;
    const projects = new Set(this.snapshot?.documents.flatMap((document) => document.projects) ?? []);
    this.project.textContent = "";
    this.project.append(new Option("All projects", ""));
    for (const project of [...projects].sort()) this.project.append(new Option(project, project));
    if ([...this.project.options].some((option) => option.value === current)) this.project.value = current;
  }

  private scheduleSearch(): void {
    window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => this.search(), 120);
  }

  private search(): void {
    if (!this.snapshot) return;
    const query = this.query.value;
    if (!query.trim()) {
      this.results.textContent = "";
      this.status.textContent = this.indexStatus();
      return;
    }
    const requestId = ++this.requestId;
    if (this.worker) {
      this.worker.postMessage({
        type: "search",
        requestId,
        query,
        project: this.project.value || undefined,
      });
    } else {
      this.renderResults(searchProjectDocuments(
        this.snapshot.documents,
        query,
        this.project.value || undefined,
      ));
    }
  }

  private onWorkerMessage(message: { type?: string; requestId?: number; results?: ProjectSearchResult[] }): void {
    if (message.type !== "results" || message.requestId !== this.requestId || !message.results) return;
    this.renderResults(message.results);
  }

  private indexStatus(): string {
    if (!this.snapshot) return "No search index";
    const readerCount = this.snapshot.documents.filter(
      (document) => document.visibility !== "support",
    ).length;
    const supportCount = this.snapshot.documents.length - readerCount;
    const base = [
      `${readerCount} documents indexed`,
      ...(supportCount ? [`${supportCount} support IDs available by exact lookup`] : []),
    ].join("; ");
    if (!this.snapshot.truncated) return base;
    const omitted = this.snapshot.omittedDocuments ?? 0;
    return omitted
      ? `${base}; ${omitted} omitted by safety limits`
      : `${base}; content bounded by safety limits`;
  }

  private renderResults(results: ProjectSearchResult[]): void {
    this.results.textContent = "";
    this.status.textContent = `${results.length} match${results.length === 1 ? "" : "es"}`;
    for (const result of results) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "project-search-result";
      const heading = document.createElement("strong");
      heading.textContent = `${result.title} · line ${result.line}`;
      const excerpt = document.createElement("span");
      excerpt.textContent = result.excerpt || "(blank line)";
      const path = document.createElement("small");
      path.textContent = result.path;
      button.append(heading, excerpt, path);
      button.addEventListener("click", async () => {
        if (await this.handlers.openPath(result.path)) this.close();
        else this.status.textContent = "Document is no longer in the current library";
      });
      this.results.append(button);
    }
  }

}
