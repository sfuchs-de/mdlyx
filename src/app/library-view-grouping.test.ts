// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeMeta } from "../markdown/frontmatter";
import type { LibraryFile } from "./library";
import type { LibrarySyncController } from "./library-sync-controller";
import { LibraryView } from "./library-view";

const GROUP_KEY = "mdlyx:lib-groupby";

function syncController(): LibrarySyncController {
  const snapshot = {
    status: { state: "ready" as const, authenticated: true, login: "example-owner" },
    connected: true,
    error: null,
    device: null,
  };
  return {
    snapshot: () => snapshot,
    subscribe: (listener: (value: typeof snapshot) => void) => {
      listener(snapshot);
      return () => undefined;
    },
  } as unknown as LibrarySyncController;
}

function projectFile(
  folder: string,
  name: string,
  projects: string[],
  tags: string[] = [],
): LibraryFile {
  const id = `${folder}-${name}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return {
    name,
    folder,
    handle: null,
    meta: normalizeMeta({ id, title: name.replace(/\.md$/, ""), projects, tags }),
    openCommentCount: 0,
  };
}

function mount(files: LibraryFile[]): { host: HTMLElement; view: LibraryView } {
  const host = document.createElement("aside");
  document.body.append(host);
  const view = new LibraryView(host, { onOpen: vi.fn() }, syncController());
  view.injectMock("Fixture", files);
  return { host, view };
}

function group(host: HTMLElement, key: string): HTMLElement {
  const section = [...host.querySelectorAll<HTMLElement>(".lib-group-section")]
    .find((candidate) => candidate.dataset.groupKey === key);
  if (!section) throw new Error(`missing group ${key}`);
  return section;
}

function disclosure(section: HTMLElement): HTMLButtonElement {
  const button = section.querySelector<HTMLButtonElement>(".lib-group-head");
  if (!button) throw new Error("missing group disclosure");
  return button;
}

function groupBody(section: HTMLElement): HTMLElement {
  const body = section.querySelector<HTMLElement>(".lib-group-body");
  if (!body) throw new Error("missing group body");
  return body;
}

afterEach(() => {
  document.body.textContent = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("LibraryView project disclosures", () => {
  const files = [
    projectFile("alpha", "alpha.md", ["Alpha"]),
    projectFile("beta", "beta.md", ["Beta"]),
    projectFile("other-notes", "note.md", []),
  ];

  it("defaults to collapsed project grouping without overwriting saved alternatives", async () => {
    const { host } = mount(files);
    await vi.waitFor(() => expect(host.querySelectorAll(".lib-group-section")).toHaveLength(3));

    expect((host.querySelector("select.lib-group-select") as HTMLSelectElement).value).toBe("project");
    expect(localStorage.getItem(GROUP_KEY)).toBeNull();
    for (const section of host.querySelectorAll<HTMLElement>(".lib-group-section")) {
      const button = disclosure(section);
      const body = groupBody(section);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.getAttribute("aria-controls")).toBe(body.id);
      expect(body.hidden).toBe(true);
    }

    localStorage.setItem(GROUP_KEY, "flat");
    const saved = mount(files);
    await vi.waitFor(() => expect(saved.host.querySelectorAll(".lib-file")).toHaveLength(3));
    expect((saved.host.querySelector("select.lib-group-select") as HTMLSelectElement).value).toBe("flat");
    expect(saved.host.querySelectorAll(".lib-group-section")).toHaveLength(0);
  });

  it("falls back to project grouping for an invalid saved value", async () => {
    localStorage.setItem(GROUP_KEY, "not-a-group");
    const { host } = mount(files);
    await vi.waitFor(() => expect(host.querySelectorAll(".lib-group-section")).toHaveLength(3));
    expect((host.querySelector("select.lib-group-select") as HTMLSelectElement).value).toBe("project");
  });

  it("toggles one native disclosure and keeps its ARIA state synchronized", async () => {
    const { host } = mount(files);
    await vi.waitFor(() => expect(host.querySelectorAll(".lib-group-section")).toHaveLength(3));
    const alpha = group(host, "Alpha");
    const alphaButton = disclosure(alpha);
    const alphaBody = groupBody(alpha);
    const betaButton = disclosure(group(host, "Beta"));

    alphaButton.click();
    expect(alphaButton.getAttribute("aria-expanded")).toBe("true");
    expect(alphaBody.hidden).toBe(false);
    expect(betaButton.getAttribute("aria-expanded")).toBe("false");

    alphaButton.click();
    expect(alphaButton.getAttribute("aria-expanded")).toBe("false");
    expect(alphaBody.hidden).toBe(true);
  });

  it("shows flat deduplicated search results and restores project disclosures", async () => {
    const { host } = mount(files);
    await vi.waitFor(() => expect(host.querySelectorAll(".lib-group-section")).toHaveLength(3));
    const search = host.querySelector<HTMLInputElement>(".lib-search")!;

    // A sibling that is temporarily absent from the search projection keeps
    // its manual disclosure choice.
    disclosure(group(host, "Beta")).click();

    search.value = "alpha";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(host.querySelectorAll(".lib-group-section")).toHaveLength(0);
    expect(host.querySelectorAll('.lib-file[data-path="alpha/alpha.md"]')).toHaveLength(1);
    expect(host.querySelector(".lib-file-context")?.textContent).toContain("Alpha");
    expect(host.querySelector(".lib-list-summary")?.textContent).toBe("1 match");

    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const restored = group(host, "Alpha");
    expect(disclosure(restored).getAttribute("aria-expanded")).toBe("false");
    expect(groupBody(restored).hidden).toBe(true);
    expect(disclosure(group(host, "Beta")).getAttribute("aria-expanded")).toBe("true");
  });

  it("reveals each project containing the newly active exact path", async () => {
    const shared = projectFile("shared", "result.md", ["Alpha", "Beta"]);
    const { host, view } = mount([shared]);
    await vi.waitFor(() => expect(host.querySelectorAll(".lib-group-section")).toHaveLength(2));

    view.setActive("result.md", null, "shared/result.md");
    for (const key of ["Alpha", "Beta"]) {
      const section = group(host, key);
      expect(disclosure(section).getAttribute("aria-expanded")).toBe("true");
      expect(section.classList.contains("has-active-document")).toBe(true);
    }
    for (const row of host.querySelectorAll<HTMLElement>('[data-path="shared/result.md"]')) {
      expect(row.getAttribute("aria-current")).toBe("page");
    }

    disclosure(group(host, "Alpha")).click();
    view.setActive("result.md", null, "shared/result.md");
    expect(disclosure(group(host, "Alpha")).getAttribute("aria-expanded")).toBe("false");
  });

  it("reveals a newly containing project after a same-path index refresh", async () => {
    const active = projectFile("research", "result.md", ["Alpha"]);
    const { host, view } = mount([active]);
    await vi.waitFor(() => expect(host.querySelectorAll(".lib-group-section")).toHaveLength(1));

    view.setActive("result.md", null, "research/result.md");
    expect(disclosure(group(host, "Alpha")).getAttribute("aria-expanded")).toBe("true");
    disclosure(group(host, "Alpha")).click();

    view.setActiveMeta(normalizeMeta({ ...active.meta, title: "Updated result" }));
    expect(disclosure(group(host, "Alpha")).getAttribute("aria-expanded")).toBe("false");

    active.meta = normalizeMeta({ ...active.meta, projects: ["Alpha", "Beta"] });
    (view as unknown as { renderList: () => void }).renderList();

    expect(disclosure(group(host, "Alpha")).getAttribute("aria-expanded")).toBe("false");
    expect(disclosure(group(host, "Beta")).getAttribute("aria-expanded")).toBe("true");
  });
});
