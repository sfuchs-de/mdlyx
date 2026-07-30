export type ProjectWorkspaceMode = "document" | "overview" | "graph";
export type ProjectWorkspaceLauncher = HTMLElement | (() => HTMLElement | null);

/**
 * Keeps the editor and generated project workspaces mutually exclusive. Views
 * still own their content; this controller owns only visibility and focus.
 */
export class ProjectWorkspaceController {
  private mode: ProjectWorkspaceMode = "document";
  private launcher: (() => HTMLElement | null) | null = null;

  constructor(
    private readonly editorPane: HTMLElement,
    private readonly tabBar: HTMLElement,
    private readonly editorHost: HTMLElement,
    private readonly overviewRoot: HTMLElement,
    private readonly graphRoot: HTMLElement,
    private readonly onModeChange?: (mode: ProjectWorkspaceMode) => void,
  ) {
    this.show("document");
  }

  get current(): ProjectWorkspaceMode {
    return this.mode;
  }

  show(mode: ProjectWorkspaceMode, launcher?: ProjectWorkspaceLauncher | null): void {
    if (launcher) {
      this.launcher = typeof launcher === "function"
        ? launcher
        : () => launcher.isConnected ? launcher : null;
    }
    this.mode = mode;
    const documentMode = mode === "document";
    this.tabBar.hidden = !documentMode;
    this.editorHost.hidden = !documentMode;
    this.overviewRoot.hidden = mode !== "overview";
    this.graphRoot.hidden = mode !== "graph";
    this.editorPane.dataset.workspaceMode = mode;
    this.editorPane.classList.toggle("is-project-workspace", !documentMode);
    this.onModeChange?.(mode);
  }

  backToDocument(): void {
    this.show("document");
    const resolveLauncher = this.launcher;
    this.launcher = null;
    requestAnimationFrame(() => resolveLauncher?.()?.focus());
  }
}
