import { describe, expect, it, vi } from "vitest";
import { ProjectWorkspaceController } from "./project-workspace";

describe("ProjectWorkspaceController", () => {
  it("keeps document, overview, and graph workspaces mutually exclusive", () => {
    const element = () => ({
      hidden: false,
      dataset: {} as Record<string, string>,
      classList: { toggle() { /* visibility is asserted through `hidden` */ } },
    }) as unknown as HTMLElement;
    const pane = element();
    const tabs = element();
    const editor = element();
    const overview = element();
    const graph = element();
    const onModeChange = vi.fn();
    const controller = new ProjectWorkspaceController(pane, tabs, editor, overview, graph, onModeChange);

    controller.show("overview");
    expect(overview.hidden).toBe(false);
    expect(graph.hidden).toBe(true);
    expect(editor.hidden).toBe(true);
    expect(onModeChange).toHaveBeenLastCalledWith("overview");

    controller.show("graph");
    expect(overview.hidden).toBe(true);
    expect(graph.hidden).toBe(false);
    expect(tabs.hidden).toBe(true);

    controller.show("document");
    expect(editor.hidden).toBe(false);
    expect(tabs.hidden).toBe(false);
    expect(pane.dataset.workspaceMode).toBe("document");
    expect(onModeChange).toHaveBeenLastCalledWith("document");
  });

  it("resolves the current launcher after the sidebar replaces its controls", () => {
    const element = () => ({
      hidden: false,
      dataset: {} as Record<string, string>,
      classList: { toggle() { /* visibility is asserted through `hidden` */ } },
    }) as unknown as HTMLElement;
    const pane = element();
    const tabs = element();
    const editor = element();
    const overview = element();
    const graph = element();
    const first = { focus: vi.fn() } as unknown as HTMLElement;
    const replacement = { focus: vi.fn() } as unknown as HTMLElement;
    let current = first;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const controller = new ProjectWorkspaceController(pane, tabs, editor, overview, graph);
    controller.show("overview", () => current);
    current = replacement;
    controller.backToDocument();

    expect(first.focus).not.toHaveBeenCalled();
    expect(replacement.focus).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
