import { createApp } from "./app.js";
import { configFromEnv, isConfigured, pendingDeviceStoreModeFromEnv } from "./config.js";
import {
  createRedisPendingDeviceStore,
  MemoryPendingDeviceStore,
  type PendingDeviceStore,
} from "./pending-device-store.js";
import { createRedisInviteStore, MemoryInviteStore, type InviteStore } from "./invite-store.js";
import { createUnconfiguredApp } from "./unconfigured.js";

type RedisStoreFactory = (url: string) => Promise<PendingDeviceStore>;
type RedisInviteStoreFactory = (url: string) => Promise<InviteStore>;

export async function createServiceApp(
  env = process.env,
  createRedis: RedisStoreFactory = createRedisPendingDeviceStore,
  createInvites: RedisInviteStoreFactory = createRedisInviteStore,
) {
  const mode = pendingDeviceStoreModeFromEnv(env);
  if (mode === "redis" && !env.REDIS_URL) {
    throw new Error("REDIS_URL is required when PENDING_DEVICE_STORE=redis");
  }
  // Initialize the production store before checking GitHub credentials. A
  // missing dashboard secret may leave the API unconfigured, but it must not
  // hide an unavailable durability dependency.
  const pendingDevices = mode === "redis"
    ? await createRedis(env.REDIS_URL as string)
    : new MemoryPendingDeviceStore();
  const invites = mode === "redis"
    ? await createInvites(env.REDIS_URL as string)
    : new MemoryInviteStore();
  return isConfigured(env)
    ? createApp(configFromEnv(env), undefined, undefined, pendingDevices, invites)
    : createUnconfiguredApp(env, pendingDevices);
}
