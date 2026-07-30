// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabView } from "./app";
import { TabBar, type TabBarHandlers } from "./tab-bar";

const view = (
  id: string,
  name: string,
  active = false,
  dirty = false,
  path?: string,
): TabView => ({ id, name, active, dirty, path });

function setup() {
  const host = document.createElement("nav");
  host.id = "tab-bar";
  document.body.appendChild(host);
  const handlers: TabBarHandlers = {
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    onReorder: vi.fn(),
    onBulkClose: vi.fn(),
  };
  const bar = new TabBar(host, handlers);
  bars.push(bar);
  return { host, handlers, bar };
}

let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;
let revealed: HTMLElement[];
let bars: TabBar[];
let resizeObservers: Array<{
  callback: ResizeObserverCallback;
  observed: Set<Element>;
  disconnected: boolean;
}>;

beforeEach(() => {
  bars = [];
  revealed = [];
  resizeObservers = [];
  class MockResizeObserver {
    private readonly record: (typeof resizeObservers)[number];

    constructor(callback: ResizeObserverCallback) {
      this.record = { callback, observed: new Set(), disconnected: false };
      resizeObservers.push(this.record);
    }

    observe(target: Element) {
      this.record.observed.add(target);
    }

    unobserve(target: Element) {
      this.record.observed.delete(target);
    }

    disconnect() {
      this.record.disconnected = true;
      this.record.observed.clear();
    }
  }
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    revealed.push(this);
  };
});

afterEach(async () => {
  await Promise.resolve();
  bars.forEach((bar) => bar.destroy());
  document.body.textContent = "";
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TabBar", () => {
  it("renders the phone active-document identity, duplicate qualifier, and save activity", () => {
    const { bar, host, handlers } = setup();
    bar.render([
      view("a", "index.md", true, true, "projects/alpha/index.md"),
      view("b", "index.md", false, false, "projects/beta/index.md"),
    ]);
    bar.setActivity({
      path: "projects/alpha/index.md",
      name: "index.md",
      saveState: "saving",
      dirty: true,
      lastSavedAt: null,
      provider: "github",
    });
    expect(host.querySelector(".mobile-document-title")?.textContent).toBe("index.md");
    expect(host.querySelector(".mobile-document-path")?.textContent).toBe("projects/alpha");
    expect(host.querySelector(".mobile-document-activity")?.textContent).toBe("Saving…");
    expect(host.querySelector(".mobile-document-count")?.textContent).toBe("2 open");
    host.querySelector<HTMLButtonElement>(".mobile-document-new")!.click();
    expect(handlers.onNew).toHaveBeenCalledOnce();
  });

  it("keeps the New button fixed and reconciles existing tab nodes by id", async () => {
    const { bar, host, handlers } = setup();
    bar.render([view("a", "a.md", true), view("b", "b.md")]);
    await Promise.resolve();

    const scroll = host.querySelector<HTMLElement>(".tab-scroll")!;
    const add = host.querySelector<HTMLButtonElement>(".tab-new")!;
    const overview = host.querySelector<HTMLButtonElement>(".tab-overview-toggle")!;
    const a = host.querySelector<HTMLButtonElement>('.tab[data-id="a"]')!;
    const b = host.querySelector<HTMLButtonElement>('.tab[data-id="b"]')!;
    expect(scroll.contains(add)).toBe(false);
    expect(scroll.contains(overview)).toBe(false);
    expect(add.parentElement?.classList.contains("tab-actions")).toBe(true);
    expect(overview.parentElement).toBe(add.parentElement);
    expect(overview.querySelector(".tab-overview-toggle-count")?.textContent).toBe("2");
    expect(overview.title).toBe("View all 2 open tabs");

    // An identical notification is a true no-op; changing active/dirty state
    // reuses the same controls and moves them rather than rebuilding them.
    bar.render([view("a", "a.md", true), view("b", "b.md")]);
    expect(host.querySelector('.tab[data-id="a"]')).toBe(a);
    bar.render([view("b", "b.md", true, true), view("a", "a.md")]);
    expect(host.querySelector('.tab[data-id="a"]')).toBe(a);
    expect(host.querySelector('.tab[data-id="b"]')).toBe(b);
    expect(host.querySelector(".tab-list")!.firstElementChild?.querySelector(".tab")).toBe(b);

    add.click();
    expect(handlers.onNew).toHaveBeenCalledOnce();
  });

  it("uses the provider path and dirty state in accessible labels", () => {
    const { bar, host } = setup();
    bar.render([view("a", "index.md", true, true, "notes/nested/index.md")]);

    const tab = host.querySelector<HTMLButtonElement>(".tab")!;
    const close = host.querySelector<HTMLButtonElement>(".tab-close")!;
    expect(tab.textContent).toContain("index.md");
    expect(tab.getAttribute("aria-label")).toBe("notes/nested/index.md, unsaved changes");
    expect(tab.getAttribute("aria-controls")).toBe("editor-host");
    expect(tab.getAttribute("aria-current")).toBe("page");
    expect(tab.title).toContain("notes/nested/index.md · Unsaved changes");
    expect(close.getAttribute("aria-label")).toBe(
      "Close notes/nested/index.md, unsaved changes",
    );
    expect(close.parentElement).toBe(tab.parentElement);
    expect(tab.contains(close)).toBe(false);
    expect(tab.classList.contains("is-dirty")).toBe(true);
    expect(host.querySelector(".tab-announcer")?.textContent)
      .toBe("notes/nested/index.md has unsaved changes.");

    bar.render([view("a", "index.md", true, false, "notes/nested/index.md")]);
    expect(host.querySelector(".tab-announcer")?.textContent).toBe("All open tabs are saved.");
  });

  it("selects and focuses tabs with Arrow, Home, and End keys", async () => {
    const { bar, host, handlers } = setup();
    bar.render([
      view("a", "a.md", true),
      view("b", "b.md"),
      view("c", "c.md"),
    ]);
    await Promise.resolve();
    const tab = (id: string) => host.querySelector<HTMLButtonElement>(`.tab[data-id="${id}"]`)!;

    const right = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    tab("a").dispatchEvent(right);
    await Promise.resolve();
    expect(right.defaultPrevented).toBe(true);
    expect(handlers.onSelect).toHaveBeenLastCalledWith("b");
    expect(document.activeElement).toBe(tab("b"));

    tab("b").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await Promise.resolve();
    expect(handlers.onSelect).toHaveBeenLastCalledWith("c");
    expect(document.activeElement).toBe(tab("c"));

    tab("c").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();
    expect(handlers.onSelect).toHaveBeenLastCalledWith("a");

    tab("a").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await Promise.resolve();
    tab("c").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await Promise.resolve();
    expect(handlers.onSelect).toHaveBeenLastCalledWith("a");
  });

  it("closes via Delete, Backspace, the close button, and middle click", () => {
    const { bar, host, handlers } = setup();
    bar.render([view("a", "a.md", true)]);
    const tab = host.querySelector<HTMLButtonElement>(".tab")!;
    const close = host.querySelector<HTMLButtonElement>(".tab-close")!;

    const deletion = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    tab.dispatchEvent(deletion);
    expect(deletion.defaultPrevented).toBe(true);
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    close.click();
    tab.dispatchEvent(new MouseEvent("mousedown", { button: 1, bubbles: true }));
    expect(handlers.onClose).toHaveBeenCalledTimes(4);
    expect(handlers.onClose).toHaveBeenCalledWith("a");
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  it("reveals a newly active tab in the scroll viewport", async () => {
    const { bar, host } = setup();
    bar.render([view("a", "a.md", true), view("b", "b.md")]);
    await Promise.resolve();
    revealed = [];

    bar.render([view("a", "a.md"), view("b", "b.md", true)]);
    await Promise.resolve();
    expect(revealed).toEqual([host.querySelector('.tab-item[data-id="b"]')]);
  });

  it("reveals the active tab again when the host or scroller resizes", async () => {
    const { bar, host } = setup();
    bar.render([view("a", "a.md", true), view("b", "b.md")]);
    await Promise.resolve();
    revealed = [];

    expect(resizeObservers).toHaveLength(1);
    expect(resizeObservers[0].observed).toEqual(new Set([
      host,
      host.querySelector(".tab-scroll")!,
    ]));
    resizeObservers[0].callback([], {} as ResizeObserver);
    await Promise.resolve();
    expect(revealed).toEqual([host.querySelector('.tab-item[data-id="a"]')]);

    revealed = [];
    bar.revealActive();
    await Promise.resolve();
    expect(revealed).toEqual([host.querySelector('.tab-item[data-id="a"]')]);
  });

  it("searches open tabs by basename or full path and jumps without rebuilding tabs", async () => {
    const { bar, host, handlers } = setup();
    bar.render([
      view("a", "index.md", true, false, "project-a/index.md"),
      view("b", "index.md", false, true, "notes/nested/index.md"),
      view("c", "proof.md", false, false, "results/proof.md"),
    ]);
    const originalTab = host.querySelector('.tab[data-id="b"]');
    const toggle = host.querySelector<HTMLButtonElement>(".tab-overview-toggle")!;
    toggle.click();
    await Promise.resolve();

    const panel = document.querySelector<HTMLElement>(".tab-overview-panel")!;
    const search = panel.querySelector<HTMLInputElement>(".tab-overview-search")!;
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(search);
    expect(panel.querySelectorAll(".tab-overview-item")).toHaveLength(3);
    expect(panel.querySelector(".tab-overview-count")?.textContent).toBe("3 of 3 open tabs");

    search.value = "nested";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const result = panel.querySelector<HTMLButtonElement>('.tab-overview-select[data-id="b"]')!;
    expect(panel.querySelectorAll(".tab-overview-item")).toHaveLength(1);
    expect(result.textContent).toContain("index.md");
    expect(result.textContent).toContain("notes/nested/index.md");
    expect(result.getAttribute("aria-label")).toBe(
      "Open notes/nested/index.md, unsaved changes",
    );
    result.click();

    expect(handlers.onSelect).toHaveBeenCalledWith("b");
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('.tab[data-id="b"]')).toBe(originalTab);
  });

  it("closes the overview with Escape and restores focus to its launcher", async () => {
    const { bar, host } = setup();
    bar.render([view("a", "a.md", true)]);
    const toggle = host.querySelector<HTMLButtonElement>(".tab-overview-toggle")!;
    toggle.click();
    await Promise.resolve();

    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.querySelector<HTMLElement>(".tab-overview-panel")!.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it("requests one aggregate close for other dirty tabs and all saved tabs", () => {
    const { bar, host, handlers } = setup();
    bar.render([
      view("a", "active.md", true),
      view("b", "dirty.md", false, true),
      view("c", "saved.md"),
    ]);
    const toggle = host.querySelector<HTMLButtonElement>(".tab-overview-toggle")!;
    toggle.click();
    document.querySelector<HTMLButtonElement>(".tab-overview-close-others")!.click();
    expect(handlers.onBulkClose).toHaveBeenCalledOnce();
    expect(handlers.onBulkClose).toHaveBeenLastCalledWith({
      mode: "others",
      activeId: "a",
      tabIds: ["b", "c"],
      dirtyTabIds: ["b"],
    });
    expect(handlers.onClose).not.toHaveBeenCalled();

    toggle.click();
    document.querySelector<HTMLButtonElement>(".tab-overview-close-saved")!.click();
    expect(handlers.onBulkClose).toHaveBeenLastCalledWith({
      mode: "saved",
      activeId: "a",
      tabIds: ["a", "c"],
      dirtyTabIds: [],
    });
    expect(handlers.onBulkClose).toHaveBeenCalledTimes(2);
  });

  it("keeps close-current on the existing single-tab close path", () => {
    const { bar, host, handlers } = setup();
    bar.render([view("a", "active.md", true, true), view("b", "other.md")]);
    host.querySelector<HTMLButtonElement>(".tab-overview-toggle")!.click();
    document.querySelector<HTMLButtonElement>(".tab-overview-close-current")!.click();
    expect(handlers.onClose).toHaveBeenCalledOnce();
    expect(handlers.onClose).toHaveBeenCalledWith("a");
    expect(handlers.onBulkClose).not.toHaveBeenCalled();
  });

  it("disconnects resize containment and removes its portal when destroyed", () => {
    const { bar } = setup();
    const panel = document.querySelector(".tab-overview-panel");
    expect(panel).not.toBeNull();
    bar.destroy();
    expect(resizeObservers[0].disconnected).toBe(true);
    expect(panel?.isConnected).toBe(false);
  });

  it("preserves drag reordering with the keyed tab items", () => {
    const { bar, host, handlers } = setup();
    bar.render([view("a", "a.md", true), view("b", "b.md")]);
    host.querySelector('.tab[data-id="a"]')!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    host.querySelector('.tab-item[data-id="b"]')!.dispatchEvent(
      new Event("drop", { bubbles: true, cancelable: true }),
    );
    expect(handlers.onReorder).toHaveBeenCalledWith("a", 1);
  });
});
