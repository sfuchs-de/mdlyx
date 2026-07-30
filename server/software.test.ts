import { describe, expect, it } from "vitest";
import { serviceSoftwareInfo } from "./software.js";

describe("service software info", () => {
  it("reports the npm version and a bounded deployment revision", () => {
    expect(serviceSoftwareInfo({
      npm_package_version: "0.3.0",
      RENDER_GIT_COMMIT: "1234567890abcdef",
    })).toEqual({ version: "0.3.0", revision: "1234567890ab" });
  });

  it("has a truthful fallback outside an npm-managed deployment", () => {
    expect(serviceSoftwareInfo({})).toEqual({ version: "unknown" });
  });
});
