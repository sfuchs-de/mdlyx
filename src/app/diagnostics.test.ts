import { describe, expect, it } from "vitest";
import { DiagnosticsStore } from "./diagnostics";

describe("DiagnosticsStore", () => {
  it("sanitizes URLs and bearer values and bounds retained events", () => {
    const store = new DiagnosticsStore();
    for (let index = 0; index < 105; index++) {
      store.record("application", new Error(
        `failed https://example.test/path?token=secret Bearer abc.${index}`,
      ));
    }
    const bundle = store.export({ state: "offline" });
    expect(bundle).not.toContain("token=secret");
    expect(bundle).not.toContain("Bearer abc");
    expect(bundle).toContain("https://example.test/path");
    expect(JSON.parse(bundle).software.events).toHaveLength(100);
  });
});
