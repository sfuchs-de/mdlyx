export const PERSISTED_SESSION_KEY = "session:v2";
export const LEGACY_SESSION_KEY = "mdlyx:session";
export const RECOVERY_PREFIX = "recovery:";

export type PersistenceFailureKind = "unavailable" | "quota" | "permission" | "unknown";

export class PersistenceError extends Error {
  constructor(
    public readonly kind: PersistenceFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PersistenceError";
  }
}

export interface RecoveryRevision {
  id: string;
  kind: "github-conflict" | "dirty-snapshot" | "manual";
  name: string;
  path?: string;
  text: string;
  createdAt: number;
  documentRevision?: number;
}

export interface PersistenceStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>>;
  clear(): Promise<void>;
}

function persistenceError(error: unknown, operation: string): PersistenceError {
  if (error instanceof PersistenceError) return error;
  const name = error instanceof DOMException ? error.name : "";
  const kind: PersistenceFailureKind = name === "QuotaExceededError"
    ? "quota"
    : name === "NotAllowedError" || name === "SecurityError"
      ? "permission"
      : name === "InvalidStateError" || name === "NotSupportedError"
        ? "unavailable"
        : "unknown";
  return new PersistenceError(kind, `Local persistence ${operation} failed.`, { cause: error });
}

/** IndexedDB-backed storage for document state and structured-cloneable handles. */
export class IndexedDbPersistenceStore implements PersistenceStore {
  private database: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly indexedDb: IDBFactory | undefined = globalThis.indexedDB,
    private readonly databaseName = "mdlyx",
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const store = await this.objectStore("readonly");
    return this.request<T | undefined>(store.get(key), "read");
  }

  async set<T>(key: string, value: T): Promise<void> {
    const store = await this.objectStore("readwrite");
    await this.request(store.put(value, key), "write");
    await this.transactionDone(store.transaction, "write");
  }

  async delete(key: string): Promise<void> {
    const store = await this.objectStore("readwrite");
    await this.request(store.delete(key), "delete");
    await this.transactionDone(store.transaction, "delete");
  }

  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    const store = await this.objectStore("readonly");
    const values: Array<{ key: string; value: T }> = [];
    await new Promise<void>((resolve, reject) => {
      const request = store.openCursor();
      request.onerror = () => reject(persistenceError(request.error, "scan"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) {
          values.push({ key: cursor.key, value: cursor.value as T });
        }
        cursor.continue();
      };
    });
    return values;
  }

  async clear(): Promise<void> {
    const store = await this.objectStore("readwrite");
    await this.request(store.clear(), "clear");
    await this.transactionDone(store.transaction, "clear");
  }

  private async objectStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const database = await this.open();
    return database.transaction("state", mode).objectStore("state");
  }

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    if (!this.indexedDb) {
      return Promise.reject(new PersistenceError("unavailable", "IndexedDB is unavailable."));
    }
    this.database = new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.indexedDb!.open(this.databaseName, 1);
      } catch (error) {
        reject(persistenceError(error, "open"));
        return;
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("state")) {
          request.result.createObjectStore("state");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(persistenceError(request.error, "open"));
      request.onblocked = () => reject(new PersistenceError(
        "unavailable",
        "A previous MdLyx window is blocking the local database upgrade.",
      ));
    });
    return this.database;
  }

  private request<T>(request: IDBRequest<T>, operation: string): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(persistenceError(request.error, operation));
    });
  }

  private transactionDone(transaction: IDBTransaction, operation: string): Promise<void> {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(persistenceError(transaction.error, operation));
      transaction.onerror = () => reject(persistenceError(transaction.error, operation));
    });
  }
}

/** Small deterministic implementation for unit tests and non-browser tooling. */
export class MemoryPersistenceStore implements PersistenceStore {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    return [...this.values]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value: value as T }));
  }
  async clear(): Promise<void> {
    this.values.clear();
  }
}

export const persistenceStore: PersistenceStore = new IndexedDbPersistenceStore();

export function recoveryKey(revision: RecoveryRevision): string {
  const identity = revision.path ?? revision.name;
  return `${RECOVERY_PREFIX}${encodeURIComponent(identity)}:${revision.createdAt}:${revision.id}`;
}

function isRecoveryRevision(value: unknown): value is RecoveryRevision {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RecoveryRevision>;
  return typeof candidate.id === "string"
    && candidate.id.length > 0
    && (
      candidate.kind === "github-conflict"
      || candidate.kind === "dirty-snapshot"
      || candidate.kind === "manual"
    )
    && typeof candidate.name === "string"
    && candidate.name.length > 0
    && typeof candidate.text === "string"
    && typeof candidate.createdAt === "number"
    && Number.isFinite(candidate.createdAt);
}

export async function listRecoveryRevisions(
  store: PersistenceStore,
): Promise<RecoveryRevision[]> {
  const entries = await store.list<unknown>(RECOVERY_PREFIX);
  return entries
    .map(({ value }) => value)
    .filter(isRecoveryRevision)
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
}

export async function deleteRecoveryRevision(
  store: PersistenceStore,
  id: string,
): Promise<boolean> {
  const entries = await store.list<unknown>(RECOVERY_PREFIX);
  const match = entries.find(({ value }) => isRecoveryRevision(value) && value.id === id);
  if (!match) return false;
  await store.delete(match.key);
  return true;
}

export async function exportRecoveryBundle(store: PersistenceStore): Promise<string> {
  const session = await store.get<unknown>(PERSISTED_SESSION_KEY);
  const recoveries = await listRecoveryRevisions(store);
  return JSON.stringify({
    format: "mathdown-recovery-bundle",
    version: 1,
    exportedAt: new Date().toISOString(),
    session,
    recoveries,
  }, null, 2);
}
