import { createServer, request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { GitHubError, type GitHubLibraryApi } from "./github.js";
import type { PendingDeviceStore } from "./pending-device-store.js";

const servers: ReturnType<typeof createServer>[] = [];

const config: Config = {
  appOrigin: "https://research-library-api.onrender.com",
  apiOrigin: "https://research-library-api.onrender.com",
  desktopAppOrigins: [],
  allowedLogin: "example-owner",
  libraryOwner: "example-owner",
  libraryRepo: "research-library",
  libraryBranch: "main",
  libraryProtectedBranch: "protected-main",
  accessPolicyPath: "library-access.yaml",
  releaseOwner: "example-owner",
  releaseRepo: "mdlyx",
  releaseGithubAppId: "789",
  releaseGithubInstallationId: "987",
  releaseGithubPrivateKey: "not-used-by-this-mock",
  sessionSecret: "test-secret",
  inviteTokenSecret: "invite-test-secret",
  githubAppId: "123",
  githubClientId: "client-id",
  githubClientSecret: "client-secret",
  githubInstallationId: "456",
  githubPrivateKey: "not-used-by-this-mock",
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start(
  overrides: Record<string, unknown> = {},
  appConfig = config,
  pendingDevices?: PendingDeviceStore,
) {
  const github = {
    oauthUser: async () => ({ login: "example-owner" }),
    ...overrides,
  } as unknown as GitHubLibraryApi;
  const server = createServer(createApp(
    appConfig,
    github,
    { version: "0.3.0", revision: "abcdef123456" },
    pendingDevices,
  ));
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

function firstCookie(response: Response): string {
  return setCookies(response)[0]?.split(";", 1)[0] ?? "";
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.();
  if (values?.length) return values;
  const combined = response.headers.get("set-cookie");
  return combined ? combined.split(/,(?=\s*[A-Za-z0-9_]+=)/) : [];
}

function expectBrowserCookies(response: Response, names: string[]): void {
  const values = setCookies(response);
  expect(values).toHaveLength(names.length);
  for (const name of names) {
    const value = values.find((candidate) => candidate.trimStart().startsWith(`${name}=`));
    expect(value, `missing ${name} cookie`).toBeDefined();
    expect(value).toContain("Path=/");
    expect(value).toContain("HttpOnly");
    expect(value).toContain("Secure");
    expect(value).toContain("SameSite=Lax");
  }
}

describe("GitHub OAuth callback relay", () => {
  it("rejects malformed request URLs without terminating the API process", async () => {
    const base = await start();
    const malformed = await rawGet(base, "//[");
    expect(malformed.status).toBe(400);
    expect(malformed.headers["content-type"]).toContain("application/json");
    const payload = JSON.parse(malformed.body) as { error: string; requestId: string };
    expect(payload.error).toBe("Malformed request URL");
    expect(payload.requestId).toMatch(/^[A-Za-z0-9-]+$/);
    await expect(fetch(`${base}/health`)).resolves.toMatchObject({ status: 200 });
  });

  it("rate-limits one forwarded client without blocking another", async () => {
    const base = await start();
    const headers = { "x-forwarded-for": "203.0.113.7" };
    for (let count = 0; count < 180; count++) {
      const response = await fetch(`${base}/health`, { headers });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const limited = await fetch(`${base}/health`, {
      headers: { ...headers, "x-request-id": "rate-limit-proof" },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("x-request-id")).toBe("rate-limit-proof");
    await expect(limited.json()).resolves.toEqual({
      error: "Too many requests; retry shortly",
      requestId: "rate-limit-proof",
    });

    const otherClient = await fetch(`${base}/health`, {
      headers: { "x-forwarded-for": "203.0.113.8" },
    });
    expect(otherClient.status).toBe(200);
  });

  it("reports service version and deployment revision through health", async () => {
    const base = await start();
    const response = await fetch(`${base}/health`, { headers: { origin: config.appOrigin } });
    await expect(response.json()).resolves.toEqual({
      ok: true,
      configured: false,
      releaseConfigured: true,
      pendingDeviceStoreMode: "memory",
      pendingDeviceStoreReady: true,
      inviteStoreMode: "memory",
      inviteStoreReady: true,
      version: "0.3.0",
      revision: "abcdef123456",
    });
  });

  it("fails readiness while the durable pending-device store is disconnected", async () => {
    const pendingDevices: PendingDeviceStore = {
      mode: "redis",
      set: async () => {},
      get: async () => null,
      delete: async () => {},
      isReady: () => false,
    };
    const base = await start({}, config, pendingDevices);
    const health = await fetch(`${base}/health`, { headers: { origin: config.appOrigin } });
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      pendingDeviceStoreMode: "redis",
      pendingDeviceStoreReady: false,
    });
    const ready = await fetch(`${base}/ready`, { headers: { origin: config.appOrigin } });
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toMatchObject({
      ready: false,
      pendingDeviceStoreMode: "redis",
      pendingDeviceStoreReady: false,
    });
  });

  it("actively probes durable-store readiness instead of trusting socket state", async () => {
    const pendingDevices: PendingDeviceStore = {
      mode: "redis",
      set: async () => {},
      get: async () => null,
      delete: async () => {},
      isReady: () => true,
      checkReady: async () => false,
    };
    const base = await start({}, config, pendingDevices);
    const ready = await fetch(`${base}/ready`, { headers: { origin: config.appOrigin } });
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toMatchObject({
      ready: false,
      pendingDeviceStoreReady: false,
    });
  });

  it("reports release-feed readiness separately from library readiness", async () => {
    const base = await start({}, {
      ...config,
      releaseGithubAppId: undefined,
      releaseGithubInstallationId: undefined,
      releaseGithubPrivateKey: undefined,
    });
    const health = await fetch(`${base}/health`, { headers: { origin: config.appOrigin } });
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      releaseConfigured: false,
    });
    const ready = await fetch(`${base}/ready`, { headers: { origin: config.appOrigin } });
    await expect(ready.json()).resolves.toMatchObject({
      releaseConfigured: false,
    });
  });

  it("returns GitHub to the same-origin SPA and exchanges the code through a protected POST", async () => {
    const assetWrites: unknown[][] = [];
    const base = await start({
      index: async () => ({
        revision: "tree-sha",
        entries: [{ path: "proof.md", sha: "blob-sha", meta: { id: "proof" }, openCommentCount: 0 }],
      }),
      assets: async () => ({
        revision: "tree-sha",
        entries: [{ path: "assets/clock.pdf", sha: "asset-sha", size: 12 }],
      }),
      readAsset: async () => ({
        path: "assets/clock.pdf", sha: "asset-sha", size: 4, content: "AAEC/w==",
      }),
      writeAsset: async (...args: unknown[]) => {
        assetWrites.push(args);
        return { path: "assets/clock.pdf", sha: "asset-new", size: 4 };
      },
    });
    const begin = await fetch(`${base}/auth/github`, { redirect: "manual" });
    expect(begin.status).toBe(302);
    const destination = new URL(begin.headers.get("location")!);
    expect(destination.origin + destination.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(destination.searchParams.get("redirect_uri")).toBe("https://research-library-api.onrender.com/github-link");
    expect(destination.searchParams.get("client_id")).toBe("client-id");
    expectBrowserCookies(begin, ["mathdown_library_oauth"]);

    const complete = await fetch(`${base}/auth/complete`, {
      method: "POST",
      headers: {
        cookie: firstCookie(begin),
        origin: config.appOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: "github-code", state: destination.searchParams.get("state") }),
    });
    await expect(complete.json()).resolves.toEqual({ authenticated: true, login: "example-owner" });
    expect(complete.headers.get("access-control-allow-origin")).toBe(config.appOrigin);
    expect(complete.headers.get("access-control-allow-credentials")).toBe("true");
    expect(complete.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, OPTIONS");
    expect(complete.headers.get("vary")).toBe("Origin");
    expectBrowserCookies(complete, [
      "mathdown_library_session",
      "mathdown_library_oauth",
      "mathdown_library_device",
    ]);

    const session = await fetch(`${base}/auth/session`, {
      headers: { cookie: firstCookie(complete), origin: config.appOrigin },
    });
    await expect(session.json()).resolves.toMatchObject({
      authenticated: true,
      login: "example-owner",
      principal: { id: "example-owner", kind: "owner" },
      capabilities: { canShare: true, canUseUpdater: true },
    });

    const index = await fetch(`${base}/v2/library/index`, {
      headers: { cookie: firstCookie(complete), origin: config.appOrigin },
    });
    expect(index.headers.get("etag")).toBe('"tree-sha.owner"');
    await expect(index.json()).resolves.toMatchObject({ revision: "tree-sha" });
    const unchanged = await fetch(`${base}/v2/library/index`, {
      headers: {
        cookie: firstCookie(complete),
        origin: config.appOrigin,
        "if-none-match": '"tree-sha.owner"',
      },
    });
    expect(unchanged.status).toBe(304);

    const assets = await fetch(`${base}/v2/library/assets`, {
      headers: { cookie: firstCookie(complete), origin: config.appOrigin },
    });
    expect(assets.headers.get("etag")).toBe('"tree-sha.owner"');
    await expect(assets.json()).resolves.toMatchObject({
      entries: [{ path: "assets/clock.pdf", sha: "asset-sha", size: 12 }],
    });

    const asset = await fetch(`${base}/v2/library/assets/file?path=assets%2Fclock.pdf`, {
      headers: { cookie: firstCookie(complete), origin: config.appOrigin },
    });
    await expect(asset.json()).resolves.toMatchObject({ content: "AAEC/w==", sha: "asset-sha" });
    const savedAsset = await fetch(`${base}/v2/library/assets/file?path=assets%2Fclock.pdf`, {
      method: "PUT",
      headers: {
        cookie: firstCookie(complete),
        origin: config.appOrigin,
        "content-type": "application/json",
        "if-match": "asset-sha",
      },
      body: JSON.stringify({ content: "AAEC/w==" }),
    });
    await expect(savedAsset.json()).resolves.toEqual({
      path: "assets/clock.pdf", sha: "asset-new", size: 4,
    });
    expect(assetWrites).toEqual([["assets/clock.pdf", "AAEC/w==", "asset-sha"]]);

    const logout = await fetch(`${base}/auth/logout`, {
      method: "POST",
      headers: { cookie: firstCookie(complete), origin: config.appOrigin },
    });
    expectBrowserCookies(logout, ["mathdown_library_session"]);
  });

  it("keeps the device code in an HTTP-only cookie while polling GitHub authorization", async () => {
    const base = await start({
      startDeviceAuthorization: async () => ({
        deviceCode: "secret-device-code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        expiresIn: 900,
        interval: 5,
      }),
      pollDeviceAuthorization: async () => ({ state: "authorized", login: "example-owner" }),
    });
    const begin = await fetch(`${base}/auth/device/start`, {
      method: "POST",
      headers: { origin: config.appOrigin },
    });
    await expect(begin.json()).resolves.toEqual({
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    });
    expect(begin.headers.get("access-control-allow-origin")).toBe(config.appOrigin);
    expect(begin.headers.get("access-control-allow-credentials")).toBe("true");
    expectBrowserCookies(begin, ["mathdown_library_device"]);

    const complete = await fetch(`${base}/auth/device/poll`, {
      method: "POST",
      headers: { cookie: firstCookie(begin), origin: config.appOrigin },
    });
    await expect(complete.json()).resolves.toEqual({ state: "authorized", login: "example-owner" });
    expectBrowserCookies(complete, [
      "mathdown_library_session",
      "mathdown_library_oauth",
      "mathdown_library_device",
    ]);
    const session = await fetch(`${base}/auth/session`, {
      headers: { cookie: firstCookie(complete), origin: config.appOrigin },
    });
    await expect(session.json()).resolves.toMatchObject({
      authenticated: true,
      login: "example-owner",
      principal: { id: "example-owner", kind: "owner" },
      capabilities: { canShare: true, canUseUpdater: true },
    });
  });

  it("keeps desktop device state server-side and accepts the resulting bearer session", async () => {
    const desktopConfig: Config = { ...config, desktopAppOrigins: ["tauri://localhost"] };
    const base = await start({
      startDeviceAuthorization: async () => ({
        deviceCode: "secret-device-code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        expiresIn: 900,
        interval: 5,
      }),
      pollDeviceAuthorization: async () => ({ state: "authorized", login: "example-owner" }),
      list: async () => [],
    }, desktopConfig);

    const begin = await fetch(`${base}/auth/device/start`, {
      method: "POST",
      headers: { origin: "tauri://localhost" },
    });
    const pending = await begin.json() as { pendingId: string };
    expect(begin.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect(begin.headers.get("set-cookie")).toBeNull();
    expect(pending.pendingId).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const complete = await fetch(`${base}/auth/device/poll`, {
      method: "POST",
      headers: { origin: "tauri://localhost", "content-type": "application/json" },
      body: JSON.stringify({ pendingId: pending.pendingId }),
    });
    const authorized = await complete.json() as { state: string; desktopSession: string };
    expect(authorized.state).toBe("authorized");
    expect(authorized.desktopSession).toContain(".");
    expect(complete.headers.get("set-cookie")).toBeNull();

    const library = await fetch(`${base}/v1/library`, {
      headers: {
        origin: "tauri://localhost",
        authorization: `Bearer ${authorized.desktopSession}`,
      },
    });
    expect(library.status).toBe(200);
    expect(library.headers.get("access-control-allow-headers")).toContain("authorization");

    const bearerWithoutDesktopOrigin = await fetch(`${base}/v1/library`, {
      headers: { authorization: `Bearer ${authorized.desktopSession}` },
    });
    expect(bearerWithoutDesktopOrigin.status).toBe(401);

    const browserBegin = await fetch(`${base}/auth/device/start`, {
      method: "POST",
      headers: { origin: config.appOrigin },
    });
    const browserComplete = await fetch(`${base}/auth/device/poll`, {
      method: "POST",
      headers: { cookie: firstCookie(browserBegin), origin: config.appOrigin },
    });
    const browserCookie = firstCookie(browserComplete);
    expect(browserCookie).toContain("mathdown_library_session=");

    const cookieOnlyDesktopLibrary = await fetch(`${base}/v1/library`, {
      headers: { cookie: browserCookie, origin: "tauri://localhost" },
    });
    expect(cookieOnlyDesktopLibrary.status).toBe(401);
    const cookieOnlyDesktopUpdater = await fetch(`${base}/v1/software/update/darwin/aarch64/0.3.1`, {
      headers: { cookie: browserCookie, origin: "tauri://localhost" },
    });
    expect(cookieOnlyDesktopUpdater.status).toBe(401);

    const rejected = await fetch(`${base}/health`, { headers: { origin: "https://untrusted.example" } });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
    expect(rejected.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("reports an interrupted desktop attempt instead of a GitHub expiry", async () => {
    const desktopConfig: Config = { ...config, desktopAppOrigins: ["tauri://localhost"] };
    const base = await start({}, desktopConfig);
    const response = await fetch(`${base}/auth/device/poll`, {
      method: "POST",
      headers: { origin: "tauri://localhost", "content-type": "application/json" },
      body: JSON.stringify({ pendingId: "unknown-pending-id" }),
    });
    await expect(response.json()).resolves.toEqual({ state: "interrupted" });
  });

  it("cancels only an origin-bound desktop pending attempt", async () => {
    const records = new Map<string, { deviceCode: string; origin: string; expiresAt: number }>();
    const pendingDevices: PendingDeviceStore = {
      mode: "redis",
      set: async (id, record) => { records.set(id, record); },
      get: async (id) => records.get(id) ?? null,
      delete: async (id) => { records.delete(id); },
      isReady: () => true,
    };
    const desktopConfig: Config = {
      ...config,
      desktopAppOrigins: ["tauri://localhost", "https://tauri.localhost"],
    };
    const base = await start({
      startDeviceAuthorization: async () => ({
        deviceCode: "secret-device-code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        expiresIn: 900,
        interval: 5,
      }),
    }, desktopConfig, pendingDevices);
    const begin = await fetch(`${base}/auth/device/start`, {
      method: "POST",
      headers: { origin: "tauri://localhost" },
    });
    const { pendingId } = await begin.json() as { pendingId: string };

    const wrongOrigin = await fetch(`${base}/auth/device/cancel`, {
      method: "POST",
      headers: { origin: "https://tauri.localhost", "content-type": "application/json" },
      body: JSON.stringify({ pendingId }),
    });
    expect(wrongOrigin.status).toBe(204);
    expect(records.has(pendingId)).toBe(true);

    const cancelled = await fetch(`${base}/auth/device/cancel`, {
      method: "POST",
      headers: { origin: "tauri://localhost", "content-type": "application/json" },
      body: JSON.stringify({ pendingId }),
    });
    expect(cancelled.status).toBe(204);
    expect(records.has(pendingId)).toBe(false);

    const poll = await fetch(`${base}/auth/device/poll`, {
      method: "POST",
      headers: { origin: "tauri://localhost", "content-type": "application/json" },
      body: JSON.stringify({ pendingId }),
    });
    await expect(poll.json()).resolves.toEqual({ state: "interrupted" });
  });

  it("serves authenticated desktop update checks and private updater assets", async () => {
    const desktopConfig: Config = { ...config, desktopAppOrigins: ["tauri://localhost"] };
    const binary = "private updater bytes";
    const updaterCalls: unknown[][] = [];
    const base = await start({
      startDeviceAuthorization: async () => ({
        deviceCode: "secret-device-code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        expiresIn: 900,
        interval: 5,
      }),
      pollDeviceAuthorization: async () => ({ state: "authorized", login: "example-owner" }),
      latestUpdaterRelease: async (...args: unknown[]) => {
        updaterCalls.push(args);
        const [target, arch, currentVersion] = args;
        if (target !== "darwin" || (arch !== "aarch64" && arch !== "x86_64")) {
          throw new GitHubError(400, "Unsupported updater target or architecture");
        }
        if (currentVersion === "0.4.0") return null;
        return {
          releaseId: 44,
          version: "0.4.0",
          notes: "Updater is ready.",
          pubDate: "2026-07-12T12:00:00Z",
          signature: "signed-update-payload",
          assetId: 202,
          assetName: "MdLyx_0.4.0_universal.app.tar.gz",
        };
      },
      downloadUpdaterAsset: async (releaseId: number, assetId: number, assetName: string) => {
        if (releaseId !== 44 || assetId !== 202 || assetName !== "MdLyx_0.4.0_universal.app.tar.gz") {
          throw new GitHubError(404, "Updater asset was not found in this release");
        }
        return {
          name: assetName,
          contentType: "application/gzip",
          contentLength: Buffer.byteLength(binary),
          body: new Response(binary).body!,
        };
      },
    }, desktopConfig);

    const unauthenticated = await fetch(`${base}/v1/software/update/darwin/aarch64/0.3.1`, {
      headers: { origin: "tauri://localhost" },
    });
    expect(unauthenticated.status).toBe(401);
    expect(updaterCalls).toHaveLength(0);

    const begin = await fetch(`${base}/auth/device/start`, {
      method: "POST",
      headers: { origin: "tauri://localhost" },
    });
    const pending = await begin.json() as { pendingId: string };
    const complete = await fetch(`${base}/auth/device/poll`, {
      method: "POST",
      headers: { origin: "tauri://localhost", "content-type": "application/json" },
      body: JSON.stringify({ pendingId: pending.pendingId }),
    });
    const session = await complete.json() as { desktopSession: string };
    const headers = {
      origin: "tauri://localhost",
      authorization: `Bearer ${session.desktopSession}`,
    };

    const update = await fetch(`${base}/v1/software/update/darwin/aarch64/0.3.1`, { headers });
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toEqual({
      version: "0.4.0",
      notes: "Updater is ready.",
      pub_date: "2026-07-12T12:00:00Z",
      url: `${config.apiOrigin}/v1/software/update/assets/44/202/MdLyx_0.4.0_universal.app.tar.gz`,
      signature: "signed-update-payload",
    });
    expect(update.headers.get("access-control-allow-origin")).toBe("tauri://localhost");

    const intelUpdate = await fetch(`${base}/v1/software/update/darwin/x86_64/0.3.1`, { headers });
    expect(intelUpdate.status).toBe(200);
    await expect(intelUpdate.json()).resolves.toMatchObject({
      version: "0.4.0",
      url: `${config.apiOrigin}/v1/software/update/assets/44/202/MdLyx_0.4.0_universal.app.tar.gz`,
    });

    const current = await fetch(`${base}/v1/software/update/darwin/aarch64/0.4.0`, { headers });
    expect(current.status).toBe(204);
    expect(await current.text()).toBe("");

    const invalidTarget = await fetch(`${base}/v1/software/update/windows/aarch64/0.3.1`, { headers });
    expect(invalidTarget.status).toBe(400);
    await expect(invalidTarget.json()).resolves.toMatchObject({ error: "Unsupported updater target or architecture" });

    const asset = await fetch(`${base}/v1/software/update/assets/44/202/MdLyx_0.4.0_universal.app.tar.gz`, { headers });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("application/gzip");
    expect(asset.headers.get("content-disposition")).toContain("MdLyx_0.4.0_universal.app.tar.gz");
    expect(await asset.text()).toBe(binary);

    const missingAsset = await fetch(`${base}/v1/software/update/assets/44/999/missing.app.tar.gz`, { headers });
    expect(missingAsset.status).toBe(404);
    await expect(missingAsset.json()).resolves.toMatchObject({ error: "Updater asset was not found in this release" });
  });
});
