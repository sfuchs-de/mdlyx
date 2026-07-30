import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { desktopAppOriginsFromEnv, pendingDeviceStoreModeFromEnv } from "./config.js";
import type { PendingDeviceStore } from "./pending-device-store.js";
import { RequestRateLimiter, requestClientAddress } from "./rate-limit.js";
import { serviceSoftwareInfo } from "./software.js";

// Keep the browser-readable health signal available while the service waits for
// its GitHub App Secret File. The hosted SPA uses it to show setup guidance
// instead of a broken OAuth button.
export function createUnconfiguredApp(env = process.env, pendingDevices?: PendingDeviceStore) {
  const software = serviceSoftwareInfo(env);
  const rateLimiter = new RequestRateLimiter();
  const pendingDeviceStoreMode = pendingDevices?.mode ?? pendingDeviceStoreModeFromEnv(env);
  const pendingDeviceStoreReady = () => pendingDevices?.checkReady?.()
    ?? Promise.resolve(pendingDevices?.isReady?.() ?? false);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = /^[A-Za-z0-9._-]{1,80}$/.test(String(req.headers["x-request-id"] ?? ""))
      ? String(req.headers["x-request-id"])
      : randomUUID();
    res.setHeader("x-request-id", requestId);
    const origin = req.headers.origin;
    const allowedOrigins = new Set([env.APP_ORIGIN, ...desktopAppOriginsFromEnv(env)]);
    if (origin && !allowedOrigins.has(origin)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Origin is not allowed" }));
      return;
    }
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("access-control-allow-headers", "authorization, content-type, if-match, if-none-match");
      res.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
      res.setHeader("vary", "Origin");
    }
    if (!rateLimiter.allow(requestClientAddress(req))) {
      res.writeHead(429, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "60",
      });
      res.end(JSON.stringify({ error: "Too many requests; retry shortly", requestId }));
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Malformed request URL", requestId }));
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      const storeReady = await pendingDeviceStoreReady();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        configured: false,
        releaseConfigured: false,
        pendingDeviceStoreMode,
        pendingDeviceStoreReady: storeReady,
        ...software,
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/ready") {
      const storeReady = await pendingDeviceStoreReady();
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ready: false,
        releaseConfigured: false,
        pendingDeviceStoreMode,
        pendingDeviceStoreReady: storeReady,
        ...software,
      }));
      return;
    }
    res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "GitHub library service is not configured" }));
  };
}
