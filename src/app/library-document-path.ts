/**
 * Canonical relative path accepted by every Markdown library provider.
 * Providers still revalidate at their trust boundary; this keeps browser,
 * GitHub, and native creation behavior identical before dispatch.
 */
export function normaliseDocumentPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\\")) return null;
  const parts = trimmed
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (
    !parts.length
    || parts.length > 9
    || parts.some((part) => part === "." || part === ".." || part.startsWith("."))
  ) {
    return null;
  }
  const last = parts.length - 1;
  if (!/\.(md|markdown)$/i.test(parts[last])) parts[last] += ".md";
  return parts.join("/");
}
