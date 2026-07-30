import { describe, expect, it } from "vitest";
import {
  AccessPolicyProvider,
  AccessPolicyError,
  canReadProjects,
  canWriteProjects,
  coauthorScope,
  normalizeAccessPrincipal,
  parseAccessPolicy,
  projectForAsset,
  projectsForMeta,
  serializeAccessPolicy,
} from "./access-policy";

const configuration = {
  revision: "tree-1",
  policySha: "policy-sha-1",
  policy: `schema_version: "1.0"
principals:
  alice:
    display_name: Alice Smith
    auth_version: 2
    grants:
      sample-model: commenter
      network-hubs: reader
`,
  projects: [
    { path: "projects/sample-model/project.yaml", text: "project:\n  key: sample-model\n  title: Sample Model\n  lifecycle: active\n" },
    { path: "projects/container/project.yaml", text: "project:\n  key: network-hubs\n  title: Network Hubs\n  lifecycle: active\n" },
  ],
};

describe("shared access policy", () => {
  it("resolves active project roots and exact role capabilities", () => {
    const snapshot = parseAccessPolicy(configuration);
    expect(snapshot.policySha).toBe("policy-sha-1");
    expect(snapshot.projects).toEqual([
      { key: "network-hubs", title: "Network Hubs" },
      { key: "sample-model", title: "Sample Model" },
    ]);
    const scope = coauthorScope(snapshot, "alice", 2);
    expect(scope?.displayName).toBe("Alice Smith");
    expect(canReadProjects(scope!, ["sample-model", "network-hubs"])).toBe(true);
    expect(canWriteProjects(scope!, ["sample-model"], "commenter")).toBe(true);
    expect(canWriteProjects(scope!, ["sample-model"], "editor")).toBe(false);
    expect(canWriteProjects(scope!, ["sample-model", "network-hubs"], "commenter")).toBe(false);
    expect(canReadProjects(scope!, [])).toBe(false);
    expect(projectForAsset(scope!, "projects/sample-model/figures/a.pdf")).toBe("sample-model");
    expect(projectForAsset(scope!, "other-notes/a.pdf")).toBeNull();
  });

  it("invalidates sessions when auth_version changes", () => {
    const snapshot = parseAccessPolicy(configuration);
    expect(coauthorScope(snapshot, "alice", 1)).toBeNull();
    expect(coauthorScope(snapshot, "missing", 2)).toBeNull();
  });

  it("fails closed on malformed and projectless document declarations", () => {
    const snapshot = parseAccessPolicy(configuration);
    const scope = coauthorScope(snapshot, "alice", 2)!;
    expect(canReadProjects(scope, projectsForMeta({ projects: ["sample-model", 7] }))).toBe(false);
    expect(canReadProjects(scope, projectsForMeta({ projects: [] }))).toBe(false);
  });

  it("shares concurrent revision checks without retaining a failed load", async () => {
    let calls = 0;
    let fail = true;
    const provider = new AccessPolicyProvider({
      accessConfiguration: async () => {
        calls++;
        if (fail) throw new Error("temporary GitHub failure");
        return configuration;
      },
    });
    await expect(Promise.all([provider.snapshot(), provider.snapshot()])).rejects.toThrow("temporary GitHub failure");
    expect(calls).toBe(1);
    fail = false;
    await expect(provider.snapshot()).resolves.toMatchObject({ revision: "tree-1" });
    expect(calls).toBe(2);
  });

  it("rejects unknown projects, roles, and duplicate project keys", () => {
    expect(() => parseAccessPolicy({
      ...configuration,
      policy: configuration.policy.replace("network-hubs: reader", "unknown-project: editor"),
    })).toThrow(AccessPolicyError);
    expect(() => parseAccessPolicy({
      ...configuration,
      policy: configuration.policy.replace("sample-model: commenter", "sample-model: owner"),
    })).toThrow(/invalid role/);
    expect(() => parseAccessPolicy({
      ...configuration,
      projects: [...configuration.projects, configuration.projects[0]],
    })).toThrow(/Duplicate active project key/);
    expect(() => parseAccessPolicy({
      ...configuration,
      policy: configuration.policy.replace("auth_version: 2", "auth_version: 2\n    email: hidden@example.test"),
    })).toThrow(/unknown fields: email/);
  });

  it("serializes reviewed principal changes deterministically while preserving policy comments", () => {
    const snapshot = parseAccessPolicy(configuration);
    const principals = new Map(snapshot.principals);
    principals.set("bob-smith", normalizeAccessPrincipal(
      "bob-smith",
      "Bob Smith",
      1,
      { "network-hubs": "editor" },
      snapshot.projectRoots,
    ));
    const serialized = serializeAccessPolicy(`# Reviewed access\n${configuration.policy}`, principals.values());
    expect(serialized).toContain("# Reviewed access");
    const reparsed = parseAccessPolicy({ ...configuration, policy: serialized });
    expect(reparsed.principals.get("bob-smith")).toEqual({
      id: "bob-smith",
      displayName: "Bob Smith",
      authVersion: 1,
      grants: { "network-hubs": "editor" },
    });
    expect([...reparsed.principals.keys()]).toEqual(["alice", "bob-smith"]);
  });
});
