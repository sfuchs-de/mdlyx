import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { serveStaticApp } from "./static.js";

export type ApiHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

export function isApiRequest(req: IncomingMessage): boolean {
  if (req.method === "OPTIONS") return true;
  let pathname: string;
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return false;
  }
  return pathname === "/health"
    || pathname === "/ready"
    || pathname.startsWith("/auth/")
    || pathname.startsWith("/v1/")
    || pathname.startsWith("/v2/");
}

/**
 * Route both API generations before applying the SPA fallback. Keeping this
 * boundary separate from the listening process lets tests exercise the exact
 * production dispatcher rather than only the inner API handler.
 */
export function createRequestRouter(app: ApiHandler, staticRoot: string): RequestListener {
  return (req, res) => {
    if (isApiRequest(req)) {
      const fail = (error: unknown) => {
        // Once a streamed response has begun, appending a JSON error would
        // corrupt it while retaining the original success status. Terminate the
        // connection instead; before headers, return a small sanitized error.
        if (res.headersSent || res.writableEnded || res.destroyed) {
          res.destroy(error instanceof Error ? error : undefined);
          return;
        }
        res.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify({ error: "Unexpected server error" }));
      };
      try {
        void Promise.resolve(app(req, res)).catch(fail);
      } catch (error) {
        fail(error);
      }
      return;
    }
    try {
      serveStaticApp(staticRoot, req, res);
    } catch (error) {
      if (res.headersSent || res.writableEnded || res.destroyed) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      res.writeHead(500, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end("Unexpected server error");
    }
  };
}
