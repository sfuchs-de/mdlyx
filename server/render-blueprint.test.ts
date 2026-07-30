import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface BlueprintService {
  type: string;
  name: string;
  region?: string;
  plan?: string;
  ipAllowList?: unknown[];
  maxmemoryPolicy?: string;
  persistenceMode?: string;
  healthCheckPath?: string;
  headers?: Array<{ path: string; name: string; value: string }>;
  envVars?: Array<{
    key: string;
    value?: string;
    sync?: boolean;
    fromService?: { type: string; name: string; property: string };
  }>;
}

describe("Render Blueprint", () => {
  it("deploys a credential-free local-first static application", () => {
    const source = readFileSync(resolve(process.cwd(), "render.yaml"), "utf8");
    const blueprint = parse(source) as { services: BlueprintService[] };
    const web = blueprint.services.find((service) => service.name === "mdlyx");
    expect(blueprint.services).toHaveLength(1);
    expect(web).toMatchObject({
      type: "web",
      runtime: "static",
    });
    expect(web?.envVars ?? []).toEqual([]);
    expect(web?.headers).toContainEqual({
      path: "/site.webmanifest",
      name: "Content-Type",
      value: "application/manifest+json",
    });
  });

  it("keeps the optional GitHub-sync example explicit, private, and placeholder-only", () => {
    const source = readFileSync(
      resolve(process.cwd(), "deploy/render-github-sync.example.yaml"),
      "utf8",
    );
    const blueprint = parse(source) as { services: BlueprintService[] };
    const web = blueprint.services.find((service) => service.type === "web");
    const store = blueprint.services.find((service) => service.type === "keyvalue");
    expect(blueprint.services).toHaveLength(2);
    expect(web).toMatchObject({
      name: "your-mdlyx-api",
      plan: "starter",
      region: "oregon",
      healthCheckPath: "/ready",
    });
    expect(store).toMatchObject({
      name: "your-mdlyx-auth-kv",
      plan: "starter",
      region: "oregon",
      ipAllowList: [],
      maxmemoryPolicy: "volatile-ttl",
      persistenceMode: "off",
    });

    const env = new Map((web?.envVars ?? []).map((item) => [item.key, item]));
    for (const key of [
      "APP_ORIGIN",
      "API_ORIGIN",
      "VITE_LIBRARY_API_URL",
      "VITE_APP_ORIGIN",
      "ALLOWED_GITHUB_LOGIN",
      "LIBRARY_OWNER",
      "LIBRARY_REPO",
      "SESSION_SECRET",
      "INVITE_TOKEN_SECRET",
      "GITHUB_APP_ID",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "GITHUB_INSTALLATION_ID",
      "GITHUB_PRIVATE_KEY_FILE",
      "PENDING_DEVICE_STORE",
      "REDIS_URL",
    ]) {
      expect(env.has(key), `${key} should be declared`).toBe(true);
    }
    expect(env.get("GITHUB_PRIVATE_KEY_FILE")?.value)
      .toBe("/etc/secrets/mdlyx-github-app.pem");
    expect(env.get("PENDING_DEVICE_STORE")?.value).toBe("redis");
    expect(env.get("REDIS_URL")?.fromService).toEqual({
      type: "keyvalue",
      name: "your-mdlyx-auth-kv",
      property: "connectionString",
    });
    expect(source).not.toMatch(/-----BEGIN .*PRIVATE KEY-----/);
  });
});
