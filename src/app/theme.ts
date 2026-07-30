export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

const DARK_QUERY = "(prefers-color-scheme: dark)";
const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: "#f6f4ee",
  dark: "#171717",
};

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark = systemPrefersDark(),
): ResolvedTheme {
  if (preference !== "system") return preference;
  return systemDark ? "dark" : "light";
}

export function applyTheme(
  preference: ThemePreference,
  doc: Document = document,
  systemDark = systemPrefersDark(),
): ResolvedTheme {
  const resolved = resolveTheme(preference, systemDark);
  const root = doc.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;

  const themeColor = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = THEME_COLORS[resolved];

  return resolved;
}

export function watchSystemTheme(onChange: (dark: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia(DARK_QUERY);
  const listener = (event: MediaQueryListEvent) => onChange(event.matches);
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }

  // Older WebKit releases expose the deprecated listener pair only.
  query.addListener(listener);
  return () => query.removeListener(listener);
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(DARK_QUERY).matches;
}
