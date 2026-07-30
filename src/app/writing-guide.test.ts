// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterWritingGuideSections,
  WritingGuide,
  WRITING_GUIDE_SECTIONS,
} from "./writing-guide";

let activeGuide: WritingGuide | null = null;

beforeEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});

afterEach(() => {
  activeGuide?.destroy();
  activeGuide = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Writing guide", () => {
  it("searches titles, syntax, descriptions, shortcuts, and synonyms", () => {
    const wiki = filterWritingGuideSections("wiki anchor");
    expect(wiki).toHaveLength(1);
    expect(wiki[0].title).toBe("Documents, results, and links");
    expect(wiki[0].items.map((item) => item.title)).toEqual(["Document anchor link"]);

    const shortcut = filterWritingGuideSections("inline ctrl-m");
    expect(shortcut.flatMap((section) => section.items).map((item) => item.title))
      .toEqual(["Inline mathematics"]);

    expect(filterWritingGuideSections("nonexistent feature")).toEqual([]);
    expect(filterWritingGuideSections("")).toHaveLength(WRITING_GUIDE_SECTIONS.length);
  });

  it("opens as an accessible, searchable panel and restores launcher focus", () => {
    const launcher = document.createElement("button");
    document.body.append(launcher);
    const guide = new WritingGuide(launcher);
    activeGuide = guide;

    launcher.click();
    const panel = document.getElementById("writing-guide")!;
    const query = panel.querySelector<HTMLInputElement>("[type='search']")!;
    expect(panel.hidden).toBe(false);
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-label")).toBe("Writing guide");
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(query);

    query.value = "footnote matching";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    expect(panel.textContent).toContain("Footnote");
    expect(panel.textContent).not.toContain("Aligned systems");
    expect(panel.querySelectorAll(".writing-guide-item")).toHaveLength(1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(launcher);
  });

  it("toggles from F1 and copies a syntax example", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const launcher = document.createElement("button");
    document.body.append(launcher);
    const guide = new WritingGuide(launcher);
    activeGuide = guide;

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "F1",
      bubbles: true,
      cancelable: true,
    }));
    expect(guide.isOpen).toBe(true);
    const copy = document.querySelector<HTMLButtonElement>(
      "[aria-label='Copy syntax for Headings and stable anchors']",
    )!;
    copy.click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("## Section title {#sec:results}");
      expect(document.querySelector(".writing-guide-status")?.textContent)
        .toBe("Copied Headings and stable anchors");
    });

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "F1",
      bubbles: true,
      cancelable: true,
    }));
    expect(guide.isOpen).toBe(false);
  });
});
