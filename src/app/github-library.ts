import {
  commentActivityDigest,
  countUnresolvedComments,
  normalizeMeta,
  parseFrontmatter,
  type DocMeta,
} from "../markdown/frontmatter";
import type { GitHubFileRef, OpenedFile, RemoteConflictResult, SaveResult } from "./file-adapter";
import { desktopSessionStore, type DesktopSessionStore } from "./tauri-bridge";
import { HttpClient, responseJson } from "./http-client";
import {
  libraryAssetMimeType,
  validateLibraryAssetPath,
  validateLibraryAssetWrite,
  type LibraryAsset,
  type LibraryAssetWrite,
} from "./library-assets";
import { normaliseDocumentPath } from "./library-document-path";

export interface GitHubLibraryFile {
  name: string;
  folder: string;
  handle: GitHubFileRef;
  meta: DocMeta;
  /** Comments which have not been explicitly resolved in document frontmatter. */
  openCommentCount: number;
  commentActivityDigest?: string;
}

export type SharedAccessRole = "reader" | "commenter" | "editor";

export interface SharedPrincipal {
  id: string;
  displayName: string;
  kind: "owner" | "coauthor";
}

export interface SessionResponse {
  authenticated: boolean;
  login?: string;
  principal?: SharedPrincipal;
  expiresAt?: number;
  grants?: Array<{ project: string; role: SharedAccessRole }>;
  capabilities?: { canShare: boolean; canUseUpdater: boolean };
}

export interface DocumentAccessCapabilities {
  authorized: boolean;
  canEditContent: boolean;
  canEditComments: boolean;
  canManageAllComments: boolean;
  sharedAccess?: boolean;
}

export interface SharingPrincipal {
  id: string;
  displayName: string;
  authVersion: number;
  grants: Record<string, SharedAccessRole>;
}

export interface SharingInvitation {
  id: string;
  principalId: string;
  createdAt: number;
  expiresAt: number;
  url?: string;
}

export interface SharingAccess {
  principals: SharingPrincipal[];
  invitations: SharingInvitation[];
  policyRevision: string;
  policySha: string;
  projects: Array<{ key: string; title: string }>;
}

interface HealthResponse {
  ok: boolean;
  configured: boolean;
  releaseConfigured?: boolean;
  version?: string;
  revision?: string;
}

export interface GitHubSyncStatus {
  state: "unavailable" | "setup" | "offline" | "ready";
  authenticated: boolean;
  login?: string;
  principal?: SharedPrincipal;
  expiresAt?: number;
  grants?: Array<{ project: string; role: SharedAccessRole }>;
  capabilities?: { canShare: boolean; canUseUpdater: boolean };
  serviceVersion?: string;
  serviceRevision?: string;
  releaseConfigured?: boolean;
}

export interface GitHubOAuthReturn {
  handled: boolean;
  error?: string;
}

export interface GitHubDeviceAuthorization {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  pendingId?: string;
}

export type GitHubDevicePoll =
  | { state: "pending" | "slow_down" | "expired" | "denied" | "interrupted" }
  | { state: "authorized"; login: string; desktopSession?: string };

interface ListResponse {
  entries: Array<{ path: string; sha: string; text: string }>;
}

interface IndexResponse {
  revision: string;
  entries: Array<{
    path: string;
    sha: string;
    meta: unknown;
    openCommentCount: number;
    commentActivityDigest?: string;
  }>;
}

interface DocumentResponse {
  path: string;
  sha: string;
  text: string;
}

interface AssetResponse {
  path: string;
  sha: string;
  size: number;
  content?: string;
}

interface ConflictResponse {
  code: "REMOTE_CONFLICT";
  remote: DocumentResponse;
}

interface CachedSource {
  source: DocumentResponse;
  generation: number;
  estimatedBytes: number;
}

// A complete list response is useful to the project catalog, but keeping every
// historical/deleted document forever would turn repeated Pulls into a leak.
// Libraries beyond this generous bound simply refetch evicted sources on demand.
const MAX_CACHED_SOURCES = 2_048;
const MAX_CACHED_SOURCE_BYTES = 32 * 1024 * 1024;

function configuredApiUrl(): string | null {
  const devOverride = import.meta.env.DEV
    ? localStorage.getItem("mdlyx:github-api-url")
    : null;
  // The public build is deliberately local-first. A static host must not be
  // mistaken for an API merely because production assets are same-origin.
  const value = (devOverride ?? import.meta.env.VITE_LIBRARY_API_URL)?.trim();
  return value ? value.replace(/\/$/, "") : null;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function folder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

export class GitHubLibrary {
  private pendingId: string | null = null;
  private readonly sourcesByPath = new Map<string, CachedSource>();
  private sourceGeneration = 0;
  private cachedSourceBytes = 0;
  private readonly http: HttpClient;
  private indexRevision: string | null = null;
  private indexEntries: IndexResponse["entries"] | null = null;
  private assetRevision: string | null = null;
  private assetEntries: LibraryAsset[] | null = null;
  private currentSession: SessionResponse = { authenticated: false };

  constructor(
    private readonly apiUrl: () => string | null = configuredApiUrl,
    // Store a wrapper rather than the native function itself: invoking an
    // unbound browser `fetch` as `this.request(...)` has the wrong receiver.
    private readonly request: typeof fetch = (input, init) => fetch(input, init),
    private readonly sessionStore: DesktopSessionStore = desktopSessionStore,
  ) {
    this.http = new HttpClient(this.request);
  }

  get configured(): boolean {
    return this.apiUrl() !== null;
  }

  async session(): Promise<SessionResponse> {
    const base = this.apiUrl();
    if (!base) return { authenticated: false };
    try {
      return await this.readSession(base);
    } catch {
      return { authenticated: false };
    }
  }

  // The public health probe distinguishes a deployment that merely has an API
  // URL from one that has the GitHub App key needed to write back to GitHub.
  // It keeps the Library UI honest: don't offer OAuth while Render is still
  // awaiting its PEM Secret File.
  async syncStatus(): Promise<GitHubSyncStatus> {
    const base = this.apiUrl();
    if (!base) return { state: "unavailable", authenticated: false };
    try {
      const health = await responseJson<HealthResponse>(
        await this.apiFetch(`${base}/health`),
      );
      const software = {
        ...(health.version ? { serviceVersion: health.version } : {}),
        ...(health.revision ? { serviceRevision: health.revision } : {}),
        ...(typeof health.releaseConfigured === "boolean"
          ? { releaseConfigured: health.releaseConfigured }
          : {}),
      };
      if (!health.ok || !health.configured) return { state: "setup", authenticated: false, ...software };
      const session = await this.readSession(base);
      return {
        state: "ready",
        authenticated: session.authenticated,
        login: session.login,
        principal: session.principal,
        expiresAt: session.expiresAt,
        grants: session.grants,
        capabilities: session.capabilities,
        ...software,
      };
    } catch {
      return { state: "offline", authenticated: false };
    }
  }

  connect(): void {
    window.location.assign(this.connectUrl());
  }

  // Keep the OAuth entry point available as a normal link as well as for any
  // programmatic callers. A real anchor gives the browser a native navigation
  // gesture, rather than relying on a later async callback to change location.
  connectUrl(): string {
    const base = this.apiUrl();
    if (!base) throw new Error("GitHub library sync is not configured");
    return `${base.replace(/\/$/, "")}/auth/github`;
  }

  // GitHub sends `code` and `state` back to the same-origin /github-link SPA
  // route. The API verifies the signed HTTP-only state cookie before exchanging
  // the code and issuing the browser session.
  async completeBrowserOAuth(location = window.location): Promise<GitHubOAuthReturn> {
    if (location.pathname !== "/github-link") return { handled: false };
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const state = params.get("state");
    const githubError = params.get("error_description") ?? params.get("error");
    const clearReturnUrl = () => window.history.replaceState(null, "", `${location.origin}/`);
    if (githubError) {
      clearReturnUrl();
      return { handled: true, error: `GitHub authorization was not completed: ${githubError}` };
    }
    if (!code || !state) {
      clearReturnUrl();
      return { handled: true, error: "GitHub did not return a valid authorization response." };
    }
    const base = this.apiUrl();
    if (!base) {
      clearReturnUrl();
      return { handled: true, error: "GitHub library sync is not configured." };
    }
    try {
      const session = await responseJson<SessionResponse>(
        await this.apiFetch(`${base}/auth/complete`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, state }),
        }),
      );
      return session.authenticated
        ? { handled: true }
        : { handled: true, error: "GitHub sign-in did not create an MdLyx session." };
    } catch (error) {
      return {
        handled: true,
        error: error instanceof Error ? error.message : "GitHub sign-in could not be completed.",
      };
    } finally {
      clearReturnUrl();
    }
  }

  invitationToken(location = window.location): string | null {
    if (location.pathname !== "/invite") return null;
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const token = params.get("token");
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  }

  async redeemInvitation(token: string): Promise<SessionResponse> {
    const base = this.apiUrl();
    if (!base) throw new Error("Shared library access is not configured");
    const session = await responseJson<SessionResponse>(await this.apiFetch(`${base}/auth/invite/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }));
    this.currentSession = session;
    return session;
  }

  async sharingAccess(): Promise<SharingAccess> {
    const base = this.apiUrl();
    if (!base) throw new Error("Shared library access is not configured");
    return responseJson<SharingAccess>(await this.apiFetch(`${base}/v1/sharing/access`));
  }

  async createInvitation(principalId: string, expiresInSeconds = 7 * 24 * 60 * 60): Promise<SharingInvitation> {
    const base = this.apiUrl();
    if (!base) throw new Error("Shared library access is not configured");
    const body = await responseJson<{ invitation: SharingInvitation }>(await this.apiFetch(`${base}/v1/sharing/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId, expiresInSeconds }),
    }));
    return body.invitation;
  }

  async createSharingPrincipal(
    id: string,
    displayName: string,
    grants: Record<string, SharedAccessRole>,
    expectedPolicySha: string,
  ): Promise<void> {
    const base = this.apiUrl();
    if (!base) throw new Error("Shared library access is not configured");
    await responseJson(await this.apiFetch(`${base}/v1/sharing/principals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, displayName, grants, expectedPolicySha }),
    }), "Could not add coauthor");
  }

  async updateSharingPrincipal(
    id: string,
    displayName: string,
    grants: Record<string, SharedAccessRole>,
    expectedPolicySha: string,
  ): Promise<void> {
    const base = this.apiUrl();
    if (!base) throw new Error("Shared library access is not configured");
    await responseJson(await this.apiFetch(`${base}/v1/sharing/principals/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName, grants, expectedPolicySha }),
    }), "Could not update coauthor");
  }

  async revokeSharingSessions(id: string, expectedPolicySha: string): Promise<void> {
    const base = this.apiUrl();
    if (!base) throw new Error("Shared library access is not configured");
    await responseJson(await this.apiFetch(`${base}/v1/sharing/principals/${encodeURIComponent(id)}/revoke-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedPolicySha }),
    }), "Could not revoke coauthor sessions");
  }

  async removeSharingPrincipal(id: string, expectedPolicySha: string): Promise<void> {
    const base = this.apiUrl();
    if (!base) throw new Error("Shared library access is not configured");
    await responseJson(await this.apiFetch(`${base}/v1/sharing/principals/${encodeURIComponent(id)}/remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedPolicySha }),
    }), "Could not remove coauthor");
  }

  async revokeInvitation(id: string): Promise<void> {
    const base = this.apiUrl();
    if (!base) throw new Error("Shared library access is not configured");
    const response = await this.apiFetch(`${base}/v1/sharing/invites/${encodeURIComponent(id)}/revoke`, { method: "POST" });
    if (!response.ok) await responseJson(response, "Could not revoke invitation");
  }

  documentCapabilities(
    projects: string[],
    generatedReadOnly = false,
    path?: string,
  ): DocumentAccessCapabilities {
    const sharedAccess = this.currentSession.principal?.kind === "coauthor";
    if (!this.currentSession.authenticated) {
      return { authorized: false, canEditContent: false, canEditComments: false, canManageAllComments: false, ...(sharedAccess ? { sharedAccess: true } : {}) };
    }
    if (this.currentSession.principal?.kind !== "coauthor") {
      return generatedReadOnly
        ? { authorized: true, canEditContent: false, canEditComments: false, canManageAllComments: false }
        : { authorized: true, canEditContent: true, canEditComments: true, canManageAllComments: true };
    }
    // Cached tab metadata is user-controlled browser state. A coauthor path is
    // authorized only when it also appears in the latest server-filtered index.
    if (!path || !this.indexEntries?.some((entry) => entry.path === path)) {
      return { authorized: false, canEditContent: false, canEditComments: false, canManageAllComments: false, sharedAccess: true };
    }
    if (!projects.length) return { authorized: false, canEditContent: false, canEditComments: false, canManageAllComments: false, sharedAccess: true };
    const grants = new Map((this.currentSession.grants ?? []).map((grant) => [grant.project, grant.role]));
    const rank: Record<SharedAccessRole, number> = { reader: 1, commenter: 2, editor: 3 };
    const roles = projects.map((project) => grants.get(project)).filter(Boolean) as SharedAccessRole[];
    if (roles.length !== projects.length) return { authorized: false, canEditContent: false, canEditComments: false, canManageAllComments: false, sharedAccess: true };
    if (generatedReadOnly) {
      return { authorized: true, canEditContent: false, canEditComments: false, canManageAllComments: false, sharedAccess: true };
    }
    return {
      authorized: true,
      canEditContent: roles.every((role) => rank[role] >= rank.editor),
      canEditComments: roles.every((role) => rank[role] >= rank.commenter),
      canManageAllComments: roles.every((role) => rank[role] >= rank.editor),
      sharedAccess: true,
    };
  }

  canEditProjectAssets(projects: readonly string[]): boolean {
    if (!this.currentSession.authenticated) return false;
    if (this.currentSession.principal?.kind !== "coauthor") return true;
    if (!projects.length) return false;
    const grants = new Map((this.currentSession.grants ?? []).map((grant) => [grant.project, grant.role]));
    return projects.every((project) => grants.get(project) === "editor");
  }

  async startDeviceAuthorization(): Promise<GitHubDeviceAuthorization> {
    const base = this.apiUrl();
    if (!base) throw new Error("GitHub library sync is not configured");
    const device = await responseJson<GitHubDeviceAuthorization>(
      await this.apiFetch(`${base}/auth/device/start`, { method: "POST" }),
    );
    this.pendingId = device.pendingId ?? null;
    return device;
  }

  async pollDeviceAuthorization(): Promise<GitHubDevicePoll> {
    const base = this.apiUrl();
    if (!base) throw new Error("GitHub library sync is not configured");
    const init: RequestInit = { method: "POST" };
    if (this.pendingId) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify({ pendingId: this.pendingId });
    }
    const result = await responseJson<GitHubDevicePoll>(
      await this.apiFetch(`${base}/auth/device/poll`, init),
    );
    if (result.state === "authorized") {
      if (result.desktopSession) await this.sessionStore.set(result.desktopSession);
      this.pendingId = null;
    } else if (["expired", "denied", "interrupted"].includes(result.state)) {
      this.pendingId = null;
    }
    return result;
  }

  async cancelDeviceAuthorization(): Promise<void> {
    const pendingId = this.pendingId;
    this.pendingId = null;
    const base = this.apiUrl();
    if (!base || !pendingId) return;
    const response = await this.apiFetch(`${base}/auth/device/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pendingId }),
    });
    if (!response.ok) throw new Error(`GitHub authorization cancellation failed (${response.status})`);
  }

  async logout(): Promise<void> {
    const base = this.apiUrl();
    try {
      if (base) await this.apiFetch(`${base}/auth/logout`, { method: "POST" });
    } finally {
      this.pendingId = null;
      this.sourcesByPath.clear();
      this.cachedSourceBytes = 0;
      this.indexRevision = null;
      this.indexEntries = null;
      this.assetRevision = null;
      this.assetEntries = null;
      this.currentSession = { authenticated: false };
      await this.sessionStore.clear();
    }
  }

  async list(): Promise<GitHubLibraryFile[]> {
    const base = this.apiUrl();
    if (!base) return [];
    const generation = this.nextSourceGeneration();
    const indexHeaders = new Headers();
    if (this.indexRevision) indexHeaders.set("if-none-match", this.indexRevision);
    const indexed = await this.apiFetch(`${base}/v2/library/index`, { headers: indexHeaders });
    const contentType = indexed.headers.get("content-type")?.toLowerCase() ?? "";
    const legacyEndpoint = indexed.status === 404
      || indexed.status === 405
      // The pre-v2 production dispatcher served the SPA fallback with 200 for
      // unknown API paths. Treat only a successful non-JSON body as that legacy
      // behavior; real JSON API errors must still surface to the user.
      || (indexed.ok && !contentType.includes("application/json"));
    if (!legacyEndpoint) {
      if (indexed.status === 304 && this.indexEntries) {
        return this.filesFromIndex(this.indexEntries, generation);
      }
      // Tolerate an old/mock service returning its v1 body at the new URL. This
      // is also useful during a rolling Render deploy where app and API briefly
      // straddle versions.
      const possibleLegacy = await indexed.clone().json().catch(() => null) as ListResponse | null;
      if (possibleLegacy?.entries?.every((entry) => typeof entry.text === "string")) {
        return this.filesFromSources(possibleLegacy.entries, generation);
      }
      const response = await responseJson<IndexResponse>(indexed, "GitHub library index failed");
      this.indexRevision = indexed.headers.get("etag") ?? `"${response.revision}"`;
      this.indexEntries = response.entries;
      this.reconcileIndexSources(response.entries, generation);
      return this.filesFromIndex(response.entries, generation);
    }

    // One-release compatibility path for API deployments that predate v2.
    this.indexRevision = null;
    this.indexEntries = null;
    const response = await responseJson<ListResponse>(
      await this.apiFetch(`${base}/v1/library`),
    );
    return this.filesFromSources(response.entries, generation);
  }

  async listAssets(): Promise<LibraryAsset[]> {
    const base = this.apiUrl();
    if (!base) return [];
    const headers = new Headers();
    if (this.assetRevision) headers.set("if-none-match", this.assetRevision);
    const response = await this.apiFetch(`${base}/v2/library/assets`, { headers });
    if (response.status === 304 && this.assetEntries) return [...this.assetEntries];
    const body = await responseJson<{ revision: string; entries: AssetResponse[] }>(response);
    this.assetRevision = response.headers.get("etag") ?? `"${body.revision}"`;
    this.assetEntries = body.entries.map((entry) => ({
      path: entry.path,
      sha: entry.sha,
      size: entry.size,
      mimeType: assetMimeType(entry.path),
    }));
    return [...this.assetEntries];
  }

  async readAsset(path: string): Promise<{ asset: LibraryAsset; bytes: Uint8Array }> {
    const base = this.apiUrl();
    if (!base) throw new Error("GitHub library sync is not configured");
    const clean = validateLibraryAssetPath(path);
    const response = await responseJson<AssetResponse>(
      await this.apiFetch(`${base}/v2/library/assets/file?path=${encodeURIComponent(clean)}`),
    );
    if (!response.content) throw new Error("GitHub returned an empty asset response");
    const bytes = base64ToBytes(response.content);
    return {
      asset: { path: response.path, sha: response.sha, size: bytes.byteLength, mimeType: assetMimeType(path) },
      bytes,
    };
  }

  async writeAsset(input: LibraryAssetWrite): Promise<LibraryAsset> {
    const base = this.apiUrl();
    if (!base) throw new Error("GitHub library sync is not configured");
    const validated = validateLibraryAssetWrite(input);
    const headers = new Headers({ "content-type": "application/json" });
    if (validated.ifMatch) headers.set("if-match", `"${validated.ifMatch}"`);
    const response = await responseJson<AssetResponse>(await this.apiFetch(
      `${base}/v2/library/assets/file?path=${encodeURIComponent(validated.path)}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ content: bytesToBase64(validated.bytes) }),
      },
    ));
    this.assetRevision = null;
    this.assetEntries = null;
    return {
      path: response.path,
      sha: response.sha,
      size: response.size,
      mimeType: validated.mimeType,
    };
  }

  private filesFromSources(entries: ListResponse["entries"], generation: number): GitHubLibraryFile[] {
    const effectiveSources = this.reconcileListedSources(entries, generation);
    return effectiveSources.map((entry) => {
      // The list endpoint already returns the complete source. Parse it once so
      // comments beyond the old 64 KiB indexing slice are counted correctly.
      const { frontmatter } = parseFrontmatter(entry.text);
      return {
        name: basename(entry.path),
        folder: folder(entry.path),
        handle: { kind: "github" as const, path: entry.path, sha: entry.sha },
        meta: frontmatter.library,
        openCommentCount: countUnresolvedComments(frontmatter.comments),
        commentActivityDigest: commentActivityDigest(frontmatter.comments),
      };
    });
  }

  private filesFromIndex(entries: IndexResponse["entries"], generation: number): GitHubLibraryFile[] {
    const listedPaths = new Set(entries.map((entry) => entry.path));
    const effective = entries.map((entry) => {
      const cached = this.sourcesByPath.get(entry.path);
      if (!cached || cached.generation <= generation || cached.source.sha === entry.sha) return entry;
      const parsed = parseFrontmatter(cached.source.text).frontmatter;
      return {
        path: cached.source.path,
        sha: cached.source.sha,
        meta: parsed.library,
        openCommentCount: countUnresolvedComments(parsed.comments),
        commentActivityDigest: commentActivityDigest(parsed.comments),
      };
    });
    for (const cached of this.sourcesByPath.values()) {
      if (cached.generation <= generation || listedPaths.has(cached.source.path)) continue;
      const parsed = parseFrontmatter(cached.source.text).frontmatter;
      effective.push({
        path: cached.source.path,
        sha: cached.source.sha,
        meta: parsed.library,
        openCommentCount: countUnresolvedComments(parsed.comments),
        commentActivityDigest: commentActivityDigest(parsed.comments),
      });
    }
    return effective.map((entry) => ({
      name: basename(entry.path),
      folder: folder(entry.path),
      handle: { kind: "github", path: entry.path, sha: entry.sha },
      meta: normalizeMeta(entry.meta),
      openCommentCount: Number.isSafeInteger(entry.openCommentCount) && entry.openCommentCount > 0
        ? entry.openCommentCount
        : 0,
      ...(typeof entry.commentActivityDigest === "string" && entry.commentActivityDigest
        ? { commentActivityDigest: entry.commentActivityDigest }
        : {}),
    }));
  }

  private reconcileIndexSources(entries: IndexResponse["entries"], generation: number): void {
    const shas = new Map(entries.map((entry) => [entry.path, entry.sha]));
    for (const [path, cached] of this.sourcesByPath) {
      if (cached.generation <= generation && shas.get(path) !== cached.source.sha) {
        this.forgetSource(path, cached);
      }
    }
  }

  /** Return the newest source captured by a list/save response for projections. */
  async catalogSource(file: GitHubLibraryFile): Promise<string> {
    const cached = this.sourcesByPath.get(file.handle.path);
    if (cached) {
      // Map insertion order doubles as a small LRU. Catalog projections often
      // revisit overview/manifest documents, so retain those preferentially.
      this.sourcesByPath.delete(file.handle.path);
      this.sourcesByPath.set(file.handle.path, cached);
      return cached.source.text;
    }
    return (await this.open(file)).text;
  }

  async open(file: GitHubLibraryFile): Promise<OpenedFile> {
    const base = this.apiUrl();
    if (!base) throw new Error("GitHub library sync is not configured");
    const cached = this.sourcesByPath.get(file.handle.path);
    // The index SHA is the library snapshot's freshness boundary. Reusing an
    // exact-SHA source makes owner navigation instant without weakening Pull:
    // a changed index SHA evicts this source. Shared coauthors continue through
    // the server on every open so current project grants are re-authorized.
    if (
      cached?.source.sha === file.handle.sha
      && this.currentSession.principal?.kind !== "coauthor"
    ) {
      this.sourcesByPath.delete(file.handle.path);
      this.sourcesByPath.set(file.handle.path, cached);
      return {
        name: basename(cached.source.path),
        path: cached.source.path,
        text: cached.source.text,
        handle: {
          kind: "github",
          path: cached.source.path,
          sha: cached.source.sha,
        },
      };
    }
    const generation = this.nextSourceGeneration();
    const response = await responseJson<DocumentResponse>(
      await this.apiFetch(`${base}/v1/library/documents?path=${encodeURIComponent(file.handle.path)}`),
    );
    this.rememberSource(response, generation);
    return {
      name: basename(response.path),
      path: response.path,
      text: response.text,
      handle: { kind: "github", path: response.path, sha: response.sha },
    };
  }

  async create(rawPath: string): Promise<OpenedFile | null> {
    const path = normalisePath(rawPath);
    if (!path) return null;
    const base = this.apiUrl();
    if (!base) throw new Error("GitHub library sync is not configured");
    const generation = this.nextSourceGeneration();
    const existing = await this.apiFetch(`${base}/v1/library/documents?path=${encodeURIComponent(path)}`);
    const response = existing.status === 404
      ? await this.write(path, "", undefined)
      : await responseJson<DocumentResponse>(existing);
    // `write` owns a newer generation in the create case.
    if (existing.status !== 404) this.rememberSource(response, generation);
    return {
      name: basename(response.path),
      path: response.path,
      text: response.text,
      handle: { kind: "github", path: response.path, sha: response.sha },
    };
  }

  async save(
    text: string,
    handle: GitHubFileRef,
  ): Promise<SaveResult | RemoteConflictResult> {
    try {
      const saved = await this.write(handle.path, text, handle.sha);
      return { name: basename(saved.path), handle: { kind: "github", path: saved.path, sha: saved.sha } };
    } catch (error) {
      if (error instanceof GitHubConflictError) {
        return {
          kind: "remote-conflict",
          name: basename(error.remote.path),
          handle: { kind: "github", path: error.remote.path, sha: error.remote.sha },
          text: error.remote.text,
        };
      }
      throw error;
    }
  }

  private async write(path: string, text: string, expectedSha?: string): Promise<DocumentResponse> {
    const base = this.apiUrl();
    if (!base) throw new Error("GitHub library sync is not configured");
    const writeStartedAt = this.nextSourceGeneration();
    const response = await this.apiFetch(`${base}/v1/library/documents?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, expectedSha }),
    });
    if (response.status === 409) {
      const body = (await response.json()) as ConflictResponse;
      if (body.code === "REMOTE_CONFLICT" && body.remote) {
        // Remote-wins conflict recovery replaces the editor and invalidates the
        // project catalog immediately. Make that rebuild read the remote source,
        // not the stale text retained from the preceding list response.
        // Allocate precedence at mutation *completion*. A Pull may have started
        // after this PUT and still snapshotted the old branch before the commit;
        // its higher request-start generation must not outrank this response.
        // The server read this body while handling the failed mutation, so it
        // is more authoritative than any earlier overlapping list response.
        this.rememberSource(body.remote, this.nextSourceGeneration());
        throw new GitHubConflictError(body.remote);
      }
    }
    const saved = await responseJson<DocumentResponse>(response);
    const newerRemote = this.newerRemoteObserved(
      saved.path,
      writeStartedAt,
      expectedSha,
      saved.sha,
    );
    if (newerRemote) {
      // The write committed, but a Pull that began afterward has already seen a
      // third SHA (for example, another client's immediate follow-up commit).
      // Treat it exactly like a SHA conflict so the editor cannot claim the
      // older saved blob is current or replace the newer library index handle.
      throw new GitHubConflictError(newerRemote);
    }
    this.rememberSource(saved, this.nextSourceGeneration());
    return saved;
  }

  private newerRemoteObserved(
    path: string,
    writeStartedAt: number,
    expectedSha: string | undefined,
    responseSha: string,
  ): DocumentResponse | null {
    const current = this.sourcesByPath.get(path);
    if (!current || current.generation <= writeStartedAt) return null;
    const sha = current.source.sha;
    return sha !== expectedSha && sha !== responseSha ? current.source : null;
  }

  private nextSourceGeneration(): number {
    return ++this.sourceGeneration;
  }

  private rememberSource(source: DocumentResponse, generation: number): void {
    const current = this.sourcesByPath.get(source.path);
    // A list/open begun before a save may finish afterward. Request generation,
    // rather than completion order, prevents that delayed response from
    // replacing the saved/conflict SHA and text in the catalog cache.
    if (current && current.generation > generation) {
      // Retain and touch the newer source so a delayed full list cannot make it
      // the first cache entry evicted merely because it completed earlier.
      this.sourcesByPath.delete(source.path);
      this.sourcesByPath.set(source.path, current);
      return;
    }
    if (current) this.forgetSource(source.path, current);
    // JavaScript strings use up to two bytes per UTF-16 code unit. This
    // conservative estimate bounds heap retention without allocating another
    // full encoded copy of every Markdown document.
    const estimatedBytes = source.text.length * 2;
    this.sourcesByPath.set(source.path, { source, generation, estimatedBytes });
    this.cachedSourceBytes += estimatedBytes;
    this.trimSourceCache();
  }

  private reconcileListedSources(
    sources: DocumentResponse[],
    generation: number,
  ): DocumentResponse[] {
    const listedPaths = new Set(sources.map((source) => source.path));
    const retainedNewer = [...this.sourcesByPath.values()].filter(
      (cached) => cached.generation > generation,
    );
    for (const [path, cached] of this.sourcesByPath) {
      if (!listedPaths.has(path) && cached.generation <= generation) {
        this.forgetSource(path, cached);
      }
    }
    for (const source of sources) this.rememberSource(source, generation);
    // Reinsert any response newer than this list after the bulk list entries,
    // both to preserve its LRU priority and to keep a concurrently-created path
    // visible even when the older list did not contain it yet.
    for (const cached of retainedNewer) {
      this.rememberSource(cached.source, cached.generation);
    }

    const effective = sources.map(
      (source) => this.sourcesByPath.get(source.path)?.source ?? source,
    );
    for (const cached of retainedNewer) {
      if (!listedPaths.has(cached.source.path)) effective.push(cached.source);
    }
    return effective;
  }

  private trimSourceCache(): void {
    while (
      this.sourcesByPath.size > MAX_CACHED_SOURCES ||
      this.cachedSourceBytes > MAX_CACHED_SOURCE_BYTES
    ) {
      const oldest = this.sourcesByPath.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      const cached = this.sourcesByPath.get(oldest);
      if (cached) this.forgetSource(oldest, cached);
    }
  }

  private forgetSource(path: string, cached: CachedSource): void {
    if (!this.sourcesByPath.delete(path)) return;
    this.cachedSourceBytes = Math.max(0, this.cachedSourceBytes - cached.estimatedBytes);
  }

  private async readSession(base: string): Promise<SessionResponse> {
    const session = await responseJson<SessionResponse>(
      await this.apiFetch(`${base}/auth/session`),
    );
    this.currentSession = session;
    if (!session.authenticated && this.sessionStore.enabled) await this.sessionStore.clear();
    return session;
  }

  private async apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.sessionStore.enabled) {
      const session = await this.sessionStore.get();
      if (session) headers.set("authorization", `Bearer ${session}`);
    }
    return this.http.request(input, { ...init, headers, credentials: "include" });
  }
}

class GitHubConflictError extends Error {
  constructor(readonly remote: DocumentResponse) {
    super("The GitHub version changed before this save");
  }
}

export function normalisePath(rawPath: string): string | null {
  return normaliseDocumentPath(rawPath);
}

export const githubLibrary = new GitHubLibrary();

function assetMimeType(path: string): string {
  return libraryAssetMimeType(path) ?? "application/octet-stream";
}

function base64ToBytes(content: string): Uint8Array {
  const binary = atob(content.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
