import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import packageJson from "../../package.json";
import tauriConfig from "../../src-tauri/tauri.conf.json";
import tauriCapabilities from "../../src-tauri/capabilities/default.json";
import type { LibrarySyncSnapshot } from "./library-sync-controller";
import {
  buildSoftwareStatus,
  resolveSoftwareIdentity,
  type SoftwareIdentity,
} from "./software-status";

const web: SoftwareIdentity = {
  version: "0.3.0",
  revision: "abc123",
  runtime: "web",
  runtimeLabel: "Hosted web",
  channel: "stable",
  distribution: "development",
};

function snapshot(state: LibrarySyncSnapshot["status"]["state"]): LibrarySyncSnapshot {
  return {
    status: {
      state,
      authenticated: false,
      releaseConfigured: true,
      serviceVersion: "0.3.0",
      serviceRevision: "def456",
    },
    connected: false,
    error: null,
    device: null,
  };
}

describe("software status", () => {
  it("keeps web, Tauri, and Cargo package versions aligned", () => {
    const cargo = readFileSync(new URL("../../src-tauri/Cargo.toml", import.meta.url), "utf8");
    const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    expect(tauriConfig.version).toBe(packageJson.version);
    expect(cargoVersion).toBe(packageJson.version);
    expect(tauriConfig.productName).toBe("MdLyx");
    expect(cargo).not.toContain('tauri-plugin-updater = "2"');
    expect(cargo).toContain('tauri-plugin-process = "2"');
    expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(false);
    expect(tauriConfig.bundle.macOS.signingIdentity).toBe("-");
    expect("plugins" in tauriConfig).toBe(false);
    expect(tauriCapabilities.permissions.some((permission) => permission.startsWith("updater:"))).toBe(false);
    expect(tauriCapabilities.permissions).toContain("process:allow-restart");
  });

  it("describes hosted builds as automatically deployed", () => {
    const status = buildSoftwareStatus(web, snapshot("ready"));
    expect(status.updateMode).toBe("automatic");
    expect(status.serviceLabel).toBe("Online and configured");
    expect(status.serviceVersion).toBe("0.3.0");
    expect(status.serviceRevision).toBe("def456");
    expect(status.releaseConfigured).toBe(true);
    expect(status.distributionLabel).toBe("Development build");
    expect(status.distributionDetail).toContain("Hosted source build");
    expect(status.githubAuthentication).toBe("Sign-in required");
  });

  it("reports the authenticated GitHub owner explicitly", () => {
    const connected = snapshot("ready");
    connected.connected = true;
    connected.status.authenticated = true;
    connected.status.login = "example-owner";
    expect(buildSoftwareStatus(web, connected).githubAuthentication).toBe("Connected as example-owner");
  });

  it("describes the signed desktop updater without claiming unattended installation", () => {
    const status = buildSoftwareStatus({
      ...web,
      runtime: "desktop",
      runtimeLabel: "macOS desktop (Tauri)",
      distribution: "signed-release",
    }, undefined, true);
    expect(status.updateMode).toBe("signed");
    expect(status.updateLabel).toBe("Signed in-app updates");
    expect(status.distributionLabel).toBe("Signed release");
    expect(status.distributionDetail).toContain("Developer ID signing");
    expect(status.distributionDetail).toContain("notarization");
    expect(status.updateDetail).toContain("configured stable release channel");
    expect(status.updateDetail).toContain("only after you confirm");
  });

  it("identifies a locally built desktop app without claiming signed provenance", () => {
    const status = buildSoftwareStatus({
      ...web,
      runtime: "desktop",
      runtimeLabel: "macOS desktop (Tauri)",
    }, undefined, false);
    expect(status.identity.distribution).toBe("development");
    expect(status.distributionLabel).toBe("Development build");
    expect(status.distributionDetail).toContain("Ad-hoc development build");
    expect(status.distributionDetail).toContain("not asserted");
    expect(status.updateMode).toBe("manual");
    expect(status.updateLabel).toBe("Manual source updates");
    expect(status.updateDetail).toContain("no configured update feed");
  });

  it("reports an incomplete private release feed independently of library health", () => {
    const library = snapshot("ready");
    library.status.releaseConfigured = false;
    const status = buildSoftwareStatus({
      ...web,
      runtime: "desktop",
      runtimeLabel: "macOS desktop (Tauri)",
      distribution: "signed-release",
    }, library, true);
    expect(status.serviceLabel).toBe("Online and configured");
    expect(status.releaseConfigured).toBe(false);
    expect(status.updateDetail).toContain("private desktop releases still need");
  });

  it.each([
    ["setup", "Online; GitHub setup incomplete"],
    ["offline", "Offline or unreachable"],
    ["unavailable", "Not configured"],
  ] as const)("maps %s service health", (state, label) => {
    expect(buildSoftwareStatus(web, snapshot(state)).serviceLabel).toBe(label);
  });

  it("reads the installed Tauri version and falls back safely", async () => {
    const desktop = { ...web, runtime: "desktop" as const };
    await expect(resolveSoftwareIdentity(desktop, async () => "0.4.2")).resolves.toMatchObject({ version: "0.4.2" });
    await expect(resolveSoftwareIdentity(desktop, async () => { throw new Error("unavailable"); }))
      .resolves.toEqual(desktop);
    const nativeVersion = vi.fn(async () => "9.9.9");
    await expect(resolveSoftwareIdentity(web, nativeVersion)).resolves.toEqual(web);
    expect(nativeVersion).not.toHaveBeenCalled();
  });
});
