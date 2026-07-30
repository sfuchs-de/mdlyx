import { describe, expect, it, vi } from "vitest";
import {
  MemoryPendingDeviceStore,
  pendingDeviceReconnectDelay,
  RedisPendingDeviceStore,
} from "./pending-device-store";

const pendingId = "A".repeat(43);

function redisClient() {
  const records = new Map<string, string>();
  const calls: Array<{ key: string; value: string; ttl: number }> = [];
  return {
    records,
    calls,
    client: {
      isReady: true,
      set: async (key: string, value: string, options: { PX: number }) => {
        records.set(key, value);
        calls.push({ key, value, ttl: options.PX });
      },
      get: async (key: string) => records.get(key) ?? null,
      del: async (key: string) => records.delete(key),
      ping: async () => "PONG",
    },
  };
}

describe("PendingDeviceStore", () => {
  it("retains origin-bound pending state across app-handler instances", async () => {
    const store = new MemoryPendingDeviceStore();
    await store.set("pending", {
      deviceCode: "secret",
      origin: "tauri://localhost",
      expiresAt: Date.now() + 1_000,
    });
    await expect(store.get("pending")).resolves.toMatchObject({ deviceCode: "secret" });
  });

  it("expires records by TTL", async () => {
    vi.useFakeTimers();
    const store = new MemoryPendingDeviceStore();
    await store.set("pending", {
      deviceCode: "secret",
      origin: "tauri://localhost",
      expiresAt: Date.now() + 10,
    });
    vi.advanceTimersByTime(11);
    await expect(store.get("pending")).resolves.toBeNull();
    vi.useRealTimers();
  });

  it("writes Redis records atomically with their remaining TTL", async () => {
    const redis = redisClient();
    const store = new RedisPendingDeviceStore(redis.client, () => 1_000);
    await store.set(pendingId, {
      deviceCode: "secret",
      origin: "tauri://localhost",
      expiresAt: 16_000,
    });
    expect(redis.calls).toEqual([{
      key: `mathdown:device:${pendingId}`,
      value: JSON.stringify({
        deviceCode: "secret",
        origin: "tauri://localhost",
        expiresAt: 16_000,
      }),
      ttl: 15_000,
    }]);
    await expect(store.get(pendingId)).resolves.toEqual({
      deviceCode: "secret",
      origin: "tauri://localhost",
      expiresAt: 16_000,
    });
  });

  it("deletes expired, malformed, and invalid Redis records", async () => {
    const redis = redisClient();
    const store = new RedisPendingDeviceStore(redis.client, () => 2_000);
    const key = `mathdown:device:${pendingId}`;

    redis.records.set(key, "not-json");
    await expect(store.get(pendingId)).resolves.toBeNull();
    expect(redis.records.has(key)).toBe(false);

    redis.records.set(key, JSON.stringify({ deviceCode: "secret", origin: "tauri://localhost" }));
    await expect(store.get(pendingId)).resolves.toBeNull();
    expect(redis.records.has(key)).toBe(false);

    redis.records.set(key, JSON.stringify({
      deviceCode: "secret",
      origin: "tauri://localhost",
      expiresAt: 1_999,
    }));
    await expect(store.get(pendingId)).resolves.toBeNull();
    expect(redis.records.has(key)).toBe(false);
    await expect(store.get("../not-an-opaque-id")).resolves.toBeNull();
  });

  it("does not store already-expired records and exposes client readiness", async () => {
    const redis = redisClient();
    const store = new RedisPendingDeviceStore(redis.client, () => 2_000);
    await store.set(pendingId, {
      deviceCode: "secret",
      origin: "tauri://localhost",
      expiresAt: 2_000,
    });
    expect(redis.calls).toHaveLength(0);
    expect(store.isReady()).toBe(true);
    redis.client.isReady = false;
    expect(store.isReady()).toBe(false);
  });

  it("propagates Redis failures instead of silently falling back to memory", async () => {
    const redis = redisClient();
    redis.client.set = async () => {
      throw new Error("redis unavailable");
    };
    const store = new RedisPendingDeviceStore(redis.client, () => 1_000);
    await expect(store.set(pendingId, {
      deviceCode: "secret",
      origin: "tauri://localhost",
      expiresAt: 2_000,
    })).rejects.toThrow("redis unavailable");
  });

  it("bounds commands, fails readiness, and recovers after a successful probe", async () => {
    const redis = redisClient();
    redis.client.get = async () => new Promise<string | null>(() => undefined);
    const store = new RedisPendingDeviceStore(redis.client, () => 1_000, 5);
    await expect(store.get(pendingId)).rejects.toThrow("command timed out");
    expect(store.isReady()).toBe(false);

    redis.client.get = async (key: string) => redis.records.get(key) ?? null;
    await expect(store.checkReady()).resolves.toBe(true);
    expect(store.isReady()).toBe(true);
  });

  it("limits startup reconnects but keeps runtime reconnects recoverable", () => {
    expect(pendingDeviceReconnectDelay(2, true)).toEqual(expect.any(Number));
    expect(pendingDeviceReconnectDelay(3, true)).toBeInstanceOf(Error);
    expect(pendingDeviceReconnectDelay(100, false)).toEqual(expect.any(Number));
  });
});
