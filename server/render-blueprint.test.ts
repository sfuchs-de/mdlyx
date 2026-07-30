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
});
