import type { StoredComment } from "../editor/comments";
import { commentActivityDigest } from "../markdown/frontmatter";
import { AnchoredPanelController } from "./anchored-panel";
import type { CommentInboxSource } from "./library-view";
import { persistenceStore, type PersistenceStore } from "./persistence-store";

export type CommentInboxFilter = "new" | "unresolved" | "all";
export type CommentActivityKind = "comment" | "reply" | "updated" | "resolved" | "reopened";

export interface CommentInboxContext {
  providerIdentity: string;
  revision: string;
  principalKey: string;
}

export interface CommentInboxItem {
  key: string;
  path: string;
  documentId?: string;
  documentTitle: string;
  projects: string[];
  projectLabels: string[];
  comment: StoredComment;
  fingerprint: string;
  activityAt: number;
  activityAuthor: string;
  activityKind: CommentActivityKind;
  unread: boolean;
}

export interface CommentInboxHandlers {
  context: () => CommentInboxContext;
  sources: () => CommentInboxSource[];
  open: (path: string, commentId: string) => Promise<boolean>;
  focus?: (commentId: string) => boolean;
  refreshLibrary: () => Promise<boolean>;
  usesGitHub: () => boolean;
}

interface SeenThread {
  fingerprint: string;
  resolved: boolean;
  replyCount: number;
}

interface PersistedInboxState {
  version: 1;
  initialized: true;
  seen: Record<string, SeenThread>;
}

interface CachedSource {
  digest: string;
  items: Array<Omit<CommentInboxItem, "activityKind" | "unread">>;
}

const STATE_PREFIX = "comment-inbox:v1:";
const MAX_SEEN_THREADS = 4_000;

/**
 * A provider-neutral comment activity view. Markdown remains authoritative;
 * only per-device read markers are stored locally.
 */
export class CommentInbox {
  private readonly panel = document.createElement("section");
  private readonly status = document.createElement("p");
  private readonly list = document.createElement("div");
  private readonly tabs = new Map<CommentInboxFilter, HTMLButtonElement>();
  private readonly badge = document.createElement("span");
  private readonly panelController: AnchoredPanelController;
  private readonly sourceCache = new Map<string, CachedSource>();
  private items: CommentInboxItem[] = [];
  private filter: CommentInboxFilter = "new";
  private identity = "";
  private storageKey = "";
  private state: PersistedInboxState | null = null;
  private refreshPromise: Promise<void> | null = null;
  private refreshSequence = 0;
  private refreshQueued = false;
  private initialized = false;

  constructor(
    private readonly launcher: HTMLButtonElement,
    private readonly handlers: CommentInboxHandlers,
    private readonly store: PersistenceStore = persistenceStore,
  ) {
    this.panel.id = "comment-inbox";
    this.panel.hidden = true;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-labelledby", "comment-inbox-title");

    const header = document.createElement("header");
    header.className = "comment-inbox-header";
    const title = document.createElement("h2");
    title.id = "comment-inbox-title";
    title.textContent = "Comment inbox";
    const check = document.createElement("button");
    check.type = "button";
    check.className = "comment-inbox-check";
    check.textContent = "Check";
    check.addEventListener("click", () => void this.checkForComments(check));
    header.append(title, check);

    const tabList = document.createElement("div");
    tabList.className = "comment-inbox-tabs";
    tabList.setAttribute("role", "tablist");
    tabList.setAttribute("aria-label", "Comment inbox view");
    tabList.addEventListener("keydown", (event) => this.onTabKey(event));
    for (const filter of ["new", "unresolved", "all"] as const) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.dataset.filter = filter;
      tab.setAttribute("aria-controls", "comment-inbox-list");
      tab.addEventListener("click", () => {
        this.filter = filter;
        this.render();
      });
      this.tabs.set(filter, tab);
      tabList.append(tab);
    }

    this.status.className = "comment-inbox-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.list.id = "comment-inbox-list";
    this.list.className = "comment-inbox-list";
    this.list.setAttribute("role", "tabpanel");
    this.panel.append(header, tabList, this.status, this.list);
    document.body.append(this.panel);

    this.badge.className = "toolbar-activity-badge";
    this.badge.hidden = true;
    this.badge.setAttribute("aria-hidden", "true");
    this.launcher.append(this.badge);

    this.panelController = new AnchoredPanelController(this.launcher, this.panel, {
      initialFocus: () => this.tabs.get(this.filter) ?? null,
      beforeOpen: () => this.render(),
      onOpen: () => void this.refresh(),
    });
    this.render();
  }

  /** Establishes the first device-local baseline without labelling old threads new. */
  async initialize(): Promise<void> {
    await this.refresh(true);
    this.initialized = true;
    this.launcher.disabled = false;
  }

  invalidate(): void {
    // A changed provider index may alter comment digests. Refresh in the
    // background so the toolbar badge remains useful while the panel is closed.
    if (this.initialized) void this.refresh();
  }

  async markDocumentRead(path: string): Promise<void> {
    await this.refresh();
    const matching = this.items.filter((item) => item.path === path);
    if (!matching.length) return;
    for (const item of matching) this.markSeenInMemory(item);
    await this.persistState();
    this.reconcileUnread();
    this.render();
  }

  async refresh(baselineIfEmpty = false): Promise<void> {
    if (this.refreshPromise) {
      this.refreshQueued = true;
      return this.refreshPromise.then(() => {
        if (!this.refreshQueued) return;
        this.refreshQueued = false;
        return this.refresh(baselineIfEmpty);
      });
    }
    const sequence = ++this.refreshSequence;
    let promise!: Promise<void>;
    promise = this.performRefresh(sequence, baselineIfEmpty)
      .finally(() => {
        if (this.refreshPromise === promise) this.refreshPromise = null;
      });
    this.refreshPromise = promise;
    return promise;
  }

  private async performRefresh(sequence: number, baselineIfEmpty: boolean): Promise<void> {
    const context = this.handlers.context();
    const nextIdentity = `${context.providerIdentity}\u0000${context.principalKey}`;
    if (nextIdentity !== this.identity) {
      this.identity = nextIdentity;
      this.storageKey = this.stateKey(context);
      this.state = (await this.store.get<PersistedInboxState>(this.storageKey).catch(() => undefined)) ?? null;
      if (!validState(this.state)) this.state = null;
      this.sourceCache.clear();
      this.items = [];
    }

    this.status.textContent = "Checking comment activity…";
    const sources = this.handlers.sources();
    const sourcePaths = new Set(sources.map((source) => source.path));
    for (const path of this.sourceCache.keys()) {
      if (!sourcePaths.has(path)) this.sourceCache.delete(path);
    }

    const changed = sources.filter((source) => this.sourceCache.get(source.path)?.digest !== source.digest);
    const failures: string[] = [];
    for (let offset = 0; offset < changed.length; offset += 6) {
      await Promise.all(changed.slice(offset, offset + 6).map(async (source) => {
        try {
          const comments = await source.read();
          this.sourceCache.set(source.path, {
            digest: source.digest,
            items: comments
              .filter((comment) => typeof comment.id === "string" && comment.id.length > 0)
              .map((comment) => baseItem(source, comment)),
          });
        } catch {
          failures.push(source.path);
        }
      }));
    }
    if (sequence !== this.refreshSequence || nextIdentity !== this.identity) return;

    const baseItems = [...this.sourceCache.values()].flatMap((source) => source.items);
    if (!this.state) {
      this.state = { version: 1, initialized: true, seen: {} };
      if (baselineIfEmpty) {
        for (const item of baseItems) this.markSeenInMemory(item);
      }
      await this.persistState();
    }
    this.items = baseItems.map((item) => this.withActivity(item))
      .sort((a, b) => Number(b.unread) - Number(a.unread)
        || b.activityAt - a.activityAt
        || a.documentTitle.localeCompare(b.documentTitle));
    this.updateBadge();
    this.status.textContent = failures.length
      ? `Showing available comments; ${failures.length} ${plural(failures.length, "document")} could not be checked.`
      : this.items.length
        ? `Checked ${this.items.length} comment ${plural(this.items.length, "thread")}. Read state is stored on this device.`
        : "No comments in the current library.";
    this.render();
  }

  private withActivity(
    item: Omit<CommentInboxItem, "activityKind" | "unread">,
  ): CommentInboxItem {
    const seen = this.state?.seen[item.key];
    const replyCount = item.comment.replies.length;
    const activityKind: CommentActivityKind = !seen
      ? replyCount > 0 ? "reply" : "comment"
      : replyCount > seen.replyCount
        ? "reply"
        : item.comment.resolved !== seen.resolved
          ? item.comment.resolved ? "resolved" : "reopened"
          : seen.fingerprint !== item.fingerprint
            ? "updated"
            : replyCount > 0 ? "reply" : "comment";
    return {
      ...item,
      activityKind,
      unread: seen?.fingerprint !== item.fingerprint,
    };
  }

  private reconcileUnread(): void {
    this.items = this.items.map((item) => this.withActivity(item));
    this.updateBadge();
  }

  private render(): void {
    const unread = this.items.filter((item) => item.unread).length;
    const unresolved = this.items.filter((item) => !item.comment.resolved).length;
    const counts: Record<CommentInboxFilter, number> = {
      new: unread,
      unresolved,
      all: this.items.length,
    };
    for (const [filter, tab] of this.tabs) {
      tab.textContent = `${filter === "new" ? "New" : filter === "unresolved" ? "Unresolved" : "All"} ${counts[filter]}`;
      tab.setAttribute("aria-selected", String(filter === this.filter));
      tab.tabIndex = filter === this.filter ? 0 : -1;
    }
    this.list.setAttribute(
      "aria-label",
      `${this.filter === "new" ? "New" : this.filter === "unresolved" ? "Unresolved" : "All"} comment threads`,
    );

    const visible = this.items.filter((item) => this.filter === "new"
      ? item.unread
      : this.filter === "unresolved" ? !item.comment.resolved : true);
    this.list.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "comment-inbox-empty";
      empty.textContent = this.filter === "new"
        ? "No new comment activity."
        : this.filter === "unresolved" ? "No unresolved comments." : "No comments in this library.";
      this.list.append(empty);
      return;
    }

    if (this.filter === "new") {
      const markAll = document.createElement("button");
      markAll.type = "button";
      markAll.className = "comment-inbox-mark-all";
      markAll.textContent = "Mark all read";
      markAll.addEventListener("click", () => void this.markAllRead());
      this.list.append(markAll);
    }
    for (const item of visible) this.list.append(this.renderItem(item));
  }

  private renderItem(item: CommentInboxItem): HTMLElement {
    const article = document.createElement("article");
    article.className = "comment-inbox-item";
    article.classList.toggle("is-unread", item.unread);

    const open = document.createElement("button");
    open.type = "button";
    open.className = "comment-inbox-open";
    open.addEventListener("click", () => void this.openItem(item));

    const heading = document.createElement("span");
    heading.className = "comment-inbox-item-heading";
    const activity = document.createElement("span");
    activity.className = "comment-inbox-activity";
    activity.textContent = activityLabel(item.activityKind, item.unread);
    const author = document.createElement("strong");
    author.textContent = item.activityAuthor;
    const time = document.createElement("time");
    if (item.activityAt > 0) {
      time.dateTime = new Date(item.activityAt).toISOString();
      time.title = new Date(item.activityAt).toLocaleString();
      time.textContent = relativeTime(item.activityAt);
    }
    heading.append(activity, author, time);

    const context = document.createElement("span");
    context.className = "comment-inbox-context";
    context.textContent = [item.projectLabels.join(", "), item.documentTitle].filter(Boolean).join(" · ");
    const body = document.createElement("span");
    body.className = "comment-inbox-body";
    const latestReply = item.comment.replies.at(-1);
    body.textContent = excerpt(latestReply?.body || item.comment.body || "Highlighted passage");
    const quote = commentQuote(item.comment);
    if (quote) {
      const quoted = document.createElement("span");
      quoted.className = "comment-inbox-quote";
      quoted.textContent = `“${excerpt(quote, 120)}”`;
      open.append(heading, context, body, quoted);
    } else {
      open.append(heading, context, body);
    }
    open.setAttribute(
      "aria-label",
      `${activityLabel(item.activityKind, item.unread)} by ${item.activityAuthor} in ${item.documentTitle}. ${item.comment.resolved ? "Resolved" : "Unresolved"}.`,
    );

    const footer = document.createElement("footer");
    const state = document.createElement("span");
    state.textContent = item.comment.resolved ? "Resolved" : "Unresolved";
    const read = document.createElement("button");
    read.type = "button";
    read.textContent = item.unread ? "Mark read" : "Mark unread";
    read.addEventListener("click", () => void this.toggleRead(item));
    footer.append(state, read);
    article.append(open, footer);
    return article;
  }

  private async openItem(item: CommentInboxItem): Promise<void> {
    const opened = await this.handlers.open(item.path, item.comment.id);
    if (opened) {
      this.markSeenInMemory(item);
      await this.persistState();
      this.reconcileUnread();
      this.render();
      this.panelController.close(false);
      requestAnimationFrame(() => this.handlers.focus?.(item.comment.id));
    } else {
      this.status.textContent = "The comment is unavailable in the current library.";
    }
  }

  private async toggleRead(item: CommentInboxItem): Promise<void> {
    if (item.unread) this.markSeenInMemory(item);
    else if (this.state) delete this.state.seen[item.key];
    await this.persistState();
    this.reconcileUnread();
    this.render();
  }

  private async markAllRead(): Promise<void> {
    for (const item of this.items) this.markSeenInMemory(item);
    await this.persistState();
    this.reconcileUnread();
    this.render();
  }

  private markSeenInMemory(item: Pick<CommentInboxItem, "key" | "fingerprint" | "comment">): void {
    if (!this.state) this.state = { version: 1, initialized: true, seen: {} };
    delete this.state.seen[item.key];
    this.state.seen[item.key] = {
      fingerprint: item.fingerprint,
      resolved: item.comment.resolved,
      replyCount: item.comment.replies.length,
    };
  }

  private async persistState(): Promise<void> {
    if (!this.state || !this.identity) return;
    const entries = Object.entries(this.state.seen);
    if (entries.length > MAX_SEEN_THREADS) {
      this.state.seen = Object.fromEntries(entries.slice(-MAX_SEEN_THREADS));
    }
    await this.store.set(this.storageKey, this.state).catch(() => undefined);
  }

  private async checkForComments(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    this.status.textContent = this.handlers.usesGitHub()
      ? "Pulling the library…"
      : "Refreshing the local library…";
    try {
      const refreshed = await this.handlers.refreshLibrary();
      if (!refreshed) {
        this.status.textContent = "Refresh failed; showing the previous comment snapshot.";
        return;
      }
      await this.refresh();
    } catch {
      this.status.textContent = "Refresh failed; showing the previous comment snapshot.";
    } finally {
      button.disabled = false;
    }
  }

  private updateBadge(): void {
    const count = this.items.filter((item) => item.unread).length;
    this.badge.hidden = count === 0;
    this.badge.textContent = count > 99 ? "99+" : String(count);
    this.launcher.classList.toggle("has-activity", count > 0);
    const label = count > 0
      ? `Comment inbox, ${count} new ${plural(count, "activity", "activities")}`
      : "Comment inbox, no new activity";
    this.launcher.setAttribute("aria-label", label);
    this.launcher.title = label;
  }

  private stateKey(context: CommentInboxContext): string {
    return `${STATE_PREFIX}${encodeURIComponent(context.providerIdentity)}:${encodeURIComponent(context.principalKey)}`;
  }

  private onTabKey(event: KeyboardEvent): void {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const order: CommentInboxFilter[] = ["new", "unresolved", "all"];
    const current = order.indexOf(this.filter);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? order.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + order.length) % order.length;
    event.preventDefault();
    this.filter = order[next];
    this.render();
    this.tabs.get(this.filter)?.focus({ preventScroll: true });
  }
}

function baseItem(
  source: CommentInboxSource,
  comment: StoredComment,
): Omit<CommentInboxItem, "activityKind" | "unread"> {
  const replies = Array.isArray(comment.replies) ? comment.replies : [];
  const latestReply = replies.reduce<(typeof replies)[number] | undefined>((latest, reply) =>
    !latest || safeTime(reply.createdAt) >= safeTime(latest.createdAt) ? reply : latest, undefined);
  const commentAt = safeTime(comment.createdAt);
  const replyAt = safeTime(latestReply?.createdAt);
  const latestIsReply = Boolean(latestReply && replyAt >= commentAt);
  return {
    key: `${source.path}#${comment.id}`,
    path: source.path,
    documentId: source.documentId,
    documentTitle: source.documentTitle,
    projects: source.projects,
    projectLabels: source.projectLabels,
    comment,
    fingerprint: threadFingerprint(comment),
    activityAt: Math.max(commentAt, replyAt),
    activityAuthor: latestIsReply ? latestReply!.author : comment.author,
  };
}

function threadFingerprint(comment: StoredComment): string {
  // Location metadata changes when surrounding prose is edited. It is useful
  // for navigation but is not new review activity, so exclude anchors and
  // positional fields from the device-local unread fingerprint.
  const activity = {
    id: comment.id,
    kind: comment.kind,
    author: comment.author,
    principalId: comment.principalId,
    body: comment.body,
    resolved: comment.resolved,
    replies: comment.replies,
    priority: comment.priority,
    status: comment.status,
    color: comment.color,
  };
  return commentActivityDigest([activity]) ?? "empty";
}

function validState(value: unknown): value is PersistedInboxState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<PersistedInboxState>;
  return state.version === 1
    && state.initialized === true
    && !!state.seen
    && typeof state.seen === "object"
    && !Array.isArray(state.seen);
}

function safeTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function commentQuote(comment: StoredComment): string {
  if (typeof comment.quote === "string" && comment.quote.trim()) return comment.quote.trim();
  if (typeof comment.orphanQuote === "string" && comment.orphanQuote.trim()) return comment.orphanQuote.trim();
  const anchor = comment.anchor;
  return anchor && typeof anchor.quote === "string" ? anchor.quote.trim() : "";
}

function excerpt(value: string, limit = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1).trimEnd()}…` : compact;
}

function activityLabel(kind: CommentActivityKind, unread: boolean): string {
  switch (kind) {
    case "reply": return unread ? "New reply" : "Latest reply";
    case "updated": return "Updated";
    case "resolved": return "Resolved";
    case "reopened": return "Reopened";
    default: return unread ? "New comment" : "Comment";
  }
}

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}
