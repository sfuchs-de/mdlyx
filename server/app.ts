import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { isConfigured, type Config } from "./config.js";
import {
  AccessPolicyProvider,
  AccessPolicyError,
  canReadProjects,
  canWriteProjects,
  coauthorScope,
  normalizeAccessPrincipal,
  ownerScope,
  parseAccessPolicy,
  projectForAsset,
  projectsForMeta,
  roleAtLeast,
  serializeAccessPolicy,
  type AccessPrincipal,
  type AuthorizedLibraryScope,
} from "./access-policy.js";
import {
  GitHubError,
  GitHubLibraryApi,
  normaliseAssetPath,
  normaliseLibraryPath,
  protectedDocumentWriteReason,
  type UpdaterAssetDownload,
} from "./github.js";
import { authorizeCommenterSave, CommentAuthorizationError, stampEditorSave } from "./comment-authorization.js";
import { serviceSoftwareInfo, type ServiceSoftwareInfo } from "./software.js";
import {
  MemoryPendingDeviceStore,
  type PendingDeviceStore,
} from "./pending-device-store.js";
import { RequestRateLimiter, requestClientAddress } from "./rate-limit.js";
import { MemoryInviteStore, type InviteStore } from "./invite-store.js";

const SESSION_COOKIE = "mathdown_library_session";
const STATE_COOKIE = "mathdown_library_oauth";
const DEVICE_COOKIE = "mathdown_library_device";
const UPDATER_CLIENT_IDLE_MS = 30_000;
const UPDATER_CLIENT_TOTAL_MS = 10 * 60_000;
const COAUTHOR_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const COAUTHOR_SESSION_MAX_AGE_MS = COAUTHOR_SESSION_MAX_AGE_SECONDS * 1000;

interface LegacySession {
  login: string;
  exp: number;
}

interface OwnerSession {
  version: 2;
  kind: "owner";
  principalId: string;
  login: string;
  exp: number;
}

interface CoauthorSession {
  version: 2;
  kind: "coauthor";
  principalId: string;
  authVersion: number;
  exp: number;
}

type Session = LegacySession | OwnerSession | CoauthorSession;

interface DeviceSession {
  deviceCode: string;
  exp: number;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function signed(value: object, secret: string): string {
  const body = encode(value);
  return `${body}.${sign(body, secret)}`;
}

function verified<T>(value: string | undefined, secret: string): T | null {
  if (!value) return null;
  const [body, signature] = value.split(".");
  if (!body || !signature) return null;
  const expected = sign(body, secret);
  const sameLength = expected.length === signature.length;
  if (!sameLength || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split(/=(.*)/, 2))
      .filter(([key]) => Boolean(key)),
  );
}

function cookie(
  name: string,
  value: string,
  maxAge: number,
  sameSite: "Lax" | "None" = "Lax",
): string {
  // The canonical browser app is served by this API origin, so Lax HTTP-only
  // cookies remain first-party and survive the top-level GitHub OAuth return.
  // Desktop authentication remains cookie-free and uses its signed bearer.
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

function ownerSessionCookies(login: string, config: Config): string[] {
  return [
    cookie(SESSION_COOKIE, desktopSession(login, config), 7 * 24 * 60 * 60),
    cookie(STATE_COOKIE, "", 0),
    cookie(DEVICE_COOKIE, "", 0),
  ];
}

function desktopSession(login: string, config: Config): string {
  return signed({
    version: 2,
    kind: "owner",
    principalId: login,
    login,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  }, config.sessionSecret);
}

function coauthorSession(principalId: string, authVersion: number, config: Config): string {
  return signed({
    version: 2,
    kind: "coauthor",
    principalId,
    authVersion,
    exp: Date.now() + COAUTHOR_SESSION_MAX_AGE_MS,
  }, config.sessionSecret);
}

async function jsonBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length;
    if (length > maxBytes) throw new GitHubError(413, "Request exceeds the endpoint size limit");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GitHubError(400, "Expected JSON request body");
  }
}

function sharingGrants(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubError(400, "At least one project permission is required");
  }
  return { ...(value as Record<string, unknown>) };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: object,
  headers: Record<string, string | string[]> = {},
): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(302, { location, ...headers });
  res.end();
}

function setCors(req: IncomingMessage, res: ServerResponse, config: Config): boolean {
  const origin = req.headers.origin;
  const allowedOrigins = new Set([config.appOrigin, ...config.desktopAppOrigins]);
  if (origin && !allowedOrigins.has(origin)) {
    sendJson(res, 403, { error: "Origin is not allowed" });
    return false;
  }
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-headers", "authorization, content-type, if-match, if-none-match");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
    res.setHeader("vary", "Origin");
  }
  return true;
}

function requestSession(req: IncomingMessage, config: Config, updater = false): Session | null {
  const authorization = req.headers.authorization;
  const origin = req.headers.origin;
  const isDesktop = updater ? !origin || Boolean(desktopOrigin(req, config)) : Boolean(desktopOrigin(req, config));
  const bearer = isDesktop && authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : undefined;
  // A configured desktop origin is bearer-only. Falling back to a browser
  // cookie here would undo the origin-bound Keychain transport and allow a
  // cookie copied into the WebView to impersonate a desktop session.
  const credential = isDesktop ? bearer : cookies(req)[SESSION_COOKIE];
  const session = verified<Session>(credential, config.sessionSecret);
  if (!session || typeof session.exp !== "number" || session.exp <= Date.now()) return null;
  return session;
}

function ownerLogin(session: Session | null, config: Config): string | null {
  if (!session) return null;
  if (!("version" in session)) return session.login === config.allowedLogin ? session.login : null;
  return session.kind === "owner" && session.login === config.allowedLogin ? session.login : null;
}

function desktopOrigin(req: IncomingMessage, config: Config): string | null {
  const origin = req.headers.origin;
  return origin && config.desktopAppOrigins.includes(origin) ? origin : null;
}

async function sendUpdaterAsset(res: ServerResponse, asset: UpdaterAssetDownload): Promise<void> {
  const headers: Record<string, string | number> = {
    "cache-control": "private, no-store",
    "content-type": asset.contentType,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
    "x-content-type-options": "nosniff",
  };
  if (asset.contentLength !== undefined) headers["content-length"] = asset.contentLength;
  res.writeHead(200, headers);
  const reader = asset.body.getReader();
  let completed = false;
  const stop = (message: string) => {
    if (completed) return;
    const error = new Error(message);
    void reader.cancel(error);
    res.destroy(error);
  };
  const onClose = () => {
    if (!completed) void reader.cancel(new Error("Updater client disconnected"));
  };
  const totalTimeout = setTimeout(
    () => stop("Updater response exceeded its total deadline"),
    UPDATER_CLIENT_TOTAL_MS,
  );
  res.setTimeout(UPDATER_CLIENT_IDLE_MS, () => stop("Updater client became idle"));
  res.once("close", onClose);
  try {
    while (!res.destroyed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            res.off("drain", finish);
            res.off("close", finish);
            resolve();
          };
          res.once("drain", finish);
          res.once("close", finish);
        });
      }
    }
    if (res.destroyed) await reader.cancel();
    else {
      completed = true;
      res.end();
    }
  } finally {
    clearTimeout(totalTimeout);
    res.setTimeout(0);
    res.off("close", onClose);
    reader.releaseLock();
  }
}

export function createApp(
  config: Config,
  github = new GitHubLibraryApi(config),
  software: ServiceSoftwareInfo = serviceSoftwareInfo(),
  pendingDevices: PendingDeviceStore = new MemoryPendingDeviceStore(),
  invites: InviteStore = new MemoryInviteStore(),
  accessPolicies = new AccessPolicyProvider(github),
) {
  const releaseConfigured = Boolean(
    config.releaseGithubAppId
    && config.releaseGithubInstallationId
    && config.releaseGithubPrivateKey,
  );
  // Desktop WebViews commonly block third-party cookies. Keep the sensitive
  // GitHub device code on the API and give the desktop app only a random,
  // short-lived handle used while it polls. Production injects a durable
  // Render Key Value store so an API restart does not interrupt approval.
  const rateLimiter = new RequestRateLimiter();
  const inviteRedeemLimiter = new RequestRateLimiter(20, 60_000, 4_096);
  const inviteCreateLimiter = new RequestRateLimiter(20, 60 * 60_000, 128);
  const sharingMutationLimiter = new RequestRateLimiter(60, 60 * 60_000, 128);
  const pendingDeviceStoreMode = pendingDevices.mode ?? "memory";
  const pendingDeviceStoreReady = () => pendingDevices.isReady?.() ?? true;
  const inviteStoreReady = () => invites.isReady?.() ?? true;
  const checkPendingDeviceStoreReady = () => pendingDevices.checkReady?.()
    ?? Promise.resolve(pendingDeviceStoreReady());

  const resolveScope = async (req: IncomingMessage): Promise<{
    scope: AuthorizedLibraryScope;
    session: Session;
  } | null> => {
    const session = requestSession(req, config);
    const login = ownerLogin(session, config);
    if (login && session) return { scope: ownerScope(login), session };
    if (!session || !("version" in session) || session.kind !== "coauthor") return null;
    const snapshot = await accessPolicies.snapshot();
    const scope = coauthorScope(snapshot, session.principalId, session.authVersion);
    return scope ? { scope, session } : null;
  };

  const publicSession = (scope: AuthorizedLibraryScope, session: Session) => ({
    authenticated: true,
    login: scope.kind === "owner" ? scope.principalId : undefined,
    principal: {
      id: scope.principalId,
      displayName: scope.displayName,
      kind: scope.kind,
    },
    expiresAt: session.exp,
    grants: Object.entries(scope.grants)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([project, role]) => ({ project, role })),
    capabilities: {
      canShare: scope.canShare,
      canUseUpdater: scope.canUseUpdater,
    },
  });

  const updateSharingPolicy = async (
    expectedPolicySha: string,
    mutate: (
      principals: Map<string, AccessPrincipal>,
      snapshot: ReturnType<typeof parseAccessPolicy>,
    ) => void,
  ) => {
    const configuration = await github.accessConfiguration();
    const snapshot = parseAccessPolicy(configuration);
    if (!expectedPolicySha || expectedPolicySha !== snapshot.policySha) {
      throw new GitHubError(409, "Sharing access changed remotely. Refresh before saving.");
    }
    const principals = new Map(
      [...snapshot.principals].map(([id, principal]) => [
        id,
        { ...principal, grants: { ...principal.grants } },
      ]),
    );
    try {
      mutate(principals, snapshot);
      const text = serializeAccessPolicy(configuration.policy, principals.values());
      parseAccessPolicy({ ...configuration, policy: text });
      return await github.writeAccessPolicy(text, expectedPolicySha);
    } catch (error) {
      if (error instanceof AccessPolicyError) throw new GitHubError(400, error.message);
      throw error;
    }
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = /^[A-Za-z0-9._-]{1,80}$/.test(String(req.headers["x-request-id"] ?? ""))
      ? String(req.headers["x-request-id"])
      : randomUUID();
    res.setHeader("x-request-id", requestId);
    if (!setCors(req, res, config)) return;
    if (!rateLimiter.allow(requestClientAddress(req))) {
      sendJson(res, 429, { error: "Too many requests; retry shortly", requestId }, { "retry-after": "60" });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      sendJson(res, 400, { error: "Malformed request URL", requestId });
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        configured: isConfigured(),
        releaseConfigured,
        pendingDeviceStoreMode,
        pendingDeviceStoreReady: pendingDeviceStoreReady(),
        inviteStoreMode: invites.mode ?? "memory",
        inviteStoreReady: inviteStoreReady(),
        ...software,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/ready") {
      const configured = isConfigured();
      const deviceReady = await checkPendingDeviceStoreReady();
      const inviteReady = await (invites.checkReady?.() ?? Promise.resolve(invites.isReady?.() ?? true));
      const storeReady = deviceReady && inviteReady;
      const ready = configured && storeReady;
      sendJson(res, ready ? 200 : 503, {
        ready,
        releaseConfigured,
        pendingDeviceStoreMode,
        pendingDeviceStoreReady: deviceReady,
        inviteStoreMode: invites.mode ?? "memory",
        inviteStoreReady: inviteReady,
        ...software,
      });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      if (req.method === "GET" && url.pathname === "/auth/session") {
        const resolved = await resolveScope(req);
        if (!resolved) {
          sendJson(res, 200, { authenticated: false });
          return;
        }
        if (resolved.scope.kind === "coauthor") {
          // Project membership is permanent until the owner changes or removes
          // it. Rotate the signed browser credential whenever the hosted app
          // revalidates the current policy, giving active collaborators a
          // rolling session without creating an unrevocable bearer token.
          const credential = coauthorSession(
            resolved.scope.principalId,
            resolved.scope.authVersion,
            config,
          );
          const session = verified<CoauthorSession>(credential, config.sessionSecret) as CoauthorSession;
          sendJson(res, 200, publicSession(resolved.scope, session), {
            "set-cookie": cookie(SESSION_COOKIE, credential, COAUTHOR_SESSION_MAX_AGE_SECONDS),
          });
          return;
        }
        sendJson(res, 200, publicSession(resolved.scope, resolved.session));
        return;
      }
      if (req.method === "POST" && url.pathname === "/auth/invite/redeem") {
        if (req.headers.origin !== config.appOrigin) {
          sendJson(res, 400, { error: "Shared invitations must be accepted in the hosted application" });
          return;
        }
        const client = requestClientAddress(req);
        if (!inviteRedeemLimiter.allow(client)) {
          sendJson(res, 429, { error: "Too many invitation attempts; retry shortly" }, { "retry-after": "60" });
          return;
        }
        const body = await jsonBody(req, 4_096);
        const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
        const token = typeof payload.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(payload.token)
          ? payload.token
          : null;
        if (!token) {
          sendJson(res, 400, { error: "Invalid or expired invitation" });
          return;
        }
        const digest = createHmac("sha256", config.inviteTokenSecret)
          .update(`mathdown-invite-v1:${token}`)
          .digest("hex");
        const invite = await invites.consume(digest);
        if (!invite || invite.origin !== config.appOrigin) {
          sendJson(res, 410, { error: "This invitation is invalid, expired, or already used" });
          return;
        }
        const policy = await accessPolicies.snapshot();
        const principal = policy.principals.get(invite.principalId);
        if (!principal || principal.authVersion !== invite.authVersion) {
          sendJson(res, 410, { error: "This invitation is no longer authorized" });
          return;
        }
        const credential = coauthorSession(principal.id, principal.authVersion, config);
        const session = verified<CoauthorSession>(credential, config.sessionSecret) as CoauthorSession;
        const scope = coauthorScope(policy, principal.id, principal.authVersion);
        if (!scope) throw new GitHubError(503, "Shared access is temporarily unavailable");
        sendJson(res, 200, publicSession(scope, session), {
          "set-cookie": [
            cookie(SESSION_COOKIE, credential, COAUTHOR_SESSION_MAX_AGE_SECONDS),
            cookie(STATE_COOKIE, "", 0),
            cookie(DEVICE_COOKIE, "", 0),
          ],
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/sharing/access") {
        const login = ownerLogin(requestSession(req, config), config);
        if (!login) {
          sendJson(res, 403, { error: "Only the library owner can manage sharing" });
          return;
        }
        const policy = await accessPolicies.snapshot();
        const outstanding = await invites.list();
        sendJson(res, 200, {
          principals: [...policy.principals.values()]
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
            .map((principal) => ({
              id: principal.id,
              displayName: principal.displayName,
              authVersion: principal.authVersion,
              grants: principal.grants,
            })),
          invitations: outstanding.map((invite) => ({
            id: invite.id,
            principalId: invite.principalId,
            createdAt: invite.createdAt,
            expiresAt: invite.expiresAt,
          })),
          policyRevision: policy.revision,
          policySha: policy.policySha,
          projects: policy.projects,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/sharing/principals") {
        const login = ownerLogin(requestSession(req, config), config);
        if (!login) {
          sendJson(res, 403, { error: "Only the library owner can manage sharing" });
          return;
        }
        if (!sharingMutationLimiter.allow(login)) {
          sendJson(res, 429, { error: "Too many sharing changes; retry later" }, { "retry-after": "3600" });
          return;
        }
        const body = await jsonBody(req, 32_768);
        const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
        const id = typeof payload.id === "string" ? payload.id.trim() : "";
        const displayName = typeof payload.displayName === "string" ? payload.displayName : "";
        const grants = sharingGrants(payload.grants);
        const expectedPolicySha = typeof payload.expectedPolicySha === "string" ? payload.expectedPolicySha : "";
        const saved = await updateSharingPolicy(expectedPolicySha, (principals, snapshot) => {
          if (principals.has(id)) throw new AccessPolicyError(`A coauthor with ID ${id} already exists`);
          principals.set(id, normalizeAccessPrincipal(id, displayName, 1, grants, snapshot.projectRoots));
        });
        sendJson(res, 201, { policySha: saved.sha });
        return;
      }

      const updatePrincipal = /^\/v1\/sharing\/principals\/([a-z][a-z0-9-]{1,62})$/.exec(url.pathname);
      if (req.method === "PUT" && updatePrincipal) {
        const login = ownerLogin(requestSession(req, config), config);
        if (!login) {
          sendJson(res, 403, { error: "Only the library owner can manage sharing" });
          return;
        }
        if (!sharingMutationLimiter.allow(login)) {
          sendJson(res, 429, { error: "Too many sharing changes; retry later" }, { "retry-after": "3600" });
          return;
        }
        const body = await jsonBody(req, 32_768);
        const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
        const displayName = typeof payload.displayName === "string" ? payload.displayName : "";
        const grants = sharingGrants(payload.grants);
        const expectedPolicySha = typeof payload.expectedPolicySha === "string" ? payload.expectedPolicySha : "";
        const saved = await updateSharingPolicy(expectedPolicySha, (principals, snapshot) => {
          const existing = principals.get(updatePrincipal[1]);
          if (!existing) throw new AccessPolicyError("Coauthor was not found");
          principals.set(existing.id, normalizeAccessPrincipal(
            existing.id,
            displayName,
            existing.authVersion,
            grants,
            snapshot.projectRoots,
          ));
        });
        sendJson(res, 200, { policySha: saved.sha });
        return;
      }

      const revokePrincipalSessions = /^\/v1\/sharing\/principals\/([a-z][a-z0-9-]{1,62})\/revoke-sessions$/.exec(url.pathname);
      if (req.method === "POST" && revokePrincipalSessions) {
        const login = ownerLogin(requestSession(req, config), config);
        if (!login) {
          sendJson(res, 403, { error: "Only the library owner can manage sharing" });
          return;
        }
        if (!sharingMutationLimiter.allow(login)) {
          sendJson(res, 429, { error: "Too many sharing changes; retry later" }, { "retry-after": "3600" });
          return;
        }
        const body = await jsonBody(req, 4_096);
        const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
        const expectedPolicySha = typeof payload.expectedPolicySha === "string" ? payload.expectedPolicySha : "";
        const principalId = revokePrincipalSessions[1];
        const saved = await updateSharingPolicy(expectedPolicySha, (principals, snapshot) => {
          const existing = principals.get(principalId);
          if (!existing) throw new AccessPolicyError("Coauthor was not found");
          principals.set(existing.id, normalizeAccessPrincipal(
            existing.id,
            existing.displayName,
            existing.authVersion + 1,
            existing.grants,
            snapshot.projectRoots,
          ));
        });
        await invites.revokePrincipal(principalId);
        sendJson(res, 200, { policySha: saved.sha });
        return;
      }

      const removePrincipal = /^\/v1\/sharing\/principals\/([a-z][a-z0-9-]{1,62})\/remove$/.exec(url.pathname);
      if (req.method === "POST" && removePrincipal) {
        const login = ownerLogin(requestSession(req, config), config);
        if (!login) {
          sendJson(res, 403, { error: "Only the library owner can manage sharing" });
          return;
        }
        if (!sharingMutationLimiter.allow(login)) {
          sendJson(res, 429, { error: "Too many sharing changes; retry later" }, { "retry-after": "3600" });
          return;
        }
        const body = await jsonBody(req, 4_096);
        const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
        const expectedPolicySha = typeof payload.expectedPolicySha === "string" ? payload.expectedPolicySha : "";
        const principalId = removePrincipal[1];
        const saved = await updateSharingPolicy(expectedPolicySha, (principals) => {
          if (!principals.delete(principalId)) throw new AccessPolicyError("Coauthor was not found");
        });
        await invites.revokePrincipal(principalId);
        sendJson(res, 200, { policySha: saved.sha });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/sharing/invites") {
        const login = ownerLogin(requestSession(req, config), config);
        if (!login) {
          sendJson(res, 403, { error: "Only the library owner can manage sharing" });
          return;
        }
        if (!inviteCreateLimiter.allow(login)) {
          sendJson(res, 429, { error: "Too many invitations created; retry later" }, { "retry-after": "3600" });
          return;
        }
        const body = await jsonBody(req, 4_096);
        const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
        const principalId = typeof payload.principalId === "string" ? payload.principalId : "";
        const requested = typeof payload.expiresInSeconds === "number" ? payload.expiresInSeconds : 7 * 24 * 60 * 60;
        if (!Number.isSafeInteger(requested) || requested < 3_600 || requested > 7 * 24 * 60 * 60) {
          sendJson(res, 400, { error: "Invitation expiry must be between one hour and seven days" });
          return;
        }
        const policy = await accessPolicies.snapshot();
        const principal = policy.principals.get(principalId);
        if (!principal) {
          sendJson(res, 404, { error: "Approved coauthor was not found" });
          return;
        }
        const token = randomBytes(32).toString("base64url");
        const tokenDigest = createHmac("sha256", config.inviteTokenSecret)
          .update(`mathdown-invite-v1:${token}`)
          .digest("hex");
        const now = Date.now();
        const invite = {
          id: randomUUID(),
          tokenDigest,
          principalId: principal.id,
          authVersion: principal.authVersion,
          origin: config.appOrigin,
          createdAt: now,
          expiresAt: now + requested * 1000,
        };
        await invites.put(invite);
        sendJson(res, 201, {
          invitation: {
            id: invite.id,
            principalId: invite.principalId,
            createdAt: invite.createdAt,
            expiresAt: invite.expiresAt,
            url: `${config.appOrigin.replace(/\/$/, "")}/invite#token=${token}`,
          },
        });
        return;
      }

      const revokeInvite = /^\/v1\/sharing\/invites\/([0-9a-f-]{20,80})\/revoke$/.exec(url.pathname);
      if (req.method === "POST" && revokeInvite) {
        const login = ownerLogin(requestSession(req, config), config);
        if (!login) {
          sendJson(res, 403, { error: "Only the library owner can manage sharing" });
          return;
        }
        const revoked = await invites.revoke(revokeInvite[1]);
        if (!revoked) {
          sendJson(res, 404, { error: "Invitation was not found" });
          return;
        }
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/auth/github") {
        const state = randomBytes(32).toString("base64url");
        // GitHub returns an authorization code as a query parameter. Some
        // privacy extensions block that pattern on an API hostname, so return
        // to the same-origin SPA route and exchange it through a credentialed
        // POST. The HTTP-only state cookie still protects the exchange from a
        // forged callback.
        const redirectUri = `${config.appOrigin.replace(/\/$/, "")}/github-link`;
        const destination = new URL("https://github.com/login/oauth/authorize");
        destination.searchParams.set("client_id", config.githubClientId);
        destination.searchParams.set("redirect_uri", redirectUri);
        destination.searchParams.set("state", state);
        redirect(res, destination.toString(), { "set-cookie": cookie(STATE_COOKIE, signed({ state, exp: Date.now() + 600_000 }, config.sessionSecret), 600) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/auth/device/start") {
        const device = await github.startDeviceAuthorization();
        const { deviceCode, ...publicDevice } = device;
        const origin = desktopOrigin(req, config);
        if (origin) {
          const pendingId = randomBytes(32).toString("base64url");
          await pendingDevices.set(pendingId, {
            deviceCode,
            origin,
            expiresAt: Date.now() + device.expiresIn * 1000,
          });
          sendJson(res, 200, { ...publicDevice, pendingId });
          return;
        }
        sendJson(res, 200, publicDevice, {
          "set-cookie": cookie(
            DEVICE_COOKIE,
            signed({ deviceCode, exp: Date.now() + device.expiresIn * 1000 }, config.sessionSecret),
            device.expiresIn,
          ),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/auth/device/cancel") {
        const origin = desktopOrigin(req, config);
        if (!origin) {
          sendJson(res, 400, { error: "Desktop device authorization is required" });
          return;
        }
        const body = await jsonBody(req);
        const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
        const pendingId = typeof payload.pendingId === "string" ? payload.pendingId : null;
        const pending = pendingId ? await pendingDevices.get(pendingId) : null;
        // The random pending ID acts as a short-lived capability. Still bind it
        // to the initiating desktop origin before deleting, and return the same
        // response for missing/mismatched IDs so the endpoint leaks no state.
        if (pendingId && pending?.origin === origin) await pendingDevices.delete(pendingId);
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/auth/device/poll") {
        const origin = desktopOrigin(req, config);
        let pendingId: string | null = null;
        let device: DeviceSession | null;
        if (origin) {
          const body = await jsonBody(req);
          const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
          pendingId = typeof payload.pendingId === "string" ? payload.pendingId : null;
          const pending = pendingId ? await pendingDevices.get(pendingId) : null;
          device = pending && pending.origin === origin
            ? { deviceCode: pending.deviceCode, exp: pending.expiresAt }
            : null;
          if (!device) {
            sendJson(res, 200, { state: "interrupted" });
            return;
          }
        } else {
          device = verified<DeviceSession>(cookies(req)[DEVICE_COOKIE], config.sessionSecret);
        }
        if (!device || !device.deviceCode || device.exp <= Date.now()) {
          if (pendingId) await pendingDevices.delete(pendingId);
          sendJson(res, 200, { state: "expired" }, origin ? {} : { "set-cookie": cookie(DEVICE_COOKIE, "", 0) });
          return;
        }
        const result = await github.pollDeviceAuthorization(device.deviceCode);
        if (result.state === "authorized") {
          if (result.login !== config.allowedLogin) {
            if (pendingId) await pendingDevices.delete(pendingId);
            sendJson(res, 200, { state: "denied" }, { "set-cookie": cookie(DEVICE_COOKIE, "", 0) });
            return;
          }
          if (origin) {
            if (pendingId) await pendingDevices.delete(pendingId);
            sendJson(res, 200, {
              state: "authorized",
              login: result.login,
              desktopSession: desktopSession(result.login, config),
            });
            return;
          }
          sendJson(res, 200, { state: "authorized", login: result.login }, {
            "set-cookie": ownerSessionCookies(result.login, config),
          });
          return;
        }
        if (pendingId && (result.state === "expired" || result.state === "denied")) {
          await pendingDevices.delete(pendingId);
        }
        sendJson(res, 200, result, result.state === "expired" || result.state === "denied"
          ? { "set-cookie": cookie(DEVICE_COOKIE, "", 0) }
          : {});
        return;
      }
      if (req.method === "POST" && url.pathname === "/auth/complete") {
        const body = await jsonBody(req);
        const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
        const state = typeof payload.state === "string" ? payload.state : null;
        const code = typeof payload.code === "string" ? payload.code : null;
        const pending = verified<{ state?: string; exp?: number }>(cookies(req)[STATE_COOKIE], config.sessionSecret);
        if (!state || !code || !pending || pending.state !== state || !pending.exp || pending.exp < Date.now()) {
          sendJson(res, 400, { error: "Invalid or expired GitHub login state" });
          return;
        }
        const user = await github.oauthUser(code);
        if (user.login !== config.allowedLogin) {
          sendJson(res, 403, { error: "This GitHub account is not allowed" });
          return;
        }
        sendJson(res, 200, { authenticated: true, login: user.login }, {
          "set-cookie": ownerSessionCookies(user.login, config),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/auth/github/callback") {
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const pending = verified<{ state?: string; exp?: number }>(cookies(req)[STATE_COOKIE], config.sessionSecret);
        if (!state || !code || !pending || pending.state !== state || !pending.exp || pending.exp < Date.now()) {
          sendJson(res, 400, { error: "Invalid or expired GitHub login state" });
          return;
        }
        const user = await github.oauthUser(code);
        if (user.login !== config.allowedLogin) {
          sendJson(res, 403, { error: "This GitHub account is not allowed" });
          return;
        }
        redirect(res, config.appOrigin, {
          "set-cookie": ownerSessionCookies(user.login, config),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/auth/logout") {
        res.setHeader("set-cookie", cookie(SESSION_COOKIE, "", 0));
        sendJson(res, 200, { authenticated: false });
        return;
      }

      const updaterAsset = /^\/v1\/software\/update\/assets\/(\d+)\/(\d+)\/([^/]+)$/.exec(url.pathname);
      const updaterCheck = /^\/v1\/software\/update\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (updaterAsset || updaterCheck) {
        if (!ownerLogin(requestSession(req, config, true), config)) {
          sendJson(res, 401, { error: "Connect GitHub to check private MdLyx releases" });
          return;
        }
        if (req.method === "GET" && updaterAsset) {
          let assetName: string;
          try {
            assetName = decodeURIComponent(updaterAsset[3]);
          } catch {
            throw new GitHubError(400, "Invalid updater asset");
          }
          const controller = new AbortController();
          const abort = () => controller.abort();
          res.once("close", abort);
          try {
            const asset = await github.downloadUpdaterAsset(
              Number(updaterAsset[1]),
              Number(updaterAsset[2]),
              assetName,
              controller.signal,
            );
            await sendUpdaterAsset(res, asset);
          } finally {
            res.off("close", abort);
          }
          return;
        }
        if (req.method === "GET" && updaterCheck) {
          let currentVersion: string;
          try {
            currentVersion = decodeURIComponent(updaterCheck[3]);
          } catch {
            throw new GitHubError(400, "Invalid current application version");
          }
          const release = await github.latestUpdaterRelease(updaterCheck[1], updaterCheck[2], currentVersion);
          if (!release) {
            res.writeHead(204, { "cache-control": "private, no-store" });
            res.end();
            return;
          }
          const assetPath = `/v1/software/update/assets/${release.releaseId}/${release.assetId}/${encodeURIComponent(release.assetName)}`;
          sendJson(res, 200, {
            version: release.version,
            notes: release.notes,
            pub_date: release.pubDate,
            url: new URL(assetPath, `${config.apiOrigin.replace(/\/$/, "")}/`).toString(),
            signature: release.signature,
          });
          return;
        }
      }

      const resolved = await resolveScope(req);
      if (!resolved) {
        sendJson(res, 401, { error: "Sign in or accept an invitation to access this library" });
        return;
      }
      const { scope } = resolved;
      if (req.method === "GET" && url.pathname === "/v1/library") {
        const entries = await github.list();
        if (scope.kind === "owner") {
          sendJson(res, 200, { entries });
          return;
        }
        const index = await github.index();
        const visible = new Set(index.entries
          .filter((entry) => canReadProjects(scope, projectsForMeta(entry.meta)))
          .map((entry) => entry.path));
        sendJson(res, 200, { entries: entries.filter((entry) => visible.has(entry.path)) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v2/library/index") {
        const index = await github.index();
        const filtered = scope.kind === "owner"
          ? index
          : {
              ...index,
              entries: index.entries.filter((entry) => canReadProjects(scope, projectsForMeta(entry.meta))),
            };
        const etag = `"${index.revision}.${scope.digest.slice(0, 24)}"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { etag, "cache-control": "private, no-cache" });
          res.end();
          return;
        }
        sendJson(res, 200, filtered, { etag, "cache-control": "private, no-cache" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v2/library/assets") {
        const assets = await github.assets();
        const filtered = scope.kind === "owner"
          ? assets
          : { ...assets, entries: assets.entries.filter((entry) => projectForAsset(scope, entry.path)) };
        const etag = `"${assets.revision}.${scope.digest.slice(0, 24)}"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { etag, "cache-control": "private, no-cache" });
          res.end();
          return;
        }
        sendJson(res, 200, filtered, { etag, "cache-control": "private, no-cache" });
        return;
      }
      if (url.pathname === "/v2/library/assets/file") {
        const path = url.searchParams.get("path");
        if (!path || !normaliseAssetPath(path)) throw new GitHubError(400, "Invalid asset path");
        const assetProject = projectForAsset(scope, path);
        if (scope.kind !== "owner" && !assetProject) {
          sendJson(res, 404, { error: "Asset was not found" });
          return;
        }
        const existingAsset = scope.kind === "coauthor"
          ? (await github.assets()).entries.find((entry) => entry.path === path)
          : undefined;
        if (scope.kind === "coauthor" && !existingAsset) {
          sendJson(res, 404, { error: "Asset was not found" });
          return;
        }
        if (req.method === "GET") {
          sendJson(res, 200, await github.readAsset(path));
          return;
        }
        if (req.method === "PUT") {
          if (scope.kind !== "owner" && (!assetProject || !roleAtLeast(scope.grants[assetProject], "editor"))) {
            sendJson(res, 403, { error: "This shared access is read-only for assets" });
            return;
          }
          const body = await jsonBody(req, 35 * 1024 * 1024);
          const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
          if (typeof record.content !== "string") throw new GitHubError(400, "Base64 asset content is required");
          const ifMatch = req.headers["if-match"];
          const expectedSha = typeof ifMatch === "string" ? ifMatch.replace(/^"|"$/g, "") : undefined;
          if (scope.kind === "coauthor" && (!expectedSha || expectedSha !== existingAsset?.sha)) {
            sendJson(res, 409, { error: "The shared asset changed remotely; Pull before saving again" });
            return;
          }
          const saved = scope.kind === "coauthor"
            ? await github.writeAsset(path, record.content, expectedSha, {
                principalId: scope.principalId,
                displayName: scope.displayName,
              })
            : await github.writeAsset(path, record.content, expectedSha);
          sendJson(res, 200, saved);
          return;
        }
      }
      if (url.pathname === "/v1/library/documents") {
        const path = url.searchParams.get("path");
        if (!path || !normaliseLibraryPath(path)) throw new GitHubError(400, "Invalid library path");
        const index = await github.index();
        const entry = index.entries.find((candidate) => candidate.path === path);
        const projects = entry ? projectsForMeta(entry.meta) : [];
        // Coauthors can never use an unknown path as an existence oracle or a
        // file-creation endpoint. Owners retain the established topic-branch
        // creation flow, whose branch protection is enforced by GitHubLibrary.
        if ((!entry && (scope.kind !== "owner" || req.method !== "PUT"))
          || (entry && !canReadProjects(scope, projects))) {
          sendJson(res, 404, { error: "Document was not found" });
          return;
        }
        if (req.method === "GET") {
          sendJson(res, 200, await github.read(path));
          return;
        }
        if (req.method === "PUT") {
          const generated = Boolean(
            entry?.meta
            && typeof entry.meta === "object"
            && !Array.isArray(entry.meta)
            && (entry.meta as Record<string, unknown>).projection
            && typeof (entry.meta as Record<string, unknown>).projection === "object"
            && ((entry.meta as Record<string, unknown>).projection as Record<string, unknown>).read_only === true,
          );
          if (generated) {
            sendJson(res, 403, { error: "Generated project manifests are read-only" });
            return;
          }
          const body = await jsonBody(req);
          const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
          if (typeof record.text !== "string") throw new GitHubError(400, "Document text is required");
          const expectedSha = typeof record.expectedSha === "string" ? record.expectedSha : undefined;
          let nextText = record.text;
          if (scope.kind === "coauthor") {
            if (canWriteProjects(scope, projects, "editor")) {
              const remote = await github.read(path);
              if (!expectedSha || remote.sha !== expectedSha) {
                sendJson(res, 409, { code: "REMOTE_CONFLICT", remote });
                return;
              }
              const guardedChange = protectedDocumentWriteReason(path, remote.text, nextText);
              if (guardedChange) {
                sendJson(res, 403, { error: `Shared editors cannot change ${guardedChange}` });
                return;
              }
              nextText = stampEditorSave(remote.text, nextText, scope);
            } else if (canWriteProjects(scope, projects, "commenter")) {
              const remote = await github.read(path);
              if (!expectedSha || remote.sha !== expectedSha) {
                sendJson(res, 409, { code: "REMOTE_CONFLICT", remote });
                return;
              }
              try {
                nextText = authorizeCommenterSave(remote.text, nextText, scope);
              } catch (error) {
                if (error instanceof CommentAuthorizationError) {
                  sendJson(res, 403, { error: error.message });
                  return;
                }
                throw error;
              }
            } else {
              sendJson(res, 403, { error: "This shared access is read-only" });
              return;
            }
          }
          try {
            const saved = scope.kind === "coauthor"
              ? await github.write(path, nextText, expectedSha, {
                  principalId: scope.principalId,
                  displayName: scope.displayName,
                })
              : await github.write(path, nextText, expectedSha);
            sendJson(res, 200, saved);
          } catch (error) {
            if (error instanceof GitHubError && (error.status === 409 || error.status === 422)) {
              const remote = await github.read(path);
              sendJson(res, 409, { code: "REMOTE_CONFLICT", remote });
              return;
            }
            throw error;
          }
          return;
        }
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const status = error instanceof GitHubError
        ? error.status
        : error instanceof AccessPolicyError ? 503 : 500;
      const message = status >= 500
        ? "Unexpected server error"
        : error instanceof Error ? error.message : "Request failed";
      console.error(JSON.stringify({
        level: "error",
        requestId,
        method: req.method,
        path: url.pathname,
        status,
        error: error instanceof Error ? error.name : "UnknownError",
      }));
      sendJson(res, status, { error: message, requestId });
    }
  };
}
