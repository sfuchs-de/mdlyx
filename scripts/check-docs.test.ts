import { describe, expect, it } from "vitest";
import { checkDocumentation } from "./check-docs";

describe("public documentation", () => {
  it("keeps required onboarding guides and repository-local links valid", async () => {
    expect(await checkDocumentation()).toEqual([]);
  });
});
