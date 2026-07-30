// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  isThemePreference,
  resolveTheme,
  watchSystemTheme,
} from "./theme";

afterEach(() => {
  document.head.textContent = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-preference");
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
});

describe("theme preferences", () => {
  it("validates preferences and resolves system appearance", () => {
    expect(["system", "light", "dark"].every(isThemePreference)).toBe(true);
    expect(isThemePreference("sepia")).toBe(false);
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("applies the resolved theme and browser chrome color", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);

    expect(applyTheme("system", document, true)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreference).toBe("system");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(meta.content).toBe("#171717");

    applyTheme("light", document, true);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(meta.content).toBe("#f6f4ee");
  });

  it("reacts to operating-system theme changes and unsubscribes", () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined;
    const remove = vi.fn();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: (_type: string, next: (event: MediaQueryListEvent) => void) => {
        listener = next;
      },
      removeEventListener: remove,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList)));
    const changed = vi.fn();

    const stop = watchSystemTheme(changed);
    listener?.({ matches: true } as MediaQueryListEvent);
    expect(changed).toHaveBeenCalledWith(true);

    stop();
    expect(remove).toHaveBeenCalledOnce();
  });
});
