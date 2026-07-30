import { describe, expect, it } from "vitest";
import { MemoryInviteStore, RedisInviteStore, type InviteRecord } from "./invite-store";

const record: InviteRecord = {
  id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  tokenDigest: "b".repeat(64),
  principalId: "alice",
  authVersion: 1,
  origin: "https://mathdown.test",
  createdAt: 1_000,
  expiresAt: 8_000,
};

describe("InviteStore", () => {
  it("consumes a memory invitation exactly once and supports revocation", async () => {
    const store = new MemoryInviteStore(() => 2_000);
    await store.put(record);
    await expect(store.list()).resolves.toEqual([record]);
    await expect(store.consume(record.tokenDigest)).resolves.toEqual(record);
    await expect(store.consume(record.tokenDigest)).resolves.toBeNull();
    await store.put(record);
    await expect(store.revoke(record.id)).resolves.toBe(true);
    await expect(store.consume(record.tokenDigest)).resolves.toBeNull();
    await store.put(record);
    await store.put({
      ...record,
      id: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
      tokenDigest: "d".repeat(64),
      principalId: "bob",
    });
    await expect(store.revokePrincipal("alice")).resolves.toBe(1);
    await expect(store.list()).resolves.toHaveLength(1);
    await expect(store.revokePrincipal("missing")).resolves.toBe(0);
  });

  it("drops expired records independently of backing-store eviction", async () => {
    const store = new MemoryInviteStore(() => 9_000);
    await store.put(record);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("uses atomic Redis GETDEL and stores a bounded token TTL", async () => {
    const strings = new Map<string, string>();
    const hashes = new Map<string, Record<string, string>>();
    const ttl: number[] = [];
    let getDelCalls = 0;
    const client = {
      isReady: true,
      set: async (key: string, value: string, options: { PX: number }) => {
        strings.set(key, value);
        ttl.push(options.PX);
      },
      getDel: async (key: string) => {
        getDelCalls++;
        const value = strings.get(key) ?? null;
        strings.delete(key);
        return value;
      },
      get: async (key: string) => strings.get(key) ?? null,
      del: async (key: string) => strings.delete(key),
      hSet: async (key: string, field: string, value: string) => {
        const hash = hashes.get(key) ?? {};
        hash[field] = value;
        hashes.set(key, hash);
      },
      hGet: async (key: string, field: string) => hashes.get(key)?.[field],
      hGetAll: async (key: string) => ({ ...(hashes.get(key) ?? {}) }),
      hDel: async (key: string, field: string) => delete (hashes.get(key) ?? {})[field],
      ping: async () => "PONG",
    };
    const store = new RedisInviteStore(client, () => 2_000);
    await store.put(record);
    expect(ttl).toEqual([6_000]);
    await store.put({
      ...record,
      id: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
      tokenDigest: "d".repeat(64),
      principalId: "bob",
    });
    await expect(store.revokePrincipal("bob")).resolves.toBe(1);
    await expect(store.consume(record.tokenDigest)).resolves.toEqual(record);
    await expect(store.consume(record.tokenDigest)).resolves.toBeNull();
    expect(getDelCalls).toBe(2);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("fails readiness without silently falling back and deletes malformed index records", async () => {
    let ready = false;
    const hashes = new Map<string, Record<string, string>>([
      ["mathdown:invite:index", { broken: "not-json" }],
    ]);
    const client = {
      get isReady() { return ready; },
      set: async () => undefined,
      getDel: async () => null,
      get: async () => null,
      del: async () => undefined,
      hSet: async () => undefined,
      hGet: async () => undefined,
      hGetAll: async (key: string) => ({ ...(hashes.get(key) ?? {}) }),
      hDel: async (key: string, field: string) => { delete (hashes.get(key) ?? {})[field]; },
      ping: async () => "PONG",
    };
    const store = new RedisInviteStore(client);
    await expect(store.checkReady()).resolves.toBe(false);
    await expect(store.put({
      ...record,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10_000,
    })).rejects.toThrow("not connected");
    ready = true;
    await expect(store.checkReady()).resolves.toBe(true);
    await expect(store.list()).resolves.toEqual([]);
    expect(hashes.get("mathdown:invite:index")).toEqual({});
  });
});
