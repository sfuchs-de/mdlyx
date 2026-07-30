import { describe, expect, it } from "vitest";
import {
  LEGACY_SESSION_KEY,
  MemoryPersistenceStore,
  PERSISTED_SESSION_KEY,
  deleteRecoveryRevision,
  exportRecoveryBundle,
  listRecoveryRevisions,
  recoveryKey,
  type RecoveryRevision,
} from "./persistence-store";

describe("PersistenceStore", () => {
  it("stores structured values and scans recovery prefixes", async () => {
    const store = new MemoryPersistenceStore();
    await store.set(PERSISTED_SESSION_KEY, { version: 2, tabs: [] });
    const recovery: RecoveryRevision = {
      id: "r1",
      kind: "github-conflict",
      name: "proof.md",
      path: "nested/proof.md",
      text: "local proof",
      createdAt: 12,
    };
    await store.set(recoveryKey(recovery), recovery);

    await expect(store.get(PERSISTED_SESSION_KEY)).resolves.toEqual({ version: 2, tabs: [] });
    await expect(store.list("recovery:")).resolves.toEqual([
      { key: recoveryKey(recovery), value: recovery },
    ]);
    await expect(exportRecoveryBundle(store)).resolves.toContain("local proof");
  });

  it("keeps unrelated preference storage outside the document store", () => {
    expect(LEGACY_SESSION_KEY).toBe("mdlyx:session");
  });

  it("lists valid recovery revisions newest-first and deletes by opaque id", async () => {
    const store = new MemoryPersistenceStore();
    const older: RecoveryRevision = {
      id: "older",
      kind: "manual",
      name: "older.md",
      text: "old",
      createdAt: 10,
    };
    const newer: RecoveryRevision = {
      id: "newer",
      kind: "dirty-snapshot",
      name: "newer.md",
      path: "notes/newer.md",
      text: "new",
      createdAt: 20,
      documentRevision: 4,
    };
    await store.set(recoveryKey(older), older);
    await store.set(recoveryKey(newer), newer);
    await store.set("recovery:malformed", { id: "broken", createdAt: "yesterday" });

    await expect(listRecoveryRevisions(store)).resolves.toEqual([newer, older]);
    await expect(deleteRecoveryRevision(store, "newer")).resolves.toBe(true);
    await expect(deleteRecoveryRevision(store, "missing")).resolves.toBe(false);
    await expect(listRecoveryRevisions(store)).resolves.toEqual([older]);
  });
});
