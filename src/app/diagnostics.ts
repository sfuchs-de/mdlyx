export interface DiagnosticEvent {
  id: string;
  at: number;
  source: "error" | "unhandled-rejection" | "application";
  message: string;
  stack?: string;
}

export interface DiagnosticSnapshot {
  version: string;
  revision: string | null;
  runtime: "web" | "tauri";
  online: boolean;
  userAgent: string;
  events: DiagnosticEvent[];
}

const MAX_EVENTS = 100;

export class DiagnosticsStore {
  private readonly events: DiagnosticEvent[] = [];
  private installed = false;
  private banner: HTMLElement | null = null;

  install(): void {
    if (this.installed || typeof window === "undefined") return;
    this.installed = true;
    window.addEventListener("error", (event) => {
      this.record("error", event.error ?? event.message);
      this.showBoundary();
    });
    window.addEventListener("unhandledrejection", (event) => {
      this.record("unhandled-rejection", event.reason);
      this.showBoundary();
    });
  }

  record(source: DiagnosticEvent["source"], error: unknown): DiagnosticEvent {
    const normalized = normalizeError(error);
    const event: DiagnosticEvent = {
      id: crypto.randomUUID(),
      at: Date.now(),
      source,
      message: normalized.message,
      ...(normalized.stack ? { stack: normalized.stack } : {}),
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    return event;
  }

  snapshot(): DiagnosticSnapshot {
    const browserWindow = typeof window === "undefined" ? undefined : window;
    const browserNavigator = typeof navigator === "undefined" ? undefined : navigator;
    return {
      version: __MATHDOWN_VERSION__,
      revision: __MATHDOWN_REVISION__ || null,
      runtime: browserWindow && "__TAURI_INTERNALS__" in browserWindow ? "tauri" : "web",
      online: browserNavigator?.onLine ?? true,
      userAgent: browserNavigator?.userAgent ?? "non-browser test runtime",
      events: this.events.slice(),
    };
  }

  export(providerState?: unknown): string {
    return JSON.stringify({
      format: "mathdown-diagnostics",
      exportedAt: new Date().toISOString(),
      software: this.snapshot(),
      providerState,
      note: "This bundle is local-only and contains no GitHub credentials or document bodies.",
    }, null, 2);
  }

  clear(): void {
    this.events.length = 0;
    this.banner?.remove();
    this.banner = null;
  }

  private showBoundary(): void {
    if (this.banner || !document.body) return;
    const banner = document.createElement("div");
    banner.className = "app-error-boundary";
    banner.setAttribute("role", "alert");
    const message = document.createElement("span");
    message.textContent = "MdLyx encountered an unexpected error. Your recovery snapshot is retained.";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => {
      banner.remove();
      this.banner = null;
    });
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reload";
    reload.addEventListener("click", () => window.location.reload());
    banner.append(message, dismiss, reload);
    document.body.append(banner);
    this.banner = banner;
  }
}

function normalizeError(error: unknown): { message: string; stack?: string } {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown application error";
  const stack = error instanceof Error ? error.stack : undefined;
  return {
    message: sanitize(message).slice(0, 1_000),
    ...(stack ? { stack: sanitize(stack).slice(0, 8_000) } : {}),
  };
}

function sanitize(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/g, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return "[url]";
      }
    })
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/(token|secret|code)=([^\s&]+)/gi, "$1=[redacted]");
}

export const diagnosticsStore = new DiagnosticsStore();
