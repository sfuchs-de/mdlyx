import {
  isGitHubFileRef,
  isNativeFileRef,
  type FileHandle,
  type FileRef,
  type NativeInvoker,
  type NativeFileRef,
  type OpenedFile,
} from "./file-adapter";
import { countUnresolvedComments, parseFrontmatter, emptyMeta, normalizeMeta, type DocMeta } from "../markdown/frontmatter";
import { isTauriRuntime, tauriInvoke } from "./tauri-bridge";
import {
  libraryAssetMimeType,
  validateLibraryAssetPath,
  validateLibraryAssetWrite,
  type LibraryAsset,
  type LibraryAssetProvider,
  type LibraryAssetWrite,
} from "./library-assets";
import { normaliseDocumentPath } from "./library-document-path";

// A folder-backed local library: point at a directory once (File System Access
// API), then browse/open/create the .md files in it. The chosen directory handle
// is persisted in IndexedDB so the library survives reloads (the browser may
// re-prompt for permission on the first interaction). The opened file handles are
// the same shape the save path already uses, so saving writes back in place.

interface DirHandle {
  name: string;
  kind: "directory";
  entries(): AsyncIterableIterator<[string, FsEntry]>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  getDirectoryHandle?(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  queryPermission?(opts: { mode: string }): Promise<PermissionState>;
  requestPermission?(opts: { mode: string }): Promise<PermissionState>;
}

// A directory entry is either a file handle or a nested directory handle.
type FsEntry = ((FileHandle & { kind: "file"; name: string }) | DirHandle);

const MAX_DEPTH = 8; // guard against pathological nesting / cycles
const MAX_TEXT_PREFIX_CHARS = 1_000_001;

interface DirPickerWindow {
  showDirectoryPicker?: (opts?: { mode?: string }) => Promise<DirHandle>;
}

export const supportsLibrary =
  typeof window !== "undefined" && "showDirectoryPicker" in window;

export interface LibraryFile {
  name: string;
  /** Relative folder path from the library root ("" = root, "a/b" = nested). */
  folder: string;
  handle: FileRef;
  meta: DocMeta;
  /** Comments which have not been explicitly resolved in document frontmatter. */
  openCommentCount: number;
}

// --- tiny IndexedDB key/value (handles are structured-cloneable) -----------
const DB_NAME = "mdlyx";
const STORE = "handles";
const DIR_KEY = "library-dir";
const NATIVE_DIR_KEY = "mdlyx:native-library-root";

interface NativeLibraryEntry {
  name: string;
  folder: string;
  grantId: string;
  identity: string;
  meta: unknown;
  openCommentCount: number;
}

interface NativeOpenedFile {
  name: string;
  grantId: string;
  identity: string;
  text: string;
}

export async function createNativeLibraryDocument(
  root: NativeRootGrant,
  path: string,
  invoke: NativeInvoker = tauriInvoke,
): Promise<OpenedFile> {
  const opened = await invoke<NativeOpenedFile>("native_create_library_file", {
    grantId: root.grantId,
    relativePath: path,
  });
  return {
    name: opened.name,
    path,
    text: opened.text,
    handle: {
      kind: "native-file",
      grantId: opened.grantId,
      identity: opened.identity,
      name: opened.name,
    },
  };
}

export interface NativeRootGrant {
  grantId: string;
  /** Missing only in legacy localStorage records, which are never restored. */
  identity?: string;
  name: string;
}

const NATIVE_IDENTITY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validNativeRoot(value: NativeRootGrant | null): value is NativeRootGrant & { identity: string } {
  return !!value
    && NATIVE_IDENTITY.test(value.grantId)
    && typeof value.identity === "string"
    && NATIVE_IDENTITY.test(value.identity)
    && typeof value.name === "string"
    && value.name.length > 0
    && !/[\\/]/.test(value.name);
}

/** Exchange a persisted root identity for a fresh process-local native grant. */
export async function reconnectNativeLibraryRoot(
  persisted: NativeRootGrant,
  invoke: NativeInvoker = tauriInvoke,
): Promise<(NativeRootGrant & { identity: string }) | null> {
  if (!persisted.identity || !NATIVE_IDENTITY.test(persisted.identity)) return null;
  const reconnected = await invoke<NativeRootGrant | null>(
    "native_reconnect_library_root",
    { identity: persisted.identity },
  );
  if (!validNativeRoot(reconnected) || reconnected.identity !== persisted.identity) return null;
  return reconnected;
}

interface NativeAssetEntry {
  path: string;
  size: number;
  sha?: string;
  bytes?: number[];
}

const INDEX_CHUNK_BYTES = 65_536;
const MAX_RETAINED_INDEX_FIELD_CHARS = 8 * 1024 * 1024;

interface IndexedFrontmatter {
  meta: DocMeta;
  openCommentCount: number;
}

function indexFrontmatter(source: string): IndexedFrontmatter {
  const { frontmatter } = parseFrontmatter(source);
  return {
    meta: frontmatter.library,
    openCommentCount: countUnresolvedComments(frontmatter.comments),
  };
}

type IndexField = "library" | "comments";

/**
 * Incrementally extracts only the two JSON fields needed by the library index.
 * Irrelevant frontmatter lines are discarded as they arrive, so even a very
 * large macro block does not become one giant browser string. Target JSON
 * fields are retained only up to a defensive cap; oversized malformed values
 * are ignored while delimiter scanning continues.
 */
class FrontmatterIndexScanner {
  private opening = true;
  private inside = false;
  private stopped = false;
  private closed = false;
  private linePrefix = "";
  private keyDisabled = false;
  private capture: IndexField | null = null;
  private captureText = "";
  private captureStarted = false;
  private captureDepth = 0;
  private captureInString = false;
  private captureEscape = false;
  private captureDiscarded = false;
  private libraryJson: string | null = null;
  private commentsJson: string | null = null;

  get done(): boolean {
    return this.stopped;
  }

  feed(source: string): void {
    if (this.stopped) return;
    for (const char of source) {
      if (this.stopped) break;
      if (char === "\n") {
        this.finishLine();
        continue;
      }

      if (this.linePrefix.length < 10 && char !== "\r") this.linePrefix += char;

      if (this.opening) {
        const possible = "---".startsWith(this.linePrefix);
        if (!possible) this.stopped = true;
        continue;
      }
      if (!this.inside) continue;

      if (this.capture) {
        this.captureChar(char);
        continue;
      }
      if (this.keyDisabled) continue;
      if (this.linePrefix === "library:") {
        this.beginCapture("library");
      } else if (this.linePrefix === "comments:") {
        this.beginCapture("comments");
      } else if (
        !"library:".startsWith(this.linePrefix)
        && !"comments:".startsWith(this.linePrefix)
      ) {
        this.keyDisabled = true;
      }
    }
  }

  finish(): void {
    if (this.stopped) return;
    // A final delimiter without a trailing newline is valid.
    if (!this.opening && this.linePrefix === "---") this.closed = true;
    this.stopped = true;
  }

  source(): string {
    if (!this.closed) return "";
    const lines = ["---"];
    if (this.libraryJson != null) lines.push(`library: ${this.libraryJson}`);
    if (this.commentsJson != null) lines.push(`comments: ${this.commentsJson}`);
    lines.push("---", "");
    return lines.join("\n");
  }

  private finishLine(): void {
    if (this.opening) {
      if (this.linePrefix === "---") {
        this.opening = false;
        this.inside = true;
      } else {
        this.stopped = true;
      }
      this.resetLine();
      return;
    }

    // Delimiter recognition is independent of JSON capture. A malformed JSON
    // field therefore cannot hide the real end of otherwise valid frontmatter.
    if (this.inside && this.linePrefix === "---") {
      this.closed = true;
      this.inside = false;
      this.stopped = true;
      return;
    }

    if (this.capture) {
      if (this.captureStarted) this.retainCaptureChar("\n");
      else this.cancelCapture();
    }
    this.resetLine();
  }

  private resetLine(): void {
    this.linePrefix = "";
    this.keyDisabled = false;
  }

  private beginCapture(field: IndexField): void {
    this.capture = field;
    this.captureText = "";
    this.captureStarted = false;
    this.captureDepth = 0;
    this.captureInString = false;
    this.captureEscape = false;
    this.captureDiscarded = false;
  }

  private cancelCapture(): void {
    this.capture = null;
    this.captureText = "";
    this.captureStarted = false;
    this.captureDiscarded = false;
    this.keyDisabled = true;
  }

  private retainCaptureChar(char: string): void {
    if (this.captureDiscarded) return;
    if (this.captureText.length >= MAX_RETAINED_INDEX_FIELD_CHARS) {
      console.warn(
        `[library] ${this.capture ?? "frontmatter"} JSON exceeds the indexing limit and was ignored`,
      );
      this.captureText = "";
      this.captureDiscarded = true;
      return;
    }
    this.captureText += char;
  }

  private captureChar(char: string): void {
    if (!this.captureStarted) {
      if (/\s/.test(char)) return;
      if (char !== "[" && char !== "{") {
        this.cancelCapture();
        return;
      }
      this.captureStarted = true;
    }

    this.retainCaptureChar(char);
    if (this.captureEscape) {
      this.captureEscape = false;
      return;
    }
    if (this.captureInString) {
      if (char === "\\") this.captureEscape = true;
      else if (char === '"') this.captureInString = false;
      return;
    }
    if (char === '"') this.captureInString = true;
    else if (char === "[" || char === "{") this.captureDepth += 1;
    else if (char === "]" || char === "}") this.captureDepth -= 1;

    if (this.captureDepth !== 0) return;
    if (!this.captureDiscarded) {
      try {
        const parsed = JSON.parse(this.captureText) as unknown;
        if (
          this.capture === "library"
          && parsed !== null
          && typeof parsed === "object"
          && !Array.isArray(parsed)
        ) {
          this.libraryJson = this.captureText;
        } else if (this.capture === "comments" && Array.isArray(parsed)) {
          this.commentsJson = this.captureText;
        }
      } catch {
        // Match the full parser: malformed JSON is ignored and a previous valid
        // occurrence, if any, remains authoritative.
      }
    }
    this.capture = null;
    this.captureText = "";
    this.captureStarted = false;
    this.captureDiscarded = false;
    this.keyDisabled = true;
  }
}

async function readBlobText(blob: Blob, decoder: TextDecoder, final: boolean): Promise<string> {
  if (typeof blob.arrayBuffer === "function") {
    return decoder.decode(await blob.arrayBuffer(), { stream: !final });
  }
  return blob.text();
}

async function readIndexSource(file: File): Promise<string> {
  // A real File System Access File always supports Blob slicing. Refuse to
  // index a non-standard adapter rather than falling back to an unbounded read.
  if (typeof file.slice !== "function") return "";

  const size = Number.isFinite(file.size) ? Math.max(0, file.size) : 0;
  const scanner = new FrontmatterIndexScanner();
  const decoder = new TextDecoder();
  let offset = 0;

  // Five bytes distinguish LF/CRLF frontmatter from an ordinary document. This
  // keeps the common no-frontmatter path tiny before proceeding in 64 KiB
  // streaming chunks for a real frontmatter block.
  while (offset < size && !scanner.done) {
    const length = offset === 0 ? 5 : INDEX_CHUNK_BYTES;
    const end = Math.min(size, offset + length);
    const blob = file.slice(offset, end);
    scanner.feed(await readBlobText(blob, decoder, end >= size));
    offset = end;
  }
  if (offset >= size) {
    const tail = decoder.decode();
    if (tail) scanner.feed(tail);
    scanner.finish();
  }
  return scanner.source();
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openDb();
    return await new Promise<T | undefined>((resolve, reject) => {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result as T | undefined);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return undefined;
  }
}
async function idbSet(key: string, val: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* persistence is best-effort */
  }
}

export class Library implements LibraryAssetProvider {
  private dir: DirHandle | null = null;
  private nativeRoot: NativeRootGrant | null = null;

  get folderName(): string | null {
    return this.nativeRoot?.name ?? this.dir?.name ?? null;
  }

  // Reconnect to a previously-chosen folder after a reload (no picker gesture).
  async restore(): Promise<boolean> {
    if (isTauriRuntime) {
      try {
        const stored = localStorage.getItem(NATIVE_DIR_KEY);
        const persisted = stored ? JSON.parse(stored) as NativeRootGrant : null;
        if (!persisted) {
          this.nativeRoot = null;
          return false;
        }
        const reconnected = await reconnectNativeLibraryRoot(persisted);
        if (!reconnected) {
          this.nativeRoot = null;
          return false;
        }
        this.nativeRoot = reconnected;
        localStorage.setItem(NATIVE_DIR_KEY, JSON.stringify(reconnected));
        return true;
      } catch {
        this.nativeRoot = null;
        return false;
      }
    }
    this.dir = (await idbGet<DirHandle>(DIR_KEY)) ?? null;
    return this.dir != null;
  }

  async choose(): Promise<boolean> {
    if (isTauriRuntime) {
      const root = await tauriInvoke<NativeRootGrant | null>("native_pick_library_root");
      if (!validNativeRoot(root)) return false;
      this.nativeRoot = root;
      localStorage.setItem(NATIVE_DIR_KEY, JSON.stringify(root));
      return true;
    }
    const picker = (window as unknown as DirPickerWindow).showDirectoryPicker;
    if (!picker) return false;
    try {
      const dir = await picker({ mode: "readwrite" });
      this.dir = dir;
      await idbSet(DIR_KEY, dir);
      return true;
    } catch {
      return false; // cancelled
    }
  }

  private async ensurePermission(): Promise<boolean> {
    if (!this.dir) return false;
    const opts = { mode: "readwrite" };
    if ((await this.dir.queryPermission?.(opts)) === "granted") return true;
    return (await this.dir.requestPermission?.(opts)) === "granted";
  }

  // Non-prompting check (safe without a user gesture, e.g. on startup).
  async permitted(): Promise<boolean> {
    if (isTauriRuntime) {
      if (!this.nativeRoot) return false;
      try {
        return await tauriInvoke<boolean>("native_library_grant_available", {
          grantId: this.nativeRoot.grantId,
        });
      } catch {
        return false;
      }
    }
    if (!this.dir) return false;
    return (await this.dir.queryPermission?.({ mode: "readwrite" })) === "granted";
  }

  // Prompt for access (needs a user gesture) — used by the "reconnect" button
  // after a reload, where the browser requires re-granting permission.
  async reconnect(): Promise<boolean> {
    if (isTauriRuntime) return this.choose();
    return this.ensurePermission();
  }

  async list(): Promise<LibraryFile[]> {
    if (isTauriRuntime) {
      if (!this.nativeRoot) return [];
      const entries = await tauriInvoke<NativeLibraryEntry[]>("native_list_library", {
        grantId: this.nativeRoot.grantId,
      });
      return entries.map((entry) => ({
        name: entry.name,
        folder: entry.folder,
        handle: {
          kind: "native-file",
          grantId: entry.grantId,
          identity: entry.identity,
          name: entry.name,
        } satisfies NativeFileRef,
        meta: normalizeMeta(entry.meta),
        openCommentCount: entry.openCommentCount,
      }));
    }
    if (!this.dir || !(await this.ensurePermission())) return [];
    const out: LibraryFile[] = [];
    await this.collect(this.dir, "", 0, out);
    // Sort by folder, then filename, so grouping/flat views are both stable.
    return out.sort(
      (a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name),
    );
  }

  // Walk the folder tree, indexing every .md file with its relative folder path.
  // Permission granted on the picked root covers nested folders, so no extra
  // prompts. Dot-directories (.git, .mathdown) and dotfiles are skipped.
  private async collect(dir: DirHandle, prefix: string, depth: number, out: LibraryFile[]) {
    if (depth > MAX_DEPTH) return;
    for await (const [name, entry] of dir.entries()) {
      if (name.startsWith(".")) continue;
      if (entry.kind === "directory") {
        await this.collect(entry, prefix ? `${prefix}/${name}` : name, depth + 1, out);
      } else if (/\.(md|markdown)$/i.test(name)) {
        // Index each file's frontmatter. Read only the leading slice (frontmatter
        // lives at the top) so a large body doesn't dominate the scan. A per-file
        // read failure (permission / transient) must not break the whole list.
        let indexed: IndexedFrontmatter = { meta: emptyMeta(), openCommentCount: 0 };
        try {
          indexed = indexFrontmatter(await readIndexSource(await entry.getFile()));
        } catch {
          /* fall back to empty metadata for this entry */
        }
        out.push({ name, folder: prefix, handle: entry, ...indexed });
      }
    }
  }

  async open(f: LibraryFile): Promise<OpenedFile> {
    const handle = f.handle;
    const path = f.folder ? `${f.folder}/${f.name}` : f.name;
    if (isTauriRuntime && isNativeFileRef(handle)) {
      const text = await tauriInvoke<string>("native_read_file", { grantId: handle.grantId });
      return { name: f.name, path, text, handle };
    }
    if (!handle || isNativeFileRef(handle) || isGitHubFileRef(handle)) {
      throw new Error("Local library entry has no file-system handle");
    }
    const file = await handle.getFile();
    return { name: f.name, path, text: await file.text(), handle };
  }

  /** Read only a bounded prefix for full-text indexing, never the whole file. */
  async readPrefix(f: LibraryFile, maxChars: number): Promise<string> {
    if (!Number.isSafeInteger(maxChars) || maxChars <= 0 || maxChars > MAX_TEXT_PREFIX_CHARS) {
      throw new Error("Text prefix length is outside the supported range");
    }
    const handle = f.handle;
    if (isTauriRuntime && isNativeFileRef(handle)) {
      return tauriInvoke<string>("native_read_file_prefix", {
        grantId: handle.grantId,
        maxChars,
      });
    }
    if (!handle || isNativeFileRef(handle) || isGitHubFileRef(handle)) {
      throw new Error("Local library entry has no file-system handle");
    }
    const file = await handle.getFile();
    // Four UTF-8 bytes per requested JavaScript code unit is a conservative
    // file-read bound. Slice the decoded string too because ASCII needs only
    // one byte and would otherwise return up to four times the requested text.
    const maxBytes = Math.min(file.size, maxChars * 4);
    return (await file.slice(0, maxBytes).text()).slice(0, maxChars);
  }

  // Create an empty .md and return it, ready to open. The name may include a
  // folder path (`drafts/notes.md`) — intermediate folders are created as needed
  // (#I80). If a file of that name already exists it is opened AS-IS (never
  // truncated) — creating a "new" doc must not silently wipe an existing one.
  async create(rawName: string): Promise<OpenedFile | null> {
    const path = normaliseDocumentPath(rawName);
    if (!path) return null;
    if (isTauriRuntime) {
      if (!this.nativeRoot) return null;
      // Picker cancellation is represented by a missing root above. Native
      // create failures are real provider errors and must reach LibraryView's
      // inline notice instead of being converted into a silent no-op.
      return createNativeLibraryDocument(this.nativeRoot, path);
    }
    if (!this.dir || !(await this.ensurePermission())) return null;
    const segs = path.split("/");
    const fileSeg = segs.pop() ?? "";
    if (!fileSeg) return null;
    const name = fileSeg;
    // Resolve (creating as needed) the target directory for any leading path.
    let dir: DirHandle = this.dir;
    for (const seg of segs) {
      if (seg === "." || seg === ".." || !dir.getDirectoryHandle) return null; // no escaping / unsupported
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
    try {
      const existing = await dir.getFileHandle(name); // no {create} — open as-is
      return { name, path, text: await (await existing.getFile()).text(), handle: existing };
    } catch {
      /* not found → create a fresh empty file below */
    }
    const handle = await dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write("");
    await w.close();
    return { name, path, text: "", handle };
  }

  async listAssets(): Promise<LibraryAsset[]> {
    if (isTauriRuntime) {
      if (!this.nativeRoot) return [];
      const entries = await tauriInvoke<NativeAssetEntry[]>("native_list_assets", {
        grantId: this.nativeRoot.grantId,
      });
      return entries.map((entry) => ({
        path: entry.path,
        size: entry.size,
        sha: entry.sha,
        mimeType: libraryAssetMimeType(entry.path) ?? "application/octet-stream",
      }));
    }
    if (!this.dir || !(await this.ensurePermission())) return [];
    const entries: LibraryAsset[] = [];
    await this.collectAssets(this.dir, "", 0, entries);
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readAsset(path: string): Promise<{ asset: LibraryAsset; bytes: Uint8Array }> {
    const clean = validateLibraryAssetPath(path);
    if (isTauriRuntime) {
      if (!this.nativeRoot) throw new Error("Choose a local library first");
      const result = await tauriInvoke<NativeAssetEntry>("native_read_asset", {
        grantId: this.nativeRoot.grantId,
        relativePath: clean,
      });
      const bytes = new Uint8Array(result.bytes ?? []);
      return {
        asset: {
          path: result.path,
          size: result.size,
          sha: result.sha,
          mimeType: libraryAssetMimeType(result.path) ?? "application/octet-stream",
        },
        bytes,
      };
    }
    if (!this.dir || !(await this.ensurePermission())) throw new Error("Choose a local library first");
    const handle = await this.resolveAssetHandle(clean, false);
    const file = await handle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      asset: {
        path: clean,
        size: bytes.byteLength,
        sha: await contentSha(bytes),
        mimeType: libraryAssetMimeType(clean) ?? file.type ?? "application/octet-stream",
      },
      bytes,
    };
  }

  async writeAsset(input: LibraryAssetWrite): Promise<LibraryAsset> {
    const validated = validateLibraryAssetWrite(input);
    if (isTauriRuntime) {
      if (!this.nativeRoot) throw new Error("Choose a local library first");
      const result = await tauriInvoke<NativeAssetEntry>("native_write_asset", {
        grantId: this.nativeRoot.grantId,
        relativePath: validated.path,
        bytes: Array.from(validated.bytes),
        ifMatch: validated.ifMatch ?? null,
      });
      return {
        path: result.path,
        size: result.size,
        sha: result.sha,
        mimeType: validated.mimeType,
      };
    }
    if (!this.dir || !(await this.ensurePermission())) throw new Error("Choose a local library first");
    if (validated.ifMatch) {
      let current: { asset: LibraryAsset; bytes: Uint8Array } | null = null;
      try {
        current = await this.readAsset(validated.path);
      } catch {
        // A missing target is a valid create only when the caller has no version.
      }
      if (!current || current.asset.sha !== validated.ifMatch) {
        throw new Error("Asset changed since it was opened");
      }
    }
    const handle = await this.resolveAssetHandle(validated.path, true);
    const writable = await handle.createWritable();
    await writable.write(validated.bytes);
    await writable.close();
    return {
      path: validated.path,
      size: validated.bytes.byteLength,
      sha: await contentSha(validated.bytes),
      mimeType: validated.mimeType,
    };
  }

  private async collectAssets(
    dir: DirHandle,
    prefix: string,
    depth: number,
    out: LibraryAsset[],
  ): Promise<void> {
    if (depth > MAX_DEPTH) return;
    for await (const [name, entry] of dir.entries()) {
      if (name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === "directory") {
        await this.collectAssets(entry, path, depth + 1, out);
      } else {
        const mimeType = libraryAssetMimeType(path);
        if (!mimeType) continue;
        try {
          const file = await entry.getFile();
          out.push({ path, mimeType, size: file.size });
        } catch {
          /* an unreadable asset does not hide the rest of the project bundle */
        }
      }
    }
  }

  private async resolveAssetHandle(path: string, create: boolean): Promise<FileHandle> {
    if (!this.dir) throw new Error("Choose a local library first");
    const parts = validateLibraryAssetPath(path).split("/");
    const name = parts.pop()!;
    let dir = this.dir;
    for (const part of parts) {
      if (!dir.getDirectoryHandle) throw new Error("Nested assets are not supported by this browser");
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return dir.getFileHandle(name, { create });
  }
}

async function contentSha(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
