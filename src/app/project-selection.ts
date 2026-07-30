export const PROJECT_SELECTION_KEY = "mdlyx:project-workspace-project";
const LEGACY_GRAPH_PROJECT_KEY = "mdlyx:dependency-project";

export function savedProjectSelection(): string {
  try {
    return localStorage.getItem(PROJECT_SELECTION_KEY)
      ?? localStorage.getItem(LEGACY_GRAPH_PROJECT_KEY)
      ?? "";
  } catch {
    return "";
  }
}

export function saveProjectSelection(project: string): void {
  try {
    localStorage.setItem(PROJECT_SELECTION_KEY, project);
  } catch {
    /* persistence is best-effort */
  }
}
