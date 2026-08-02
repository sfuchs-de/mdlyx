export interface LibraryAsset {
  path: string;
  mimeType: string;
  size: number;
  sha?: string;
}

export interface LibraryAssetWrite {
  path: string;
  bytes: Uint8Array;
  mimeType: string;
  ifMatch?: string;
}

export interface LibraryAssetProvider {
  listAssets(project?: string): Promise<LibraryAsset[]>;
  readAsset(path: string): Promise<{ asset: LibraryAsset; bytes: Uint8Array }>;
  writeAsset(input: LibraryAssetWrite): Promise<LibraryAsset>;
}

export const MAX_LIBRARY_ASSET_BYTES = 25 * 1024 * 1024;
const FORMAL_EVIDENCE_EXTENSIONS = new Set(["yaml", "yml", "json", "lean", "toml"]);

const ASSET_MIME_TYPES: Record<string, string> = {
  bib: "application/x-bibtex",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  tex: "text/x-tex",
  sty: "text/x-tex",
  cls: "text/x-tex",
  bst: "text/plain",
  yaml: "application/yaml",
  yml: "application/yaml",
  json: "application/json",
  lean: "text/plain",
  toml: "application/toml",
};

export function libraryAssetMimeType(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (FORMAL_EVIDENCE_EXTENSIONS.has(extension) && !path.replace(/\\/g, "/").startsWith("formal/")) {
    return null;
  }
  return ASSET_MIME_TYPES[extension] ?? null;
}

export function validateLibraryAssetPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").trim();
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes("\0")
  ) throw new Error("Asset path must be relative to the library root");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("Asset path contains a hidden or escaping segment");
  }
  const result = parts.join("/");
  if (parts.length > 9) throw new Error("Asset path is too deeply nested");
  if (!libraryAssetMimeType(result)) throw new Error("Asset type is not supported");
  return result;
}

export function validateLibraryAssetWrite(input: LibraryAssetWrite): LibraryAssetWrite {
  const path = validateLibraryAssetPath(input.path);
  if (input.bytes.byteLength > MAX_LIBRARY_ASSET_BYTES) {
    throw new Error("Asset exceeds the 25 MiB limit");
  }
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType)) throw new Error("Asset MIME type is invalid");
  return { ...input, path };
}
