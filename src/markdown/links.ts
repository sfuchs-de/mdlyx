// A Markdown document is untrusted input, including when it is opened in the
// desktop shell. Keep browser-navigable links to ordinary web/mail targets and
// relative references; never turn an executable or local-resource scheme into
// a live anchor.
const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

export function isSafeLinkHref(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const href = value.trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href) || href.startsWith("//")) {
    return false;
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  return scheme ? SAFE_SCHEMES.has(scheme) : true;
}
