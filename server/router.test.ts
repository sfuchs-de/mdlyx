import { createServer } from "node:http";
import { request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRequestRouter, type ApiHandler } from "./router.js";

const servers: ReturnType<typeof createServer>[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const respondingApi: ApiHandler = (req, res) => {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ path: new URL(req.url ?? "/", "http://localhost").pathname }));
};

async function start(api: ApiHandler = respondingApi): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mathdown-router-"));
  roots.push(root);
  await writeFile(join(root, "index.html"), "<main>Mathdown SPA</main>");
  const server = createServer(createRequestRouter(api, root));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function rawGet(base: string, path: string): Promise<{
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("production request router", () => {
  it.each([
    "/health",
    "/ready",
    "/auth/session",
    "/v1/library",
    "/v2/library/index",
    "/v2/library/assets",
  ])("routes %s to the API handler", async (path) => {
    const response = await fetch(`${await start()}${path}`);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ path });
  });

  it("retains the SPA fallback for document routes", async () => {
    const response = await fetch(`${await start()}/github-link`);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toContain("Mathdown SPA");
  });

  it("rejects a malformed request URL without crashing the server", async () => {
    const base = await start();
    const malformed = await rawGet(base, "//[");
    expect(malformed.status).toBe(400);
    expect(malformed.headers["content-security-policy"]).toContain("default-src 'self'");
    await expect(fetch(`${base}/health`)).resolves.toMatchObject({ status: 200 });
  });

  it("rejects invalid path encoding with the static security policy intact", async () => {
    const response = await rawGet(await start(), "/%ZZ");
    expect(response.status).toBe(400);
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.body).toBe("");
  });

  it("sanitizes an unexpected API-handler rejection", async () => {
    const response = await fetch(`${await start(() => {
      throw new Error("secret internal detail");
    })}/health`);
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({ error: "Unexpected server error" });
  });
});
