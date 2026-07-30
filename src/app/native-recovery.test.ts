import { describe, expect, it } from "vitest";
import { reconcileNativeRecovery } from "./native-recovery";

describe("native recovery reconciliation", () => {
  it("refreshes clean tabs from the current disk source", () => {
    expect(reconcileNativeRecovery("cached", false, "cached", "external")).toEqual({
      text: "external",
      dirty: false,
      attachGrant: true,
      conflict: false,
      baseText: "external",
    });
  });

  it("reattaches dirty recovery only when disk still matches the exact base", () => {
    expect(reconcileNativeRecovery("local work", true, "base", "base")).toMatchObject({
      text: "local work",
      dirty: true,
      attachGrant: true,
      conflict: false,
    });
  });

  it("recognizes an already-persisted recovery revision", () => {
    expect(reconcileNativeRecovery("same", true, undefined, "same")).toMatchObject({
      text: "same",
      dirty: false,
      attachGrant: true,
      conflict: false,
    });
  });

  it("keeps divergent recovery text but withholds the write grant", () => {
    expect(reconcileNativeRecovery("local work", true, "base", "external")).toEqual({
      text: "local work",
      dirty: true,
      attachGrant: false,
      conflict: true,
      baseText: "base",
    });
    expect(reconcileNativeRecovery("legacy recovery", true, undefined, "disk").attachGrant)
      .toBe(false);
  });
});
