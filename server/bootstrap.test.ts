import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceApp } from "./bootstrap.js";
import type { PendingDeviceStore } from "./pending-device-store.js";
import { MemoryInviteStore } from "./invite-store.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("server bootstrap", () => {
  it("connects the production Redis store even while GitHub secrets are incomplete", async () => {
    const pendingDevices: PendingDeviceStore = {
      mode: "redis",
      set: async () => {},
      get: async () => null,
      delete: async () => {},
      isReady: () => true,
      checkReady: async () => true,
    };
    const createRedis = vi.fn(async () => pendingDevices);
    const app = await createServiceApp({
      NODE_ENV: "production",
      APP_ORIGIN: "https://mdlyx.onrender.com",
      REDIS_URL: "redis://private.internal:6379",
    }, createRedis, async () => new MemoryInviteStore());
    expect(createRedis).toHaveBeenCalledWith("redis://private.internal:6379");

    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    await expect(health.json()).resolves.toMatchObject({
      configured: false,
      pendingDeviceStoreMode: "redis",
      pendingDeviceStoreReady: true,
    });
  });

  it("refuses production startup without Redis before considering GitHub configuration", async () => {
    const createRedis = vi.fn();
    await expect(createServiceApp({ NODE_ENV: "production" }, createRedis, async () => new MemoryInviteStore())).rejects.toThrow("REDIS_URL");
    expect(createRedis).not.toHaveBeenCalled();
  });

  it("propagates an unreachable production Redis store before serving setup health", async () => {
    const createRedis = vi.fn(async () => {
      throw new Error("durable store unavailable");
    });
    await expect(createServiceApp({
      NODE_ENV: "production",
      REDIS_URL: "redis://private.internal:6379",
    }, createRedis, async () => new MemoryInviteStore())).rejects.toThrow("durable store unavailable");
    expect(createRedis).toHaveBeenCalledTimes(1);
  });
});
