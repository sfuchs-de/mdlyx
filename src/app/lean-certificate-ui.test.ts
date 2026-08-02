// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLeanCertificateBadge, openLeanCertificateEvidence } from "./lean-certificate-ui";
import type { LeanCertificateEvidence } from "./lean-certificates";

const evidence: LeanCertificateEvidence = {
  resultId: "R-A",
  resultTitle: "Exact result",
  project: "p",
  ownerDocumentId: "owner",
  ownerPath: "projects/p/owner.md",
  coverage: "partial",
  status: "kernel-checked",
  declarations: ["Mathdown.exact_result"],
  certifiedScope: ["exact identity"],
  assumptions: ["finite inputs"],
  excludedScope: ["economic admissibility"],
  sourcePath: "formal/Mathdown/Proof.lean",
  sourceText: "theorem exact_result : True := by trivial",
  manifestPath: "formal/lake-manifest.json",
  leanVersion: "4.30.0",
  mathlibVersion: "4.30.0",
  buildState: "passed",
};

afterEach(() => { document.body.textContent = ""; });

describe("Lean certificate evidence UI", () => {
  it("labels partial coverage without implying full validation", () => {
    const badge = createLeanCertificateBadge(evidence);
    expect(badge.textContent).toBe("L◐");
    expect(badge.getAttribute("aria-label")).toContain("partial coverage");
    expect(badge.title).toContain("Not certified: economic admissibility");
  });

  it("opens scoped evidence and routes to the owning result", () => {
    const openOwner = vi.fn();
    openLeanCertificateEvidence(evidence, openOwner);
    const dialog = document.querySelector(".lean-certificate-dialog")!;
    expect(dialog.textContent).toContain("Certified scope");
    expect(dialog.textContent).toContain("Not certified");
    expect(dialog.textContent).toContain("Mathdown.exact_result");
    expect(dialog.querySelector(".lean-certificate-source")?.textContent).toContain("View certificate source");
    expect(dialog.querySelector(".lean-certificate-source code")?.textContent).toContain("theorem exact_result");
    (dialog.querySelector(".lean-certificate-owner") as HTMLButtonElement).click();
    expect(openOwner).toHaveBeenCalledOnce();
  });
});
