import { describe, expect, it } from "vitest";
import {
  MAX_LIBRARY_ASSET_BYTES,
  validateLibraryAssetPath,
  validateLibraryAssetWrite,
} from "./library-assets";

describe("library assets", () => {
  it("accepts safe nested paths", () => {
    expect(validateLibraryAssetPath("assets/figures/clock.pdf")).toBe("assets/figures/clock.pdf");
    expect(validateLibraryAssetPath("formal/certificate-map.yaml")).toBe("formal/certificate-map.yaml");
  });

  it("limits structured proof assets to the formal evidence root", () => {
    expect(() => validateLibraryAssetPath("projects/p/project.yaml")).toThrow(/not supported/);
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
