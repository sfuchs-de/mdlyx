import { describe, expect, it } from "vitest";
import {
  configFromEnv,
  isConfigured,
  isReleaseConfigured,
  pendingDeviceStoreModeFromEnv,
} from "./config.js";

const required = {
  APP_ORIGIN: "https://mdlyx.onrender.com",
  ALLOWED_GITHUB_LOGIN: "example-owner",
  LIBRARY_OWNER: "example-owner",
  LIBRARY_REPO: "research-library",
  SESSION_SECRET: "secret",
  INVITE_TOKEN_SECRET: "invite-secret",
  GITHUB_APP_ID: "123",
  GITHUB_CLIENT_ID: "client",
  GITHUB_CLIENT_SECRET: "client-secret",
  GITHUB_INSTALLATION_ID: "456",
  GITHUB_PRIVATE_KEY: "private-key",
};

describe("server configuration", () => {
  it("uses explicit library identity and defaults release ownership to it", () => {
    const config = configFromEnv(required);
    expect(config).toMatchObject({
      apiOrigin: required.APP_ORIGIN,
      releaseOwner: "example-owner",
      releaseRepo: "mdlyx",
      libraryBranch: "main",
      libraryProtectedBranch: "main",
    });
    expect(config.releaseGithubAppId).toBeUndefined();
    expect(config.releaseGithubInstallationId).toBeUndefined();
    expect(config.releaseGithubPrivateKey).toBeUndefined();
    expect(isConfigured(required)).toBe(true);
    expect(isReleaseConfigured(required)).toBe(false);
  });

  it("treats blank branch settings as main so protection cannot be disabled by omission", () => {
    expect(configFromEnv({
      ...required,
      LIBRARY_BRANCH: "   ",
      LIBRARY_PROTECTED_BRANCH: "   ",
    })).toMatchObject({
      libraryBranch: "main",
      libraryProtectedBranch: "main",
    });
  });

  it("allows a topic library branch while retaining main as the protected branch", () => {
    expect(configFromEnv({
      ...required,
      LIBRARY_BRANCH: "theory/new-result",
      LIBRARY_PROTECTED_BRANCH: "",
    })).toMatchObject({
      libraryBranch: "theory/new-result",
      libraryProtectedBranch: "main",
    });
  });

  it("accepts a separate private-release GitHub App without changing library credentials", () => {
    const env = {
      ...required,
      API_ORIGIN: "https://updates.example.test",
      RELEASE_OWNER: "research-owner",
      RELEASE_REPO: "private-releases",
      RELEASE_GITHUB_APP_ID: "release-app",
      RELEASE_GITHUB_INSTALLATION_ID: "release-installation",
      RELEASE_GITHUB_PRIVATE_KEY: "release-private-key\\nsecond-line",
    };
    expect(configFromEnv(env)).toMatchObject({
      apiOrigin: "https://updates.example.test",
      releaseOwner: "research-owner",
      releaseRepo: "private-releases",
      releaseGithubAppId: "release-app",
      releaseGithubInstallationId: "release-installation",
      releaseGithubPrivateKey: "release-private-key\nsecond-line",
    });
    expect(isConfigured(env)).toBe(true);
    expect(isReleaseConfigured(env)).toBe(true);
  });

  it("uses memory locally but requires Redis in Render production", () => {
    expect(pendingDeviceStoreModeFromEnv(required)).toBe("memory");
    expect(configFromEnv(required).redisUrl).toBeUndefined();

    const render = { ...required, PENDING_DEVICE_STORE: "redis" };
    expect(isConfigured(render)).toBe(false);
    expect(() => configFromEnv(render)).toThrow("REDIS_URL");

    const configured = { ...render, REDIS_URL: "redis://mathdown-auth-kv:6379" };
    expect(isConfigured(configured)).toBe(true);
    expect(configFromEnv(configured).redisUrl).toBe("redis://mathdown-auth-kv:6379");
  });

  it("rejects an unknown pending-device store mode", () => {
    expect(() => pendingDeviceStoreModeFromEnv({ PENDING_DEVICE_STORE: "disk" })).toThrow(
      "Invalid PENDING_DEVICE_STORE",
    );
    expect(() => pendingDeviceStoreModeFromEnv({
      RENDER: "true",
      PENDING_DEVICE_STORE: "memory",
    })).toThrow("not allowed in production");
    expect(pendingDeviceStoreModeFromEnv({ NODE_ENV: "production" })).toBe("redis");
    expect(() => pendingDeviceStoreModeFromEnv({
      NODE_ENV: "production",
      PENDING_DEVICE_STORE: "memory",
    })).toThrow("not allowed in production");
  });
});
