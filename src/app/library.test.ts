import { describe, it, expect, vi } from "vitest";
import {
  Library,
  createNativeLibraryDocument,
  reconnectNativeLibraryRoot,
} from "./library";
import type { NativeInvoker } from "./file-adapter";

// A minimal fake FileSystemDirectoryHandle to exercise the list/open/create
// logic without the real (gesture-gated) File System Access picker.
interface FileReadTracker {
  fullTextReads: number;
  sliceEnds: number[];
}

function fakeFile(name: string, text: string, tracker?: FileReadTracker) {
  let current = text;
  return {
    name,
    kind: "file" as const,
    getFile: async () => ({
      size: new TextEncoder().encode(current).byteLength,
      text: async () => {
        if (tracker) tracker.fullTextReads += 1;
        return current;
      },
      arrayBuffer: async () => new TextEncoder().encode(current).buffer,
      slice: (start = 0, end = current.length) => {
        const sliced = current.slice(start, end);
        tracker?.sliceEnds.push(end);
        return {
          text: async () => sliced,
          arrayBuffer: async () => new TextEncoder().encode(sliced).buffer,
        };
      },
    }) as unknown as File,
    createWritable: async () => ({
      write: async (data: string | Blob | ArrayBuffer | Uint8Array) => {
        if (typeof data === "string") current = data;
        else if (data instanceof Blob) current = await data.text();
        else current = new TextDecoder().decode(data);
      },
      close: async () => {},
    }),
  };
}
function fakeDir(files: ReturnType<typeof fakeFile>[]) {
  return {
    name: "notes",
    kind: "directory" as const,
    async *entries() {
      for (const f of files) yield [f.name, f] as [string, ReturnType<typeof fakeFile>];
    },
    async getFileHandle(name: string) {
      const existing = files.find((file) => file.name === name);
      if (existing) return existing;
      const f = fakeFile(name, "");
      files.push(f);
      return f;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subdirs: {} as Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async getDirectoryHandle(name: string): Promise<any> {
      // create-on-demand nested dir (mirrors the FS Access API)
      this.subdirs[name] ??= fakeDir([]);
      return this.subdirs[name];
    },
    queryPermission: async () => "granted" as PermissionState,
    requestPermission: async () => "granted" as PermissionState,
  };
}

function withDir(files: ReturnType<typeof fakeFile>[]): Library {
  const lib = new Library();
  (lib as unknown as { dir: unknown }).dir = fakeDir(files);
  return lib;
}

// A directory that also contains named sub-directories (each a fakeDir), to
// exercise the recursive folder walk.
function fakeTree(
  files: ReturnType<typeof fakeFile>[],
  subdirs: Record<string, unknown>,
) {
  const base = fakeDir(files);
  Object.assign(base.subdirs, subdirs);
  return {
    ...base,
    async *entries() {
      for (const f of files) yield [f.name, f] as [string, unknown];
      for (const [name, dir] of Object.entries(subdirs)) yield [name, dir] as [string, unknown];
    },
  };
}
function withTree(tree: unknown): Library {
  const lib = new Library();
  (lib as unknown as { dir: unknown }).dir = tree;
  return lib;
}

describe("Library (folder-backed)", () => {
  it("lists only .md/.markdown files, sorted", async () => {
    const lib = withDir([
      fakeFile("zeta.md", ""),
      fakeFile("notes.txt", ""),
      fakeFile("alpha.markdown", ""),
      fakeFile("beta.md", ""),
    ]);
    const names = (await lib.list()).map((f) => f.name);
    expect(names).toEqual(["alpha.markdown", "beta.md", "zeta.md"]);
  });

  it("opens a file's text via its handle", async () => {
    const lib = withDir([fakeFile("doc.md", "# Hello\n")]);
    const [f] = await lib.list();
    expect((await lib.open(f)).text).toBe("# Hello\n");
  });

  it("reads a bounded prefix for search without loading the complete file", async () => {
    const tracker: FileReadTracker = { fullTextReads: 0, sliceEnds: [] };
    const lib = withDir([fakeFile("large.md", "x".repeat(5_000_000), tracker)]);
    const [file] = await lib.list();
    tracker.sliceEnds.length = 0;

    const prefix = await lib.readPrefix(file, 1_001);

    expect(prefix).toHaveLength(1_001);
    expect(tracker.fullTextReads).toBe(0);
    expect(tracker.sliceEnds).toEqual([4_004]);
  });

  it("lists, reads, and version-guards project assets", async () => {
    const asset = fakeFile("clock.pdf", "binary-clock");
    const tree = fakeTree([fakeFile("paper.md", "# Paper"), fakeFile("ignore.txt", "no")], {
      assets: fakeDir([asset]),
    });
    const lib = withTree(tree);

    await expect(lib.listAssets()).resolves.toEqual([{
      path: "assets/clock.pdf",
      mimeType: "application/pdf",
      size: 12,
    }]);
    const opened = await lib.readAsset("assets/clock.pdf");
    expect(new TextDecoder().decode(opened.bytes)).toBe("binary-clock");
    await expect(lib.writeAsset({
      path: "assets/clock.pdf",
      mimeType: "application/pdf",
      bytes: new TextEncoder().encode("replacement"),
      ifMatch: "stale",
    })).rejects.toThrow(/changed/);
    const saved = await lib.writeAsset({
      path: "assets/clock.pdf",
      mimeType: "application/pdf",
      bytes: new TextEncoder().encode("replacement"),
      ifMatch: opened.asset.sha,
    });
    expect(saved).toMatchObject({ path: "assets/clock.pdf", size: 11 });
    expect(new TextDecoder().decode((await lib.readAsset("assets/clock.pdf")).bytes)).toBe("replacement");
  });

  it("adds a .md extension when creating without one", async () => {
    const lib = withDir([]);
    const created = await lib.create("draft");
    expect(created?.name).toBe("draft.md");
    expect(created?.text).toBe("");
  });

  it("keeps an explicit extension when creating", async () => {
    const lib = withDir([]);
    expect((await lib.create("notes.markdown"))?.name).toBe("notes.markdown");
    expect((await lib.create("notes.txt"))?.name).toBe("notes.txt.md");
  });

  it("creates a document inside a folder path, adding .md (#I80)", async () => {
    const created = await withDir([]).create("drafts/intro");
    expect(created?.name).toBe("intro.md"); // filename only; folder handled by the handle
    expect(created?.text).toBe("");
  });

  it("refuses a path that tries to escape the root (#I80)", async () => {
    expect(await withDir([]).create("../evil.md")).toBeNull();
    expect(await withDir([]).create("reading\\evil.md")).toBeNull();
  });

  it("recurses into subfolders, recording each file's relative folder path", async () => {
    const nested = fakeDir([fakeFile("deep.md", "")]);
    const chapter = fakeTree([fakeFile("intro.md", "")], { sub: nested });
    const tree = fakeTree([fakeFile("root.md", "")], { chapter });
    const lib = withTree(tree);
    const files = (await lib.list()).map((f) => ({ name: f.name, folder: f.folder }));
    // sorted by folder (root "" first), then filename
    expect(files).toEqual([
      { name: "root.md", folder: "" },
      { name: "intro.md", folder: "chapter" },
      { name: "deep.md", folder: "chapter/sub" },
    ]);
  });

  it("skips dot-directories and dotfiles", async () => {
    const gitDir = fakeDir([fakeFile("config.md", "")]);
    const tree = fakeTree([fakeFile("visible.md", ""), fakeFile(".hidden.md", "")], {
      ".git": gitDir,
    });
    const names = (await withTree(tree).list()).map((f) => f.name);
    expect(names).toEqual(["visible.md"]);
  });

  it("indexes unresolved comments from complete frontmatter", async () => {
    const source = `---
library: {"id":"commented","title":"Commented"}
comments: [{"id":"open","resolved":false},{"id":"legacy"},{"id":"closed","resolved":true}]
---
Body
`;
    const [file] = await withDir([fakeFile("commented.md", source)]).list();
    expect(file.meta.id).toBe("commented");
    expect(file.openCommentCount).toBe(2);
  });

  it("ignores malformed comment array members instead of dropping the document", async () => {
    const source = `---
library: {"id":"mixed-comments","title":"Mixed comments"}
comments: [null,"bad",{}, {"id":"open","resolved":false},{"id":"closed","resolved":true}]
---
Body
`;
    const [file] = await withDir([fakeFile("mixed.md", source)]).list();
    expect(file.meta.id).toBe("mixed-comments");
    expect(file.openCommentCount).toBe(2);
  });

  it("expands the index read when frontmatter exceeds 65,536 bytes", async () => {
    const source = `---
macros:
  huge: "${"x".repeat(70_000)}"
library: {"id":"large-frontmatter","projects":["test-project"]}
comments: [{"id":"open","resolved":false},{"id":"closed","resolved":true}]
---
Body
`;
    const [file] = await withDir([fakeFile("large.md", source)]).list();
    expect(file.meta.id).toBe("large-frontmatter");
    expect(file.meta.projects).toEqual(["test-project"]);
    expect(file.openCommentCount).toBe(1);
  });

  it("indexes complete frontmatter just below the bounded safety window", async () => {
    const source = `---
macros:
  huge: "${"x".repeat(8 * 1024 * 1024 - 512)}"
library: {"id":"very-large-frontmatter"}
comments: [{"id":"still-open","resolved":false}]
---
Body
`;
    const [file] = await withDir([fakeFile("very-large.md", source)]).list();
    expect(file.meta.id).toBe("very-large-frontmatter");
    expect(file.openCommentCount).toBe(1);
  });

  it("streams valid frontmatter whose delimiter is beyond eight MiB without a whole-file read", async () => {
    const tracker: FileReadTracker = { fullTextReads: 0, sliceEnds: [] };
    const source = `---\nmacros:\n  huge: "${"x".repeat(8 * 1024 * 1024 + 256)}"\nlibrary: {"id":"past-eight-mib","projects":["test"]}\ncomments: [{"id":"past-cap","resolved":false}]\n---\nBody\n`;
    const [file] = await withDir([fakeFile("oversized.md", source, tracker)]).list();

    expect(file.meta.id).toBe("past-eight-mib");
    expect(file.meta.projects).toEqual(["test"]);
    expect(file.openCommentCount).toBe(1);
    expect(tracker.fullTextReads).toBe(0);
    expect(tracker.sliceEnds.length).toBeGreaterThan(100);
    expect(tracker.sliceEnds[0]).toBe(5);
    expect(tracker.sliceEnds.slice(1).every((end, index) =>
      end - tracker.sliceEnds[index] <= 65_536
    )).toBe(true);
  });

  it("keeps memory chunked while scanning malformed frontmatter without a closing delimiter", async () => {
    const tracker: FileReadTracker = { fullTextReads: 0, sliceEnds: [] };
    const source = `---\ncomments: [{"id":"unclosed","resolved":false}]\n${"x".repeat(9 * 1024 * 1024)}`;
    const [file] = await withDir([fakeFile("malformed.md", source, tracker)]).list();

    expect(file.openCommentCount).toBe(0);
    expect(tracker.fullTextReads).toBe(0);
    expect(tracker.sliceEnds.length).toBeGreaterThan(100);
    expect(tracker.sliceEnds[1] - tracker.sliceEnds[0]).toBeLessThanOrEqual(65_536);
  });

  it("discards a huge unterminated comments value without retaining it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tracker: FileReadTracker = { fullTextReads: 0, sliceEnds: [] };
    const source = `---\nlibrary: {"id":"retained-meta"}\ncomments: [${"x".repeat(8 * 1024 * 1024 + 256)}\n---\nBody\n`;

    const [file] = await withDir([fakeFile("huge-malformed-comments.md", source, tracker)]).list();

    expect(file.meta.id).toBe("retained-meta");
    expect(file.openCommentCount).toBe(0);
    expect(tracker.fullTextReads).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("comments JSON exceeds"));
    warn.mockRestore();
  });

  it("indexes 1,000 ordinary files without copying document heads", async () => {
    const trackers = Array.from({ length: 1_000 }, (): FileReadTracker => ({
      fullTextReads: 0,
      sliceEnds: [],
    }));
    const files = trackers.map((tracker, index) =>
      fakeFile(`document-${index}.md`, `# Document ${index}\n${"body ".repeat(20_000)}`, tracker),
    );

    const indexed = await withDir(files).list();

    expect(indexed).toHaveLength(1_000);
    expect(trackers.every((tracker) => tracker.fullTextReads === 0)).toBe(true);
    expect(trackers.every((tracker) => tracker.sliceEnds.length === 1)).toBe(true);
    expect(trackers.every((tracker) => tracker.sliceEnds[0] === 5)).toBe(true);
  });
});

describe("native library root reconnection", () => {
  const identity = "11111111-1111-4111-8111-111111111111";
  const oldGrant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const freshGrant = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("exchanges a stable identity for a fresh root grant", async () => {
    const invoke = vi.fn(async () => ({
      grantId: freshGrant,
      identity,
      name: "research",
    })) as unknown as NativeInvoker;

    await expect(reconnectNativeLibraryRoot({
      grantId: oldGrant,
      identity,
      name: "research",
    }, invoke)).resolves.toEqual({
      grantId: freshGrant,
      identity,
      name: "research",
    });
    expect(invoke).toHaveBeenCalledWith("native_reconnect_library_root", { identity });
  });

  it("rejects legacy, missing, and mismatched root identities", async () => {
    const invoke = vi.fn(async () => null) as unknown as NativeInvoker;
    await expect(reconnectNativeLibraryRoot({
      grantId: oldGrant,
      name: "research",
    }, invoke)).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();

    const mismatch = vi.fn(async () => ({
      grantId: freshGrant,
      identity: "22222222-2222-4222-8222-222222222222",
      name: "research",
    })) as unknown as NativeInvoker;
    await expect(reconnectNativeLibraryRoot({
      grantId: oldGrant,
      identity,
      name: "research",
    }, mismatch)).resolves.toBeNull();
  });

  it("propagates native create failures to the library action notice", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("disk permission denied");
    }) as unknown as NativeInvoker;

    await expect(createNativeLibraryDocument({
      grantId: freshGrant,
      identity,
      name: "research",
    }, "notes/new.md", invoke)).rejects.toThrow("disk permission denied");
  });
});
