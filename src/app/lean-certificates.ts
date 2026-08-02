import { parse as parseYaml } from "yaml";

export type LeanCertificateCoverage = "full" | "partial";

export interface LeanCertificateEvidence {
  resultId: string;
  resultTitle: string;
  project: string;
  ownerDocumentId: string;
  ownerPath: string;
  coverage: LeanCertificateCoverage;
  status: string;
  declarations: string[];
  certifiedScope: string[];
  assumptions: string[];
  excludedScope: string[];
  sourcePath: string;
  sourceText: string;
  manifestPath: string;
  leanVersion: string;
  mathlibVersion: string;
  buildState: "passed";
}

export interface LeanCertificateCatalog {
  byResult: Map<string, LeanCertificateEvidence>;
  byOwner: Map<string, LeanCertificateEvidence[]>;
  diagnostics: string[];
  buildState: "passed" | "failed" | "unknown" | "invalid";
}

export interface LeanCertificateAssetSource {
  read(path: string): Promise<Uint8Array>;
}

export interface LeanCertificateResult {
  id: string;
  title: string;
  project: string;
  ownerId: string;
}

export interface LeanCertificateDocument {
  id: string;
  path: string;
  projects: string[];
}

interface DigestedFile {
  path: string;
  digest: string;
}

interface RawCertificate {
  result_id: string;
  project: string;
  owner: string;
  coverage: LeanCertificateCoverage;
  status: string;
  source: string;
  declarations: string[];
  certified_scope: string[];
  assumptions: string[];
  excluded_scope: string[];
}

interface RawCertificateMap {
  schema_version: number;
  environment: {
    lean: string;
    mathlib: string;
    build_command: string;
    root_module: string;
  };
  integrity: {
    build_state: "passed" | "failed" | "unknown";
    manifest: DigestedFile;
    sources: DigestedFile[];
  };
  certificates: RawCertificate[];
}

const MAP_PATH = "formal/certificate-map.yaml";
const MANIFEST_PATH = "formal/lake-manifest.json";
const BUILD_COMMAND = "lake build --wfail";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DECLARATION = /^[A-Z][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)+$/;

export async function loadLeanCertificateCatalog(
  source: LeanCertificateAssetSource | null,
  results: readonly LeanCertificateResult[],
  documents: readonly LeanCertificateDocument[],
): Promise<LeanCertificateCatalog> {
  const empty = (diagnostics: string[] = [], buildState: LeanCertificateCatalog["buildState"] = "invalid") => ({
    byResult: new Map<string, LeanCertificateEvidence>(),
    byOwner: new Map<string, LeanCertificateEvidence[]>(),
    diagnostics,
    buildState,
  });
  if (!source) return empty([], "unknown");

  let value: RawCertificateMap;
  try {
    const parsed = parseYaml(new TextDecoder().decode(await source.read(MAP_PATH)));
    value = validateShape(parsed);
  } catch (error) {
    return empty([`Lean certificate map: ${messageOf(error)}`]);
  }
  if (value.integrity.build_state !== "passed") {
    return empty(
      [`Lean certificate build state is ${value.integrity.build_state}; badges are suppressed.`],
      value.integrity.build_state,
    );
  }

  const diagnostics: string[] = [];
  const bytes = new Map<string, Uint8Array>();
  const pinned = [value.integrity.manifest, ...value.integrity.sources];
  if (new Set(pinned.map((item) => item.path)).size !== pinned.length) {
    return empty(["Lean certificate integrity lists a file more than once."]);
  }
  await Promise.all(pinned.map(async (item) => {
    try {
      const loaded = await source.read(item.path);
      bytes.set(item.path, loaded);
      if (await sha256(loaded) !== item.digest) diagnostics.push(`${item.path}: stale certificate digest`);
    } catch (error) {
      diagnostics.push(`${item.path}: ${messageOf(error)}`);
    }
  }));
  if (diagnostics.length) return empty(diagnostics);

  const sources = new Set(value.integrity.sources.map((item) => item.path));
  const sourceText = new Map(
    value.integrity.sources.map((item) => [item.path, new TextDecoder().decode(bytes.get(item.path)!)]),
  );
  for (const [path, text] of sourceText) {
    if (/^\s*(?:sorry|admit|axiom|unsafe)\b/m.test(stripLeanComments(text))) {
      diagnostics.push(`${path}: prohibited Lean proof escape`);
    }
  }
  if (diagnostics.length) return empty(diagnostics);

  const resultById = new Map(results.map((result) => [result.id, result]));
  const documentByPath = new Map(documents.map((document) => [document.path, document]));
  const seenResults = new Set<string>();
  const seenDeclarations = new Set<string>();
  const byResult = new Map<string, LeanCertificateEvidence>();
  const byOwner = new Map<string, LeanCertificateEvidence[]>();

  for (const certificate of value.certificates) {
    const prefix = certificate.result_id || "certificate";
    if (seenResults.has(certificate.result_id)) {
      diagnostics.push(`${prefix}: duplicate result mapping`);
      continue;
    }
    seenResults.add(certificate.result_id);
    const result = resultById.get(certificate.result_id);
    const owner = documentByPath.get(certificate.owner);
    if (!result || result.project !== certificate.project) {
      diagnostics.push(`${prefix}: result/project mapping is not in the active catalog`);
      continue;
    }
    if (!owner || owner.id !== result.ownerId || !owner.projects.includes(certificate.project)) {
      diagnostics.push(`${prefix}: owner mapping does not match the registered result`);
      continue;
    }
    if (!sources.has(certificate.source)) {
      diagnostics.push(`${prefix}: certificate source is not integrity-pinned`);
      continue;
    }
    if (certificate.coverage === "partial" && !certificate.excluded_scope.length) {
      diagnostics.push(`${prefix}: partial coverage has no excluded scope`);
      continue;
    }
    if (certificate.coverage === "full" && certificate.excluded_scope.length) {
      diagnostics.push(`${prefix}: full coverage declares excluded scope`);
      continue;
    }
    let declarationsValid = true;
    for (const declaration of certificate.declarations) {
      const shortName = declaration.split(".").at(-1)!;
      const declared = new RegExp(`^\\s*(?:theorem|lemma|def)\\s+${escapeRegExp(shortName)}\\b`, "m")
        .test(stripLeanComments(sourceText.get(certificate.source)!));
      if (!declared || seenDeclarations.has(declaration)) {
        diagnostics.push(
          `${prefix}: ${seenDeclarations.has(declaration) ? "duplicate" : "missing"} Lean declaration ${declaration}`,
        );
        declarationsValid = false;
      }
      seenDeclarations.add(declaration);
    }
    if (!declarationsValid) continue;
    const evidence: LeanCertificateEvidence = {
      resultId: result.id,
      resultTitle: result.title,
      project: certificate.project,
      ownerDocumentId: result.ownerId,
      ownerPath: certificate.owner,
      coverage: certificate.coverage,
      status: certificate.status,
      declarations: [...certificate.declarations],
      certifiedScope: [...certificate.certified_scope],
      assumptions: [...certificate.assumptions],
      excludedScope: [...certificate.excluded_scope],
      sourcePath: certificate.source,
      sourceText: sourceText.get(certificate.source)!,
      manifestPath: value.integrity.manifest.path,
      leanVersion: value.environment.lean,
      mathlibVersion: value.environment.mathlib,
      buildState: "passed",
    };
    byResult.set(result.id, evidence);
    const owned = byOwner.get(result.ownerId) ?? [];
    owned.push(evidence);
    byOwner.set(result.ownerId, owned);
  }

  return { byResult, byOwner, diagnostics, buildState: "passed" };
}

export function leanCertificateBadgeText(evidence: LeanCertificateEvidence): "L" | "L◐" {
  return evidence.coverage === "full" ? "L" : "L◐";
}

export function leanCertificateDescription(evidence: LeanCertificateEvidence): string {
  const scope = evidence.certifiedScope.join("; ");
  const exclusion = evidence.excludedScope.length
    ? ` Not certified: ${evidence.excludedScope.join("; ")}.`
    : "";
  return `Lean kernel checked (${evidence.coverage} coverage). Certified: ${scope}.${exclusion}`;
}

function validateShape(value: unknown): RawCertificateMap {
  if (!isRecord(value) || value.schema_version !== 1) throw new Error("unsupported schema version");
  const environment = value.environment;
  const integrity = value.integrity;
  if (!isRecord(environment) || !isRecord(integrity) || !Array.isArray(value.certificates)) {
    throw new Error("missing environment, integrity, or certificate records");
  }
  if (environment.build_command !== BUILD_COMMAND) throw new Error("unsupported certificate build command");
  if (!["passed", "failed", "unknown"].includes(String(integrity.build_state))) {
    throw new Error("invalid build state");
  }
  const manifest = digestedFile(integrity.manifest);
  if (manifest.path !== MANIFEST_PATH) throw new Error("certificate map uses a noncanonical Lean manifest");
  const rawSources = Array.isArray(integrity.sources) ? integrity.sources : [];
  const sources = rawSources.map(digestedFile);
  if (!sources.length) throw new Error("no pinned Lean sources");
  if (sources.some((source) => !source.path.startsWith("formal/") || !source.path.endsWith(".lean"))) {
    throw new Error("certificate source is not a formal Lean source");
  }
  const certificates = value.certificates.map((raw, index): RawCertificate => {
    if (!isRecord(raw)) throw new Error(`certificate ${index + 1} is not an object`);
    const coverage = raw.coverage;
    if (coverage !== "full" && coverage !== "partial") throw new Error(`certificate ${index + 1} has invalid coverage`);
    const declarations = stringList(raw.declarations, true);
    if (!declarations.every((item) => DECLARATION.test(item))) throw new Error(`certificate ${index + 1} has an invalid declaration`);
    return {
      result_id: requiredString(raw.result_id, "result_id"),
      project: requiredString(raw.project, "project"),
      owner: safePath(raw.owner, "owner"),
      coverage,
      status: requiredString(raw.status, "status"),
      source: safePath(raw.source, "source"),
      declarations,
      certified_scope: stringList(raw.certified_scope, true),
      assumptions: stringList(raw.assumptions, true),
      excluded_scope: stringList(raw.excluded_scope, false),
    };
  });
  return {
    schema_version: 1,
    environment: {
      lean: requiredString(environment.lean, "environment.lean"),
      mathlib: requiredString(environment.mathlib, "environment.mathlib"),
      build_command: requiredString(environment.build_command, "environment.build_command"),
      root_module: requiredString(environment.root_module, "environment.root_module"),
    },
    integrity: {
      build_state: integrity.build_state as RawCertificateMap["integrity"]["build_state"],
      manifest,
      sources,
    },
    certificates,
  };
}

function digestedFile(value: unknown): DigestedFile {
  if (!isRecord(value)) throw new Error("invalid digested file record");
  const digest = requiredString(value.digest, "digest");
  if (!DIGEST.test(digest)) throw new Error("invalid SHA-256 digest");
  return { path: safePath(value.path, "path"), digest };
}

function stringList(value: unknown, nonempty: boolean): string[] {
  if (!Array.isArray(value) || (nonempty && !value.length) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error("invalid certificate text list");
  }
  return value.map((item) => (item as string).trim());
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing ${label}`);
  return value.trim();
}

function safePath(value: unknown, label: string): string {
  const path = requiredString(value, label).replace(/\\/g, "/");
  if (path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error(`unsafe ${label}`);
  }
  return path;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return `sha256:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function stripLeanComments(source: string): string {
  let output = "";
  let blockDepth = 0;
  let lineComment = false;
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const current = source[index];
    const next = source[index + 1] ?? "";
    if (lineComment) {
      if (current === "\n") { lineComment = false; output += "\n"; }
      continue;
    }
    if (blockDepth) {
      if (current === "/" && next === "-") { blockDepth++; index++; }
      else if (current === "-" && next === "/") { blockDepth--; index++; }
      else if (current === "\n") output += "\n";
      continue;
    }
    if (!quoted && current === "-" && next === "-") { lineComment = true; index++; continue; }
    if (!quoted && current === "/" && next === "-") { blockDepth = 1; index++; continue; }
    if (current === '"' && source[index - 1] !== "\\") quoted = !quoted;
    output += current;
  }
  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "could not read evidence";
}
