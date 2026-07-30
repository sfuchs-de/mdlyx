import { createClient, type RedisClientType } from "redis";
import { pendingDeviceReconnectDelay } from "./pending-device-store.js";

export interface InviteRecord {
  id: string;
  tokenDigest: string;
  principalId: string;
  authVersion: number;
  origin: string;
  createdAt: number;
  expiresAt: number;
}

export interface InviteStore {
  readonly mode?: "memory" | "redis";
  put(record: InviteRecord): Promise<void>;
  consume(tokenDigest: string): Promise<InviteRecord | null>;
  revoke(id: string): Promise<boolean>;
  revokePrincipal(principalId: string): Promise<number>;
  list(): Promise<InviteRecord[]>;
  isReady?(): boolean;
  checkReady?(): Promise<boolean>;
}

interface RedisInviteClient {
  readonly isReady: boolean;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  getDel(key: string): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  hSet(key: string, field: string, value: string): Promise<unknown>;
  hGet(key: string, field: string): Promise<string | undefined>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hDel(key: string, field: string): Promise<unknown>;
  ping(): Promise<string>;
}

const TOKEN_PREFIX = "mathdown:invite:token:";
const INDEX_KEY = "mathdown:invite:index";
const TOKEN_DIGEST = /^[0-9a-f]{64}$/;
const INVITE_ID = /^[0-9a-f-]{20,80}$/;
const DEFAULT_COMMAND_TIMEOUT_MS = 3_000;

export class MemoryInviteStore implements InviteStore {
  readonly mode = "memory" as const;
  private readonly byToken = new Map<string, InviteRecord>();
  private readonly byId = new Map<string, InviteRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(record: InviteRecord): Promise<void> {
    validateRecord(record);
    if (record.expiresAt <= this.now()) return;
    this.byToken.set(record.tokenDigest, { ...record });
    this.byId.set(record.id, { ...record });
  }

  async consume(tokenDigest: string): Promise<InviteRecord | null> {
    if (!TOKEN_DIGEST.test(tokenDigest)) return null;
    const record = this.byToken.get(tokenDigest);
    if (!record) return null;
    this.byToken.delete(tokenDigest);
    this.byId.delete(record.id);
    return record.expiresAt > this.now() ? { ...record } : null;
  }

  async revoke(id: string): Promise<boolean> {
    const record = this.byId.get(id);
    if (!record) return false;
    this.byId.delete(id);
    this.byToken.delete(record.tokenDigest);
    return true;
  }

  async revokePrincipal(principalId: string): Promise<number> {
    let revoked = 0;
    for (const [id, record] of [...this.byId]) {
      if (record.principalId !== principalId) continue;
      this.byId.delete(id);
      this.byToken.delete(record.tokenDigest);
      revoked++;
    }
    return revoked;
  }

  async list(): Promise<InviteRecord[]> {
    const records: InviteRecord[] = [];
    for (const record of this.byId.values()) {
      if (record.expiresAt <= this.now()) {
        this.byId.delete(record.id);
        this.byToken.delete(record.tokenDigest);
      } else {
        records.push({ ...record });
      }
    }
    return records.sort((a, b) => a.expiresAt - b.expiresAt);
  }

  isReady(): boolean { return true; }
  async checkReady(): Promise<boolean> { return true; }
}

export class RedisInviteStore implements InviteStore {
  readonly mode = "redis" as const;
  private operational = true;

  constructor(
    private readonly client: RedisInviteClient,
    private readonly now: () => number = Date.now,
    private readonly commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ) {}

  async put(record: InviteRecord): Promise<void> {
    validateRecord(record);
    const ttl = Math.ceil(record.expiresAt - this.now());
    if (ttl <= 0) return;
    const encoded = JSON.stringify(record);
    await this.command(() => this.client.set(`${TOKEN_PREFIX}${record.tokenDigest}`, encoded, { PX: ttl }));
    await this.command(() => this.client.hSet(INDEX_KEY, record.id, encoded));
  }

  async consume(tokenDigest: string): Promise<InviteRecord | null> {
    if (!TOKEN_DIGEST.test(tokenDigest)) return null;
    const encoded = await this.command(() => this.client.getDel(`${TOKEN_PREFIX}${tokenDigest}`));
    if (!encoded) return null;
    const record = parseRecord(encoded);
    if (record) await this.command(() => this.client.hDel(INDEX_KEY, record.id));
    return record && record.expiresAt > this.now() ? record : null;
  }

  async revoke(id: string): Promise<boolean> {
    if (!INVITE_ID.test(id)) return false;
    const encoded = await this.command(() => this.client.hGet(INDEX_KEY, id));
    const record = encoded ? parseRecord(encoded) : null;
    if (!record) {
      await this.command(() => this.client.hDel(INDEX_KEY, id));
      return false;
    }
    await this.command(() => this.client.del(`${TOKEN_PREFIX}${record.tokenDigest}`));
    await this.command(() => this.client.hDel(INDEX_KEY, id));
    return true;
  }

  async revokePrincipal(principalId: string): Promise<number> {
    const values = await this.command(() => this.client.hGetAll(INDEX_KEY));
    let revoked = 0;
    for (const [id, encoded] of Object.entries(values)) {
      const record = parseRecord(encoded);
      if (!record || record.principalId !== principalId) continue;
      await this.command(() => this.client.del(`${TOKEN_PREFIX}${record.tokenDigest}`));
      await this.command(() => this.client.hDel(INDEX_KEY, id));
      revoked++;
    }
    return revoked;
  }

  async list(): Promise<InviteRecord[]> {
    const values = await this.command(() => this.client.hGetAll(INDEX_KEY));
    const records: InviteRecord[] = [];
    for (const [id, encoded] of Object.entries(values)) {
      const record = parseRecord(encoded);
      if (!record || record.expiresAt <= this.now()) {
        await this.command(() => this.client.hDel(INDEX_KEY, id));
        if (record) await this.command(() => this.client.del(`${TOKEN_PREFIX}${record.tokenDigest}`));
      } else {
        records.push(record);
      }
    }
    return records.sort((a, b) => a.expiresAt - b.expiresAt);
  }

  isReady(): boolean { return this.client.isReady && this.operational; }

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
      throw new Error("Invite Redis is not connected");
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        run(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Invite Redis command timed out")), this.commandTimeoutMs);
        }),
      ]);
      this.operational = true;
      return value;
    } catch (error) {
      this.operational = false;
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export async function createRedisInviteStore(
  url: string,
  onError: (error: Error) => void = (error) => {
    console.error(JSON.stringify({ level: "error", component: "invite-store", error: error.name }));
  },
): Promise<RedisInviteStore> {
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
    const store = new RedisInviteStore(client as unknown as RedisInviteClient);
    if (!await store.checkReady()) throw new Error("Invite Redis did not pass its startup readiness check");
    starting = false;
    return store;
  } catch (error) {
    client.destroy();
    throw error;
  }
}

function parseRecord(encoded: string): InviteRecord | null {
  try {
    const value = JSON.parse(encoded) as unknown;
    validateRecord(value);
    return value;
  } catch {
    return null;
  }
}

function validateRecord(value: unknown): asserts value is InviteRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid invite record");
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !INVITE_ID.test(record.id)) throw new Error("Invalid invite ID");
  if (typeof record.tokenDigest !== "string" || !TOKEN_DIGEST.test(record.tokenDigest)) throw new Error("Invalid invite token digest");
  if (typeof record.principalId !== "string" || !record.principalId) throw new Error("Invalid invite principal");
  if (!Number.isSafeInteger(record.authVersion) || Number(record.authVersion) <= 0) throw new Error("Invalid invite auth version");
  if (typeof record.origin !== "string" || !record.origin) throw new Error("Invalid invite origin");
  if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.expiresAt)) throw new Error("Invalid invite expiry");
}
