import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyKimiRegionEnvBridge } from "../src/constants.ts";
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

    const aliased: NodeJS.ProcessEnv = { KIMI_OAUTH_HOST: "https://auth.example.com" };
    assert.equal(applyKimiRegionEnvBridge(aliased, "global"), false);
    assert.equal(aliased.KIMI_CODE_OAUTH_HOST, undefined);
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
