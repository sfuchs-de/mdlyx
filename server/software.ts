export interface ServiceSoftwareInfo {
  version: string;
  revision?: string;
}

export function serviceSoftwareInfo(env: NodeJS.ProcessEnv = process.env): ServiceSoftwareInfo {
  const version = env.npm_package_version?.trim() || "unknown";
  const revision = (env.RENDER_GIT_COMMIT ?? env.GITHUB_SHA)?.trim().slice(0, 12);
  return revision ? { version, revision } : { version };
}
