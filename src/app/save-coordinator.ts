export type SaveState = "dirty" | "queued" | "saving" | "saved" | "conflict" | "failed";

export interface SaveRetryMetadata {
  state: SaveState;
  latestRevision: number;
  attempts: number;
  retryAt: number | null;
}

export type SaveOperationResult<T> =
  | { kind: "saved"; value: T }
  | { kind: "conflict"; value: T }
  | { kind: "cancelled" };

export type SaveAttempt<T> =
  | { kind: "saved"; value: T; revision: number }
  | { kind: "conflict"; value: T; revision: number }
  | { kind: "failed"; error: unknown; revision: number }
  | { kind: "cancelled"; revision: number };

export interface SaveQuiescenceLease {
  /** Resolves after the started operation settles and stale queued work drains. */
  readonly idle: Promise<void>;
  /** True only while this lease still owns the same persistence identity. */
  owns(): boolean;
  /** Unfreezes only if this lease still owns the current persistence identity. */
  resume(): boolean;
}

/**
 * Serializes writes for one document identity. Revisions are monotonic and a
 * cancellation generation prevents a closed, replaced, or Save-As document
 * from being mutated by an older queued write.
 */
export class SaveCoordinator {
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private queueEpoch = 0;
  private freezeLease: symbol | null = null;
  private running = 0;
  private latestRevision = 0;
  private attempts = 0;
  private retryAt: number | null = null;
  private currentState: SaveState = "saved";

  constructor(private readonly onState?: (state: SaveState) => void) {}

  get state(): SaveState {
    return this.currentState;
  }

  get isQuiesced(): boolean {
    return this.freezeLease !== null;
  }

  markDirty(revision: number): void {
    this.latestRevision = Math.max(this.latestRevision, revision);
    if (this.currentState !== "queued" && this.currentState !== "saving") {
      this.transition("dirty");
    }
  }

  enqueue<T>(
    revision: number,
    operation: () => Promise<SaveOperationResult<T>>,
  ): Promise<SaveAttempt<T>> {
    // Closing a tab freezes its provider identity before awaiting the current
    // write. Timers and keyboard commands may still run under the asynchronous
    // discard dialog, but none may extend this queue until close is cancelled.
    if (this.freezeLease) {
      return Promise.resolve({ kind: "cancelled", revision });
    }
    this.latestRevision = Math.max(this.latestRevision, revision);
    const generation = this.generation;
    const queueEpoch = this.queueEpoch;
    // A newer queued revision must not make an in-flight provider write appear
    // idle in the UI. It will transition to `saving` when it actually starts.
    if (this.running === 0) this.transition("queued");

    let resolveAttempt!: (attempt: SaveAttempt<T>) => void;
    const attempt = new Promise<SaveAttempt<T>>((resolve) => {
      resolveAttempt = resolve;
    });
    const run = async () => {
      if (generation !== this.generation || queueEpoch !== this.queueEpoch) {
        // A queued-but-not-started write is safe to cancel. Preserve the result
        // of any earlier in-flight attempt; only a queue with no such settled
        // result still needs to be restored from `queued` to an honest state.
        if (
          generation === this.generation &&
          this.running === 0 &&
          (this.currentState === "queued" || this.currentState === "saving")
        ) {
          this.transition(this.latestRevision > 0 ? "dirty" : "saved");
        }
        resolveAttempt({ kind: "cancelled", revision });
        return;
      }
      // Freeze epochs are checked exactly once, before a provider operation
      // starts. A write already in flight must settle normally under a close
      // barrier; only an identity-generation change may invalidate its result.
      this.running++;
      this.transition("saving");
      try {
        const result = await operation();
        if (generation !== this.generation) {
          resolveAttempt({ kind: "cancelled", revision });
          return;
        }
        this.attempts = 0;
        this.retryAt = null;
        if (result.kind === "cancelled") {
          this.transition(this.latestRevision > 0 ? "dirty" : "saved");
          resolveAttempt({ kind: "cancelled", revision });
        } else if (result.kind === "conflict") {
          this.transition("conflict");
          resolveAttempt({ kind: "conflict", value: result.value, revision });
        } else {
          this.transition(this.latestRevision > revision ? "dirty" : "saved");
          resolveAttempt({ kind: "saved", value: result.value, revision });
        }
      } catch (error) {
        if (generation !== this.generation) {
          resolveAttempt({ kind: "cancelled", revision });
          return;
        }
        this.attempts++;
        this.retryAt = Date.now() + retryDelay(this.attempts);
        this.transition("failed");
        resolveAttempt({ kind: "failed", error, revision });
      } finally {
        this.running--;
      }
    };
    this.queue = this.queue.then(run, run).catch(() => undefined);
    return attempt;
  }

  /**
   * Freeze new provider writes, cancel work which has not started, and wait for
   * the current attempt (if any) to settle. The extra microtask lets consumers
   * of the returned SaveAttempt apply its saved/conflict result before close
   * code re-evaluates the document's dirty flag.
   */
  quiesce(): SaveQuiescenceLease {
    const token = Symbol("save-quiescence");
    this.freezeLease = token;
    // Every item which has not reached its run-start check becomes stale. The
    // item currently inside its provider operation has already passed the check
    // and therefore ignores this epoch change.
    this.queueEpoch++;
    const idle = this.queue.then(async () => {
      // SaveAttempt consumers update file handles/dirty flags in their own
      // promise reaction. Give that reaction one turn before close rechecks.
      await Promise.resolve();
    });
    return {
      idle,
      owns: () => this.freezeLease === token,
      resume: () => {
        if (this.freezeLease !== token) return false;
        this.freezeLease = null;
        // Defensive normalization: a drained queue must not stay apparently
        // busy when Cancel rearms its latest dirty revision.
        if (
          this.running === 0 &&
          (this.currentState === "queued" || this.currentState === "saving")
        ) {
          this.transition(this.latestRevision > 0 ? "dirty" : "saved");
        }
        return true;
      },
    };
  }

  cancel(nextState: SaveState = "saved"): void {
    this.generation++;
    this.queueEpoch++;
    // A new persistence identity owns its own queue. An older close-finally
    // lease must not be able to thaw a later freeze on that identity.
    this.freezeLease = null;
    this.queue = Promise.resolve();
    this.attempts = 0;
    this.retryAt = null;
    this.transition(nextState);
  }

  snapshot(): SaveRetryMetadata {
    return {
      state: this.currentState,
      latestRevision: this.latestRevision,
      attempts: this.attempts,
      retryAt: this.retryAt,
    };
  }

  restore(metadata: SaveRetryMetadata | undefined): void {
    if (!metadata) return;
    this.latestRevision = Math.max(0, metadata.latestRevision);
    this.attempts = Math.max(0, metadata.attempts);
    this.retryAt = metadata.retryAt;
    // A process cannot resume an in-flight promise. Preserve it as a retryable
    // failure instead of claiming that the document is still saving forever.
    const restored = metadata.state === "queued" || metadata.state === "saving"
      ? "failed"
      : metadata.state;
    this.transition(restored);
  }

  private transition(state: SaveState): void {
    this.currentState = state;
    this.onState?.(state);
  }
}

export function retryDelay(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}
