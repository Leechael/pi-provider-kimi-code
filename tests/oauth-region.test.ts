import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ENV_KIMI_CODE_REGION,
  applyKimiRegionEnvBridge,
  getDefaultBaseUrl,
  getOAuthHost,
  setKimiRegionOverride,
} from "../src/constants.ts";
import { isKimiCredentialRegionValid } from "../src/oauth.ts";

describe("applyKimiRegionEnvBridge", () => {
  it("bridges the global region into KIMI_CODE_OAUTH_HOST", () => {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(applyKimiRegionEnvBridge(env, "global"), true);
    assert.equal(env.KIMI_CODE_OAUTH_HOST, "https://auth.kimi.ai");
  });

  it("does nothing for the default mainland region", () => {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(applyKimiRegionEnvBridge(env, "mainland-cn"), false);
    assert.equal(env.KIMI_CODE_OAUTH_HOST, undefined);
  });

  it("never overrides an explicit OAuth host configuration", () => {
    const explicit: NodeJS.ProcessEnv = { KIMI_CODE_OAUTH_HOST: "https://auth.example.com" };
    assert.equal(applyKimiRegionEnvBridge(explicit, "global"), false);
    assert.equal(explicit.KIMI_CODE_OAUTH_HOST, "https://auth.example.com");

    // A later re-apply must not retract the user's own value.
    assert.equal(applyKimiRegionEnvBridge(explicit, "mainland-cn"), false);
    assert.equal(explicit.KIMI_CODE_OAUTH_HOST, "https://auth.example.com");
  });

  it("forwards the KIMI_OAUTH_HOST alias into the variable pi core reads", () => {
    const aliased: NodeJS.ProcessEnv = { KIMI_OAUTH_HOST: "https://auth.example.com" };
    assert.equal(applyKimiRegionEnvBridge(aliased, "global"), false);
    assert.equal(aliased.KIMI_CODE_OAUTH_HOST, "https://auth.example.com");
    // The alias remains the source of truth.
    assert.equal(aliased.KIMI_OAUTH_HOST, "https://auth.example.com");
  });
});

describe("region override from plugin config", () => {
  const ENV_HOST_KEYS = ["KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST"] as const;
  const savedHostEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    setKimiRegionOverride(null);
    for (const key of ENV_HOST_KEYS) {
      const saved = savedHostEnv[key];
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  function clearHostEnv(): void {
    for (const key of ENV_HOST_KEYS) {
      savedHostEnv[key] = process.env[key];
      delete process.env[key];
    }
  }

  it("drives default endpoints and the OAuth host from the override", () => {
    clearHostEnv();
    setKimiRegionOverride("global");
    assert.equal(getDefaultBaseUrl("openai"), "https://api.kimi.ai/coding/v1");
    assert.equal(getOAuthHost(), "https://auth.kimi.ai");

    setKimiRegionOverride("mainland-cn");
    assert.equal(getDefaultBaseUrl("openai"), "https://api.kimi.com/coding/v1");
    assert.equal(getOAuthHost(), "https://auth.kimi.com");
  });

  it("falls back to the env capture when the override is cleared", () => {
    setKimiRegionOverride("global");
    setKimiRegionOverride(null);
    // After clearing, the module-load env capture decides again.
    assert.equal(getDefaultBaseUrl("openai"), getDefaultBaseUrl("openai", ENV_KIMI_CODE_REGION));
  });
});

describe("applyKimiRegionEnvBridge ownership", () => {
  it("retracts an injected host when re-applied for the default region", () => {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(applyKimiRegionEnvBridge(env, "global"), true);
    assert.equal(env.KIMI_CODE_OAUTH_HOST, "https://auth.kimi.ai");

    assert.equal(applyKimiRegionEnvBridge(env, "mainland-cn"), false);
    assert.equal(env.KIMI_CODE_OAUTH_HOST, undefined);
  });

  it("keeps an explicitly configured host across re-applies", () => {
    const env: NodeJS.ProcessEnv = { KIMI_CODE_OAUTH_HOST: "https://auth.example.com" };
    assert.equal(applyKimiRegionEnvBridge(env, "global"), false);
    assert.equal(env.KIMI_CODE_OAUTH_HOST, "https://auth.example.com");

    // A later re-apply must not retract the user's own value.
    assert.equal(applyKimiRegionEnvBridge(env, "mainland-cn"), false);
    assert.equal(env.KIMI_CODE_OAUTH_HOST, "https://auth.example.com");
  });
});

describe("isKimiCredentialRegionValid", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("treats an explicit 401 as region-invalid and other statuses as usable", async () => {
    globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
    assert.equal(await isKimiCredentialRegionValid("tok"), false);

    globalThis.fetch = async () => new Response("{}", { status: 200 });
    assert.equal(await isKimiCredentialRegionValid("tok"), true);

    globalThis.fetch = async () => new Response("server error", { status: 500 });
    assert.equal(await isKimiCredentialRegionValid("tok"), true);
  });

  it("probes the current region's managed /me endpoint and keeps usability on network failures", async () => {
    let requestedUrl: string | undefined;
    let authHeader: string | null = null;
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      throw new Error("offline");
    };

    assert.equal(await isKimiCredentialRegionValid("tok-1"), true);
    assert.match(requestedUrl ?? "", /\/v1\/me$/);
    assert.equal(authHeader, "Bearer tok-1");
  });
});
