import { describe, expect, it, vi } from "vitest";
import { SaveCoordinator, retryDelay } from "./save-coordinator";

describe("SaveCoordinator", () => {
  it("serializes writes and preserves a newer dirty revision", async () => {
    let release!: () => void;
    const firstGate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const coordinator = new SaveCoordinator();
    coordinator.markDirty(1);
    const first = coordinator.enqueue(1, async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
      return { kind: "saved", value: "sha-2" };
    });
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    expect(coordinator.state).toBe("saving");
    coordinator.markDirty(2);
    const second = coordinator.enqueue(2, async () => {
      order.push("second");
      return { kind: "saved", value: "sha-3" };
    });

    // Queueing a later revision must not replace the truthful in-flight state.
    expect(coordinator.state).toBe("saving");
    release();
    await expect(first).resolves.toMatchObject({ kind: "saved", value: "sha-2" });
    await expect(second).resolves.toMatchObject({ kind: "saved", value: "sha-3" });
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(coordinator.state).toBe("saved");
  });

  it("cancels queued writes after a document identity change", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const operation = vi.fn(async () => ({ kind: "saved" as const, value: "ok" }));
    const coordinator = new SaveCoordinator();
    const first = coordinator.enqueue(1, async () => {
      await gate;
      return { kind: "saved", value: "old" };
    });
    const queued = coordinator.enqueue(2, operation);
    coordinator.cancel();
    release();
    await expect(first).resolves.toMatchObject({ kind: "cancelled" });
    await expect(queued).resolves.toMatchObject({ kind: "cancelled" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("quiesces close without starting queued writes and resumes after Cancel", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const coordinator = new SaveCoordinator();
    coordinator.markDirty(1);
    const active = coordinator.enqueue(1, async () => {
      order.push("active-start");
      await gate;
      order.push("active-end");
      return { kind: "saved", value: "sha-2" };
    });
    await vi.waitFor(() => expect(order).toEqual(["active-start"]));

    coordinator.markDirty(2);
    const queuedOperation = vi.fn(async () => ({ kind: "saved" as const, value: "sha-3" }));
    const queued = coordinator.enqueue(2, queuedOperation);
    const lease = coordinator.quiesce();
    const duringDialog = vi.fn(async () => ({ kind: "saved" as const, value: "sha-4" }));
    const frozen = coordinator.enqueue(3, duringDialog);

    expect(coordinator.isQuiesced).toBe(true);
    expect(queuedOperation).not.toHaveBeenCalled();
    expect(duringDialog).not.toHaveBeenCalled();
    release();
    await lease.idle;
    await expect(active).resolves.toMatchObject({ kind: "saved", revision: 1 });
    await expect(queued).resolves.toMatchObject({ kind: "cancelled", revision: 2 });
    await expect(frozen).resolves.toMatchObject({ kind: "cancelled", revision: 3 });
    expect(order).toEqual(["active-start", "active-end"]);
    expect(coordinator.state).toBe("dirty");

    expect(lease.resume()).toBe(true);
    expect(coordinator.isQuiesced).toBe(false);
    const resumed = vi.fn(async () => ({ kind: "saved" as const, value: "sha-5" }));
    await expect(coordinator.enqueue(2, resumed)).resolves.toMatchObject({ kind: "saved" });
    expect(resumed).toHaveBeenCalledOnce();
    expect(coordinator.state).toBe("saved");
  });

  it("same-tick quiescence cancels a write before its provider operation starts", async () => {
    const operation = vi.fn(async () => ({ kind: "saved" as const, value: "unexpected" }));
    const coordinator = new SaveCoordinator();
    coordinator.markDirty(1);
    const queued = coordinator.enqueue(1, operation);
    const lease = coordinator.quiesce();

    await lease.idle;
    await expect(queued).resolves.toMatchObject({ kind: "cancelled", revision: 1 });
    expect(operation).not.toHaveBeenCalled();
    expect(coordinator.state).toBe("dirty");
    expect(lease.resume()).toBe(true);
    expect(coordinator.isQuiesced).toBe(false);
  });

  it("does not let a stale pre-cancel lease thaw a new identity", async () => {
    const coordinator = new SaveCoordinator();
    const oldLease = coordinator.quiesce();
    await oldLease.idle;
    coordinator.cancel("saved");
    expect(coordinator.isQuiesced).toBe(false);

    const newLease = coordinator.quiesce();
    expect(coordinator.isQuiesced).toBe(true);
    expect(oldLease.owns()).toBe(false);
    expect(newLease.owns()).toBe(true);
    expect(oldLease.resume()).toBe(false);
    expect(coordinator.isQuiesced).toBe(true);
    await newLease.idle;
    expect(newLease.resume()).toBe(true);
    expect(coordinator.isQuiesced).toBe(false);
  });

  it("records conflicts and restart-safe retry failures", async () => {
    const coordinator = new SaveCoordinator();
    await expect(coordinator.enqueue(4, async () => ({
      kind: "conflict",
      value: "remote",
    }))).resolves.toMatchObject({ kind: "conflict" });
    expect(coordinator.state).toBe("conflict");

    await expect(coordinator.enqueue(5, async () => { throw new Error("offline"); }))
      .resolves.toMatchObject({ kind: "failed" });
    const metadata = coordinator.snapshot();
    expect(metadata.attempts).toBe(1);
    expect(metadata.retryAt).not.toBeNull();

    const restored = new SaveCoordinator();
    restored.restore({ ...metadata, state: "saving" });
    expect(restored.state).toBe("failed");
  });

  it("bounds exponential retry metadata", () => {
    expect(retryDelay(1)).toBe(1_000);
    expect(retryDelay(20)).toBe(60_000);
  });
});
