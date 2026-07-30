import { createSign } from "node:crypto";
import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";
import type { Config } from "./config.js";

const API = "https://api.github.com";
const BLOB_READ_CONCURRENCY = 8;
const MAX_BLOB_CACHE_ENTRIES = 2_048;
const MAX_BLOB_CACHE_BYTES = 64 * 1024 * 1024;
export const MAX_UPDATER_ASSET_BYTES = 256 * 1024 * 1024;
const DEFAULT_UPDATER_STREAM_IDLE_MS = 30_000;
const DEFAULT_UPDATER_STREAM_TOTAL_MS = 10 * 60_000;
const PROTECTED_LIBRARY_FIELDS = [
  "id",
  "kind",
  "status",
  "visibility",
  "projects",
  "contains",
  "related",
  "task_authority",
] as const;

export interface LibraryDocument {
  path: string;
  sha: string;
  text: string;
}

export interface LibraryWriteActor {
  principalId: string;
  displayName: string;
}

export interface LibraryIndexEntry {
  path: string;
  sha: string;
  meta: Record<string, unknown>;
  openCommentCount: number;
}

export interface LibraryIndex {
  revision: string;
  entries: LibraryIndexEntry[];
}

export interface LibraryAssetRecord {
  path: string;
  sha: string;
  size: number;
  content?: string;
}

export interface UpdaterRelease {
  releaseId: number;
  version: string;
  notes: string;
  pubDate: string;
  signature: string;
  assetId: number;
  assetName: string;
}

export interface UpdaterAssetDownload {
  name: string;
  contentType: string;
  contentLength: number;
  body: ReadableStream<Uint8Array>;
}

interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  contentType: string;
}

interface UpdaterBundle {
  release: {
    id: number;
    tagName: string;
    notes: string;
    publishedAt: string;
    assets: ReleaseAsset[];
  };
  manifest: {
    version: string;
    notes?: string;
    pubDate?: string;
    platforms: Record<string, { signature: string; url: string }>;
  };
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

interface GitHubFailure {
  message?: string;
}

export interface DeviceAuthorization {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

interface DeviceAuthorizationResult extends DeviceAuthorization {
  deviceCode: string;
}

export type DeviceAuthorizationPoll =
  | { state: "pending" | "slow_down" | "expired" | "denied" }
  | { state: "authorized"; login: string };

export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function normaliseLibraryPath(raw: string): string | null {
  const parts = raw
    .trim()
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (
    !parts.length ||
    parts.length > 9 ||
    parts.some((part) => part === "." || part === ".." || part.startsWith(".") || part.includes("\\"))
  ) {
    return null;
  }
  const final = parts.at(-1);
  if (!final || !/\.(md|markdown)$/i.test(final)) return null;
  return parts.join("/");
}

const ASSET_EXTENSIONS = new Set([
  "bib", "png", "jpg", "jpeg", "gif", "webp", "svg", "pdf",
  "tex", "sty", "cls", "bst",
]);

export function normaliseAssetPath(raw: string): string | null {
  const parts = raw.trim().split("/").map((part) => part.trim()).filter(Boolean);
  if (
    !parts.length
    || parts.length > 9
    || parts.some((part) => part === "." || part === ".." || part.startsWith(".") || part.includes("\\"))
  ) return null;
  const extension = parts.at(-1)?.split(".").at(-1)?.toLowerCase();
  return extension && ASSET_EXTENSIONS.has(extension) ? parts.join("/") : null;
}

const UPDATER_PLATFORMS = new Map([
  ["darwin/aarch64", "darwin-aarch64"],
  ["darwin/x86_64", "darwin-x86_64"],
]);

function updaterPlatformKey(target: string, arch: string): string | null {
  return UPDATER_PLATFORMS.get(`${target}/${arch}`) ?? null;
}

interface SemVer {
  core: [number, number, number];
  prerelease: Array<number | string>;
}

function parseSemVer(raw: string): SemVer | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(raw);
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease: Array<number | string> = [];
  for (const part of match[4]?.split(".") ?? []) {
    if (!/^\d+$/.test(part)) {
      prerelease.push(part);
      continue;
    }
    if ((part.length > 1 && part.startsWith("0")) || !Number.isSafeInteger(Number(part))) return null;
    prerelease.push(Number(part));
  }
  return {
    core,
    prerelease,
  };
}

function compareSemVer(left: SemVer, right: SemVer): number {
  for (let index = 0; index < left.core.length; index++) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b !== "number") return -1;
    if (typeof a !== "number" && typeof b === "number") return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function releaseAssetName(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    const encoded = parsed.pathname.split("/").at(-1);
    const name = encoded ? decodeURIComponent(encoded) : "";
    return /^[A-Za-z0-9][A-Za-z0-9._+ -]{0,199}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

function updaterAssetName(platform: string, version: string): string | null {
  if (platform !== "darwin-aarch64" && platform !== "darwin-x86_64") return null;
  return `MdLyx_${version}_universal.app.tar.gz`;
}

function boundedUpdaterBody(
  source: ReadableStream<Uint8Array>,
  expectedBytes: number,
  abort: (reason?: unknown) => void,
  idleTimeoutMs: number,
  totalTimeoutMs: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const deadline = Date.now() + totalTimeoutMs;
  let received = 0;
  let finished = false;
  let readerReleased = false;
  const releaseReader = () => {
    if (readerReleased) return;
    readerReleased = true;
    reader.releaseLock();
  };

  const fail = async (controller: ReadableStreamDefaultController<Uint8Array>, error: unknown) => {
    finished = true;
    abort(error);
    await reader.cancel(error).catch(() => undefined);
    releaseReader();
    controller.error(error);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await fail(controller, new GitHubError(504, "Updater asset stream exceeded its total deadline"));
        return;
      }
      const wait = Math.max(1, Math.min(idleTimeoutMs, remaining));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new GitHubError(504, "Updater asset stream became idle")),
              wait,
            );
          }),
        ]);
        if (result.done) {
          finished = true;
          abort();
          releaseReader();
          if (received !== expectedBytes) {
            controller.error(new GitHubError(502, "Updater asset length did not match release metadata"));
          } else {
            controller.close();
          }
          return;
        }
        received += result.value.byteLength;
        if (received > expectedBytes || received > MAX_UPDATER_ASSET_BYTES) {
          await fail(controller, new GitHubError(502, "Updater asset exceeded its declared size"));
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        await fail(controller, error);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      abort(reason);
      await reader.cancel(reason).catch(() => undefined);
      releaseReader();
    },
  });
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function commitMessage(action: string, actor?: LibraryWriteActor): string {
  if (!actor) return `mdlyx: ${action}`;
  const principal = actor.principalId.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64) || "coauthor";
  const display = actor.displayName.replace(/[\r\n\0]/g, " ").trim().slice(0, 100) || principal;
  return `mdlyx(${principal}): ${action}\n\nMdLyx-Principal: ${principal}\nMdLyx-Display-Name: ${display}`;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}

export class GitHubLibraryApi {
  private installationToken: { value: string; expiresAt: number } | null = null;
  private installationTokenRequest: Promise<string> | null = null;
  private releaseInstallationToken: { value: string; expiresAt: number } | null = null;
  private releaseInstallationTokenRequest: Promise<string> | null = null;
  private readonly blobCache = new Map<string, { text: string; bytes: number }>();
  private readonly blobRequests = new Map<string, Promise<string>>();
  private blobCacheBytes = 0;
  private updaterBundleCache: { value: UpdaterBundle; expiresAt: number } | null = null;
  private updaterBundleRequest: Promise<UpdaterBundle> | null = null;
  private readonly libraryBranch: string;
  private readonly libraryProtectedBranch: string;

  constructor(
    private readonly config: Config,
    private readonly request: typeof fetch = fetch,
    private readonly requestTimeoutMs = 12_000,
    private readonly updaterStreamIdleMs = DEFAULT_UPDATER_STREAM_IDLE_MS,
    private readonly updaterStreamTotalMs = DEFAULT_UPDATER_STREAM_TOTAL_MS,
  ) {
    // Config normally supplies these defaults. Normalize again at the API
    // boundary so direct callers cannot disable main-branch protection with a
    // blank value or accidentally issue requests against an empty branch.
    this.libraryBranch = config.libraryBranch.trim() || "main";
    this.libraryProtectedBranch = config.libraryProtectedBranch.trim() || "main";
  }

  async latestUpdaterRelease(target: string, arch: string, currentVersion: string): Promise<UpdaterRelease | null> {
    const platform = updaterPlatformKey(target, arch);
    if (!platform) throw new GitHubError(400, "Unsupported updater target or architecture");
    const current = parseSemVer(currentVersion);
    if (!current) throw new GitHubError(400, "Invalid current application version");

    let bundle: UpdaterBundle;
    try {
      bundle = await this.latestUpdaterBundle();
    } catch (error) {
      // A configured private repository legitimately has no update before its
      // first tagged Release. Treat GitHub's "latest release not found" as an
      // empty feed so a freshly deployed desktop reports "up to date" instead
      // of a service failure during bootstrap.
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
    const latest = parseSemVer(bundle.manifest.version);
    if (!latest) throw new GitHubError(502, "GitHub returned invalid updater metadata");
    if (compareSemVer(latest, current) <= 0) return null;

    const platformRelease = bundle.manifest.platforms[platform];
    const assetName = platformRelease ? releaseAssetName(platformRelease.url) : null;
    const version = bundle.manifest.version.replace(/^v/, "");
    if (
      !platformRelease
      || !platformRelease.signature.trim()
      || !assetName
      || assetName !== updaterAssetName(platform, version)
    ) {
      throw new GitHubError(502, "Latest release is missing signed updater metadata for this platform");
    }
    if (platformRelease.signature.length > 16_384) {
      throw new GitHubError(502, "GitHub returned invalid updater metadata");
    }
    const asset = bundle.release.assets.find((candidate) => candidate.name === assetName);
    if (!asset) throw new GitHubError(502, "Updater metadata references a missing release asset");
    const pubDate = bundle.manifest.pubDate ?? bundle.release.publishedAt;
    if (Number.isNaN(Date.parse(pubDate))) throw new GitHubError(502, "GitHub returned invalid updater metadata");

    return {
      releaseId: bundle.release.id,
      version,
      notes: bundle.manifest.notes ?? bundle.release.notes,
      pubDate,
      signature: platformRelease.signature.trim(),
      assetId: asset.id,
      assetName: asset.name,
    };
  }

  async downloadUpdaterAsset(
    releaseId: number,
    assetId: number,
    assetName: string,
    externalSignal?: AbortSignal,
  ): Promise<UpdaterAssetDownload> {
    if (
      !Number.isSafeInteger(releaseId)
      || releaseId <= 0
      || !Number.isSafeInteger(assetId)
      || assetId <= 0
      || releaseAssetName(`https://release.invalid/${encodeURIComponent(assetName)}`) !== assetName
    ) {
      throw new GitHubError(400, "Invalid updater asset");
    }
    const bundle = this.updaterBundleCache?.value.release.id === releaseId
      ? this.updaterBundleCache.value
      : await this.fetchUpdaterBundle(`/repos/${encodeURIComponent(this.config.releaseOwner)}/${encodeURIComponent(this.config.releaseRepo)}/releases/${releaseId}`);
    const referencedNames = new Set(
      Object.entries(bundle.manifest.platforms)
        .map(([platform, release]) => {
          const name = releaseAssetName(release.url);
          const version = bundle.manifest.version.replace(/^v/, "");
          return name === updaterAssetName(platform, version) ? name : null;
        })
        .filter((name): name is string => Boolean(name)),
    );
    const asset = bundle.release.assets.find((candidate) =>
      candidate.id === assetId && candidate.name === assetName && referencedNames.has(candidate.name),
    );
    if (!asset) throw new GitHubError(404, "Updater asset was not found in this release");
    if (asset.size <= 0 || asset.size > MAX_UPDATER_ASSET_BYTES) {
      throw new GitHubError(502, "Updater asset has an invalid size");
    }

    const stream = await this.releaseGithubStream(
      `/repos/${encodeURIComponent(this.config.releaseOwner)}/${encodeURIComponent(this.config.releaseRepo)}/releases/assets/${asset.id}`,
      externalSignal,
    );
    const { response } = stream;
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as GitHubFailure;
      stream.abort();
      throw new GitHubError(response.status, body.message ?? "GitHub could not download the updater asset");
    }
    if (!response.body) {
      stream.abort();
      throw new GitHubError(502, "GitHub returned an empty updater asset");
    }
    const rawHeaderLength = response.headers.get("content-length");
    const headerLength = rawHeaderLength === null ? null : Number(rawHeaderLength);
    if (headerLength !== null && (!Number.isSafeInteger(headerLength) || headerLength !== asset.size)) {
      stream.abort();
      throw new GitHubError(502, "Updater asset length did not match release metadata");
    }
    return {
      name: asset.name,
      contentType: response.headers.get("content-type") ?? asset.contentType ?? "application/octet-stream",
      contentLength: asset.size,
      body: boundedUpdaterBody(
        response.body,
        asset.size,
        stream.abort,
        this.updaterStreamIdleMs,
        this.updaterStreamTotalMs,
      ),
    };
  }

  private async latestUpdaterBundle(): Promise<UpdaterBundle> {
    if (this.updaterBundleCache && this.updaterBundleCache.expiresAt > Date.now()) {
      return this.updaterBundleCache.value;
    }
    if (this.updaterBundleRequest) return this.updaterBundleRequest;
    const request = this.fetchLatestUpdaterBundle();
    this.updaterBundleRequest = request;
    try {
      const value = await request;
      this.updaterBundleCache = { value, expiresAt: Date.now() + 60_000 };
      return value;
    } finally {
      if (this.updaterBundleRequest === request) this.updaterBundleRequest = null;
    }
  }

  private async fetchLatestUpdaterBundle(): Promise<UpdaterBundle> {
    const repository = `/repos/${encodeURIComponent(this.config.releaseOwner)}/${encodeURIComponent(this.config.releaseRepo)}`;
    return this.fetchUpdaterBundle(`${repository}/releases/latest`);
  }

  private async fetchUpdaterBundle(releasePath: string): Promise<UpdaterBundle> {
    const release = await this.releaseRequestJson<{
      id?: number;
      tag_name?: string;
      immutable?: boolean;
      body?: string | null;
      published_at?: string | null;
      assets?: Array<{ id?: number; name?: string; size?: number; content_type?: string }>;
    }>(releasePath);
    if (!Number.isSafeInteger(release.id) || (release.id ?? 0) <= 0 || typeof release.tag_name !== "string") {
      throw new GitHubError(502, "GitHub returned invalid release identity");
    }
    if (release.immutable !== true) {
      throw new GitHubError(502, "GitHub updater release is not immutable");
    }
    const assets = (release.assets ?? [])
      .filter((asset): asset is { id: number; name: string; size?: number; content_type?: string } =>
        Number.isSafeInteger(asset.id) && typeof asset.name === "string" && Boolean(asset.name),
      )
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        size: Number.isSafeInteger(asset.size) && (asset.size ?? -1) >= 0 ? asset.size as number : 0,
        contentType: asset.content_type ?? "application/octet-stream",
      }));
    const metadata = assets.find((asset) => asset.name === "latest.json");
    if (!metadata) throw new GitHubError(502, "Latest GitHub release does not contain latest.json");
    if (metadata.size > 1_000_000) throw new GitHubError(502, "Updater metadata exceeds 1 MB");

    const repository = `/repos/${encodeURIComponent(this.config.releaseOwner)}/${encodeURIComponent(this.config.releaseRepo)}`;
    const response = await this.releaseGithubRequest(`${repository}/releases/assets/${metadata.id}`, {
      headers: { accept: "application/octet-stream" },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as GitHubFailure;
      throw new GitHubError(response.status, body.message ?? "GitHub could not download updater metadata");
    }
    const source = await response.text();
    if (Buffer.byteLength(source, "utf8") > 1_000_000) throw new GitHubError(502, "Updater metadata exceeds 1 MB");
    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch {
      throw new GitHubError(502, "GitHub returned malformed updater metadata");
    }
    const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const rawPlatforms = record.platforms && typeof record.platforms === "object" && !Array.isArray(record.platforms)
      ? record.platforms as Record<string, unknown>
      : {};
    const platforms: Record<string, { signature: string; url: string }> = {};
    for (const [key, value] of Object.entries(rawPlatforms)) {
      const platform = value && typeof value === "object" ? value as Record<string, unknown> : {};
      if (typeof platform.signature === "string" && typeof platform.url === "string") {
        platforms[key] = { signature: platform.signature, url: platform.url };
      }
    }
    if (typeof record.version !== "string") throw new GitHubError(502, "GitHub returned invalid updater metadata");
    const version = record.version.replace(/^v/, "");
    if (!parseSemVer(version) || release.tag_name !== `v${version}`) {
      throw new GitHubError(502, "Updater version does not match the immutable release tag");
    }
    return {
      release: {
        id: release.id as number,
        tagName: release.tag_name,
        notes: typeof release.body === "string" ? release.body : "",
        publishedAt: typeof release.published_at === "string" ? release.published_at : new Date(0).toISOString(),
        assets,
      },
      manifest: {
        version: record.version,
        ...(typeof record.notes === "string" ? { notes: record.notes } : {}),
        ...(typeof record.pub_date === "string" ? { pubDate: record.pub_date } : {}),
        platforms,
      },
    };
  }

  async oauthUser(code: string): Promise<{ login: string }> {
    const tokenResponse = await this.fetchWithDeadline("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.githubClientId,
        client_secret: this.config.githubClientSecret,
        code,
      }),
    });
    const tokenBody = await tokenResponse.json() as { access_token?: string; error_description?: string };
    if (!tokenResponse.ok || !tokenBody.access_token) {
      throw new GitHubError(tokenResponse.status, tokenBody.error_description ?? "GitHub authorization failed");
    }
    return this.oauthUserToken(tokenBody.access_token);
  }

  async startDeviceAuthorization(): Promise<DeviceAuthorizationResult> {
    const response = await this.fetchWithDeadline("https://github.com/login/device/code", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.config.githubClientId }),
    });
    const body = await response.json().catch(() => ({})) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      interval?: number;
      error_description?: string;
    };
    if (!response.ok || !body.device_code || !body.user_code || !body.verification_uri || !body.expires_in) {
      throw new GitHubError(response.status, body.error_description ?? "GitHub could not start device authorization");
    }
    return {
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      expiresIn: body.expires_in,
      interval: body.interval ?? 5,
      // The raw device code is intentionally not returned by the HTTP API.
      // The web handler holds it in a short-lived signed HTTP-only cookie.
      deviceCode: body.device_code,
    };
  }

  async pollDeviceAuthorization(deviceCode: string): Promise<DeviceAuthorizationPoll> {
    const response = await this.fetchWithDeadline("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.githubClientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const body = await response.json().catch(() => ({})) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (body.access_token) return { state: "authorized", ...(await this.oauthUserToken(body.access_token)) };
    switch (body.error) {
      case "authorization_pending": return { state: "pending" };
      case "slow_down": return { state: "slow_down" };
      case "expired_token":
      case "incorrect_device_code": return { state: "expired" };
      case "access_denied": return { state: "denied" };
      default: throw new GitHubError(response.status, body.error_description ?? "GitHub device authorization failed");
    }
  }

  private async oauthUserToken(accessToken: string): Promise<{ login: string }> {
    const user = await this.requestJson<{ login?: string }>("/user", accessToken);
    if (!user.login) throw new GitHubError(401, "GitHub did not return an account login");
    return { login: user.login };
  }

  async list(): Promise<LibraryDocument[]> {
    const { entries } = await this.libraryTree();
    return mapWithConcurrency(entries, BLOB_READ_CONCURRENCY, async (entry) => ({
      path: entry.path,
      sha: entry.sha,
      text: await this.readBlob(entry.sha),
    }));
  }

  async index(): Promise<LibraryIndex> {
    const { revision, entries } = await this.libraryTree();
    const indexed = await mapWithConcurrency(entries, BLOB_READ_CONCURRENCY, async (entry) => {
      const text = await this.readBlob(entry.sha);
      const metadata = indexMetadata(text);
      return { path: entry.path, sha: entry.sha, ...metadata };
    });
    return { revision, entries: indexed };
  }

  async accessConfiguration(): Promise<{
    revision: string;
    policySha: string;
    policy: string;
    projects: Array<{ path: string; text: string }>;
  }> {
    const { revision, entries } = await this.repositoryTree();
    const policyPath = this.config.accessPolicyPath.replace(/^\/+|\/+$/g, "");
    const policy = entries.find((entry) => entry.path === policyPath);
    if (!policy) throw new GitHubError(503, "The shared-library access policy is unavailable");
    const projects = entries
      .filter((entry) => /^projects\/[^/]+\/project\.yaml$/.test(entry.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    return {
      revision,
      policySha: policy.sha,
      policy: await this.readBlob(policy.sha),
      projects: await mapWithConcurrency(projects, BLOB_READ_CONCURRENCY, async (entry) => ({
        path: entry.path,
        text: await this.readBlob(entry.sha),
      })),
    };
  }

  async writeAccessPolicy(text: string, expectedSha: string): Promise<LibraryDocument> {
    const clean = this.config.accessPolicyPath.replace(/^\/+|\/+$/g, "");
    if (!clean || clean.includes("..") || !expectedSha.trim()) {
      throw new GitHubError(400, "Invalid access-policy update");
    }
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
      throw new GitHubError(413, "Access policy exceeds 64 KiB");
    }
    const response = await this.githubRequest(
      `/repos/${this.config.libraryOwner}/${this.config.libraryRepo}/contents/${encodePath(clean)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: "mdlyx: update shared access policy",
          content: Buffer.from(text, "utf8").toString("base64"),
          branch: this.libraryBranch,
          sha: expectedSha,
        }),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as GitHubFailure;
      throw new GitHubError(response.status, body.message ?? "GitHub could not update shared access");
    }
    const body = await response.json() as { content?: { sha?: string } };
    const sha = body.content?.sha;
    if (!sha) throw new GitHubError(502, "GitHub did not return the access-policy SHA");
    this.rememberBlob(sha, text);
    return { path: clean, sha, text };
  }

  private async libraryTree(): Promise<{ revision: string; entries: TreeEntry[] }> {
    const { revision, entries: rawEntries } = await this.repositoryTree();
    const entries = rawEntries
      .filter((entry): entry is TreeEntry => normaliseLibraryPath(entry.path) === entry.path)
      .sort((a, b) => a.path.localeCompare(b.path));
    return { revision, entries };
  }

  async assets(): Promise<{ revision: string; entries: LibraryAssetRecord[] }> {
    const { revision, entries } = await this.repositoryTree();
    return {
      revision,
      entries: entries
        .filter((entry) => normaliseAssetPath(entry.path) === entry.path)
        .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  private async repositoryTree(): Promise<{ revision: string; entries: TreeEntry[] }> {
    const branch = encodeURIComponent(this.libraryBranch);
    const recursive = await this.requestJson<{
      sha?: string;
      truncated?: boolean;
      tree?: Array<{ path?: string; type?: string; sha?: string; size?: number }>;
    }>(`/repos/${this.config.libraryOwner}/${this.config.libraryRepo}/git/trees/${branch}?recursive=1`);
    const revision = recursive.sha ?? this.libraryBranch;
    const rawEntries = recursive.truncated
      ? await this.walkTrees(branch)
      : recursive.tree ?? [];
    const entries = rawEntries
      .filter((entry): entry is TreeEntry =>
        entry.type === "blob" &&
        typeof entry.path === "string" &&
        typeof entry.sha === "string",
      );
    return { revision, entries };
  }

  private async walkTrees(root: string): Promise<Array<{ path?: string; type?: string; sha?: string; size?: number }>> {
    const output: TreeEntry[] = [];
    const visit = async (treeSha: string, prefix: string): Promise<void> => {
      const tree = await this.requestJson<{
        tree?: Array<{ path?: string; type?: string; sha?: string; size?: number }>;
      }>(`/repos/${this.config.libraryOwner}/${this.config.libraryRepo}/git/trees/${encodeURIComponent(treeSha)}`);
      for (const entry of tree.tree ?? []) {
        if (!entry.path || !entry.sha || !entry.type) continue;
        const path = prefix ? `${prefix}/${entry.path}` : entry.path;
        if (entry.type === "tree") await visit(entry.sha, path);
        else if (entry.type === "blob") {
          output.push({ path, type: entry.type, sha: entry.sha, size: entry.size });
        }
      }
    };
    await visit(root, "");
    return output;
  }

  async read(path: string): Promise<LibraryDocument> {
    const clean = normaliseLibraryPath(path);
    if (!clean) throw new GitHubError(400, "Invalid library path");
    const body = await this.requestJson<{ content?: string; encoding?: string; sha?: string }>(
      `/repos/${this.config.libraryOwner}/${this.config.libraryRepo}/contents/${encodePath(clean)}?ref=${encodeURIComponent(this.libraryBranch)}`,
    );
    if (!body.content || body.encoding !== "base64" || !body.sha) {
      throw new GitHubError(502, "GitHub returned an invalid document response");
    }
    const text = Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8");
    this.rememberBlob(body.sha, text);
    return { path: clean, sha: body.sha, text };
  }

  async readAsset(path: string): Promise<LibraryAssetRecord> {
    const clean = normaliseAssetPath(path);
    if (!clean) throw new GitHubError(400, "Invalid asset path");
    const body = await this.requestJson<{ content?: string; encoding?: string; sha?: string; size?: number }>(
      `/repos/${this.config.libraryOwner}/${this.config.libraryRepo}/contents/${encodePath(clean)}?ref=${encodeURIComponent(this.libraryBranch)}`,
    );
    if (!body.sha) {
      throw new GitHubError(502, "GitHub returned an invalid asset response");
    }
    // The Contents API omits base64 data above 1 MiB. Resolve those files via
    // the immutable blob endpoint while retaining the path/SHA guard.
    const content = body.content && body.encoding === "base64"
      ? body.content.replace(/\n/g, "")
      : await this.readBlobBase64(body.sha);
    const size = Buffer.from(content, "base64").byteLength;
    if (size > 25 * 1024 * 1024) throw new GitHubError(413, "Asset exceeds 25 MiB");
    return { path: clean, sha: body.sha, size, content };
  }

  private async readBlobBase64(sha: string): Promise<string> {
    const blob = await this.requestJson<{ content?: string; encoding?: string }>(
      `/repos/${this.config.libraryOwner}/${this.config.libraryRepo}/git/blobs/${encodeURIComponent(sha)}`,
    );
    if (!blob.content || blob.encoding !== "base64") {
      throw new GitHubError(502, "GitHub returned an invalid asset blob");
    }
    return blob.content.replace(/\n/g, "");
  }

  async writeAsset(
    path: string,
    content: string,
    expectedSha?: string,
    actor?: LibraryWriteActor,
  ): Promise<LibraryAssetRecord> {
    const clean = normaliseAssetPath(path);
    if (!clean) throw new GitHubError(400, "Invalid asset path");
    const compact = content.replace(/\s/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
      throw new GitHubError(400, "Asset content must be base64");
    }
    const bytes = Buffer.from(compact, "base64");
    if (bytes.byteLength > 25 * 1024 * 1024) throw new GitHubError(413, "Asset exceeds 25 MiB");
    if (
      this.libraryBranch === this.libraryProtectedBranch
      && !expectedSha
    ) {
      throw protectedLibraryWriteError("new assets");
    }
    const response = await this.githubRequest(
      `/repos/${this.config.libraryOwner}/${this.config.libraryRepo}/contents/${encodePath(clean)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: commitMessage(`save asset ${clean}`, actor),
          content: bytes.toString("base64"),
          branch: this.libraryBranch,
          ...(expectedSha ? { sha: expectedSha } : {}),
        }),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as GitHubFailure;
      throw new GitHubError(response.status, body.message ?? "GitHub could not save this asset");
    }
    const body = await response.json() as { content?: { sha?: string; size?: number } };
    const sha = body.content?.sha;
    if (!sha) throw new GitHubError(502, "GitHub did not return an asset SHA");
    return { path: clean, sha, size: bytes.byteLength };
  }

  async write(
    path: string,
    text: string,
    expectedSha?: string,
    actor?: LibraryWriteActor,
  ): Promise<LibraryDocument> {
    const clean = normaliseLibraryPath(path);
    if (!clean) throw new GitHubError(400, "Invalid library path");
    if (Buffer.byteLength(text, "utf8") > 1_000_000) throw new GitHubError(413, "Document exceeds 1 MB limit");
    if (this.libraryBranch === this.libraryProtectedBranch) {
      if (!expectedSha) throw protectedLibraryWriteError("new documents");
      const previous = await this.readBlob(expectedSha);
      const guardedChange = protectedDocumentWriteReason(clean, previous, text);
      if (guardedChange) throw protectedLibraryWriteError(guardedChange);
    }
    const response = await this.githubRequest(
      `/repos/${this.config.libraryOwner}/${this.config.libraryRepo}/contents/${encodePath(clean)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: commitMessage(`save ${clean}`, actor),
          content: Buffer.from(text, "utf8").toString("base64"),
          branch: this.libraryBranch,
          ...(expectedSha ? { sha: expectedSha } : {}),
        }),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as GitHubFailure;
      throw new GitHubError(response.status, body.message ?? "GitHub could not save this document");
    }
    const body = await response.json() as { content?: { sha?: string } };
    const sha = body.content?.sha;
    if (!sha) throw new GitHubError(502, "GitHub did not return a document SHA");
    this.rememberBlob(sha, text);
    return { path: clean, sha, text };
  }

  private async readBlob(sha: string): Promise<string> {
    const key = this.blobKey(sha);
    const cached = this.blobCache.get(key);
    if (cached) {
      // Map insertion order doubles as a small LRU. Blob SHAs are immutable, so
      // a cached value remains valid for every branch/tree that references it.
      this.blobCache.delete(key);
      this.blobCache.set(key, cached);
      return cached.text;
    }
    const pending = this.blobRequests.get(key);
    if (pending) return pending;

    const request = (async () => {
      const body = await this.requestJson<{ content?: string; encoding?: string }>(
        `/repos/${this.config.libraryOwner}/${this.config.libraryRepo}/git/blobs/${encodeURIComponent(sha)}`,
      );
      if (!body.content || body.encoding !== "base64") throw new GitHubError(502, "GitHub returned an invalid blob");
      const text = Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8");
      this.rememberBlob(sha, text);
      return text;
    })();
    this.blobRequests.set(key, request);
    try {
      return await request;
    } finally {
      if (this.blobRequests.get(key) === request) this.blobRequests.delete(key);
    }
  }

  private blobKey(sha: string): string {
    // Include repository identity even though the cache is currently
    // instance-local. This prevents an unsafe cross-repository cache hit if the
    // API object is later pooled or its cache is shared.
    return `${this.config.libraryOwner}/${this.config.libraryRepo}/${sha}`;
  }

  private rememberBlob(sha: string, text: string): void {
    const key = this.blobKey(sha);
    const existing = this.blobCache.get(key);
    if (existing) {
      this.blobCacheBytes -= existing.bytes;
      this.blobCache.delete(key);
    }
    const bytes = Buffer.byteLength(text, "utf8");
    // Oversized values are still returned to the caller but never pin the
    // bounded process cache.
    if (bytes > MAX_BLOB_CACHE_BYTES) return;
    this.blobCache.set(key, { text, bytes });
    this.blobCacheBytes += bytes;
    while (
      this.blobCache.size > MAX_BLOB_CACHE_ENTRIES ||
      this.blobCacheBytes > MAX_BLOB_CACHE_BYTES
    ) {
      const oldest = this.blobCache.keys().next().value as string | undefined;
      if (!oldest) break;
      const removed = this.blobCache.get(oldest);
      this.blobCache.delete(oldest);
      this.blobCacheBytes -= removed?.bytes ?? 0;
    }
  }

  private async requestJson<T>(path: string, userToken?: string): Promise<T> {
    const response = userToken
      ? await this.fetchWithDeadline(`${API}${path}`, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${userToken}`,
            "x-github-api-version": "2026-03-10",
          },
        })
      : await this.githubRequest(path);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as GitHubFailure;
      throw new GitHubError(response.status, body.message ?? "GitHub request failed");
    }
    return response.json() as Promise<T>;
  }

  private async releaseRequestJson<T>(path: string): Promise<T> {
    const response = await this.releaseGithubRequest(path);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as GitHubFailure;
      throw new GitHubError(response.status, body.message ?? "GitHub release request failed");
    }
    return response.json() as Promise<T>;
  }

  private async githubRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getInstallationToken();
    return this.fetchWithDeadline(`${API}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2026-03-10",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  }

  private async releaseGithubRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getReleaseInstallationToken();
    return this.fetchWithDeadline(`${API}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2026-03-10",
        ...init.headers,
      },
    });
  }

  private async releaseGithubStream(
    path: string,
    externalSignal?: AbortSignal,
  ): Promise<{ response: Response; abort: (reason?: unknown) => void }> {
    const controller = new AbortController();
    const relayAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) relayAbort();
    else externalSignal?.addEventListener("abort", relayAbort, { once: true });
    let headerTimedOut = false;
    const timeout = setTimeout(() => {
      headerTimedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    const abort = (reason?: unknown) => {
      externalSignal?.removeEventListener("abort", relayAbort);
      if (!controller.signal.aborted) controller.abort(reason);
    };
    try {
      const token = await this.getReleaseInstallationToken();
      const response = await this.request(`${API}${path}`, {
        headers: {
          accept: "application/octet-stream",
          "accept-encoding": "identity",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2026-03-10",
        },
        signal: controller.signal,
      });
      return { response, abort };
    } catch (error) {
      abort(error);
      if (headerTimedOut && !externalSignal?.aborted) {
        throw new GitHubError(504, "GitHub updater asset request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getInstallationToken(): Promise<string> {
    if (this.installationToken && this.installationToken.expiresAt > Date.now() + 60_000) {
      return this.installationToken.value;
    }
    if (this.installationTokenRequest) return this.installationTokenRequest;
    const request = (async () => {
      const response = await this.fetchWithDeadline(
        `${API}/app/installations/${encodeURIComponent(this.config.githubInstallationId)}/access_tokens`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${appJwt(this.config.githubAppId, this.config.githubPrivateKey)}`,
            "x-github-api-version": "2026-03-10",
          },
        },
      );
      const body = await response.json().catch(() => ({})) as { token?: string; expires_at?: string; message?: string };
      if (!response.ok || !body.token || !body.expires_at) {
        throw new GitHubError(response.status, body.message ?? "Could not create GitHub installation token");
      }
      this.installationToken = { value: body.token, expiresAt: Date.parse(body.expires_at) };
      return body.token;
    })();
    this.installationTokenRequest = request;
    try {
      return await request;
    } finally {
      if (this.installationTokenRequest === request) this.installationTokenRequest = null;
    }
  }

  private async getReleaseInstallationToken(): Promise<string> {
    if (this.releaseInstallationToken && this.releaseInstallationToken.expiresAt > Date.now() + 60_000) {
      return this.releaseInstallationToken.value;
    }
    if (this.releaseInstallationTokenRequest) return this.releaseInstallationTokenRequest;
    const appId = this.config.releaseGithubAppId;
    const installationId = this.config.releaseGithubInstallationId;
    const privateKey = this.config.releaseGithubPrivateKey;
    if (!appId || !installationId || !privateKey) {
      throw new GitHubError(503, "Desktop release service is not configured");
    }
    const request = (async () => {
      const response = await this.fetchWithDeadline(
        `${API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${appJwt(appId, privateKey)}`,
            "x-github-api-version": "2026-03-10",
          },
        },
      );
      const body = await response.json().catch(() => ({})) as { token?: string; expires_at?: string; message?: string };
      if (!response.ok || !body.token || !body.expires_at) {
        throw new GitHubError(response.status, body.message ?? "Could not create GitHub release installation token");
      }
      this.releaseInstallationToken = { value: body.token, expiresAt: Date.parse(body.expires_at) };
      return body.token;
    })();
    this.releaseInstallationTokenRequest = request;
    try {
      return await request;
    } finally {
      if (this.releaseInstallationTokenRequest === request) this.releaseInstallationTokenRequest = null;
    }
  }

  private async fetchWithDeadline(input: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const external = init.signal;
    const abort = () => controller.abort();
    if (external?.aborted) abort();
    else external?.addEventListener("abort", abort, { once: true });
    try {
      return await this.request(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && !external?.aborted) {
        throw new GitHubError(504, "GitHub request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      external?.removeEventListener("abort", abort);
    }
  }
}

function indexMetadata(text: string): { meta: Record<string, unknown>; openCommentCount: number } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (!frontmatter) return { meta: {}, openCommentCount: 0 };
  const resolvedLibrary = protectedLibraryMetadata(text);
  const legacyLibrary = jsonField(frontmatter, "library");
  const comments = jsonField(frontmatter, "comments");
  return {
    meta: resolvedLibrary.valid
      ? resolvedLibrary.meta
      : legacyLibrary && typeof legacyLibrary === "object" && !Array.isArray(legacyLibrary)
        ? legacyLibrary as Record<string, unknown>
        : {},
    openCommentCount: Array.isArray(comments)
      ? comments.filter((comment) => comment && typeof comment === "object" && (comment as { resolved?: unknown }).resolved !== true).length
      : 0,
  };
}

export function protectedDocumentWriteReason(path: string, previous: string, next: string): string | null {
  const filename = path.split("/").at(-1) ?? path;
  if (/^(?:claim-status|result-status|claim-ledger[^.]*)\.(?:md|markdown)$/i.test(filename)) {
    return "claim-status and result-status manifests";
  }
  const beforeResult = protectedLibraryMetadata(previous);
  const afterResult = protectedLibraryMetadata(next);
  if (!beforeResult.valid || !afterResult.valid) {
    return "malformed or ambiguous library frontmatter";
  }
  const before = beforeResult.meta;
  const after = afterResult.meta;
  const beforeProjection = before.projection;
  const afterProjection = after.projection;
  if (
    (beforeProjection && typeof beforeProjection === "object" && !Array.isArray(beforeProjection)
      && (beforeProjection as Record<string, unknown>).read_only === true)
    || (afterProjection && typeof afterProjection === "object" && !Array.isArray(afterProjection)
      && (afterProjection as Record<string, unknown>).read_only === true)
  ) {
    return "generated projections";
  }
  if (
    metadataList(before, "contains").includes("dependency-graph")
    || metadataList(after, "contains").includes("dependency-graph")
  ) {
    return "dependency-graph manifests";
  }
  for (const field of PROTECTED_LIBRARY_FIELDS) {
    const beforeValue = metadataField(before, field);
    const afterValue = metadataField(after, field);
    if (canonicalJson(beforeValue) !== canonicalJson(afterValue)) {
      return `structural library metadata (${field})`;
    }
  }
  return null;
}

type ProtectedLibraryMetadata =
  | { valid: true; meta: Record<string, unknown> }
  | { valid: false };

/**
 * Resolve the complete YAML document before comparing protected metadata.
 * The ordinary indexer intentionally supports legacy JSON-shaped fragments,
 * but a protected-branch authorization decision must never interpret valid
 * block maps, anchors, aliases, or merge keys as an empty `library` object.
 */
function protectedLibraryMetadata(text: string): ProtectedLibraryMetadata {
  const opening = /^---\r?\n/.test(text);
  if (!opening) return { valid: true, meta: {} };
  const source = /^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m.exec(text)?.[1];
  if (source === undefined) return { valid: false };

  const document = parseDocument(sanitizeLegacyMacroQuotes(source), { merge: true });
  if (document.errors.length || (!isMap(document.contents) && document.contents !== null)) {
    return { valid: false };
  }
  if (document.contents === null) return { valid: true, meta: {} };
  if (hasAmbiguousResolvedYamlKeys(document)) return { valid: false };

  const libraryPairs = document.contents.items.filter((item) =>
    resolvedYamlScalarKey(document, item.key) === "library"
  );
  if (libraryPairs.length > 1) return { valid: false };

  let libraryNode: unknown = libraryPairs[0]?.value;
  if (isAlias(libraryNode)) {
    try {
      libraryNode = libraryNode.resolve(document);
    } catch {
      return { valid: false };
    }
  }
  if (libraryPairs.length && !isMap(libraryNode)) return { valid: false };

  let root: unknown;
  try {
    root = document.toJS({ maxAliasCount: 100 });
  } catch {
    return { valid: false };
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return { valid: false };
  }
  const rootRecord = root as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(rootRecord, "library")) {
    return { valid: true, meta: {} };
  }
  const library = rootRecord.library;
  if (!library || typeof library !== "object" || Array.isArray(library)) return { valid: false };
  if (hasUnsafeMetadataGraph(library)) return { valid: false };
  const meta = library as Record<string, unknown>;
  if (!protectedLibraryFieldsAreValid(meta)) return { valid: false };
  return { valid: true, meta };
}

function protectedLibraryFieldsAreValid(meta: Record<string, unknown>): boolean {
  const own = (field: string) => Object.prototype.hasOwnProperty.call(meta, field);
  for (const field of ["id", "kind", "status"] as const) {
    if (own(field) && (typeof meta[field] !== "string" || !meta[field].trim())) return false;
  }
  for (const field of ["projects", "contains"] as const) {
    const value = meta[field];
    if (own(field) && (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim()))) {
      return false;
    }
  }
  if (
    own("visibility")
    && meta.visibility !== "reader"
    && meta.visibility !== "support"
  ) return false;
  if (own("related")) {
    const related = meta.related;
    if (!Array.isArray(related) || !related.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const relation = item as Record<string, unknown>;
      return typeof relation.id === "string" && !!relation.id.trim()
        && typeof relation.rel === "string" && !!relation.rel.trim();
    })) return false;
  }
  if (own("task_authority")) {
    const authority = meta.task_authority;
    if (!authority || typeof authority !== "object" || Array.isArray(authority)) return false;
    const record = authority as Record<string, unknown>;
    if (
      record.mode !== "external"
      || typeof record.system !== "string"
      || !record.system.trim()
      || typeof record.url !== "string"
      || !record.url.trim()
    ) return false;
    try {
      const url = new URL(record.url);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// Match the editor's bounded compatibility rule for historical TeX macros
// such as `RR: "\mathbb{R}"`, which are invalid YAML only because the
// backslash was not escaped. No other malformed frontmatter is normalized.
function sanitizeLegacyMacroQuotes(source: string): string {
  let inMacros = false;
  return source.split("\n").map((line) => {
    if (/^macros:\s*$/.test(line)) {
      inMacros = true;
      return line;
    }
    if (/^[A-Za-z][\w-]*:/.test(line)) inMacros = false;
    if (!inMacros) return line;
    const match = /^(\s+[\w-]+:\s*)"(.*)"\s*$/.exec(line);
    if (!match || !match[2].includes("\\")) return line;
    return `${match[1]}'${match[2].replace(/'/g, "''")}'`;
  }).join("\n");
}

function hasUnsafeMetadataGraph(root: object): boolean {
  const active = new WeakSet<object>();
  const complete = new WeakSet<object>();
  const stack: Array<{ value: unknown; exiting: boolean; depth: number }> = [
    { value: root, exiting: false, depth: 0 },
  ];
  let objects = 0;
  while (stack.length) {
    const { value, exiting, depth } = stack.pop()!;
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return true;
      continue;
    }
    if (typeof value !== "object") return true;
    if (exiting) {
      active.delete(value);
      complete.add(value);
      continue;
    }
    if (active.has(value)) return true;
    if (complete.has(value)) continue;
    if (++objects > 10_000 || depth > 100) return true;
    if (!Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return true;
    }
    active.add(value);
    stack.push({ value, exiting: true, depth });
    for (const child of Object.values(value)) {
      stack.push({ value: child, exiting: false, depth: depth + 1 });
    }
  }
  return false;
}

function resolvedYamlScalarKey(document: ReturnType<typeof parseDocument>, key: unknown): unknown {
  if (isScalar(key)) return key.value;
  if (!isAlias(key)) return undefined;
  try {
    const resolved = key.resolve(document);
    return isScalar(resolved) ? resolved.value : undefined;
  } catch {
    return undefined;
  }
}

function resolvedYamlKeysAreUnique(
  document: ReturnType<typeof parseDocument>,
  map: Parameters<typeof isMap>[0] & { items: Array<{ key: unknown }> },
): boolean {
  const seen = new Set<string>();
  for (const item of map.items) {
    const key = resolvedYamlScalarKey(document, item.key);
    if (key === undefined) continue;
    const propertyKey = String(key);
    if (seen.has(propertyKey)) return false;
    seen.add(propertyKey);
  }
  return true;
}

function hasAmbiguousResolvedYamlKeys(document: ReturnType<typeof parseDocument>): boolean {
  let ambiguous = false;
  visit(document, (_key, node) => {
    if (isMap(node) && !resolvedYamlKeysAreUnique(document, node)) ambiguous = true;
  });
  return ambiguous;
}

function metadataList(meta: Record<string, unknown>, field: string): unknown[] {
  const value = meta[field];
  return Array.isArray(value) ? value : [];
}

function metadataField(meta: Record<string, unknown>, field: typeof PROTECTED_LIBRARY_FIELDS[number]): unknown {
  return Object.prototype.hasOwnProperty.call(meta, field) ? meta[field] : null;
}

function canonicalJson(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(canonical(value));
}

function protectedLibraryWriteError(change: string): GitHubError {
  return new GitHubError(
    403,
    `Direct saves of ${change} are blocked on protected branch. Set LIBRARY_BRANCH to a topic branch and open a pull request.`,
  );
}

function jsonField(frontmatter: string, field: string): unknown {
  const match = new RegExp(`^${field}:\\s*`, "m").exec(frontmatter);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const opener = frontmatter[start];
  if (opener !== "{" && opener !== "[") return undefined;
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < frontmatter.length; index++) {
    const character = frontmatter[index];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === opener) depth++;
    else if (character === closer && --depth === 0) {
      try {
        return JSON.parse(frontmatter.slice(start, index + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!values.length) return [];
  const results = new Array<R>(values.length);
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (next < values.length && failure === undefined) {
      const index = next++;
      try {
        results[index] = await map(values[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  if (failure !== undefined) throw failure;
  return results;
}
