import { createHash } from "node:crypto";
import { dirname } from "node:path/posix";
import { parseDocument } from "yaml";

export type AccessRole = "reader" | "commenter" | "editor";

export interface AccessPrincipal {
  id: string;
  displayName: string;
  authVersion: number;
  grants: Record<string, AccessRole>;
}

export interface AccessPolicySnapshot {
  revision: string;
  policySha: string;
  digest: string;
  principals: Map<string, AccessPrincipal>;
  projectRoots: Map<string, string>;
  projects: Array<{ key: string; title: string }>;
}

export interface AccessConfiguration {
  revision: string;
  policySha: string;
  policy: string;
  projects: Array<{ path: string; text: string }>;
}

export interface AccessConfigurationSource {
  accessConfiguration(): Promise<AccessConfiguration>;
}

export interface AuthorizedLibraryScope {
  kind: "owner" | "coauthor";
  principalId: string;
  displayName: string;
  authVersion: number;
  grants: Record<string, AccessRole>;
  projectRoots: Map<string, string>;
  digest: string;
  canShare: boolean;
  canUseUpdater: boolean;
}

const PRINCIPAL_ID = /^[a-z][a-z0-9-]{1,62}$/;
const PROJECT_KEY = /^[a-z][a-z0-9-]{1,79}$/;
const ROLES = new Set<AccessRole>(["reader", "commenter", "editor"]);

export class AccessPolicyError extends Error {}

export class AccessPolicyProvider {
  private cached: AccessPolicySnapshot | null = null;
  private loading: Promise<AccessPolicySnapshot> | null = null;

  constructor(private readonly source: AccessConfigurationSource) {}

  async snapshot(): Promise<AccessPolicySnapshot> {
    if (this.loading) return this.loading;
    const request = (async () => {
      const configuration = await this.source.accessConfiguration();
      if (this.cached?.revision === configuration.revision) return this.cached;
      const parsed = parseAccessPolicy(configuration);
      this.cached = parsed;
      return parsed;
    })();
    this.loading = request;
    try {
      return await request;
    } finally {
      if (this.loading === request) this.loading = null;
    }
  }
}

export function parseAccessPolicy(configuration: AccessConfiguration): AccessPolicySnapshot {
  const projectRoots = new Map<string, string>();
  const projectTitles = new Map<string, string>();
  for (const project of configuration.projects) {
    const value = yamlObject(project.text, project.path);
    const record = object(value.project, `${project.path}: project`);
    const key = string(record.key, `${project.path}: project.key`);
    const title = typeof record.title === "string" && record.title.trim()
      ? record.title.trim()
      : key;
    const lifecycle = string(record.lifecycle, `${project.path}: project.lifecycle`);
    if (!PROJECT_KEY.test(key)) throw new AccessPolicyError(`${project.path}: invalid project key`);
    if (lifecycle !== "active") continue;
    if (projectRoots.has(key)) throw new AccessPolicyError(`Duplicate active project key: ${key}`);
    projectRoots.set(key, dirname(project.path));
    projectTitles.set(key, title);
  }
  if (!projectRoots.size) throw new AccessPolicyError("No active project configurations were found");

  const policy = yamlObject(configuration.policy, "library-access.yaml");
  rejectUnknown(policy, new Set(["schema_version", "principals"]), "library-access.yaml");
  if (policy.schema_version !== "1.0") {
    throw new AccessPolicyError("library-access.yaml: schema_version must be '1.0'");
  }
  const rawPrincipals = object(policy.principals, "library-access.yaml: principals");
  const principals = new Map<string, AccessPrincipal>();
  for (const [id, raw] of Object.entries(rawPrincipals)) {
    if (!PRINCIPAL_ID.test(id)) throw new AccessPolicyError(`Invalid principal ID: ${id}`);
    const principal = object(raw, `principal ${id}`);
    rejectUnknown(principal, new Set(["display_name", "auth_version", "grants"]), `principal ${id}`);
    const rawGrants = object(principal.grants, `principal ${id}.grants`);
    principals.set(id, normalizeAccessPrincipal(
      id,
      principal.display_name,
      principal.auth_version,
      rawGrants,
      projectRoots,
    ));
  }

  const digest = createHash("sha256")
    .update(JSON.stringify({
      principals: [...principals.values()].sort((a, b) => a.id.localeCompare(b.id)),
      projects: [...projectRoots.entries()].sort(([a], [b]) => a.localeCompare(b)),
    }))
    .digest("hex");
  return {
    revision: configuration.revision,
    policySha: configuration.policySha,
    digest,
    principals,
    projectRoots,
    projects: [...projectRoots.keys()]
      .map((key) => ({ key, title: projectTitles.get(key) ?? key }))
      .sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key)),
  };
}

export function normalizeAccessPrincipal(
  id: string,
  rawDisplayName: unknown,
  rawAuthVersion: unknown,
  rawGrants: Record<string, unknown>,
  projectRoots: Map<string, string>,
): AccessPrincipal {
  if (!PRINCIPAL_ID.test(id)) throw new AccessPolicyError(`Invalid principal ID: ${id}`);
  const displayName = string(rawDisplayName, `principal ${id}.display_name`);
  if (displayName.length > 120) throw new AccessPolicyError(`principal ${id}: display name is too long`);
  if (!Number.isSafeInteger(rawAuthVersion) || Number(rawAuthVersion) <= 0) {
    throw new AccessPolicyError(`principal ${id}: auth_version must be a positive integer`);
  }
  const grants: Record<string, AccessRole> = {};
  for (const [projectKey, rawRole] of Object.entries(rawGrants)) {
    if (!projectRoots.has(projectKey)) {
      throw new AccessPolicyError(`principal ${id}: unknown active project ${projectKey}`);
    }
    if (typeof rawRole !== "string" || !ROLES.has(rawRole as AccessRole)) {
      throw new AccessPolicyError(`principal ${id}: invalid role for ${projectKey}`);
    }
    grants[projectKey] = rawRole as AccessRole;
  }
  if (!Object.keys(grants).length) throw new AccessPolicyError(`principal ${id}: at least one grant is required`);
  return { id, displayName, authVersion: Number(rawAuthVersion), grants };
}

export function serializeAccessPolicy(
  source: string,
  principals: Iterable<AccessPrincipal>,
): string {
  const document = parseDocument(source, { merge: false });
  if (document.errors.length) throw new AccessPolicyError("library-access.yaml: invalid YAML");
  const values: Record<string, {
    display_name: string;
    auth_version: number;
    grants: Record<string, AccessRole>;
  }> = {};
  for (const principal of [...principals].sort((a, b) => a.id.localeCompare(b.id))) {
    values[principal.id] = {
      display_name: principal.displayName,
      auth_version: principal.authVersion,
      grants: Object.fromEntries(
        Object.entries(principal.grants).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
  }
  document.set("principals", values);
  const serialized = document.toString({ lineWidth: 0 });
  return serialized.endsWith("\n") ? serialized : `${serialized}\n`;
}

export function coauthorScope(
  snapshot: AccessPolicySnapshot,
  principalId: string,
  authVersion: number,
): AuthorizedLibraryScope | null {
  const principal = snapshot.principals.get(principalId);
  if (!principal || principal.authVersion !== authVersion) return null;
  return {
    kind: "coauthor",
    principalId: principal.id,
    displayName: principal.displayName,
    authVersion: principal.authVersion,
    grants: { ...principal.grants },
    projectRoots: new Map(snapshot.projectRoots),
    digest: createHash("sha256").update(`${snapshot.digest}:${principal.id}:${principal.authVersion}`).digest("hex"),
    canShare: false,
    canUseUpdater: false,
  };
}

export function ownerScope(login: string): AuthorizedLibraryScope {
  return {
    kind: "owner",
    principalId: login,
    displayName: login,
    authVersion: 1,
    grants: {},
    projectRoots: new Map(),
    digest: "owner",
    canShare: true,
    canUseUpdater: true,
  };
}

export function roleAtLeast(role: AccessRole | undefined, required: AccessRole): boolean {
  const rank: Record<AccessRole, number> = { reader: 1, commenter: 2, editor: 3 };
  return role !== undefined && rank[role] >= rank[required];
}

export function projectsForMeta(meta: unknown): string[] {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return [];
  const projects = (meta as Record<string, unknown>).projects;
  if (!Array.isArray(projects)) return [];
  if (projects.some((value) => typeof value !== "string" || !PROJECT_KEY.test(value))) {
    // Never authorize a partially parsed declaration by silently dropping its
    // malformed members. No valid policy can grant this sentinel.
    return ["__invalid_project_declaration__"];
  }
  return [...new Set(projects as string[])];
}

export function canReadProjects(scope: AuthorizedLibraryScope, projects: string[]): boolean {
  if (scope.kind === "owner") return true;
  return projects.length > 0 && projects.every((project) => roleAtLeast(scope.grants[project], "reader"));
}

export function canWriteProjects(
  scope: AuthorizedLibraryScope,
  projects: string[],
  required: "commenter" | "editor",
): boolean {
  if (scope.kind === "owner") return true;
  return projects.length > 0 && projects.every((project) => roleAtLeast(scope.grants[project], required));
}

export function projectForAsset(scope: AuthorizedLibraryScope, path: string): string | null {
  if (scope.kind === "owner") return "owner";
  const matches = [...scope.projectRoots.entries()]
    .filter(([, root]) => path === root || path.startsWith(`${root}/`))
    .sort((a, b) => b[1].length - a[1].length);
  const project = matches[0]?.[0];
  return project && roleAtLeast(scope.grants[project], "reader") ? project : null;
}

function yamlObject(source: string, label: string): Record<string, unknown> {
  const document = parseDocument(source, { merge: false });
  if (document.errors.length) throw new AccessPolicyError(`${label}: invalid YAML`);
  const value = document.toJS({ maxAliasCount: 0 });
  return object(value, label);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AccessPolicyError(`${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AccessPolicyError(`${label} must be a non-empty string`);
  return value.trim();
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new AccessPolicyError(`${label}: unknown fields: ${unknown.sort().join(", ")}`);
}
