import { defineConfig } from "vite";
import type { Plugin } from "vite";
import packageJson from "./package.json";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import type { OutputBundle, OutputChunk } from "rollup";

// Budget the emitted entry chunk itself. Core static dependencies are tracked
// separately by Vite; specialist workspaces are forbidden from that static
// graph below and from HTML modulepreloads.
const ENTRY_CHUNK_GZIP_BUDGET_BYTES = 150 * 1024;
const SOFTWARE_DISTRIBUTIONS = ["development", "signed-release"] as const;
const OPTIONAL_STARTUP_MODULES = [
  /\/node_modules\/mathlive\//,
  /\/node_modules\/@dagrejs\/dagre\//,
  /\/src\/app\/(?:dependency-graph(?:-canvas)?|project-catalog-controller|project-graph-view|project-overview(?:-view)?|project-selection)\.ts$/,
];

function staticChunks(entry: OutputChunk, bundle: OutputBundle): OutputChunk[] {
  const chunks = new Map(
    Object.values(bundle)
      .filter((item): item is OutputChunk => item.type === "chunk")
      .map((chunk) => [chunk.fileName, chunk]),
  );
  const visited = new Set<string>();
  const visit = (chunk: OutputChunk): void => {
    if (visited.has(chunk.fileName)) return;
    visited.add(chunk.fileName);
    for (const imported of chunk.imports) {
      const dependency = chunks.get(imported);
      if (dependency) visit(dependency);
    }
  };
  visit(entry);
  return [...visited].flatMap((fileName) => {
    const chunk = chunks.get(fileName);
    return chunk ? [chunk] : [];
  });
}

function startupBudget(): Plugin {
  return {
    name: "mathdown-startup-budget",
    enforce: "post",
    generateBundle(_options, bundle) {
      const entries = Object.values(bundle).filter(
        (item): item is OutputChunk => item.type === "chunk" && item.isEntry,
      );
      for (const entry of entries) {
        const gzipBytes = gzipSync(entry.code, { level: 9 }).byteLength;
        if (gzipBytes > ENTRY_CHUNK_GZIP_BUDGET_BYTES) {
          this.error(
            `${entry.fileName} entry chunk is ${(gzipBytes / 1024).toFixed(2)} KiB gzip; ` +
              `the entry-chunk budget is ${ENTRY_CHUNK_GZIP_BUDGET_BYTES / 1024} KiB.`,
          );
        }

        for (const chunk of staticChunks(entry, bundle)) {
          const optionalModule = Object.keys(chunk.modules).find((id) =>
            OPTIONAL_STARTUP_MODULES.some((pattern) => pattern.test(id)),
          );
          if (optionalModule) {
            this.error(
              `${chunk.fileName} is loaded by the initial entry but contains optional module ${optionalModule}.`,
            );
          }
        }
      }

      const optionalChunkNames = new Set(
        Object.values(bundle).flatMap((item) =>
          item.type === "chunk" && Object.keys(item.modules).some((id) =>
            OPTIONAL_STARTUP_MODULES.some((pattern) => pattern.test(id)),
          ) ? [item.fileName] : [],
        ),
      );
      for (const item of Object.values(bundle)) {
        if (item.type !== "asset" || !item.fileName.endsWith(".html")) continue;
        const html = typeof item.source === "string" ? item.source : Buffer.from(item.source).toString();
        const preloads = (html.match(/<link\b[^>]*>/g) ?? []).filter((tag) =>
          /\brel=(['"])modulepreload\1/.test(tag),
        );
        for (const chunkName of optionalChunkNames) {
          if (preloads.some((tag) => tag.includes(chunkName))) {
            this.error(`${item.fileName} eagerly module-preloads optional chunk ${chunkName}.`);
          }
        }
      }
    },
  };
}

function sourceRevision(): string {
  const deployed = process.env.RENDER_GIT_COMMIT ?? process.env.GITHUB_SHA;
  if (deployed) return deployed.slice(0, 12);
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function softwareDistribution(): (typeof SOFTWARE_DISTRIBUTIONS)[number] {
  const configured = process.env.MATHDOWN_DISTRIBUTION?.trim() || "development";
  if (SOFTWARE_DISTRIBUTIONS.some((value) => value === configured)) {
    return configured as (typeof SOFTWARE_DISTRIBUTIONS)[number];
  }
  throw new Error(
    `MATHDOWN_DISTRIBUTION must be one of ${SOFTWARE_DISTRIBUTIONS.join(", ")}; received ${JSON.stringify(configured)}.`,
  );
}

// Web-first prototype. The Tauri shell will be layered on later; for now this is
// a plain Vite dev server so we can iterate on the editor core in a browser.
export default defineConfig({
  // Relative assets let the same local-first build run from a root domain,
  // GitHub Pages subpath, or a downloaded static folder.
  base: "./",
  plugins: [startupBudget()],
  define: {
    __MATHDOWN_VERSION__: JSON.stringify(packageJson.version),
    __MATHDOWN_REVISION__: JSON.stringify(sourceRevision()),
    "import.meta.env.MATHDOWN_DISTRIBUTION": JSON.stringify(softwareDistribution()),
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  // MathLive ships fonts/sounds it loads at runtime; keep them un-inlined.
  build: {
    target: "es2022",
    // MathLive is deliberately a large on-demand editor. The compressed entry
    // and eager dependency graph are enforced above instead of warning on that
    // optional chunk's uncompressed size.
    chunkSizeWarningLimit: 900,
  },
});
