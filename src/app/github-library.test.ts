import { describe, expect, it, vi } from "vitest";
import { GitHubLibrary, normalisePath } from "./github-library";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("GitHub library paths", () => {
  it("preserves nested markdown paths and adds a markdown extension", () => {
    expect(normalisePath("drafts/intro")).toBe("drafts/intro.md");
    expect(normalisePath("references/notation.markdown")).toBe("references/notation.markdown");
  });

  it("refuses paths that escape or expose the repository root", () => {
    expect(normalisePath("../outside.md")).toBeNull();
    expect(normalisePath(".git/config.md")).toBeNull();
    expect(normalisePath("a/b/c/d/e/f/g/h/i/j.md")).toBeNull();
    expect(normalisePath("reading\\smith.md")).toBeNull();
  });

  it("indexes metadata and unresolved comments from the complete GitHub source", async () => {
    const source = `---
macros:
  huge: "${"x".repeat(70_000)}"
library: {"id":"remote-doc","projects":["test-project"]}
comments: [{"id":"open","resolved":false},{"id":"legacy"},{"id":"closed","resolved":true}]
---
Body
`;
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url) => {
        expect(String(url)).toBe("https://library.test/v2/library/index");
        return json({ entries: [{ path: "nested/remote.md", sha: "abc123", text: source }] });
      }) as typeof fetch,
    );

    const [file] = await api.list();
    expect(file.name).toBe("remote.md");
    expect(file.folder).toBe("nested");
    expect(file.meta.id).toBe("remote-doc");
    expect(file.meta.projects).toEqual(["test-project"]);
    expect(file.openCommentCount).toBe(2);
    expect(file.commentActivityDigest).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it("falls back to v1 when the pre-v2 server returns SPA HTML", async () => {
    const source = `---\nlibrary: {"id":"legacy-doc","projects":["test-project"]}\n---\nLegacy body\n`;
    const calls: string[] = [];
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/v2/library/index")) {
          return new Response("<!doctype html><title>Mathdown</title>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return json({ entries: [{ path: "legacy.md", sha: "legacy-sha", text: source }] });
      }) as typeof fetch,
    );

    await expect(api.list()).resolves.toMatchObject([{
      name: "legacy.md",
      meta: { id: "legacy-doc", projects: ["test-project"] },
      handle: { sha: "legacy-sha" },
    }]);
    expect(calls).toEqual([
      "https://library.test/v2/library/index",
      "https://library.test/v1/library",
    ]);
  });

  it("reuses listed source for catalog reads without a document request", async () => {
    const source = `---\nlibrary: {"id":"overview","projects":["test"],"contains":["project-overview"]}\n---\n# Overview\n`;
    const calls: string[] = [];
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url) => {
        calls.push(String(url));
        return json({ entries: [{ path: "overview.md", sha: "listed-sha", text: source }] });
      }) as typeof fetch,
    );

    const [file] = await api.list();
    await expect(api.catalogSource(file)).resolves.toBe(source);
    expect(calls).toEqual(["https://library.test/v2/library/index"]);
  });

  it("opens an owner document from the exact-SHA source cache", async () => {
    const source = `---\nlibrary: {"id":"cached","projects":["test"]}\n---\n# Cached\n`;
    const calls: string[] = [];
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url) => {
        calls.push(String(url));
        return json({ entries: [{ path: "cached.md", sha: "cached-sha", text: source }] });
      }) as typeof fetch,
    );

    const [file] = await api.list();
    await expect(api.open(file)).resolves.toMatchObject({
      path: "cached.md",
      text: source,
      handle: { sha: "cached-sha" },
    });
    expect(calls).toEqual(["https://library.test/v2/library/index"]);
  });

  it("refetches a document when its indexed SHA differs from the cached source", async () => {
    const listed = `---\nlibrary: {"id":"cached"}\n---\nListed\n`;
    const remote = `---\nlibrary: {"id":"cached"}\n---\nRemote\n`;
    const calls: string[] = [];
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url) => {
        calls.push(String(url));
        if (String(url).includes("/documents?")) {
          return json({ path: "cached.md", sha: "remote-sha", text: remote });
        }
        return json({ entries: [{ path: "cached.md", sha: "listed-sha", text: listed }] });
      }) as typeof fetch,
    );

    const [file] = await api.list();
    await expect(api.open({
      ...file,
      handle: { ...file.handle, sha: "remote-sha" },
    })).resolves.toMatchObject({ text: remote, handle: { sha: "remote-sha" } });
    expect(calls).toEqual([
      "https://library.test/v2/library/index",
      "https://library.test/v1/library/documents?path=cached.md",
    ]);
  });

  it("uses a successful save as the newest catalog source", async () => {
    const original = `---\nlibrary: {"id":"overview"}\n---\nOld\n`;
    const saved = `---\nlibrary: {"id":"overview"}\n---\nSaved\n`;
    const calls: Array<{ url: string; method: string }> = [];
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url, init) => {
        calls.push({ url: String(url), method: init?.method ?? "GET" });
        if ((init?.method ?? "GET") === "PUT") {
          return json({ path: "overview.md", sha: "saved-sha", text: saved });
        }
        return json({ entries: [{ path: "overview.md", sha: "listed-sha", text: original }] });
      }) as typeof fetch,
    );

    const [file] = await api.list();
    await expect(api.save(saved, file.handle)).resolves.toEqual({
      name: "overview.md",
      handle: { kind: "github", path: "overview.md", sha: "saved-sha" },
    });
    await expect(api.catalogSource(file)).resolves.toBe(saved);
    expect(calls).toEqual([
      { url: "https://library.test/v2/library/index", method: "GET" },
      { url: "https://library.test/v1/library/documents?path=overview.md", method: "PUT" },
    ]);
  });

  it("uses the remote-wins conflict body as the newest catalog source", async () => {
    const listed = `---\nlibrary: {"id":"overview"}\n---\nListed\n`;
    const remote = `---\nlibrary: {"id":"overview"}\n---\nRemote\n`;
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (_url, init) => (init?.method ?? "GET") === "PUT"
        ? json({
            code: "REMOTE_CONFLICT",
            remote: { path: "overview.md", sha: "remote-sha", text: remote },
          }, 409)
        : json({ entries: [{ path: "overview.md", sha: "listed-sha", text: listed }] })) as typeof fetch,
    );

    const [file] = await api.list();
    await expect(api.save("Local", file.handle)).resolves.toMatchObject({
      kind: "remote-conflict",
      text: remote,
      handle: { sha: "remote-sha" },
    });
    await expect(api.catalogSource(file)).resolves.toBe(remote);
  });

  it("does not let a delayed list overwrite a newer successful save", async () => {
    const listed = `---\nlibrary: {"id":"overview"}\n---\nListed\n`;
    const saved = `---\nlibrary: {"id":"overview"}\n---\nSaved\n`;
    const delayedList = deferred<Response>();
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (_url, init) => (init?.method ?? "GET") === "PUT"
        ? json({ path: "overview.md", sha: "saved-sha", text: saved })
        : delayedList.promise) as typeof fetch,
    );

    const listing = api.list();
    await expect(api.save(saved, { kind: "github", path: "overview.md", sha: "listed-sha" }))
      .resolves.toMatchObject({ handle: { sha: "saved-sha" } });
    delayedList.resolve(json({ entries: [{ path: "overview.md", sha: "listed-sha", text: listed }] }));
    const [file] = await listing;

    expect(file.handle.sha).toBe("saved-sha");
    await expect(api.catalogSource(file)).resolves.toBe(saved);
  });

  it("lets a successful write outrank a stale list started while it was in flight", async () => {
    const listed = `---\nlibrary: {"id":"overview"}\n---\nListed\n`;
    const saved = `---\nlibrary: {"id":"overview"}\n---\nSaved\n`;
    const delayedWrite = deferred<Response>();
    let lists = 0;
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (_url, init) => {
        if ((init?.method ?? "GET") === "PUT") return delayedWrite.promise;
        lists++;
        return json({ entries: [{ path: "overview.md", sha: "listed-sha", text: listed }] });
      }) as typeof fetch,
    );

    const [file] = await api.list();
    const writing = api.save(saved, file.handle);
    const staleList = api.list();
    await expect(staleList).resolves.toMatchObject([{ handle: { sha: "listed-sha" } }]);
    delayedWrite.resolve(json({ path: "overview.md", sha: "saved-sha", text: saved }));
    await expect(writing).resolves.toMatchObject({ handle: { sha: "saved-sha" } });

    await expect(api.catalogSource(file)).resolves.toBe(saved);
    expect(lists).toBe(2);
  });

  it("preserves a third SHA observed while a successful write was in flight", async () => {
    const source = (label: string) => `---\nlibrary: {"id":"overview"}\n---\n${label}\n`;
    const delayedWrite = deferred<Response>();
    let lists = 0;
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (_url, init) => {
        if ((init?.method ?? "GET") === "PUT") return delayedWrite.promise;
        lists++;
        return json({ entries: [{
          path: "overview.md",
          sha: lists === 1 ? "sha-a" : "sha-c",
          text: source(lists === 1 ? "A" : "C"),
        }] });
      }) as typeof fetch,
    );

    const [file] = await api.list();
    const writing = api.save(source("B"), file.handle);
    await api.list();
    delayedWrite.resolve(json({ path: "overview.md", sha: "sha-b", text: source("B") }));

    await expect(writing).resolves.toMatchObject({
      kind: "remote-conflict",
      handle: { sha: "sha-c" },
      text: source("C"),
    });
    await expect(api.catalogSource(file)).resolves.toBe(source("C"));
  });

  it("keeps a concurrently-created document visible after an older list completes", async () => {
    const delayedList = deferred<Response>();
    const created = `---\nlibrary: {"id":"created"}\n---\nCreated\n`;
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url, init) => {
        if (String(url).endsWith("/v1/library")) return delayedList.promise;
        if ((init?.method ?? "GET") === "GET") return json({ error: "not found" }, 404);
        return json({ path: "created.md", sha: "created-sha", text: created });
      }) as typeof fetch,
    );

    const listing = api.list();
    await expect(api.create("created.md")).resolves.toMatchObject({
      handle: { path: "created.md", sha: "created-sha" },
    });
    delayedList.resolve(json({ entries: [] }));

    await expect(listing).resolves.toMatchObject([
      { name: "created.md", handle: { sha: "created-sha" }, meta: { id: "created" } },
    ]);
  });

  it("does not let a delayed document open overwrite a newer successful save", async () => {
    const opened = `---\nlibrary: {"id":"overview"}\n---\nOpened\n`;
    const saved = `---\nlibrary: {"id":"overview"}\n---\nSaved\n`;
    const delayedOpen = deferred<Response>();
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (_url, init) => (init?.method ?? "GET") === "PUT"
        ? json({ path: "overview.md", sha: "saved-sha", text: saved })
        : delayedOpen.promise) as typeof fetch,
    );
    const file = {
      name: "overview.md",
      folder: "",
      handle: { kind: "github" as const, path: "overview.md", sha: "opened-sha" },
      meta: {
        id: "overview",
        visibility: "reader" as const,
        tags: [],
        contains: [],
        projects: [],
        related: [],
      },
      openCommentCount: 0,
    };

    const opening = api.open(file);
    await api.save(saved, file.handle);
    delayedOpen.resolve(json({ path: "overview.md", sha: "opened-sha", text: opened }));
    await expect(opening).resolves.toMatchObject({ text: opened });
    await expect(api.catalogSource(file)).resolves.toBe(saved);
  });

  it("prunes deleted sources after a newer complete listing", async () => {
    let listing = 0;
    const calls: string[] = [];
    const source = (id: string) => `---\nlibrary: {"id":"${id}"}\n---\n${id}\n`;
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url) => {
        calls.push(String(url));
        if (String(url).includes("/documents?")) {
          return json({ path: "b.md", sha: "b-new", text: source("b-new") });
        }
        listing++;
        return listing === 1
          ? json({ entries: [
              { path: "a.md", sha: "a-1", text: source("a") },
              { path: "b.md", sha: "b-1", text: source("b") },
            ] })
          : json({ entries: [{ path: "a.md", sha: "a-2", text: source("a") }] });
      }) as typeof fetch,
    );

    const [, removed] = await api.list();
    await api.list();
    await expect(api.catalogSource(removed)).resolves.toBe(source("b-new"));
    expect(calls).toContain("https://library.test/v1/library/documents?path=b.md");
  });

  it("lists, reads, and SHA-guards binary library assets", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const calls: Array<{ path: string; method: string; headers: Headers; body?: unknown }> = [];
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url, init) => {
        const path = new URL(String(url)).pathname;
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, method, headers: new Headers(init?.headers), body });
        if (path === "/v2/library/assets" && method === "GET") {
          return json({
            revision: "tree-sha",
            entries: [{ path: "assets/clock.pdf", sha: "asset-old", size: 4 }],
          }, 200);
        }
        if (method === "PUT") {
          return json({ path: "assets/clock.pdf", sha: "asset-new", size: 4 });
        }
        return json({
          path: "assets/clock.pdf",
          sha: "asset-old",
          size: 4,
          content: "AAEC/w==",
        });
      }) as typeof fetch,
    );

    await expect(api.listAssets()).resolves.toEqual([{
      path: "assets/clock.pdf",
      sha: "asset-old",
      size: 4,
      mimeType: "application/pdf",
    }]);
    await expect(api.readAsset("assets/clock.pdf")).resolves.toMatchObject({
      asset: { path: "assets/clock.pdf", sha: "asset-old" },
      bytes,
    });
    await expect(api.writeAsset({
      path: "assets/clock.pdf",
      bytes,
      mimeType: "application/pdf",
      ifMatch: "asset-old",
    })).resolves.toEqual({
      path: "assets/clock.pdf",
      sha: "asset-new",
      size: 4,
      mimeType: "application/pdf",
    });
    const write = calls.at(-1)!;
    expect(write.method).toBe("PUT");
    expect(write.headers.get("if-match")).toBe('"asset-old"');
    expect(write.body).toEqual({ content: "AAEC/w==" });
  });

  it("bounds complete-source caching and refetches an evicted source", async () => {
    const entries = Array.from({ length: 2_050 }, (_, index) => ({
      path: `docs/${index}.md`,
      sha: `sha-${index}`,
      text: `---\nlibrary: {"id":"doc-${index}"}\n---\n${index}\n`,
    }));
    let documentReads = 0;
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url) => {
        if (String(url).includes("/documents?")) {
          documentReads++;
          return json(entries[0]);
        }
        return json({ entries });
      }) as typeof fetch,
    );

    const [evicted] = await api.list();
    await expect(api.catalogSource(evicted)).resolves.toBe(entries[0].text);
    expect(documentReads).toBe(1);
  });

  it("also bounds complete-source caching by estimated bytes", async () => {
    const body = "x".repeat(1024 * 1024);
    const entries = Array.from({ length: 18 }, (_, index) => ({
      path: `large/${index}.md`,
      sha: `large-sha-${index}`,
      text: `---\nlibrary: {"id":"large-${index}"}\n---\n${body}`,
    }));
    let documentReads = 0;
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url) => {
        if (String(url).includes("/documents?")) {
          documentReads++;
          return json(entries[0]);
        }
        return json({ entries });
      }) as typeof fetch,
    );

    const [evicted] = await api.list();
    await expect(api.catalogSource(evicted)).resolves.toBe(entries[0].text);
    expect(documentReads).toBe(1);
  });

  it("ignores malformed remote comment entries without failing the listing", async () => {
    const source = `---
library: {"id":"remote-mixed"}
comments: [null,"bad",{}, {"resolved":false},{"resolved":true}]
---
Body
`;
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async () => json({ entries: [{ path: "mixed.md", sha: "abc123", text: source }] })) as typeof fetch,
    );

    const [file] = await api.list();
    expect(file.meta.id).toBe("remote-mixed");
    expect(file.openCommentCount).toBe(2);
  });

  it("does not offer OAuth until Render reports that GitHub writes are configured", async () => {
    const calls: string[] = [];
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url) => {
        calls.push(String(url));
        return json({ ok: true, configured: false });
      }) as typeof fetch,
    );
    await expect(api.syncStatus()).resolves.toEqual({ state: "setup", authenticated: false });
    expect(calls).toEqual(["https://library.test/health"]);
  });

  it("reports a ready, authenticated GitHub sync service", async () => {
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url) => {
        if (String(url).endsWith("/health")) return json({ ok: true, configured: true });
        return json({ authenticated: true, login: "example-owner" });
      }) as typeof fetch,
    );
    await expect(api.syncStatus()).resolves.toEqual({
      state: "ready",
      authenticated: true,
      login: "example-owner",
    });
  });

  it("carries service version and deployment revision from health", async () => {
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url) => {
        if (String(url).endsWith("/health")) {
          return json({
            ok: true,
            configured: true,
            releaseConfigured: true,
            version: "0.3.0",
            revision: "abcdef123456",
          });
        }
        return json({ authenticated: false });
      }) as typeof fetch,
    );
    await expect(api.syncStatus()).resolves.toEqual({
      state: "ready",
      authenticated: false,
      serviceVersion: "0.3.0",
      serviceRevision: "abcdef123456",
      releaseConfigured: true,
    });
  });

  it("exposes the GitHub authorization endpoint for a native navigation link", () => {
    const api = new GitHubLibrary(() => "https://library.test/");
    expect(api.connectUrl()).toBe("https://library.test/auth/github");
  });

  it("exchanges a static-site OAuth return with the API and removes the code from the URL", async () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", { history: { replaceState } });
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://library.test/auth/complete");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ code: "github-code", state: "signed-state" });
      return json({ authenticated: true, login: "example-owner" });
    });
    const api = new GitHubLibrary(() => "https://library.test", request as unknown as typeof fetch);
    try {
      await expect(api.completeBrowserOAuth({
        pathname: "/github-link",
        search: "?code=github-code&state=signed-state",
        origin: "https://mathdown.test",
      } as Location)).resolves.toEqual({ handled: true });
      expect(replaceState).toHaveBeenCalledWith(null, "", "https://mathdown.test/");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("starts and polls the device flow without exposing its device code to the page", async () => {
    const request = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/auth/device/start")) {
        return json({ userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 });
      }
      return json({ state: "pending" });
    });
    const api = new GitHubLibrary(() => "https://library.test", request as unknown as typeof fetch);
    await expect(api.startDeviceAuthorization()).resolves.toEqual({
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    });
    await expect(api.pollDeviceAuthorization()).resolves.toEqual({ state: "pending" });
  });

  it("uses a server-side pending id and persists the resulting desktop session", async () => {
    let stored: string | null = null;
    const sessionStore = {
      enabled: true,
      get: vi.fn(async () => stored),
      set: vi.fn(async (value: string) => { stored = value; }),
      clear: vi.fn(async () => { stored = null; }),
    };
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/auth/device/start") {
        return json({
          userCode: "WDJB-MJHT",
          verificationUri: "https://github.com/login/device",
          expiresIn: 900,
          interval: 5,
          pendingId: "opaque-pending-id",
        });
      }
      if (path === "/auth/device/poll") {
        expect(JSON.parse(String(init?.body))).toEqual({ pendingId: "opaque-pending-id" });
        return json({ state: "authorized", login: "example-owner", desktopSession: "signed.session" });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer signed.session");
      return json({ authenticated: true, login: "example-owner" });
    });
    const api = new GitHubLibrary(
      () => "https://library.test",
      request as unknown as typeof fetch,
      sessionStore,
    );

    await api.startDeviceAuthorization();
    await expect(api.pollDeviceAuthorization()).resolves.toMatchObject({ state: "authorized" });
    expect(sessionStore.set).toHaveBeenCalledWith("signed.session");
    await expect(api.session()).resolves.toEqual({ authenticated: true, login: "example-owner" });
  });

  it("clears a desktop pending id locally and requests origin-bound server cancellation", async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      requests.push({
        path,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (path === "/auth/device/start") {
        return json({
          userCode: "WDJB-MJHT",
          verificationUri: "https://github.com/login/device",
          expiresIn: 900,
          interval: 5,
          pendingId: "opaque-pending-id",
        });
      }
      return new Response(null, { status: 204 });
    });
    const api = new GitHubLibrary(() => "https://library.test", request as unknown as typeof fetch);
    await api.startDeviceAuthorization();
    await api.cancelDeviceAuthorization();
    expect(requests.at(-1)).toEqual({
      path: "/auth/device/cancel",
      body: { pendingId: "opaque-pending-id" },
    });
    await api.cancelDeviceAuthorization();
    expect(requests.filter(({ path }) => path === "/auth/device/cancel")).toHaveLength(1);
  });

  it("clears an interrupted desktop attempt without calling it expired", async () => {
    const sessionStore = {
      enabled: true,
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const request = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/start")
        ? json({ userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5, pendingId: "pending" })
        : json({ state: "interrupted" }),
    );
    const api = new GitHubLibrary(() => "https://library.test", request as unknown as typeof fetch, sessionStore);
    await api.startDeviceAuthorization();
    await expect(api.pollDeviceAuthorization()).resolves.toEqual({ state: "interrupted" });
  });

  it("reads invitation tokens only from the fragment and redeems explicitly", async () => {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://library.test/auth/invite/redeem");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ token: "A".repeat(43) });
      return json({
        authenticated: true,
        principal: { id: "alice", displayName: "Alice Smith", kind: "coauthor" },
        grants: [{ project: "sample-model", role: "commenter" }],
      });
    });
    const api = new GitHubLibrary(() => "https://library.test", request as unknown as typeof fetch);
    expect(api.invitationToken({ pathname: "/invite", hash: `#token=${"A".repeat(43)}` } as Location))
      .toBe("A".repeat(43));
    expect(api.invitationToken({ pathname: "/invite", hash: "#token=short" } as Location)).toBeNull();
    expect(api.invitationToken({ pathname: "/", hash: `#token=${"A".repeat(43)}` } as Location)).toBeNull();
    await expect(api.redeemInvitation("A".repeat(43))).resolves.toMatchObject({
      principal: { id: "alice", kind: "coauthor" },
    });
  });

  it("derives per-document capabilities across every granted project", async () => {
    const api = new GitHubLibrary(
      () => "https://library.test",
      (async (url) => String(url).endsWith("/auth/session")
        ? json({
            authenticated: true,
            principal: { id: "alice", displayName: "Alice Smith", kind: "coauthor" },
            grants: [
              { project: "sample-model", role: "editor" },
              { project: "network-hubs", role: "commenter" },
            ],
          })
        : json({
            revision: "shared-tree",
            entries: [{
              path: "projects/sample-model/shared.md",
              sha: "shared-sha",
              meta: { id: "shared", projects: ["sample-model", "network-hubs"] },
              openCommentCount: 0,
            }],
          })) as typeof fetch,
    );
    await api.session();
    // Populate the server-filtered index before asking whether a cached path is
    // authorized for restoration.
    await api.list();
    expect(api.documentCapabilities(["sample-model"], false, "projects/sample-model/shared.md")).toMatchObject({
      authorized: true,
      canEditContent: true,
      canEditComments: true,
      canManageAllComments: true,
      sharedAccess: true,
    });
    expect(api.documentCapabilities(["sample-model", "network-hubs"], false, "projects/sample-model/shared.md")).toMatchObject({
      authorized: true,
      canEditContent: false,
      canEditComments: true,
      canManageAllComments: false,
    });
    expect(api.documentCapabilities(["sample-model", "example-logistics"], false, "projects/sample-model/shared.md")).toMatchObject({ authorized: false });
    expect(api.documentCapabilities([], false, "projects/sample-model/shared.md")).toMatchObject({ authorized: false });
    expect(api.documentCapabilities(["sample-model"], false, "projects/sample-model/tampered.md")).toMatchObject({ authorized: false });
    expect(api.documentCapabilities(["sample-model"], true, "projects/sample-model/shared.md")).toMatchObject({
      authorized: true,
      canEditContent: false,
      canEditComments: false,
    });
  });
});
