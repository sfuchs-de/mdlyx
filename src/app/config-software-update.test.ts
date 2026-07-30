// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { reflectSoftwareUpdateAvailability } from "./config";
import type { SoftwareUpdateSnapshot } from "./software-updater";

function snapshot(
  phase: SoftwareUpdateSnapshot["phase"],
  availableVersion: string | null,
): SoftwareUpdateSnapshot {
  return {
    phase,
    currentVersion: "0.3.1",
    availableVersion,
    publishedAt: null,
    notes: null,
    downloadedBytes: 0,
    totalBytes: null,
    checkedAt: null,
    error: null,
    errorStage: null,
  };
}

describe("desktop update Settings cue", () => {
  it("exposes a discovered update visually and to assistive technology until its state changes", () => {
    const button = document.createElement("button");
    reflectSoftwareUpdateAvailability(button, snapshot("available", "0.4.0"));
    expect(button.classList.contains("update-available")).toBe(true);
    expect(button.dataset.updateAvailable).toBe("0.4.0");
    expect(button.title).toContain("0.4.0 available");
    expect(button.getAttribute("aria-label")).toContain("0.4.0 available");

    reflectSoftwareUpdateAvailability(button, snapshot("downloaded", "0.4.0"));
    expect(button.classList.contains("update-available")).toBe(true);
    expect(button.title).toContain("ready to install");

    reflectSoftwareUpdateAvailability(button, snapshot("restart-required", "0.4.0"));
    expect(button.classList.contains("update-available")).toBe(true);
    expect(button.title).toContain("relaunch required");

    reflectSoftwareUpdateAvailability(button, snapshot("up-to-date", null));
    expect(button.classList.contains("update-available")).toBe(false);
    expect(button.dataset.updateAvailable).toBeUndefined();
    expect(button.title).toBe("Settings");
    expect(button.getAttribute("aria-label")).toBe("Settings");
  });
});
