import { createClient, type RedisClientType } from "redis";

export interface PendingDeviceRecord {
  deviceCode: string;
  origin: string;
  expiresAt: number;
}

export interface PendingDeviceStore {
  readonly mode?: "memory" | "redis";
  set(id: string, record: PendingDeviceRecord): Promise<void>;
  get(id: string): Promise<PendingDeviceRecord | null>;
  delete(id: string): Promise<void>;
  isReady?(): boolean;
  checkReady?(): Promise<boolean>;
}

interface RedisPendingDeviceClient {
  readonly isReady: boolean;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  ping(): Promise<string>;
}

const KEY_PREFIX = "mathdown:device:";
const OPAQUE_ID = /^[A-Za-z0-9_-]{32,128}$/;
const DEFAULT_COMMAND_TIMEOUT_MS = 3_000;

export function pendingDeviceReconnectDelay(retries: number, starting: boolean): number | Error {
  if (starting && retries >= 3) return new Error("Pending-device Redis startup reconnect limit reached");
  const delay = Math.min(250 * 2 ** Math.min(retries, 5), 5_000);
  return delay + Math.floor(Math.random() * 100);
}

function pendingDeviceRecord(value: unknown): PendingDeviceRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.deviceCode !== "string" || !record.deviceCode) return null;
  if (typeof record.origin !== "string" || !record.origin) return null;
  if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return null;
  return {
    deviceCode: record.deviceCode,
    origin: record.origin,
    expiresAt: record.expiresAt,
  };
}

/**
 * Local/test implementation. Production can inject a Render Key Value-backed
 * implementation without changing auth routes; records are explicitly TTL
 * checked even when the backing store also expires keys.
 */
export class MemoryPendingDeviceStore implements PendingDeviceStore {
  readonly mode = "memory" as const;
  private readonly records = new Map<string, PendingDeviceRecord>();

  async set(id: string, record: PendingDeviceRecord): Promise<void> {
    this.records.set(id, record);
  }

  async get(id: string): Promise<PendingDeviceRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.records.delete(id);
      return null;
    }
    return record;
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  isReady(): boolean {
    return true;
  }

  async checkReady(): Promise<boolean> {
    return true;
  }
}

/**
 * Render Key Value-backed pending device state. Every key has an explicit TTL,
 * and records are checked again on read so a delayed eviction can never revive
 * an expired authorization attempt.
 */
export class RedisPendingDeviceStore implements PendingDeviceStore {
  readonly mode = "redis" as const;
  private operational = true;

  constructor(
    private readonly client: RedisPendingDeviceClient,
    private readonly now: () => number = Date.now,
    private readonly commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ) {}

  async set(id: string, record: PendingDeviceRecord): Promise<void> {
    if (!OPAQUE_ID.test(id)) throw new Error("Invalid pending-device ID");
    const ttl = Math.ceil(record.expiresAt - this.now());
    const key = `${KEY_PREFIX}${id}`;
    if (ttl <= 0) {
      await this.command(() => this.client.del(key));
      return;
    }
    await this.command(() => this.client.set(key, JSON.stringify(record), { PX: ttl }));
  }

  async get(id: string): Promise<PendingDeviceRecord | null> {
    if (!OPAQUE_ID.test(id)) return null;
    const key = `${KEY_PREFIX}${id}`;
    const encoded = await this.command(() => this.client.get(key));
    if (!encoded) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      await this.command(() => this.client.del(key));
      return null;
    }
    const record = pendingDeviceRecord(parsed);
    if (!record || record.expiresAt <= this.now()) {
      await this.command(() => this.client.del(key));
      return null;
    }
    return record;
  }

  async delete(id: string): Promise<void> {
    if (!OPAQUE_ID.test(id)) return;
    await this.command(() => this.client.del(`${KEY_PREFIX}${id}`));
  }

  isReady(): boolean {
    return this.client.isReady && this.operational;
  }

  async checkReady(): Promise<boolean> {
    if (!this.client.isReady) {
      this.operational = false;
      return false;
    }
    try {
      await this.command(() => this.client.ping());
      return true;
    } catch {
      return false;
    }
  }

  private async command<T>(run: () => Promise<T>): Promise<T> {
    if (!this.client.isReady) {
      this.operational = false;
      throw new Error("Pending-device Redis is not connected");
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        run(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Pending-device Redis command timed out")),
            this.commandTimeoutMs,
          );
        }),
      ]);
      this.operational = true;
      return result;
    } catch (error) {
      this.operational = false;
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export async function createRedisPendingDeviceStore(
  url: string,
  onError: (error: Error) => void = (error) => {
    console.error(JSON.stringify({
      level: "error",
      component: "pending-device-store",
      error: error.name,
    }));
  },
): Promise<RedisPendingDeviceStore> {
  let starting = true;
  const client: RedisClientType = createClient({
    url,
    socket: {
      connectTimeout: 10_000,
      reconnectStrategy: (retries) => pendingDeviceReconnectDelay(retries, starting),
    },
  });
  client.on("error", onError);
  try {
    await client.connect();
    const store = new RedisPendingDeviceStore(client);
    if (!await store.checkReady()) throw new Error("Pending-device Redis did not pass its startup readiness check");
    starting = false;
    return store;
  } catch (error) {
    client.destroy();
    throw error;
  }
}
