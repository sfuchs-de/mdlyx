import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import {
  GitHubLibraryApi,
  MAX_UPDATER_ASSET_BYTES,
  normaliseAssetPath,
  normaliseLibraryPath,
} from "./github.js";

const libraryKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const releaseKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config: Config = {
  appOrigin: "https://research-library-api.onrender.com",
  apiOrigin: "https://research-library-api.onrender.com",
  desktopAppOrigins: [],
  allowedLogin: "example-owner",
  libraryOwner: "example-owner",
  libraryRepo: "research-library",
  libraryBranch: "main",
  libraryProtectedBranch: "protected-main",
  accessPolicyPath: "library-access.yaml",
  releaseOwner: "example-owner",
  releaseRepo: "mdlyx",
  releaseGithubAppId: "789",
  releaseGithubInstallationId: "987",
  releaseGithubPrivateKey: releaseKeys.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  sessionSecret: "test-secret",
  inviteTokenSecret: "invite-test-secret",
  githubAppId: "123",
  githubClientId: "client-id",
  githubClientSecret: "client-secret",
  githubInstallationId: "456",
  githubPrivateKey: libraryKeys.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GitHub library API", () => {
  it("accepts only repository-relative markdown paths", () => {
    expect(normaliseLibraryPath("drafts/intro.md")).toBe("drafts/intro.md");
    expect(normaliseLibraryPath("../outside.md")).toBeNull();
    expect(normaliseLibraryPath(".git/config.md")).toBeNull();
    expect(normaliseLibraryPath("notes.txt")).toBeNull();
  });

  it("accepts only supported repository-relative asset paths", () => {
    expect(normaliseAssetPath("assets/clock.pdf")).toBe("assets/clock.pdf");
    expect(normaliseAssetPath("references/library.bib")).toBe("references/library.bib");
    expect(normaliseAssetPath("formal/certificate-map.yaml")).toBe("formal/certificate-map.yaml");
    expect(normaliseAssetPath("formal/Mathdown/Proof.lean")).toBe("formal/Mathdown/Proof.lean");
    expect(normaliseAssetPath("formal/lake-manifest.json")).toBe("formal/lake-manifest.json");
    expect(normaliseAssetPath("projects/p/project.yaml")).toBeNull();
    expect(normaliseAssetPath("../secret.pdf")).toBeNull();
    expect(normaliseAssetPath("assets/.hidden.pdf")).toBeNull();
    expect(normaliseAssetPath("notes.md")).toBeNull();
  });

  it("reads and SHA-guards binary assets", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const bytes = Buffer.from([0, 1, 2, 255]);
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (init?.method === "PUT") return json({ content: { sha: "asset-new" } });
      return json({ content: bytes.toString("base64"), encoding: "base64", sha: "asset-old", size: 4 });
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);
    await expect(api.readAsset("assets/clock.pdf")).resolves.toEqual({
      path: "assets/clock.pdf",
      sha: "asset-old",
      size: 4,
      content: bytes.toString("base64"),
    });
    await expect(api.writeAsset("assets/clock.pdf", bytes.toString("base64"), "asset-old"))
      .resolves.toEqual({ path: "assets/clock.pdf", sha: "asset-new", size: 4 });
    const body = JSON.parse(String(calls.at(-1)?.init?.body));
    expect(body.sha).toBe("asset-old");
    expect(Buffer.from(body.content, "base64")).toEqual(bytes);
  });

  it("reads large assets through GitHub's immutable blob endpoint", async () => {
    const bytes = Buffer.from([9, 8, 7]);
    const calls: string[] = [];
    const request = async (url: string | URL | Request): Promise<Response> => {
      calls.push(String(url));
      if (String(url).endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (String(url).includes("/contents/")) {
        return json({ sha: "large-blob", size: 2_000_000, encoding: "none" });
      }
      return json({ content: bytes.toString("base64"), encoding: "base64" });
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);

    await expect(api.readAsset("assets/clock.pdf")).resolves.toMatchObject({
      sha: "large-blob",
      content: bytes.toString("base64"),
    });
    expect(calls.some((url) => url.includes("/git/blobs/large-blob"))).toBe(true);
  });

  it("writes with the caller SHA and returns GitHub's new SHA", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      return json({ content: { sha: "new-sha" } });
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);
    const saved = await api.write("drafts/intro.md", "# Hello\n", "old-sha");

    expect(saved).toEqual({ path: "drafts/intro.md", sha: "new-sha", text: "# Hello\n" });
    const write = calls.at(-1)!;
    const body = JSON.parse(String(write.init?.body));
    expect(body.sha).toBe("old-sha");
    expect(Buffer.from(body.content, "base64").toString("utf8")).toBe("# Hello\n");
    expect(calls.some((call) => call.url.endsWith("/app/installations/456/access_tokens"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/app/installations/987/access_tokens"))).toBe(false);
  });

  it("updates only the configured access policy with an explicit blob SHA", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      return json({ content: { sha: "new-policy-sha" } });
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);
    const text = 'schema_version: "1.0"\nprincipals: {}\n';
    await expect(api.writeAccessPolicy(text, "old-policy-sha")).resolves.toEqual({
      path: "library-access.yaml",
      sha: "new-policy-sha",
      text,
    });
    const write = calls.at(-1)!;
    expect(write.url).toContain("/contents/library-access.yaml");
    expect(JSON.parse(String(write.init?.body))).toMatchObject({
      message: "mdlyx: update shared access policy",
      branch: "main",
      sha: "old-policy-sha",
    });
    await expect(api.writeAccessPolicy(text, "")).rejects.toMatchObject({ status: 400 });
  });

  it("attributes coauthor commits without inventing an email address", async () => {
    let requestBody: Record<string, unknown> = {};
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url).endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ content: { sha: "new-sha" } });
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);
    await api.write("drafts/intro.md", "# Hello\n", "old-sha", {
      principalId: "alice",
      displayName: "Alice Smith\nspoofed trailer",
    });
    expect(requestBody.message).toBe(
      "mdlyx(alice): save drafts/intro.md\n\n"
      + "MdLyx-Principal: alice\nMdLyx-Display-Name: Alice Smith spoofed trailer",
    );
    expect(String(requestBody.message)).not.toMatch(/@|email/i);
  });

  it("allows prose, title, tags, and existing-asset replacement on the protected branch", async () => {
    const guardedConfig = { ...config, libraryProtectedBranch: "main" };
    const previous = `---\nlibrary: {"id":"intro","title":"Old","kind":"notes","status":"draft","tags":["old"],"projects":["p"],"contains":[],"related":[]}\n---\nOld prose\n`;
    const next = previous
      .replace('"title":"Old"', '"title":"New"')
      .replace('"tags":["old"]', '"tags":["new"]')
      .replace("Old prose", "Improved prose");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const value = String(url);
      calls.push({ url: value, init });
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.endsWith("/git/blobs/old-sha")) {
        return json({ content: Buffer.from(previous).toString("base64"), encoding: "base64" });
      }
      if (init?.method === "PUT") return json({ content: { sha: "new-sha" } });
      return json({ message: "unexpected" }, 500);
    };
    const api = new GitHubLibraryApi(guardedConfig, request as typeof fetch);

    await expect(api.write("projects/p/intro.md", next, "old-sha"))
      .resolves.toMatchObject({ sha: "new-sha" });
    await expect(api.writeAsset("assets/existing.pdf", "AA==", "asset-old"))
      .resolves.toEqual({ path: "assets/existing.pdf", sha: "new-sha", size: 1 });
    const putBodies = calls
      .filter((call) => call.init?.method === "PUT")
      .map((call) => JSON.parse(String(call.init?.body)) as { branch?: string; sha?: string });
    expect(putBodies).toEqual([
      expect.objectContaining({ branch: "main", sha: "old-sha" }),
      expect.objectContaining({ branch: "main", sha: "asset-old" }),
    ]);
  });

  it("treats blank direct branch configuration as protected main", async () => {
    const blankConfig = { ...config, libraryBranch: "", libraryProtectedBranch: "" };
    const previous = `---\nlibrary: {"id":"intro","title":"Old","kind":"notes","status":"draft","tags":[],"projects":["p"],"contains":[],"related":[]}\n---\nOld prose\n`;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const value = String(url);
      calls.push({ url: value, init });
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.endsWith("/git/blobs/old-sha")) {
        return json({ content: Buffer.from(previous).toString("base64"), encoding: "base64" });
      }
      if (init?.method === "PUT") return json({ content: { sha: "created-sha" } });
      return json({ message: "unexpected" }, 500);
    };
    const api = new GitHubLibraryApi(blankConfig, request as typeof fetch);

    await expect(api.write("projects/p/intro.md", previous.replace("Old prose", "New prose"), "old-sha"))
      .resolves.toMatchObject({ sha: "created-sha" });
    await expect(api.writeAsset("assets/existing.pdf", "AA==", "asset-old"))
      .resolves.toMatchObject({ sha: "created-sha" });
    await expect(api.write("new.md", "# New\n")).rejects.toMatchObject({ status: 403 });
    await expect(api.writeAsset("assets/new.pdf", "AA==")).rejects.toMatchObject({ status: 403 });
    expect(calls.filter((call) => call.init?.method === "PUT").map((call) =>
      (JSON.parse(String(call.init?.body)) as { branch?: string }).branch
    )).toEqual(["main", "main"]);
  });

  it("requires a topic branch for new documents and assets on the protected branch", async () => {
    const guardedConfig = { ...config, libraryProtectedBranch: "main" };
    const api = new GitHubLibraryApi(guardedConfig, vi.fn() as unknown as typeof fetch);

    await expect(api.write("new.md", "# New\n")).rejects.toMatchObject({ status: 403 });
    await expect(api.writeAsset("assets/new.pdf", "AA==")).rejects.toMatchObject({ status: 403 });
  });

  it("requires a topic branch for structural metadata and research-state manifests", async () => {
    const guardedConfig = { ...config, libraryProtectedBranch: "main" };
    const previous = `---\nlibrary: {"id":"intro","kind":"notes","status":"draft","projects":["p"],"contains":[],"related":[]}\n---\nBody\n`;
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      return json({ content: Buffer.from(previous).toString("base64"), encoding: "base64" });
    };
    const changedStatus = previous.replace('"status":"draft"', '"status":"review"');
    const changedVisibility = previous.replace('"status":"draft"', '"status":"draft","visibility":"support"');
    const changedAuthority = previous.replace(
      '"related":[]',
      '"related":[],"task_authority":{"mode":"external","system":"Task Manager","url":"https://example.test/tasks"}',
    );
    const dependencyManifest = previous.replace('"contains":[]', '"contains":["dependency-graph"]');

    await expect(new GitHubLibraryApi(guardedConfig, request as typeof fetch)
      .write("projects/p/intro.md", changedStatus, "old-sha"))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining("structural library metadata (status)") });
    await expect(new GitHubLibraryApi(guardedConfig, request as typeof fetch)
      .write("projects/p/intro.md", changedVisibility, "old-sha"))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining("structural library metadata (visibility)") });
    await expect(new GitHubLibraryApi(guardedConfig, request as typeof fetch)
      .write("projects/p/intro.md", changedAuthority, "old-sha"))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining("task_authority") });
    await expect(new GitHubLibraryApi(guardedConfig, request as typeof fetch)
      .write("projects/p/verification/claim-status.md", previous, "old-sha"))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining("claim-status") });
    await expect(new GitHubLibraryApi(guardedConfig, request as typeof fetch)
      .write("projects/p/verification/claims.md", dependencyManifest, "old-sha"))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining("dependency-graph") });
  });

  it("guards block-style and alias-resolved structural metadata on protected main", async () => {
    const guardedConfig = { ...config, libraryProtectedBranch: "main" };
    const previous = `---\nmacros:\n  RR: "\\mathbb{R}"\ndefaults: &defaults\n  status: draft\nlibrary:\n  <<: *defaults\n  id: intro\n  title: Old\n  kind: notes\n  tags: [old]\n  projects:\n    - p\n  contains: []\n  related: []\n---\nBody\n`;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const value = String(url);
      calls.push({ url: value, init });
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.endsWith("/git/blobs/old-sha")) {
        return json({ content: Buffer.from(previous).toString("base64"), encoding: "base64" });
      }
      if (init?.method === "PUT") return json({ content: { sha: "new-sha" } });
      return json({ message: "unexpected" }, 500);
    };
    const api = new GitHubLibraryApi(guardedConfig, request as typeof fetch);

    const allowed = previous
      .replace("title: Old", "title: New")
      .replace("tags: [old]", "tags: [new]")
      .replace("Body", "Improved prose");
    await expect(api.write("projects/p/intro.md", allowed, "old-sha"))
      .resolves.toMatchObject({ sha: "new-sha" });
    await expect(api.write("projects/p/intro.md", previous.replace("status: draft", "status: review"), "old-sha"))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining("status") });
    await expect(api.write("projects/p/intro.md", previous.replace("    - p", "    - q"), "old-sha"))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining("projects") });
    await expect(api.write(
      "projects/p/intro.md",
      previous.replace("contains: []", "contains:\n    - dependency-graph"),
      "old-sha",
    )).rejects.toMatchObject({ status: 403, message: expect.stringContaining("dependency-graph") });
    await expect(api.write(
      "projects/p/intro.md",
      previous.replace(
        "  related: []",
        "  related: []\n  task_authority:\n    mode: external\n    system: Task Manager\n    url: https://example.test/tasks",
      ),
      "old-sha",
    )).rejects.toMatchObject({ status: 403, message: expect.stringContaining("task_authority") });
  });

  it("fails closed on malformed, unresolved, or duplicate library frontmatter", async () => {
    const guardedConfig = { ...config, libraryProtectedBranch: "main" };
    const previous = `---\nlibrary:\n  id: intro\n  kind: notes\n  status: draft\n  projects: [p]\n---\nBody\n`;
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      return json({ content: Buffer.from(previous).toString("base64"), encoding: "base64" });
    };
    const api = new GitHubLibraryApi(guardedConfig, request as typeof fetch);
    const malformed = previous.replace("library:\n", "library: [\n");
    const unresolved = previous.replace(/library:[\s\S]*?---\nBody/, "library: *missing\n---\nBody");
    const duplicate = previous.replace(
      "  id: intro",
      "  id: intro\n  status: review\n  status: draft",
    );
    const duplicateLibrary = `---\nlibrary: {id: intro, status: draft}\nlibrary: {id: other, status: review}\n---\nBody\n`;
    const recursiveAlias = `---\nlibrary: &library\n  id: intro\n  task_authority: *library\n---\nBody\n`;
    const invalidProjects = previous.replace("projects: [p]", "projects: {}");
    const invalidContains = previous.replace("projects: [p]", "projects: [p]\n  contains: dependency-graph");
    const inheritedDuplicateAliasKey = `---\nidkey: &idkey id\nmetadata: &metadata\n  ? *idkey\n  : intro\n  id: replacement\nbase: &base\n  library: *metadata\n<<: *base\n---\nBody\n`;
    const inheritedNullLibrary = `---\nbase: &base\n  library:\n<<: *base\n---\nBody\n`;

    for (const candidate of [
      malformed,
      unresolved,
      duplicate,
      duplicateLibrary,
      recursiveAlias,
      invalidProjects,
      invalidContains,
      inheritedDuplicateAliasKey,
      inheritedNullLibrary,
    ]) {
      await expect(api.write("projects/p/intro.md", candidate, "old-sha"))
        .rejects.toMatchObject({
          status: 403,
          message: expect.stringContaining("malformed or ambiguous library frontmatter"),
        });
    }
  });

  it("allows structural writes on a distinct topic branch", async () => {
    const topicConfig = { ...config, libraryBranch: "theory/new-result", libraryProtectedBranch: "main" };
    const requests: RequestInit[] = [];
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url).endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (init) requests.push(init);
      return json({ content: { sha: "new-sha" } });
    };
    const api = new GitHubLibraryApi(topicConfig, request as typeof fetch);

    await expect(api.write("projects/p/new.md", "# New\n")).resolves.toMatchObject({ sha: "new-sha" });
    await expect(api.writeAsset("assets/new.pdf", "AA=="))
      .resolves.toEqual({ path: "assets/new.pdf", sha: "new-sha", size: 1 });
    expect(requests.map((init) => JSON.parse(String(init.body)).branch))
      .toEqual(["theory/new-result", "theory/new-result"]);
  });

  it("bounds parallel blob reads and reuses immutable SHAs across listings", async () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      path: `notes/${String(index).padStart(2, "0")}.md`,
      type: "blob",
      sha: `sha-${index}`,
    }));
    let activeBlobReads = 0;
    let peakBlobReads = 0;
    let treeRequests = 0;
    let blobRequests = 0;
    let tokenRequests = 0;
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        tokenRequests++;
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.includes("/git/trees/")) {
        treeRequests++;
        return json({ tree: entries });
      }
      if (value.includes("/git/blobs/")) {
        blobRequests++;
        activeBlobReads++;
        peakBlobReads = Math.max(peakBlobReads, activeBlobReads);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeBlobReads--;
        const sha = decodeURIComponent(value.slice(value.lastIndexOf("/") + 1));
        return json({ content: Buffer.from(`# ${sha}\n`).toString("base64"), encoding: "base64" });
      }
      return json({ message: "Unexpected request" }, 500);
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);

    const first = await api.list();
    const second = await api.list();

    expect(first).toEqual(second);
    expect(first).toHaveLength(20);
    expect(peakBlobReads).toBeGreaterThan(1);
    expect(peakBlobReads).toBeLessThanOrEqual(8);
    expect(treeRequests).toBe(2);
    expect(blobRequests).toBe(20);
    expect(tokenRequests).toBe(1);
  });

  it("builds a body-free metadata index with a branch revision", async () => {
    const source = `---\nlibrary: {"id":"proof","projects":["demo"]}\ncomments: [{"resolved":false},{"resolved":true},{}]\n---\nBody\n`;
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.includes("/git/trees/")) {
        return json({ sha: "tree-revision", truncated: false, tree: [
          { path: "nested/proof.md", type: "blob", sha: "blob-sha" },
        ] });
      }
      return json({ content: Buffer.from(source).toString("base64"), encoding: "base64" });
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);

    await expect(api.index()).resolves.toEqual({
      revision: "tree-revision",
      entries: [{
        path: "nested/proof.md",
        sha: "blob-sha",
        meta: { id: "proof", projects: ["demo"] },
        openCommentCount: 2,
        commentActivityDigest: "sha256:3cf49d31a1bc483a324294662c0e8878f65bbe7daeef13f35d3eea1ca7f682da",
      }],
    });
  });

  it("loads the access policy and in-place project roots from the same repository revision", async () => {
    const blobs: Record<string, string> = {
      policy: 'schema_version: "1.0"\nprincipals: {}\n',
      "sample-model": "project:\n  key: sample-model\n  lifecycle: active\n",
      "example-logistics": "project:\n  key: example-logistics\n  lifecycle: active\n",
    };
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.includes("/git/trees/")) {
        return json({ sha: "access-tree", truncated: false, tree: [
          { path: "library-access.yaml", type: "blob", sha: "policy" },
          { path: "projects/sample-model/project.yaml", type: "blob", sha: "sample-model" },
          { path: "projects/example-logistics/project.yaml", type: "blob", sha: "example-logistics" },
          { path: "docs/example/project.yaml", type: "blob", sha: "ignored" },
        ] });
      }
      const sha = decodeURIComponent(value.slice(value.lastIndexOf("/") + 1));
      return json({ content: Buffer.from(blobs[sha] ?? "ignored").toString("base64"), encoding: "base64" });
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);
    await expect(api.accessConfiguration()).resolves.toEqual({
      revision: "access-tree",
      policySha: "policy",
      policy: blobs.policy,
      projects: [
        { path: "projects/example-logistics/project.yaml", text: blobs["example-logistics"] },
        { path: "projects/sample-model/project.yaml", text: blobs["sample-model"] },
      ],
    });
  });

  it("indexes block-style and aliased library metadata for project grouping", async () => {
    const source = `---\nmetadata: &metadata\n  id: proof\n  projects:\n    - demo\nlibrary: *metadata\ncomments: [{"resolved":false}]\n---\nBody\n`;
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.includes("/git/trees/")) {
        return json({ sha: "tree-revision", truncated: false, tree: [
          { path: "nested/proof.md", type: "blob", sha: "block-blob-sha" },
        ] });
      }
      return json({ content: Buffer.from(source).toString("base64"), encoding: "base64" });
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);

    await expect(api.index()).resolves.toEqual({
      revision: "tree-revision",
      entries: [{
        path: "nested/proof.md",
        sha: "block-blob-sha",
        meta: { id: "proof", projects: ["demo"] },
        openCommentCount: 1,
        commentActivityDigest: "sha256:0eabb0f446972bf7fc8e8d67a62d2af31d356026ad81759f3544b0dcf2d3f346",
      }],
    });
  });

  it("falls back to subtree traversal when GitHub truncates a recursive tree", async () => {
    const requested: string[] = [];
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      requested.push(value);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.endsWith("/git/trees/main?recursive=1")) {
        return json({ sha: "root-sha", truncated: true, tree: [] });
      }
      if (value.endsWith("/git/trees/main")) {
        return json({ tree: [{ path: "nested", type: "tree", sha: "nested-sha" }] });
      }
      if (value.endsWith("/git/trees/nested-sha")) {
        return json({ tree: [{ path: "proof.md", type: "blob", sha: "proof-sha" }] });
      }
      if (value.endsWith("/git/blobs/proof-sha")) {
        return json({ content: Buffer.from("proof\n").toString("base64"), encoding: "base64" });
      }
      return json({ message: "unexpected" }, 500);
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);

    await expect(api.list()).resolves.toEqual([
      { path: "nested/proof.md", sha: "proof-sha", text: "proof\n" },
    ]);
    expect(requested.some((url) => url.endsWith("/git/trees/nested-sha"))).toBe(true);
  });

  it("deduplicates concurrent reads of the same repository-scoped SHA", async () => {
    let blobRequests = 0;
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.includes("/git/trees/")) {
        return json({ tree: [
          { path: "one.md", type: "blob", sha: "shared-sha" },
          { path: "two.md", type: "blob", sha: "shared-sha" },
        ] });
      }
      blobRequests++;
      await new Promise((resolve) => setTimeout(resolve, 2));
      return json({ content: Buffer.from("shared\n").toString("base64"), encoding: "base64" });
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);

    await expect(api.list()).resolves.toEqual([
      { path: "one.md", sha: "shared-sha", text: "shared\n" },
      { path: "two.md", sha: "shared-sha", text: "shared\n" },
    ]);
    expect(blobRequests).toBe(1);
  });

  it("stops scheduling new blob reads after the first failure", async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      path: `notes/${index}.md`,
      type: "blob",
      sha: `sha-${index}`,
    }));
    let blobRequests = 0;
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.includes("/git/trees/")) return json({ tree: entries });
      blobRequests++;
      if (value.endsWith("/sha-0")) return json({ message: "rate limited" }, 429);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return json({ content: Buffer.from("body").toString("base64"), encoding: "base64" });
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);

    await expect(api.list()).rejects.toMatchObject({ status: 429 });
    expect(blobRequests).toBeLessThanOrEqual(8);
  });

  it("uses GitHub OAuth identity for the connecting user", async () => {
    const request = async (url: string | URL | Request): Promise<Response> => {
      if (String(url).includes("access_token")) return json({ access_token: "user-token" });
      return json({ login: "example-owner" });
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);
    await expect(api.oauthUser("code")).resolves.toEqual({ login: "example-owner" });
  });

  it("starts and polls GitHub device authorization without a client secret", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/login/device/code")) {
        return json({
          device_code: "device-code",
          user_code: "WDJB-MJHT",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        });
      }
      return json({ error: "authorization_pending" }, 400);
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);
    await expect(api.startDeviceAuthorization()).resolves.toMatchObject({
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
      deviceCode: "device-code",
    });
    await expect(api.pollDeviceAuthorization("device-code")).resolves.toEqual({ state: "pending" });
    const body = new URLSearchParams(String(calls.at(-1)?.init?.body));
    expect(body.get("client_secret")).toBeNull();
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
  });

  it("resolves signed updater metadata from the private latest GitHub release", async () => {
    const updaterName = "MdLyx_0.4.0_universal.app.tar.gz";
    const manifest = {
      version: "0.4.0",
      notes: "Durable desktop updates.",
      pub_date: "2026-07-12T12:00:00Z",
      platforms: {
        "darwin-aarch64": {
          signature: "signed-update-payload",
          url: `https://github.com/example-owner/mdlyx/releases/download/v0.4.0/${updaterName}`,
        },
        "darwin-x86_64": {
          signature: "signed-update-payload",
          url: `https://github.com/example-owner/mdlyx/releases/download/v0.4.0/${updaterName}`,
        },
      },
    };
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const value = String(url);
      calls.push({ url: value, authorization: new Headers(init?.headers).get("authorization") });
      if (value.endsWith("/app/installations/987/access_tokens")) {
        return json({ token: "release-installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.endsWith("/repos/example-owner/mdlyx/releases/latest")) {
        return json({
          id: 44,
          tag_name: "v0.4.0",
          immutable: true,
          body: "Release notes fallback",
          published_at: "2026-07-12T11:00:00Z",
          assets: [
            { id: 101, name: "latest.json", size: 500, content_type: "application/json" },
            { id: 202, name: updaterName, size: 42, content_type: "application/gzip" },
          ],
        });
      }
      if (value.endsWith("/releases/assets/101")) return json(manifest);
      return json({ message: "unexpected" }, 500);
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);

    await expect(api.latestUpdaterRelease("darwin", "aarch64", "0.3.1")).resolves.toEqual({
      releaseId: 44,
      version: "0.4.0",
      notes: "Durable desktop updates.",
      pubDate: "2026-07-12T12:00:00Z",
      signature: "signed-update-payload",
      assetId: 202,
      assetName: updaterName,
    });
    await expect(api.latestUpdaterRelease("darwin", "aarch64", "0.4.0")).resolves.toBeNull();
    await expect(api.latestUpdaterRelease("darwin", "aarch64", "0.5.0")).resolves.toBeNull();
    await expect(api.latestUpdaterRelease("darwin", "x86_64", "0.3.1")).resolves.toMatchObject({
      releaseId: 44,
      version: "0.4.0",
      assetId: 202,
      assetName: updaterName,
    });

    const tokenRequest = calls.find((call) => call.url.endsWith("/app/installations/987/access_tokens"));
    const jwt = tokenRequest?.authorization?.replace(/^Bearer /, "") ?? "";
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toMatchObject({ iss: "789" });
    const releaseVerifier = createVerify("RSA-SHA256");
    releaseVerifier.update(`${header}.${payload}`);
    expect(releaseVerifier.verify(releaseKeys.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    const libraryVerifier = createVerify("RSA-SHA256");
    libraryVerifier.update(`${header}.${payload}`);
    expect(libraryVerifier.verify(libraryKeys.publicKey, Buffer.from(signature, "base64url"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/app/installations/456/access_tokens"))).toBe(false);
    const releaseCalls = calls.filter((call) => call.url.includes("/repos/example-owner/mdlyx/"));
    expect(releaseCalls.length).toBeGreaterThan(0);
    expect(releaseCalls.every((call) => call.authorization === "Bearer release-installation-token")).toBe(true);
  });

  it("treats a repository with no published Release as an empty update feed", async () => {
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "release-installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.endsWith("/repos/example-owner/mdlyx/releases/latest")) {
        return json({ message: "Not Found" }, 404);
      }
      return json({ message: "unexpected" }, 500);
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);

    await expect(api.latestUpdaterRelease("darwin", "aarch64", "0.3.1")).resolves.toBeNull();
  });

  it("rejects mutable releases before reading metadata or release-id assets", async () => {
    let metadataRequested = false;
    const mutableRelease = {
      id: 44,
      tag_name: "v0.4.0",
      immutable: false,
      assets: [
        { id: 101, name: "latest.json", size: 200 },
        { id: 202, name: "MdLyx_0.4.0_universal.app.tar.gz", size: 20 },
      ],
    };
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.endsWith("/releases/latest") || value.endsWith("/releases/44")) {
        return json(mutableRelease);
      }
      if (value.endsWith("/releases/assets/101")) metadataRequested = true;
      return json({ message: "unexpected" }, 500);
    };

    await expect(new GitHubLibraryApi(config, request as typeof fetch)
      .latestUpdaterRelease("darwin", "aarch64", "0.3.1"))
      .rejects.toMatchObject({ status: 502, message: "GitHub updater release is not immutable" });
    await expect(new GitHubLibraryApi(config, request as typeof fetch)
      .downloadUpdaterAsset(44, 202, "MdLyx_0.4.0_universal.app.tar.gz"))
      .rejects.toMatchObject({ status: 502, message: "GitHub updater release is not immutable" });
    expect(metadataRequested).toBe(false);
  });

  it("validates updater target, version, signature, and referenced release asset", async () => {
    let githubRequests = 0;
    const request = async (url: string | URL | Request): Promise<Response> => {
      githubRequests++;
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.endsWith("/releases/latest")) {
        return json({
          id: 44,
          tag_name: "v0.4.0",
          immutable: true,
          published_at: "2026-07-12T11:00:00Z",
          assets: [{ id: 101, name: "latest.json", size: 200 }],
        });
      }
      return json({
        version: "0.4.0",
        platforms: {
          "darwin-aarch64": {
            signature: "",
            url: "https://github.com/example/missing.app.tar.gz",
          },
        },
      });
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);

    await expect(api.latestUpdaterRelease("windows", "aarch64", "0.3.1"))
      .rejects.toMatchObject({ status: 400 });
    await expect(api.latestUpdaterRelease("darwin", "aarch64", "not-semver"))
      .rejects.toMatchObject({ status: 400 });
    await expect(api.latestUpdaterRelease("darwin", "aarch64", "0.3.1-01"))
      .rejects.toMatchObject({ status: 400 });
    await expect(api.latestUpdaterRelease("darwin", "aarch64", "9007199254740992.0.0"))
      .rejects.toMatchObject({ status: 400 });
    expect(githubRequests).toBe(0);
    await expect(api.latestUpdaterRelease("darwin", "aarch64", "0.3.1"))
      .rejects.toMatchObject({ status: 502 });
  });

  it("never falls back to the writable library App when release credentials are absent", async () => {
    let requests = 0;
    const api = new GitHubLibraryApi({
      ...config,
      releaseGithubAppId: undefined,
      releaseGithubInstallationId: undefined,
      releaseGithubPrivateKey: undefined,
    }, (async () => {
      requests++;
      return json({ message: "must not be called" }, 500);
    }) as typeof fetch);

    await expect(api.latestUpdaterRelease("darwin", "aarch64", "0.3.1"))
      .rejects.toMatchObject({ status: 503, message: "Desktop release service is not configured" });
    expect(requests).toBe(0);
  });

  it("streams only updater binaries referenced by latest.json", async () => {
    const binary = Buffer.from("private-updater-binary");
    const updaterName = "MdLyx_0.4.0_universal.app.tar.gz";
    const calls: Array<{ url: string; accept: string | null }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const value = String(url);
      const headers = new Headers(init?.headers);
      calls.push({ url: value, accept: headers.get("accept") });
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.endsWith("/releases/44")) {
        return json({
          id: 44,
          tag_name: "v0.4.0",
          immutable: true,
          published_at: "2026-07-12T11:00:00Z",
          assets: [
            { id: 101, name: "latest.json", size: 500, content_type: "application/json" },
            { id: 202, name: updaterName, size: binary.byteLength, content_type: "application/gzip" },
          ],
        });
      }
      if (value.endsWith("/releases/assets/101")) {
        return json({
          version: "0.4.0",
          platforms: {
            "darwin-aarch64": {
              signature: "signature",
              url: `https://github.com/example-owner/mdlyx/releases/download/v0.4.0/${updaterName}`,
            },
          },
        });
      }
      if (value.endsWith("/releases/assets/202")) {
        return new Response(binary, {
          headers: { "content-type": "application/gzip", "content-length": String(binary.byteLength) },
        });
      }
      return json({ message: "unexpected" }, 500);
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);

    const download = await api.downloadUpdaterAsset(44, 202, updaterName);
    expect(download).toMatchObject({
      name: updaterName,
      contentType: "application/gzip",
      contentLength: binary.byteLength,
    });
    await expect(new Response(download.body).arrayBuffer()).resolves.toEqual(
      binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength),
    );
    expect(calls.at(-1)?.accept).toBe("application/octet-stream");
    await expect(api.downloadUpdaterAsset(44, 999, "unknown.app.tar.gz")).rejects.toMatchObject({ status: 404 });
    await expect(api.downloadUpdaterAsset(44, -1, "../outside.app.tar.gz")).rejects.toMatchObject({ status: 400 });
  });

  it("preserves GitHub errors while fetching a private updater binary", async () => {
    const updaterName = "MdLyx_0.4.0_universal.app.tar.gz";
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.endsWith("/releases/44")) {
        return json({
          id: 44,
          tag_name: "v0.4.0",
          immutable: true,
          assets: [
            { id: 101, name: "latest.json", size: 200 },
            { id: 202, name: updaterName, size: 20 },
          ],
        });
      }
      if (value.endsWith("/releases/assets/101")) {
        return json({
          version: "0.4.0",
          platforms: {
            "darwin-aarch64": {
              signature: "signature",
              url: `https://github.com/example/${updaterName}`,
            },
          },
        });
      }
      return json({ message: "release download unavailable" }, 503);
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);

    await expect(api.downloadUpdaterAsset(44, 202, updaterName))
      .rejects.toMatchObject({ status: 503, message: "release download unavailable" });
  });

  it("binds updater metadata to the release tag and deterministic versioned asset name", async () => {
    const updaterName = "MdLyx_0.4.0_universal.app.tar.gz";
    const release = (tagName: string, name = updaterName) => ({
      id: 44,
      tag_name: tagName,
      immutable: true,
      published_at: "2026-07-12T11:00:00Z",
      assets: [
        { id: 101, name: "latest.json", size: 200 },
        { id: 202, name, size: 20 },
      ],
    });
    let currentRelease = release("v0.4.1");
    let manifestName = updaterName;
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.endsWith("/releases/latest")) return json(currentRelease);
      if (value.endsWith("/releases/assets/101")) {
        return json({
          version: "0.4.0",
          platforms: {
            "darwin-aarch64": {
              signature: "signature",
              url: `https://github.com/example-owner/mdlyx/releases/download/v0.4.0/${manifestName}`,
            },
          },
        });
      }
      return json({ message: "unexpected" }, 500);
    };

    await expect(new GitHubLibraryApi(config, request as typeof fetch)
      .latestUpdaterRelease("darwin", "aarch64", "0.3.1"))
      .rejects.toMatchObject({ status: 502, message: "Updater version does not match the immutable release tag" });

    manifestName = "MdLyx.app.tar.gz";
    currentRelease = release("v0.4.0", manifestName);
    await expect(new GitHubLibraryApi(config, request as typeof fetch)
      .latestUpdaterRelease("darwin", "aarch64", "0.3.1"))
      .rejects.toMatchObject({ status: 502, message: "Latest release is missing signed updater metadata for this platform" });
  });

  it("downloads a checked asset by immutable release id after latest advances", async () => {
    const oldName = "MdLyx_0.4.0_universal.app.tar.gz";
    const nextName = "MdLyx_0.5.0_universal.app.tar.gz";
    const binary = Buffer.from("old signed updater");
    let latest = 44;
    const calls: string[] = [];
    const release = (id: number, version: string, name: string) => ({
      id,
      tag_name: `v${version}`,
      immutable: true,
      published_at: "2026-07-12T11:00:00Z",
      assets: [
        { id: id * 10 + 1, name: "latest.json", size: 200 },
        { id: id * 10 + 2, name, size: binary.byteLength },
      ],
    });
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      calls.push(value);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.endsWith("/releases/latest")) {
        return json(latest === 44 ? release(44, "0.4.0", oldName) : release(45, "0.5.0", nextName));
      }
      if (value.endsWith("/releases/44")) return json(release(44, "0.4.0", oldName));
      if (value.endsWith("/releases/45")) return json(release(45, "0.5.0", nextName));
      if (value.endsWith("/releases/assets/441")) {
        return json({ version: "0.4.0", platforms: { "darwin-aarch64": {
          signature: "signature", url: `https://github.com/releases/${oldName}`,
        } } });
      }
      if (value.endsWith("/releases/assets/451")) {
        return json({ version: "0.5.0", platforms: { "darwin-aarch64": {
          signature: "signature", url: `https://github.com/releases/${nextName}`,
        } } });
      }
      if (value.endsWith("/releases/assets/442")) return new Response(binary);
      return json({ message: "unexpected" }, 500);
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);
    const clock = vi.spyOn(Date, "now");
    let now = 1_800_000_000_000;
    clock.mockImplementation(() => now);
    try {
      const checked = await api.latestUpdaterRelease("darwin", "aarch64", "0.3.1");
      expect(checked?.releaseId).toBe(44);
      latest = 45;
      now += 61_000;
      await expect(api.latestUpdaterRelease("darwin", "aarch64", "0.4.0")).resolves.toMatchObject({ releaseId: 45 });

      const download = await api.downloadUpdaterAsset(44, 442, oldName);
      await expect(new Response(download.body).text()).resolves.toBe(binary.toString());
      expect(calls.some((call) => call.endsWith("/releases/44"))).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects oversized updater assets before requesting their bytes", async () => {
    const updaterName = "MdLyx_0.4.0_universal.app.tar.gz";
    let binaryRequested = false;
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.endsWith("/releases/44")) return json({
        id: 44,
        tag_name: "v0.4.0",
        immutable: true,
        assets: [
          { id: 101, name: "latest.json", size: 200 },
          { id: 202, name: updaterName, size: MAX_UPDATER_ASSET_BYTES + 1 },
        ],
      });
      if (value.endsWith("/releases/assets/101")) return json({
        version: "0.4.0",
        platforms: { "darwin-aarch64": { signature: "signature", url: `https://github.com/releases/${updaterName}` } },
      });
      if (value.endsWith("/releases/assets/202")) binaryRequested = true;
      return json({ message: "unexpected" }, 500);
    };
    const api = new GitHubLibraryApi(config, request as typeof fetch);

    await expect(api.downloadUpdaterAsset(44, 202, updaterName))
      .rejects.toMatchObject({ status: 502, message: "Updater asset has an invalid size" });
    expect(binaryRequested).toBe(false);
  });

  it("aborts an idle updater body and enforces the declared byte count", async () => {
    const updaterName = "MdLyx_0.4.0_universal.app.tar.gz";
    let mode: "idle" | "short" = "idle";
    let idleCancelled = false;
    const request = async (url: string | URL | Request): Promise<Response> => {
      const value = String(url);
      if (value.endsWith("/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (value.endsWith("/releases/44")) return json({
        id: 44,
        tag_name: "v0.4.0",
        immutable: true,
        assets: [
          { id: 101, name: "latest.json", size: 200 },
          { id: 202, name: updaterName, size: 10 },
        ],
      });
      if (value.endsWith("/releases/assets/101")) return json({
        version: "0.4.0",
        platforms: { "darwin-aarch64": { signature: "signature", url: `https://github.com/releases/${updaterName}` } },
      });
      if (value.endsWith("/releases/assets/202")) {
        return mode === "idle"
          ? new Response(new ReadableStream<Uint8Array>({
              start() {},
              cancel() {
                idleCancelled = true;
              },
            }))
          : new Response(Buffer.from("short"));
      }
      return json({ message: "unexpected" }, 500);
    };
    const idleApi = new GitHubLibraryApi(config, request as typeof fetch, 12_000, 5, 50);
    const idle = await idleApi.downloadUpdaterAsset(44, 202, updaterName);
    await expect(new Response(idle.body).arrayBuffer()).rejects.toMatchObject({ status: 504 });
    expect(idleCancelled).toBe(true);

    mode = "short";
    const shortApi = new GitHubLibraryApi(config, request as typeof fetch);
    const short = await shortApi.downloadUpdaterAsset(44, 202, updaterName);
    await expect(new Response(short.body).arrayBuffer())
      .rejects.toMatchObject({ status: 502, message: "Updater asset length did not match release metadata" });
  });
});
