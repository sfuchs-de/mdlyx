import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessPolicyProvider, type AccessConfiguration } from "./access-policy";
import { createApp } from "./app";
import type { Config } from "./config";
import type { GitHubLibraryApi } from "./github";
import { MemoryInviteStore } from "./invite-store";

const servers: ReturnType<typeof createServer>[] = [];

const config: Config = {
  appOrigin: "https://mathdown.test",
  apiOrigin: "https://api.mathdown.test",
  desktopAppOrigins: ["tauri://localhost"],
  allowedLogin: "example-owner",
  libraryOwner: "example-owner",
  libraryRepo: "research-library",
  libraryBranch: "main",
  libraryProtectedBranch: "protected-main",
  accessPolicyPath: "library-access.yaml",
  releaseOwner: "example-owner",
  releaseRepo: "mdlyx",
  sessionSecret: "shared-access-session-secret",
  inviteTokenSecret: "shared-access-invite-secret",
  githubAppId: "1",
  githubClientId: "client",
  githubClientSecret: "secret",
  githubInstallationId: "2",
  githubPrivateKey: "key",
};

const sharedDocument = `---
library: {"id":"shared","projects":["sample-model"]}
comments: []
---

# Shared

Body.
`;

const hiddenDocument = `---
library: {"id":"hidden","projects":["example-logistics"]}
---

# Hidden
`;

let configuration: AccessConfiguration;

function policy(role: "reader" | "commenter" | "editor", authVersion = 1): AccessConfiguration {
  return {
    revision: `policy-${role}-${authVersion}`,
    policySha: `policy-sha-${authVersion}`,
    policy: `schema_version: "1.0"
principals:
  alice:
    display_name: Alice Smith
    auth_version: ${authVersion}
    grants:
      sample-model: ${role}
`,
    projects: [
      { path: "projects/sample-model/project.yaml", text: "project:\n  key: sample-model\n  title: Sample Model\n  lifecycle: active\n" },
      { path: "projects/example-logistics/project.yaml", text: "project:\n  key: example-logistics\n  title: Example Logistics\n  lifecycle: active\n" },
    ],
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start(role: "reader" | "commenter" | "editor") {
  configuration = policy(role);
  const writes: Array<{ path: string; text: string; actor?: { principalId: string; displayName: string } }> = [];
  const github = {
    oauthUser: async () => ({ login: "example-owner" }),
    accessConfiguration: async () => configuration,
    index: async () => ({
      revision: "tree-1",
      entries: [
        { path: "projects/sample-model/shared.md", sha: "sha-shared", meta: { projects: ["sample-model"] }, openCommentCount: 0 },
        { path: "projects/sample-model/generated.md", sha: "sha-generated", meta: { projects: ["sample-model"], projection: { read_only: true } }, openCommentCount: 0 },
        { path: "projects/sample-model/cross-project.md", sha: "sha-cross", meta: { projects: ["sample-model", "example-logistics"] }, openCommentCount: 0 },
        { path: "projects/example-logistics/hidden.md", sha: "sha-hidden", meta: { projects: ["example-logistics"] }, openCommentCount: 0 },
        { path: "other-notes/private.md", sha: "sha-other", meta: {}, openCommentCount: 0 },
      ],
    }),
    list: async () => [
      { path: "projects/sample-model/shared.md", sha: "sha-shared", text: sharedDocument },
      { path: "projects/sample-model/generated.md", sha: "sha-generated", text: sharedDocument },
      { path: "projects/sample-model/cross-project.md", sha: "sha-cross", text: hiddenDocument },
      { path: "projects/example-logistics/hidden.md", sha: "sha-hidden", text: hiddenDocument },
      { path: "other-notes/private.md", sha: "sha-other", text: "# Private" },
    ],
    read: async (path: string) => path.includes("hidden")
      ? { path, sha: "sha-hidden", text: hiddenDocument }
      : { path, sha: "sha-shared", text: sharedDocument },
    write: vi.fn(async (path: string, text: string, _sha?: string, actor?: { principalId: string; displayName: string }) => {
      writes.push({ path, text, actor });
      return { path, sha: "sha-next", text };
    }),
    writeAccessPolicy: vi.fn(async (text: string, expectedSha: string) => {
      configuration = {
        ...configuration,
        revision: `${configuration.revision}-next`,
        policySha: `${expectedSha}-next`,
        policy: text,
      };
      return {
        path: "library-access.yaml",
        sha: configuration.policySha,
        text,
      };
    }),
    assets: async () => ({
      revision: "assets-1",
      entries: [
        { path: "projects/sample-model/figure.png", sha: "asset-1", size: 10 },
        { path: "other-notes/private.pdf", sha: "asset-2", size: 10 },
      ],
    }),
    readAsset: async (path: string) => ({ path, sha: "asset-1", size: 10, content: "AA==" }),
    writeAsset: vi.fn(async (path: string) => ({ path, sha: "asset-next", size: 10 })),
  } as unknown as GitHubLibraryApi;
  const invites = new MemoryInviteStore();
  const token = "A".repeat(43);
  const tokenDigest = createHmac("sha256", config.inviteTokenSecret)
    .update(`mathdown-invite-v1:${token}`)
    .digest("hex");
  await invites.put({
    id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    tokenDigest,
    principalId: "alice",
    authVersion: 1,
    origin: config.appOrigin,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  const server = createServer(createApp(
    config,
    github,
    { version: "0.4.0", revision: "test" },
    undefined,
    invites,
    new AccessPolicyProvider({ accessConfiguration: async () => configuration }),
  ));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, token, writes };
}

async function redeem(base: string, token: string): Promise<{ cookie: string; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/auth/invite/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.appOrigin },
    body: JSON.stringify({ token }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  return { cookie, body: await response.json() as Record<string, unknown> };
}

async function ownerCookie(base: string): Promise<string> {
  const begin = await fetch(`${base}/auth/github`, { redirect: "manual" });
  const destination = new URL(begin.headers.get("location") ?? "");
  const oauthCookie = begin.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const complete = await fetch(`${base}/auth/complete`, {
    method: "POST",
    headers: { cookie: oauthCookie, origin: config.appOrigin, "content-type": "application/json" },
    body: JSON.stringify({ code: "owner-code", state: destination.searchParams.get("state") }),
  });
  expect(complete.status).toBe(200);
  return complete.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

describe("shared-project API authorization", () => {
  it("does not consume an invitation outside its hosted origin", async () => {
    const { base, token } = await start("reader");
    const rejected = await fetch(`${base}/auth/invite/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(rejected.status).toBe(400);
    await expect(redeem(base, token)).resolves.toMatchObject({ body: { authenticated: true } });
  });

  it("lets only the owner list, create, and revoke invitations", async () => {
    const { base } = await start("commenter");
    const unauthenticated = await fetch(`${base}/v1/sharing/access`);
    expect(unauthenticated.status).toBe(403);
    const cookie = await ownerCookie(base);
    const access = await fetch(`${base}/v1/sharing/access`, { headers: { cookie } });
    expect(await access.json()).toMatchObject({
      principals: [{
        id: "alice",
        displayName: "Alice Smith",
        authVersion: 1,
        grants: { "sample-model": "commenter" },
      }],
      invitations: [{ id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", principalId: "alice" }],
    });
    const created = await fetch(`${base}/v1/sharing/invites`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ principalId: "alice", expiresInSeconds: 3_600 }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { invitation: { id: string; url: string } };
    expect(createdBody.invitation.url).toMatch(/^https:\/\/mathdown\.test\/invite#token=[A-Za-z0-9_-]{43}$/);
    expect(createdBody.invitation.url).not.toContain("alice");
    const revoked = await fetch(`${base}/v1/sharing/invites/${createdBody.invitation.id}/revoke`, {
      method: "POST",
      headers: { cookie },
    });
    expect(revoked.status).toBe(204);
  });

  it("lets the owner manage coauthors and project roles with SHA conflict protection", async () => {
    const { base } = await start("commenter");
    const cookie = await ownerCookie(base);
    const stale = await fetch(`${base}/v1/sharing/principals`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        id: "bob",
        displayName: "Bob Smith",
        grants: { "example-logistics": "reader" },
        expectedPolicySha: "stale",
      }),
    });
    expect(stale.status).toBe(409);

    const created = await fetch(`${base}/v1/sharing/principals`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        id: "bob",
        displayName: "Bob Smith",
        grants: { "example-logistics": "reader" },
        expectedPolicySha: "policy-sha-1",
      }),
    });
    expect(created.status).toBe(201);

    let access = await fetch(`${base}/v1/sharing/access`, { headers: { cookie } });
    let accessBody = await access.json() as {
      policySha: string;
      principals: Array<{ id: string; authVersion: number; grants: Record<string, string> }>;
      projects: Array<{ key: string; title: string }>;
      invitations: Array<{ principalId: string }>;
    };
    expect(accessBody.projects).toEqual([
      { key: "example-logistics", title: "Example Logistics" },
      { key: "sample-model", title: "Sample Model" },
    ]);
    expect(accessBody.principals.find((principal) => principal.id === "bob")).toMatchObject({
      authVersion: 1,
      grants: { "example-logistics": "reader" },
    });

    const updated = await fetch(`${base}/v1/sharing/principals/bob`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Robert Smith",
        grants: { "sample-model": "commenter", "example-logistics": "editor" },
        expectedPolicySha: accessBody.policySha,
      }),
    });
    expect(updated.status).toBe(200);
    access = await fetch(`${base}/v1/sharing/access`, { headers: { cookie } });
    accessBody = await access.json() as typeof accessBody;
    expect(accessBody.principals.find((principal) => principal.id === "bob")).toMatchObject({
      grants: { "sample-model": "commenter", "example-logistics": "editor" },
    });

    const invited = await fetch(`${base}/v1/sharing/invites`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ principalId: "bob", expiresInSeconds: 86_400 }),
    });
    expect(invited.status).toBe(201);
    const revoked = await fetch(`${base}/v1/sharing/principals/bob/revoke-sessions`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedPolicySha: accessBody.policySha }),
    });
    expect(revoked.status).toBe(200);
    access = await fetch(`${base}/v1/sharing/access`, { headers: { cookie } });
    accessBody = await access.json() as typeof accessBody;
    expect(accessBody.principals.find((principal) => principal.id === "bob")?.authVersion).toBe(2);
    expect(accessBody.invitations.some((invitation) => invitation.principalId === "bob")).toBe(false);

    const removed = await fetch(`${base}/v1/sharing/principals/bob/remove`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedPolicySha: accessBody.policySha }),
    });
    expect(removed.status).toBe(200);
    access = await fetch(`${base}/v1/sharing/access`, { headers: { cookie } });
    accessBody = await access.json() as typeof accessBody;
    expect(accessBody.principals.some((principal) => principal.id === "bob")).toBe(false);
  });

  it("redeems once, filters indexes, hides direct paths, and revokes by auth version", async () => {
    const { base, token } = await start("reader");
    const accepted = await redeem(base, token);
    expect(accepted.body).toMatchObject({
      authenticated: true,
      principal: { id: "alice", displayName: "Alice Smith", kind: "coauthor" },
      grants: [{ project: "sample-model", role: "reader" }],
    });
    const replay = await fetch(`${base}/auth/invite/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: config.appOrigin },
      body: JSON.stringify({ token }),
    });
    expect(replay.status).toBe(410);

    const index = await fetch(`${base}/v2/library/index`, { headers: { cookie: accepted.cookie } });
    expect(index.status).toBe(200);
    expect(index.headers.get("etag")).toMatch(/^"tree-1\.[0-9a-f]{24}"$/);
    expect((await index.json() as { entries: Array<{ path: string }> }).entries.map((entry) => entry.path))
      .toEqual(["projects/sample-model/shared.md", "projects/sample-model/generated.md"]);
    const assets = await fetch(`${base}/v2/library/assets`, { headers: { cookie: accepted.cookie } });
    expect((await assets.json() as { entries: Array<{ path: string }> }).entries.map((entry) => entry.path))
      .toEqual(["projects/sample-model/figure.png"]);
    const hidden = await fetch(`${base}/v1/library/documents?path=${encodeURIComponent("projects/example-logistics/hidden.md")}`, {
      headers: { cookie: accepted.cookie },
    });
    expect(hidden.status).toBe(404);
    const projectless = await fetch(`${base}/v1/library/documents?path=${encodeURIComponent("other-notes/private.md")}`, {
      headers: { cookie: accepted.cookie },
    });
    expect(projectless.status).toBe(404);

    configuration = policy("reader", 2);
    const revoked = await fetch(`${base}/auth/session`, { headers: { cookie: accepted.cookie } });
    expect(await revoked.json()).toEqual({ authenticated: false });
  });

  it("keeps reader documents immutable", async () => {
    const { base, token } = await start("reader");
    const { cookie } = await redeem(base, token);
    const response = await fetch(`${base}/v1/library/documents?path=${encodeURIComponent("projects/sample-model/shared.md")}`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: sharedDocument, expectedSha: "sha-shared" }),
    });
    expect(response.status).toBe(403);
  });

  it("allows comment-only saves, stamps attribution, and rejects body escalation", async () => {
    const { base, token, writes } = await start("commenter");
    const { cookie } = await redeem(base, token);
    const commented = sharedDocument.replace(
      "comments: []",
      'comments: [{"id":"c1","kind":"ai","author":"spoof","body":"Review this","resolved":false,"createdAt":1,"replies":[]}]',
    );
    const saved = await fetch(`${base}/v1/library/documents?path=${encodeURIComponent("projects/sample-model/shared.md")}`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: commented, expectedSha: "sha-shared" }),
    });
    expect(saved.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].actor).toEqual({ principalId: "alice", displayName: "Alice Smith" });
    expect(writes[0].text).toContain('"kind":"user","author":"Alice Smith"');
    expect(writes[0].text).toContain('"body":"Review this","resolved":false,"createdAt":');
    expect(writes[0].text).toContain('"principalId":"alice"');

    const escalated = await fetch(`${base}/v1/library/documents?path=${encodeURIComponent("projects/sample-model/shared.md")}`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: commented.replace("Body.", "Changed."), expectedSha: "sha-shared" }),
    });
    expect(escalated.status).toBe(403);
  });

  it("allows editors to save existing files with attributed commits", async () => {
    const { base, token, writes } = await start("editor");
    const { cookie } = await redeem(base, token);
    const response = await fetch(`${base}/v1/library/documents?path=${encodeURIComponent("projects/sample-model/shared.md")}`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: sharedDocument.replace("Body.", "Edited body."), expectedSha: "sha-shared" }),
    });
    expect(response.status).toBe(200);
    expect(writes[0]).toMatchObject({
      path: "projects/sample-model/shared.md",
      actor: { principalId: "alice", displayName: "Alice Smith" },
    });
    const newDocument = await fetch(`${base}/v1/library/documents?path=${encodeURIComponent("projects/sample-model/new.md")}`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: sharedDocument, expectedSha: "sha-shared" }),
    });
    expect(newDocument.status).toBe(404);
    const structural = await fetch(`${base}/v1/library/documents?path=${encodeURIComponent("projects/sample-model/shared.md")}`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        text: sharedDocument.replace('"sample-model"', '"example-logistics"'),
        expectedSha: "sha-shared",
      }),
    });
    expect(structural.status).toBe(403);
    const generated = await fetch(`${base}/v1/library/documents?path=${encodeURIComponent("projects/sample-model/generated.md")}`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: sharedDocument, expectedSha: "sha-generated" }),
    });
    expect(generated.status).toBe(403);

    const newAsset = await fetch(`${base}/v2/library/assets/file?path=${encodeURIComponent("projects/sample-model/new.png")}`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "if-match": '"asset-1"' },
      body: JSON.stringify({ content: "AA==" }),
    });
    expect(newAsset.status).toBe(404);
  });
});
