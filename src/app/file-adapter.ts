// File I/O behind one small interface, with two backends chosen at runtime
// (#D01): the **Tauri** desktop shell (native dialogs + Rust read/write) when it
// is present, otherwise the **browser** (File System Access API, falling back to
// <input>/download). The app code is identical either way.

import { isTauriRuntime, tauriInvoke } from "./tauri-bridge";
import { githubLibrary } from "./github-library";

// Minimal typings — the DOM lib's coverage of the FS Access API is inconsistent.
type FileHandle = {
  kind?: "file";
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: string | Blob | ArrayBuffer | Uint8Array): Promise<void>;
    close(): Promise<void>;
  }>;
  name: string;
  isSameEntry?(other: FileHandle): Promise<boolean>;
};

// A backend-opaque reference to the current file: a retained browser handle, a
// native filesystem path (Tauri), a GitHub-library path + blob SHA, or null
// (unsaved / fallback download). GitHub credentials never travel with this ref.
export interface GitHubFileRef {
  kind: "github";
  path: string;
  sha: string;
}

export interface NativeFileRef {
  kind: "native-file";
  grantId: string;
  /** Stable opaque identity. Older persisted sessions do not have one. */
  identity?: string;
  name: string;
}

export type FileRef = FileHandle | NativeFileRef | GitHubFileRef | null;

export function isGitHubFileRef(handle: FileRef): handle is GitHubFileRef {
  return typeof handle === "object" && handle !== null && "kind" in handle && handle.kind === "github";
}

export function isNativeFileRef(handle: FileRef): handle is NativeFileRef {
  return typeof handle === "object" && handle !== null && "kind" in handle && handle.kind === "native-file";
}

/**
 * Provider-aware file identity comparison. Browser handles must use the File
 * System Access API's asynchronous equality check: separately restored handles
 * for the same file are not object-identical.
 */
export async function sameFileRef(left: FileRef, right: FileRef): Promise<boolean> {
  if (!left || !right) return false;
  if (left === right) return true;
  if (isGitHubFileRef(left) || isGitHubFileRef(right)) {
    return isGitHubFileRef(left) && isGitHubFileRef(right) && left.path === right.path;
  }
  if (isNativeFileRef(left) || isNativeFileRef(right)) {
    if (!isNativeFileRef(left) || !isNativeFileRef(right)) return false;
    if (left.identity && right.identity) return left.identity === right.identity;
    // Same-process compatibility for pre-identity session references. A grant
    // is deliberately not treated as durable across an application restart.
    return left.grantId === right.grantId;
  }
  try {
    if (left.isSameEntry) return await left.isSameEntry(right);
    if (right.isSameEntry) return await right.isSameEntry(left);
  } catch {
    return false;
  }
  return false;
}

/**
 * Choose the tab path after a successful provider write. A write to the same
 * retained identity preserves its library-relative path; Save As establishes a
 * new identity and therefore falls back to the returned basename. GitHub refs
 * carry their authoritative repository-relative path directly.
 */
export function displayPathAfterSave(
  previousPath: string,
  savedName: string,
  previousHandle: FileRef,
  savedHandle: FileRef,
): string {
  if (isGitHubFileRef(savedHandle)) return savedHandle.path;
  if (!previousHandle || !savedHandle) return savedName;
  if (previousHandle === savedHandle) return previousPath;
  if (isNativeFileRef(previousHandle) && isNativeFileRef(savedHandle)) {
    const sameIdentity = previousHandle.identity && savedHandle.identity
      ? previousHandle.identity === savedHandle.identity
      : previousHandle.grantId === savedHandle.grantId;
    return sameIdentity ? previousPath : savedName;
  }
  // Browser FileSystem handles returned by an ordinary save are the exact
  // retained object. A distinct handle is Save As, even when its basename is
  // identical; asynchronous isSameEntry checks cannot safely delay markSaved.
  return savedName;
}

interface FsWindow {
  showOpenFilePicker?: (opts?: unknown) => Promise<FileHandle[]>;
  showSaveFilePicker?: (opts?: unknown) => Promise<FileHandle>;
}

const fsWindow = (typeof window === "undefined" ? {} : window) as unknown as FsWindow;
export const isTauri = isTauriRuntime;
export const hasNativeFs = !!fsWindow.showOpenFilePicker;

const MD_TYPES = [
  { description: "Markdown", accept: { "text/markdown": [".md", ".markdown"] } },
];
export interface OpenedFile {
  name: string;
  /** Provider-relative identity for duplicate basenames and accessible tab labels. */
  path?: string;
  text: string;
  handle: FileRef;
}

export interface SaveResult {
  name: string;
  handle: FileRef;
}

export interface RemoteConflictResult extends SaveResult {
  kind: "remote-conflict";
  text: string;
}

export type NativeInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

interface NativeFileGrantResponse {
  grantId: string;
  identity: string;
  name: string;
  text: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validNativeGrant(
  value: NativeFileGrantResponse | null,
  expectedIdentity?: string,
): value is NativeFileGrantResponse {
  return !!value
    && UUID_V4.test(value.grantId)
    && UUID_V4.test(value.identity)
    && (!expectedIdentity || value.identity === expectedIdentity)
    && typeof value.name === "string"
    && value.name.length > 0
    && !/[\\/]/.test(value.name)
    && typeof value.text === "string";
}

export function isRemoteConflict(
  result: SaveResult | RemoteConflictResult,
): result is RemoteConflictResult {
  return "kind" in result && result.kind === "remote-conflict";
}

// --- Tauri backend --------------------------------------------------------
async function tauriOpen(): Promise<OpenedFile | null> {
  const opened = await tauriInvoke<NativeFileGrantResponse | null>("native_pick_file");
  if (!validNativeGrant(opened)) return null;
  return {
    name: opened.name,
    text: opened.text,
    handle: {
      kind: "native-file",
      grantId: opened.grantId,
      identity: opened.identity,
      name: opened.name,
    },
  };
}

/**
 * Exchange a persisted opaque native identity for a new process-local grant.
 * Legacy refs intentionally return null without calling native code: their old
 * grant cannot be trusted after a restart and no filesystem path is exposed.
 */
export async function reconnectNativeFile(
  handle: NativeFileRef,
  invoke: NativeInvoker = tauriInvoke,
): Promise<OpenedFile | null> {
  if (!handle.identity || !UUID_V4.test(handle.identity)) return null;
  const opened = await invoke<NativeFileGrantResponse | null>("native_reconnect_file", {
    identity: handle.identity,
  });
  if (!validNativeGrant(opened, handle.identity)) return null;
  return {
    name: opened.name,
    text: opened.text,
    handle: {
      kind: "native-file",
      grantId: opened.grantId,
      identity: opened.identity,
      name: opened.name,
    },
  };
}

async function tauriWrite(text: string, handle: NativeFileRef): Promise<void> {
  await tauriInvoke("native_write_file", { grantId: handle.grantId, contents: text });
}

async function tauriSaveAs(text: string, suggestedName: string): Promise<SaveResult | null> {
  const saved = await tauriInvoke<NativeFileGrantResponse | null>("native_save_file", {
    suggestedName,
    contents: text,
  });
  if (!validNativeGrant(saved)) return null;
  return {
    name: saved.name,
    handle: {
      kind: "native-file",
      grantId: saved.grantId,
      identity: saved.identity,
      name: saved.name,
    },
  };
}

// --- open -----------------------------------------------------------------
export async function openMarkdown(): Promise<OpenedFile | null> {
  if (isTauri) return tauriOpen();

  if (fsWindow.showOpenFilePicker) {
    try {
      const [handle] = await fsWindow.showOpenFilePicker({ types: MD_TYPES });
      const file = await handle.getFile();
      return { name: handle.name, text: await file.text(), handle };
    } catch {
      return null; // user cancelled
    }
  }

  // Fallback: hidden file input.
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,text/markdown";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ name: file.name, text: await file.text(), handle: null });
    };
    input.click();
  });
}

// --- save -----------------------------------------------------------------
// Save to the current file when we have a reference; otherwise prompt.
export async function saveMarkdown(
  text: string,
  handle: FileRef,
  suggestedName: string,
): Promise<SaveResult | RemoteConflictResult | null> {
  if (isGitHubFileRef(handle)) {
    return githubLibrary.save(text, handle);
  }
  if (isTauri) {
    if (isNativeFileRef(handle)) {
      await tauriWrite(text, handle);
      return { name: handle.name, handle };
    }
    return tauriSaveAs(text, suggestedName);
  }

  if (handle && !isNativeFileRef(handle)) {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return { name: handle.name, handle };
  }
  return saveMarkdownAs(text, suggestedName);
}

export async function saveMarkdownAs(
  text: string,
  suggestedName: string,
): Promise<SaveResult | null> {
  if (isTauri) return tauriSaveAs(text, suggestedName);

  if (fsWindow.showSaveFilePicker) {
    try {
      const handle = await fsWindow.showSaveFilePicker({
        suggestedName,
        types: MD_TYPES,
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return { name: handle.name, handle };
    } catch {
      return null; // cancelled
    }
  }

  // Fallback: trigger a download.
  triggerDownload(text, suggestedName, "text/markdown");
  return { name: suggestedName, handle: null };
}

// Save a derived artifact (e.g. exported .tex).
export async function downloadText(
  text: string,
  suggestedName: string,
  mime: string,
): Promise<void> {
  if (isTauri) {
    await tauriSaveAs(text, suggestedName);
    return;
  }
  if (fsWindow.showSaveFilePicker) {
    try {
      const handle = await fsWindow.showSaveFilePicker({ suggestedName });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return;
    } catch {
      return; // cancelled
    }
  }
  triggerDownload(text, suggestedName, mime);
}

function triggerDownload(text: string, name: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export type { FileHandle };
