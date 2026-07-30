import { defineConfig, devices } from "@playwright/test";

// End-to-end tests (Phase 9). Requires browsers: `npx playwright install chromium webkit`.
// Runs against the Vite dev server, which Playwright starts automatically.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  // Tests wait on explicit editor/render state. A retry would hide a real race.
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: "**/mobile-touch.e2e.ts",
    },
    {
      // macOS Tauri embeds WebKit. Keep a focused parity suite here while the
      // packaged app itself remains covered by the release smoke checklist.
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: [
        "**/project-overview.e2e.ts",
        "**/dependency-graph.e2e.ts",
        "**/authoring.e2e.ts",
        "**/github-library.e2e.ts",
        "**/persistence.e2e.ts",
        "**/ui-stabilization.e2e.ts",
        "**/accessibility.e2e.ts",
      ],
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] },
      testMatch: "**/mobile-touch.e2e.ts",
    },
    {
      name: "mobile-webkit",
      use: { ...devices["iPhone 13"] },
      testMatch: "**/mobile-touch.e2e.ts",
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
