// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubLibrary } from "./github-library";
import { renderInvitation } from "./invitation";

afterEach(() => {
  document.body.textContent = "";
  vi.restoreAllMocks();
});

describe("hosted invitation screen", () => {
  it("shows no project identity and does not redeem before explicit acceptance", async () => {
    const redeemInvitation = vi.fn(async () => ({
      authenticated: true,
      principal: { id: "alice", displayName: "Alice Smith", kind: "coauthor" as const },
    }));
    await renderInvitation({ redeemInvitation } as unknown as GitHubLibrary, "A".repeat(43));
    expect(document.body.textContent).toContain("Shared MdLyx library");
    expect(document.body.textContent).not.toContain("sample-model");
    expect(redeemInvitation).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLButtonElement>(".invite-accept")?.disabled).toBe(false);
  });

  it("fails closed for malformed or missing fragment tokens", async () => {
    const redeemInvitation = vi.fn();
    await renderInvitation({ redeemInvitation } as unknown as GitHubLibrary, null);
    const accept = document.querySelector<HTMLButtonElement>(".invite-accept")!;
    expect(accept.disabled).toBe(true);
    expect(accept.textContent).toBe("Invitation unavailable");
    expect(document.querySelector("[role='status']")?.textContent).toContain("incomplete or malformed");
    accept.click();
    expect(redeemInvitation).not.toHaveBeenCalled();
  });
});
