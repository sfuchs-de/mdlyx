interface TauriWindow {
  __TAURI_INTERNALS__?: unknown;
}

export const isTauriRuntime =
  typeof window !== "undefined" &&
  "__TAURI_INTERNALS__" in (window as unknown as TauriWindow);

export async function tauriInvoke<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export interface DesktopSessionStore {
  readonly enabled: boolean;
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

export const desktopSessionStore: DesktopSessionStore = {
  enabled: isTauriRuntime,
  async get() {
    return isTauriRuntime
      ? tauriInvoke<string | null>("github_session_get")
      : null;
  },
  async set(value) {
    if (isTauriRuntime) await tauriInvoke("github_session_set", { value });
  },
  async clear() {
    if (isTauriRuntime) await tauriInvoke("github_session_clear");
  },
};

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriRuntime) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
