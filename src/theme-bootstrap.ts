(() => {
  let preference = "system";
  try {
    const stored = JSON.parse(localStorage.getItem("mdlyx:config") || "{}") as {
      theme?: unknown;
    };
    if (stored.theme === "light" || stored.theme === "dark") preference = stored.theme;
  } catch {
    // A malformed preference must not delay application startup.
  }

  const systemDark = typeof matchMedia === "function"
    && matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = preference === "dark"
    || (preference === "system" && systemDark);
  const resolved = dark ? "dark" : "light";
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#171717" : "#f6f4ee");
})();
