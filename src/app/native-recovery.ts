export interface NativeRecoveryDecision {
  /** Text MdLyx should display after reconnection. */
  text: string;
  /** Whether the displayed text still needs a provider save. */
  dirty: boolean;
  /** Whether it is safe to attach the fresh write grant. */
  attachGrant: boolean;
  /** True when disk and recovery diverged from the last known common source. */
  conflict: boolean;
  /** Safe next comparison base. Conflicts retain the prior base. */
  baseText: string | undefined;
}

/**
 * Reconcile a restart recovery revision with the current native file. Exact
 * source comparison is deliberate: a collision-prone compact hash must never
 * authorize an automatic overwrite of an externally edited research note.
 */
export function reconcileNativeRecovery(
  recoveryText: string,
  dirty: boolean,
  baseText: string | undefined,
  diskText: string,
): NativeRecoveryDecision {
  if (!dirty) {
    return {
      text: diskText,
      dirty: false,
      attachGrant: true,
      conflict: false,
      baseText: diskText,
    };
  }
  // The recovery flag can outlive its content change (for example after a
  // crash between the provider write and the session-state update).
  if (recoveryText === diskText) {
    return {
      text: diskText,
      dirty: false,
      attachGrant: true,
      conflict: false,
      baseText: diskText,
    };
  }
  if (baseText !== undefined && baseText === diskText) {
    return {
      text: recoveryText,
      dirty: true,
      attachGrant: true,
      conflict: false,
      baseText: diskText,
    };
  }
  return {
    text: recoveryText,
    dirty: true,
    attachGrant: false,
    conflict: true,
    baseText,
  };
}
