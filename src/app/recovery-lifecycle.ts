export interface RecoveryLifecycleTargets {
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
}

export interface RecoveryLifecycleHooks {
  flush(): void;
  resume(): void;
}

/**
 * Starts lightweight browser recovery at lifecycle boundaries which may be the
 * page's last runnable task. The supplied flush must remain non-terminal: it
 * must not close editors or cancel work which can continue in the background.
 */
export function installBrowserRecoveryLifecycle(
  hooks: RecoveryLifecycleHooks,
  targets: RecoveryLifecycleTargets = { document, window },
): () => void {
  const onVisibilityChange = () => {
    if (targets.document.visibilityState === "hidden") hooks.flush();
    else if (targets.document.visibilityState === "visible") hooks.resume();
  };
  const onPageHide = () => hooks.flush();
  targets.document.addEventListener("visibilitychange", onVisibilityChange);
  targets.window.addEventListener("pagehide", onPageHide);
  return () => {
    targets.document.removeEventListener("visibilitychange", onVisibilityChange);
    targets.window.removeEventListener("pagehide", onPageHide);
  };
}
