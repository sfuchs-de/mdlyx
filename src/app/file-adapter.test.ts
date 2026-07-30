import { describe, expect, it, vi } from "vitest";
import {
  displayPathAfterSave,
  reconnectNativeFile,
  sameFileRef,
  type FileHandle,
  type GitHubFileRef,
  type NativeFileRef,
  type NativeInvoker,
} from "./file-adapter";

const IDENTITY_A = "11111111-1111-4111-8111-111111111111";
const IDENTITY_B = "22222222-2222-4222-8222-222222222222";
const GRANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GRANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function browserHandle(
  name: string,
  isSameEntry?: (other: FileHandle) => Promise<boolean>,
): FileHandle {
  return {
    kind: "file",
    name,
    getFile: vi.fn(async () => ({}) as File),
    createWritable: vi.fn(async () => ({
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    })),
    ...(isSameEntry ? { isSameEntry } : {}),
  };
}

function native(
  grantId: string,
  identity?: string,
): NativeFileRef {
  return { kind: "native-file", grantId, identity, name: "proof.md" };
}

describe("sameFileRef", () => {
  it("uses browser isSameEntry for separately restored file handles", async () => {
    const right = browserHandle("proof.md");
    const compare = vi.fn(async (candidate: FileHandle) => candidate === right);
    const left = browserHandle("proof.md", compare);

    await expect(sameFileRef(left, right)).resolves.toBe(true);
    expect(compare).toHaveBeenCalledWith(right);
  });

  it("returns false when browser entry comparison is denied", async () => {
    const left = browserHandle("proof.md", async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    await expect(sameFileRef(left, browserHandle("proof.md"))).resolves.toBe(false);
  });

  it("compares durable native identities across process grants", async () => {
    await expect(sameFileRef(native(GRANT_A, IDENTITY_A), native(GRANT_B, IDENTITY_A)))
      .resolves.toBe(true);
    await expect(sameFileRef(native(GRANT_A, IDENTITY_A), native(GRANT_A, IDENTITY_B)))
      .resolves.toBe(false);
  });

  it("keeps same-process compatibility for legacy native grants", async () => {
    await expect(sameFileRef(native(GRANT_A), native(GRANT_A))).resolves.toBe(true);
    await expect(sameFileRef(native(GRANT_A), native(GRANT_B))).resolves.toBe(false);
  });

  it("compares GitHub documents by repository-relative path", async () => {
    const left: GitHubFileRef = { kind: "github", path: "notes/proof.md", sha: "old" };
    const right: GitHubFileRef = { kind: "github", path: "notes/proof.md", sha: "new" };
    await expect(sameFileRef(left, right)).resolves.toBe(true);
  });
});

describe("displayPathAfterSave", () => {
  it("preserves an ordinary local save but resets a same-basename Save As", () => {
    const retained = browserHandle("target.md");
    expect(displayPathAfterSave("alpha/target.md", "target.md", retained, retained))
      .toBe("alpha/target.md");
    expect(displayPathAfterSave(
      "alpha/target.md",
      "target.md",
      retained,
      browserHandle("target.md"),
    )).toBe("target.md");
  });

  it("uses durable native identity and the authoritative GitHub path", () => {
    expect(displayPathAfterSave(
      "alpha/proof.md",
      "proof.md",
      native(GRANT_A, IDENTITY_A),
      native(GRANT_B, IDENTITY_A),
    )).toBe("alpha/proof.md");
    expect(displayPathAfterSave(
      "alpha/proof.md",
      "proof.md",
      native(GRANT_A, IDENTITY_A),
      native(GRANT_B, IDENTITY_B),
    )).toBe("proof.md");
    expect(displayPathAfterSave(
      "stale/proof.md",
      "proof.md",
      native(GRANT_A, IDENTITY_A),
      { kind: "github", path: "papers/proof.md", sha: "sha-2" },
    )).toBe("papers/proof.md");
  });
});

describe("reconnectNativeFile", () => {
  it("does not send legacy or malformed identities to native code", async () => {
    const invoke = vi.fn() as unknown as NativeInvoker;
    await expect(reconnectNativeFile(native(GRANT_A), invoke)).resolves.toBeNull();
    await expect(reconnectNativeFile(native(GRANT_A, "not-an-identity"), invoke)).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("exchanges a stable identity for a fresh opaque process grant", async () => {
    const invoke = vi.fn(async () => ({
      grantId: GRANT_B,
      identity: IDENTITY_A,
      name: "proof.md",
      text: "# Reopened proof",
    })) as unknown as NativeInvoker;

    await expect(reconnectNativeFile(native(GRANT_A, IDENTITY_A), invoke)).resolves.toEqual({
      name: "proof.md",
      text: "# Reopened proof",
      handle: {
        kind: "native-file",
        grantId: GRANT_B,
        identity: IDENTITY_A,
        name: "proof.md",
      },
    });
    expect(invoke).toHaveBeenCalledWith("native_reconnect_file", { identity: IDENTITY_A });
  });

  it("returns null for an unknown identity or mismatched native response", async () => {
    const missing = vi.fn(async () => null) as unknown as NativeInvoker;
    await expect(reconnectNativeFile(native(GRANT_A, IDENTITY_A), missing)).resolves.toBeNull();

    const mismatch = vi.fn(async () => ({
      grantId: GRANT_B,
      identity: IDENTITY_B,
      name: "proof.md",
      text: "wrong file",
    })) as unknown as NativeInvoker;
    await expect(reconnectNativeFile(native(GRANT_A, IDENTITY_A), mismatch)).resolves.toBeNull();
  });
});
