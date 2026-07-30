import type { LibrarySyncSnapshot } from "./library-sync-controller";
import { isTauriRuntime } from "./tauri-bridge";

export type SoftwareRuntime = "web" | "desktop";
export type SoftwareDistribution = "development" | "signed-release";
export type SoftwareServiceState = "online" | "setup" | "offline" | "unavailable";

// Vite replaces this build-only environment field. Ordinary/local/CI builds
// default to `development`; the immutable desktop release workflow embeds its
// explicitly selected development or signed-release provenance.
const packagedDistribution: SoftwareDistribution = import.meta.env.MATHDOWN_DISTRIBUTION === "signed-release"
  ? "signed-release"
  : "development";
const packagedUpdatesEnabled = import.meta.env.VITE_ENABLE_UPDATER === "true";

export interface SoftwareIdentity {
  version: string;
  revision: string | null;
  runtime: SoftwareRuntime;
  runtimeLabel: string;
  channel: "stable";
  distribution: SoftwareDistribution;
}

export interface SoftwareStatus {
  identity: SoftwareIdentity;
  serviceState: SoftwareServiceState;
  serviceLabel: string;
  serviceVersion: string | null;
  serviceRevision: string | null;
  releaseConfigured: boolean | null;
  githubAuthentication: string;
  distributionLabel: string;
  distributionDetail: string;
  updateMode: "automatic" | "signed" | "manual";
  updateLabel: string;
  updateDetail: string;
}

export const packagedSoftwareIdentity: SoftwareIdentity = {
  version: __MATHDOWN_VERSION__,
  revision: __MATHDOWN_REVISION__ || null,
  runtime: isTauriRuntime ? "desktop" : "web",
  runtimeLabel: isTauriRuntime ? "macOS desktop (Tauri)" : "Hosted web",
  channel: "stable",
  distribution: packagedDistribution,
};

/**
 * Ask Tauri for the packaged version so Settings reflects the installed bundle,
 * even if the frontend and native metadata are accidentally out of sync.
 */
export async function resolveSoftwareIdentity(
  identity: SoftwareIdentity = packagedSoftwareIdentity,
  nativeVersion: () => Promise<string> = async () => {
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  },
): Promise<SoftwareIdentity> {
  if (identity.runtime !== "desktop") return identity;
  try {
    const version = (await nativeVersion()).trim();
    return version ? { ...identity, version } : identity;
  } catch {
    return identity;
  }
}

export function buildSoftwareStatus(
  identity: SoftwareIdentity,
  sync?: LibrarySyncSnapshot,
  updatesEnabled = packagedUpdatesEnabled,
): SoftwareStatus {
  const serviceState = sync?.status.state === "ready"
    ? "online"
    : sync?.status.state === "setup"
      ? "setup"
      : sync?.status.state === "offline"
        ? "offline"
        : "unavailable";
  const serviceLabel = serviceState === "online"
    ? "Online and configured"
    : serviceState === "setup"
      ? "Online; GitHub setup incomplete"
      : serviceState === "offline"
        ? "Offline or unreachable"
        : "Not configured";
  const desktop = identity.runtime === "desktop";
  const releaseConfigured = typeof sync?.status.releaseConfigured === "boolean"
    ? sync.status.releaseConfigured
    : null;
  const signedRelease = identity.distribution === "signed-release";
  return {
    identity,
    serviceState,
    serviceLabel,
    serviceVersion: sync?.status.serviceVersion ?? null,
    serviceRevision: sync?.status.serviceRevision ?? null,
    releaseConfigured,
    githubAuthentication: sync?.connected
      ? sync.status.principal?.kind === "coauthor"
        ? `Shared access as ${sync.status.principal.displayName}`
        : `Connected as ${sync.status.login ?? "GitHub owner"}`
      : "Sign-in required",
    distributionLabel: signedRelease ? "Signed release" : "Development build",
    distributionDetail: signedRelease
      ? "Built by the protected desktop release workflow for Developer ID signing, notarization, and signed updater publication."
      : desktop
        ? "Ad-hoc development build; Developer ID signing and notarization are not asserted for this installation."
        : "Hosted source build; signed-release provenance applies only to desktop artifacts produced by the protected release workflow.",
    updateMode: desktop ? updatesEnabled ? "signed" : "manual" : "automatic",
    updateLabel: desktop
      ? updatesEnabled
        ? signedRelease ? "Signed in-app updates" : "Verified development updates"
        : "Manual source updates"
      : "Automatic hosted deployment",
    updateDetail: desktop
      ? !updatesEnabled
        ? "This public source build has no configured update feed. Rebuild it or install a newer release from the project repository."
        : releaseConfigured === false
        ? "The library service is available, but private desktop releases still need the separate read-only GitHub App and Render release credentials."
        : signedRelease
          ? "MdLyx checks the configured stable release channel automatically. Downloads, signature verification, installation, and relaunch happen only after you confirm them here."
          : "MdLyx checks the configured development feed and verifies updater archives with its embedded key."
      : "Render deploys the main branch automatically. Reloading the page after a successful deployment loads the current hosted build.",
  };
}
