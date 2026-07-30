import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const IMMUTABLE_ASSET_CACHE = "public, max-age=31536000, immutable";

function cacheControl(pathname: string): string {
  // Vite fingerprints generated files under /assets/. Stable root files such as
  // favicons, touch icons, and the web manifest must revalidate after a deploy.
  return pathname.startsWith("/assets/") ? IMMUTABLE_ASSET_CACHE : "no-cache";
}

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; media-src 'self'; worker-src 'self' blob:",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function safePath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "");
  const candidate = resolve(root, relative || "index.html");
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

function sendFile(req: IncomingMessage, res: ServerResponse, path: string, cacheControl: string): void {
  const headers = {
    ...SECURITY_HEADERS,
    "cache-control": cacheControl,
    "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
  };
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(path).on("error", () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }).pipe(res);
}

// The Node service hosts the canonical SPA on the API origin so browser
// sessions stay first-party. The separate Render static service remains a fast
// compatibility entry point whose build redirects to this origin.
export function serveStaticApp(root: string, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, HEAD" });
    res.end();
    return;
  }
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    res.writeHead(400, SECURITY_HEADERS);
    res.end();
    return;
  }
  const candidate = safePath(root, url.pathname);
  if (!candidate) {
    res.writeHead(400, SECURITY_HEADERS);
    res.end();
    return;
  }
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    sendFile(req, res, candidate, cacheControl(url.pathname));
    return;
  }
  // Client-side paths such as /github-link should boot the Vite SPA. Missing
  // fingerprinted assets remain a 404 rather than receiving HTML by mistake.
  if (extname(url.pathname)) {
    res.writeHead(404, SECURITY_HEADERS);
    res.end();
    return;
  }
  const index = resolve(root, "index.html");
  if (!existsSync(index)) {
    res.writeHead(503, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" });
    res.end("MdLyx is deploying. Please reload shortly.");
    return;
  }
  sendFile(req, res, index, "no-cache");
}
