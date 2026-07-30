import { readFileSync } from "node:fs";

export interface Config {
  appOrigin: string;
  apiOrigin: string;
  desktopAppOrigins: string[];
  allowedLogin: string;
  libraryOwner: string;
  libraryRepo: string;
  libraryBranch: string;
  libraryProtectedBranch: string;
  accessPolicyPath: string;
  releaseOwner: string;
  releaseRepo: string;
  releaseGithubAppId?: string;
  releaseGithubInstallationId?: string;
  releaseGithubPrivateKey?: string;
  redisUrl?: string;
  sessionSecret: string;
  inviteTokenSecret: string;
  githubAppId: string;
  githubClientId: string;
  githubClientSecret: string;
  githubInstallationId: string;
  githubPrivateKey: string;
}

export type PendingDeviceStoreMode = "memory" | "redis";

export function desktopAppOriginsFromEnv(env = process.env): string[] {
  return (env.DESKTOP_APP_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const required = [
  "APP_ORIGIN",
  "ALLOWED_GITHUB_LOGIN",
  "LIBRARY_OWNER",
  "LIBRARY_REPO",
  "SESSION_SECRET",
  "INVITE_TOKEN_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_INSTALLATION_ID",
] as const;

const releaseRequired = [
  "RELEASE_GITHUB_APP_ID",
  "RELEASE_GITHUB_INSTALLATION_ID",
] as const;

export function pendingDeviceStoreModeFromEnv(env = process.env): PendingDeviceStoreMode {
  const configured = env.PENDING_DEVICE_STORE?.trim().toLowerCase();
  const onRender = env.RENDER === "true" || Boolean(env.RENDER_SERVICE_ID);
  const production = onRender || env.NODE_ENV === "production";
  if (production && configured === "memory") {
    throw new Error("PENDING_DEVICE_STORE=memory is not allowed in production");
  }
  if (configured === "memory" || configured === "redis") return configured;
  if (configured) throw new Error(`Invalid PENDING_DEVICE_STORE: ${configured}`);
  return production ? "redis" : "memory";
}

function privateKeyFromEnv(env: NodeJS.ProcessEnv, prefix = "GITHUB"): string | undefined {
  const inline = env[`${prefix}_PRIVATE_KEY`];
  if (inline) return inline.replace(/\\n/g, "\n");
  const file = env[`${prefix}_PRIVATE_KEY_FILE`];
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function configFromEnv(env = process.env): Config {
  const privateKey = privateKeyFromEnv(env);
  const releasePrivateKey = privateKeyFromEnv(env, "RELEASE_GITHUB");
  const missing = [
    ...required.filter((key) => !env[key]),
    ...(privateKey ? [] : ["GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_FILE"]),
    ...(pendingDeviceStoreModeFromEnv(env) === "redis" && !env.REDIS_URL ? ["REDIS_URL"] : []),
  ];
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  return {
    appOrigin: env.APP_ORIGIN as string,
    apiOrigin: env.API_ORIGIN ?? env.RENDER_EXTERNAL_URL ?? env.APP_ORIGIN as string,
    desktopAppOrigins: desktopAppOriginsFromEnv(env),
    allowedLogin: env.ALLOWED_GITHUB_LOGIN as string,
    libraryOwner: env.LIBRARY_OWNER as string,
    libraryRepo: env.LIBRARY_REPO as string,
    libraryBranch: env.LIBRARY_BRANCH?.trim() || "main",
    libraryProtectedBranch: env.LIBRARY_PROTECTED_BRANCH?.trim() || "main",
    accessPolicyPath: env.LIBRARY_ACCESS_POLICY_PATH?.trim() || "library-access.yaml",
    releaseOwner: env.RELEASE_OWNER?.trim() || env.LIBRARY_OWNER as string,
    releaseRepo: env.RELEASE_REPO ?? "mdlyx",
    ...(env.RELEASE_GITHUB_APP_ID ? { releaseGithubAppId: env.RELEASE_GITHUB_APP_ID } : {}),
    ...(env.RELEASE_GITHUB_INSTALLATION_ID ? { releaseGithubInstallationId: env.RELEASE_GITHUB_INSTALLATION_ID } : {}),
    ...(releasePrivateKey ? { releaseGithubPrivateKey: releasePrivateKey } : {}),
    ...(env.REDIS_URL ? { redisUrl: env.REDIS_URL } : {}),
    sessionSecret: env.SESSION_SECRET as string,
    inviteTokenSecret: env.INVITE_TOKEN_SECRET as string,
    githubAppId: env.GITHUB_APP_ID as string,
    githubClientId: env.GITHUB_CLIENT_ID as string,
    githubClientSecret: env.GITHUB_CLIENT_SECRET as string,
    githubInstallationId: env.GITHUB_INSTALLATION_ID as string,
    githubPrivateKey: privateKey as string,
  };
}

export function isConfigured(env = process.env): boolean {
  const redisConfigured = pendingDeviceStoreModeFromEnv(env) !== "redis" || Boolean(env.REDIS_URL);
  return required.every((key) => Boolean(env[key])) && Boolean(privateKeyFromEnv(env)) && redisConfigured;
}

export function isReleaseConfigured(env = process.env): boolean {
  return releaseRequired.every((key) => Boolean(env[key]))
    && Boolean(privateKeyFromEnv(env, "RELEASE_GITHUB"));
}
