import { describe, expect, it } from "vitest";
import {
  MAX_LIBRARY_ASSET_BYTES,
  validateLibraryAssetPath,
  validateLibraryAssetWrite,
} from "./library-assets";

describe("library assets", () => {
  it("accepts safe nested paths", () => {
    expect(validateLibraryAssetPath("assets/figures/clock.pdf")).toBe("assets/figures/clock.pdf");
  });

  it.each(["../secret", "/tmp/a", "assets/.hidden/a", "assets//a", "C:\\tmp\\a"])(
    "rejects unsafe path %s",
    (path) => expect(() => validateLibraryAssetPath(path)).toThrow(),
  );

  it("rejects oversized writes", () => {
    expect(() => validateLibraryAssetWrite({
      path: "assets/large.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array(MAX_LIBRARY_ASSET_BYTES + 1),
    })).toThrow(/25 MiB/);
  });
});
