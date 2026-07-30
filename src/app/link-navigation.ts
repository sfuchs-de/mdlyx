import { isSafeLinkHref } from "../markdown/links";

export type MarkdownLinkTarget =
  | { kind: "external"; url: string }
  | { kind: "anchor"; anchor: string }
  | { kind: "document"; path: string; anchor?: string }
  | { kind: "unsupported" };

const EXTERNAL_SCHEME = /^(https?|mailto):/i;
const MARKDOWN_EXTENSION = /\.(?:md|markdown)$/i;

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function resolveLibraryPath(rawPath: string, sourcePath: string): string | null {
  const decoded = decode(rawPath);
  if (decoded == null || decoded.includes("\\") || decoded.includes("?")) return null;

  const rooted = decoded.startsWith("/");
  const base = rooted ? [] : sourcePath.split("/").slice(0, -1);
  const parts = [...base];
  for (const part of decoded.replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    // Library providers exclude hidden paths. Rejecting them here also avoids
    // turning an authored link into a direct-path existence probe.
    if (part.startsWith(".")) return null;
    parts.push(part);
  }
  const path = parts.join("/");
  return path && MARKDOWN_EXTENSION.test(path) ? path : null;
}

/**
 * Classify a safe authored Markdown href without relying on the webview's
 * current URL. Relative Markdown paths are resolved within the active library;
 * fragments remain current-document navigation; web/mail links use the shared
 * browser/native opener.
 */
export function resolveMarkdownLink(href: string, sourcePath: string): MarkdownLinkTarget {
  const value = href.trim();
  if (!isSafeLinkHref(value)) return { kind: "unsupported" };
  if (EXTERNAL_SCHEME.test(value)) return { kind: "external", url: value };

  if (value.startsWith("#")) {
    const anchor = decode(value.slice(1));
    return anchor ? { kind: "anchor", anchor } : { kind: "unsupported" };
  }

  const hash = value.indexOf("#");
  const rawPath = hash < 0 ? value : value.slice(0, hash);
  const rawAnchor = hash < 0 ? "" : value.slice(hash + 1);
  const path = resolveLibraryPath(rawPath, sourcePath);
  const anchor = rawAnchor ? decode(rawAnchor) : undefined;
  if (!path || (rawAnchor && !anchor)) return { kind: "unsupported" };
  return { kind: "document", path, ...(anchor ? { anchor } : {}) };
}
