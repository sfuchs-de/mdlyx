import { defineConfig } from "vitest/config";
import packageJson from "./package.json";

// Unit + component tests only. Playwright e2e (`*.e2e.ts`) is run separately by
// playwright.config.ts, so exclude it here.
export default defineConfig({
  define: {
    __MATHDOWN_VERSION__: JSON.stringify(packageJson.version),
    __MATHDOWN_REVISION__: JSON.stringify("test-revision"),
  },
  test: {
    include: ["src/**/*.test.ts", "server/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
