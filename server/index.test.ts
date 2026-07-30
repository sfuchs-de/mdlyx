import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PendingDeviceStore } from "./pending-device-store.js";
import { createUnconfiguredApp } from "./unconfigured.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function request(path: string, headers: HeadersInit = {}, method = "GET") {
  const server = createServer(createUnconfiguredApp({
    APP_ORIGIN: "https://mdlyx.onrender.com",
    DESKTOP_APP_ORIGINS: "tauri://localhost",
    npm_package_version: "0.3.0",
    RENDER_GIT_COMMIT: "abcdef1234567890",
  }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
}

describe("unconfigured library API", () => {
  it("allows the static site to read the setup health signal", async () => {
    const response = await request("/health?probe=browser", { origin: "https://mdlyx.onrender.com" });
    await expect(response.json()).resolves.toEqual({
      ok: true,
      configured: false,
      releaseConfigured: false,
      pendingDeviceStoreMode: "memory",
      pendingDeviceStoreReady: false,
      version: "0.3.0",
      revision: "abcdef123456",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://mdlyx.onrender.com");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("keeps rate limiting active while GitHub configuration is incomplete", async () => {
    const server = createServer(createUnconfiguredApp({
      APP_ORIGIN: "https://mdlyx.onrender.com",
    }));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const headers = { "x-forwarded-for": "203.0.113.11" };
    for (let count = 0; count < 180; count++) {
      const response = await fetch(`${base}/health`, { headers });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const limited = await fetch(`${base}/health`, {
      headers: { ...headers, "x-request-id": "unconfigured-limit" },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toMatchObject({ requestId: "unconfigured-limit" });
  });

  it("reports unconfigured readiness without exposing connection details", async () => {
    const response = await request("/ready", { origin: "https://mdlyx.onrender.com" });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ready: false,
      pendingDeviceStoreMode: "memory",
      pendingDeviceStoreReady: false,
    });
  });

  it("allows desktop bearer preflights while the service is awaiting GitHub secrets", async () => {
    const response = await request("/health", {
      origin: "tauri://localhost",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    }, "OPTIONS");
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("reports an initialized store without exposing its connection details", async () => {
    const pendingDevices: PendingDeviceStore = {
      mode: "redis",
      set: async () => {},
      get: async () => null,
      delete: async () => {},
      isReady: () => true,
    };
    const server = createServer(createUnconfiguredApp({
      APP_ORIGIN: "https://mdlyx.onrender.com",
      NODE_ENV: "production",
      REDIS_URL: "redis://private.internal:6379",
    }, pendingDevices));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    await expect(response.json()).resolves.toMatchObject({
      pendingDeviceStoreMode: "redis",
      pendingDeviceStoreReady: true,
    });
  });
});
