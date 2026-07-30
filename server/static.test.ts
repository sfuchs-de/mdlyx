import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serveStaticApp } from "./static.js";

const servers: ReturnType<typeof createServer>[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function start() {
  const root = await mkdtemp(join(tmpdir(), "mathdown-static-"));
  roots.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<main>Mathdown</main>");
  await writeFile(join(root, "assets", "app-BUhPMnYn.js"), "console.log('mathdown')");
  await writeFile(join(root, "favicon.ico"), "ico");
  await writeFile(join(root, "icon-192.png"), "png");
  await writeFile(join(root, "site.webmanifest"), "{}");
  const server = createServer((req, res) => serveStaticApp(root, req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("same-origin Mathdown static host", () => {
  it("serves the SPA, client routes, and assets with the expected security policy", async () => {
    const base = await start();
    const home = await fetch(base);
    expect(home.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(home.headers.get("cache-control")).toBe("no-cache");
    await expect(home.text()).resolves.toContain("Mathdown");

    const route = await fetch(`${base}/github-link`);
    await expect(route.text()).resolves.toContain("Mathdown");

    const asset = await fetch(`${base}/assets/app-BUhPMnYn.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    await expect(asset.text()).resolves.toContain("console.log");
    await expect(fetch(`${base}/assets/missing.js`)).resolves.toMatchObject({ status: 404 });
  });

  it("serves stable branding assets with their web MIME types and revalidation", async () => {
    const base = await start();
    const assets = [
      ["/favicon.ico", "image/x-icon"],
      ["/icon-192.png", "image/png"],
      ["/site.webmanifest", "application/manifest+json"],
    ] as const;

    for (const [path, contentType] of assets) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      await response.arrayBuffer();
    }
  });

  it("supports HEAD and rejects mutating methods with the security policy intact", async () => {
    const base = await start();
    const head = await fetch(base, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/html");
    expect(await head.text()).toBe("");

    const post = await fetch(base, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect(post.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
