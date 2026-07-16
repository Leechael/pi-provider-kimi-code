import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_KIMI_CODE_CONFIG } from "../src/config.ts";
import { DEFAULT_KIMI_MODEL_INPUT, PROVIDER_ID } from "../src/constants.ts";
import {
  applyKimiMembershipLimitsToModel,
  applyKimiOAuthExtrasToModel,
  discoverKimiModelMetadata,
  isKimiModelAvailableForMembership,
  resolveKimiModelConfig,
} from "../src/models.ts";
import {
  getKimiApiKey,
  isKimiAuthErrorMessage,
  refreshAccessToken,
  refreshKimiAuthToken,
  refreshKimiCodeToken,
  requestDeviceAuthorization,
  requestDeviceToken,
} from "../src/oauth.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(responder: (call: FetchCall) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const call: FetchCall = { url, init };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let mock: ReturnType<typeof mockFetch> | undefined;

afterEach(() => {
  mock?.restore();
  mock = undefined;
});

beforeEach(() => {
  delete process.env.KIMI_CODE_BASE_URL;
  delete process.env.KIMI_BASE_URL;
  delete process.env.KIMI_MODEL_NAME;
  delete process.env.KIMI_MODEL_MAX_CONTEXT_SIZE;
  delete process.env.KIMI_MODEL_CAPABILITIES;
  delete process.env.KIMI_CODE_OAUTH_HOST;
  delete process.env.KIMI_OAUTH_HOST;
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("discoverKimiModelMetadata", () => {
  it("returns empty when accessToken is missing", async () => {
    mock = mockFetch(() => jsonResponse({}));
    const result = await discoverKimiModelMetadata("");
    assert.deepEqual(result, {});
    assert.equal(mock.calls.length, 0);
  });

  it("hits /v1/models on the configured base URL with Bearer auth", async () => {
    mock = mockFetch(() =>
      jsonResponse({
        data: [{ id: "kimi-for-coding", display_name: "Kimi For Coding", context_length: 262144 }],
      }),
    );

    await discoverKimiModelMetadata("tok-1");

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0]?.url, "https://api.kimi.com/coding/v1/models");
    const headers = mock.calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer tok-1");
  });

  it("retains metadata for every model returned by the catalog", async () => {
    mock = mockFetch(() =>
      jsonResponse({
        data: [
          {
            id: "kimi-for-coding",
            display_name: "Kimi For Coding",
            context_length: 262144,
            supports_reasoning: true,
            supports_image_in: true,
          },
          {
            id: "kimi-for-coding-highspeed",
            display_name: "Kimi For Coding High Speed",
            context_length: 524288,
            supports_reasoning: true,
            supports_video_in: true,
            protocol: "anthropic",
            think_efforts: {
              support: true,
              valid_efforts: ["low", "high"],
              default_effort: "high",
            },
          },
          {
            id: "k3",
            display_name: "k3",
            context_length: 1048576,
            supports_reasoning: true,
            supports_image_in: true,
            supports_video_in: true,
            supports_thinking_type: "only",
            think_efforts: {
              support: true,
              valid_efforts: ["max"],
              default_effort: "max",
            },
          },
        ],
      }),
    );

    const result = await discoverKimiModelMetadata("tok-1");
    assert.equal(result.wireModelId, "kimi-for-coding");
    assert.equal(result.modelDisplay, "Kimi For Coding");
    assert.equal(result.contextLength, 262144);
    assert.equal(result.supportsReasoning, true);
    assert.equal(result.supportsImageIn, true);
    assert.deepEqual(result.modelCatalog?.["kimi-for-coding-highspeed"], {
      wireModelId: "kimi-for-coding-highspeed",
      modelDisplay: "Kimi For Coding High Speed",
      contextLength: 524288,
      supportsReasoning: true,
      supportsVideoIn: true,
      protocol: "anthropic",
      supportEfforts: ["low", "high"],
      defaultEffort: "high",
    });
    assert.deepEqual(result.modelCatalog?.k3, {
      wireModelId: "k3",
      modelDisplay: "k3",
      contextLength: 1048576,
      supportsThinkingType: "only",
      supportsImageIn: true,
      supportsVideoIn: true,
      supportEfforts: ["max"],
      defaultEffort: "max",
    });
  });

  it("returns empty when no kimi-for-coding is present", async () => {
    mock = mockFetch(() =>
      jsonResponse({
        data: [{ id: "k2p7-beta", display_name: "Beta K2.7", context_length: 1048576 }],
      }),
    );

    const result = await discoverKimiModelMetadata("tok-1");
    assert.deepEqual(result, {});
  });

  it("returns empty when the server replies non-2xx", async () => {
    mock = mockFetch(() => new Response("nope", { status: 401 }));
    const result = await discoverKimiModelMetadata("tok-1");
    assert.deepEqual(result, {});
  });

  it("returns empty when model discovery times out", async () => {
    mock = mockFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const result = await discoverKimiModelMetadata("tok-1", undefined, { timeoutMs: 1 });
    assert.deepEqual(result, {});
  });

  it("returns empty when the response is malformed", async () => {
    mock = mockFetch(() => new Response("not json", { status: 200 }));
    const result = await discoverKimiModelMetadata("tok-1");
    assert.deepEqual(result, {});
  });

  it("returns empty when data is missing or empty", async () => {
    mock = mockFetch(() => jsonResponse({ data: [] }));
    const result = await discoverKimiModelMetadata("tok-1");
    assert.deepEqual(result, {});
  });

  it("parses supports_thinking_type and prefers it over supports_reasoning", async () => {
    mock = mockFetch(() =>
      jsonResponse({
        data: [
          {
            id: "kimi-for-coding",
            supports_thinking_type: "only",
            supports_reasoning: false,
          },
        ],
      }),
    );

    const result = await discoverKimiModelMetadata("tok-1");
    assert.equal(result.supportsThinkingType, "only");
    assert.equal(result.supportsReasoning, undefined);
  });

  it("falls back to supports_reasoning when supports_thinking_type is missing", async () => {
    mock = mockFetch(() =>
      jsonResponse({
        data: [{ id: "kimi-for-coding", supports_reasoning: true }],
      }),
    );

    const result = await discoverKimiModelMetadata("tok-1");
    assert.equal(result.supportsThinkingType, undefined);
    assert.equal(result.supportsReasoning, true);
  });

  it("ignores unknown supports_thinking_type values and falls back", async () => {
    mock = mockFetch(() =>
      jsonResponse({
        data: [
          { id: "kimi-for-coding", supports_thinking_type: "maybe", supports_reasoning: true },
        ],
      }),
    );

    const result = await discoverKimiModelMetadata("tok-1");
    assert.equal(result.supportsThinkingType, undefined);
    assert.equal(result.supportsReasoning, true);
  });

  it("marks a fresh standard-only catalog so unavailable models can be removed", async () => {
    mock = mockFetch(() => jsonResponse({ data: [{ id: "kimi-for-coding" }] }));
    const result = await discoverKimiModelMetadata("tok-1");
    assert.deepEqual(result, {
      wireModelId: "kimi-for-coding",
      modelCatalog: {
        "kimi-for-coding": { wireModelId: "kimi-for-coding" },
      },
      modelCatalogVersion: 1,
    });
  });

  it("respects KIMI_CODE_BASE_URL when computing the discovery endpoint", async () => {
    process.env.KIMI_CODE_BASE_URL = "https://proxy.example.com/kimi";
    mock = mockFetch(() =>
      jsonResponse({ data: [{ id: "kimi-for-coding", context_length: 100 }] }),
    );

    await discoverKimiModelMetadata("tok-1");
    assert.equal(mock.calls[0]?.url, "https://proxy.example.com/kimi/v1/models");
  });

  it("accepts official KIMI_BASE_URL as a base URL alias", async () => {
    process.env.KIMI_BASE_URL = "https://official.example.com/kimi";
    mock = mockFetch(() =>
      jsonResponse({ data: [{ id: "kimi-for-coding", context_length: 100 }] }),
    );

    await discoverKimiModelMetadata("tok-1");
    assert.equal(mock.calls[0]?.url, "https://official.example.com/kimi/v1/models");
  });

  it("keeps KIMI_CODE_BASE_URL precedence over KIMI_BASE_URL", async () => {
    process.env.KIMI_CODE_BASE_URL = "https://code.example.com/kimi";
    process.env.KIMI_BASE_URL = "https://official.example.com/kimi";
    mock = mockFetch(() =>
      jsonResponse({ data: [{ id: "kimi-for-coding", context_length: 100 }] }),
    );

    await discoverKimiModelMetadata("tok-1");
    assert.equal(mock.calls[0]?.url, "https://code.example.com/kimi/v1/models");
  });
});

describe("Kimi membership model limits", () => {
  it("applies the documented model access matrix for known plans", () => {
    assert.equal(isKimiModelAvailableForMembership("k3", "LEVEL_BASIC"), false);
    assert.equal(isKimiModelAvailableForMembership("k3", "LEVEL_STANDARD"), true);
    assert.equal(isKimiModelAvailableForMembership("k3", "LEVEL_INTERMEDIATE"), true);
    assert.equal(
      isKimiModelAvailableForMembership("kimi-for-coding-highspeed", "LEVEL_STANDARD"),
      false,
    );
    assert.equal(
      isKimiModelAvailableForMembership("kimi-for-coding-highspeed", "LEVEL_INTERMEDIATE"),
      true,
    );
    assert.equal(isKimiModelAvailableForMembership("k3", "LEVEL_UNKNOWN"), undefined);
  });

  it("caps Moderato K3 at 256K without reducing higher plans", () => {
    const model = {
      id: "k3",
      contextWindow: 1048576,
    } as Model<Api>;

    assert.equal(applyKimiMembershipLimitsToModel(model, "LEVEL_STANDARD").contextWindow, 262144);
    assert.equal(
      applyKimiMembershipLimitsToModel(model, "LEVEL_INTERMEDIATE").contextWindow,
      1048576,
    );
    assert.equal(applyKimiMembershipLimitsToModel(model, "LEVEL_UNKNOWN").contextWindow, 1048576);
  });
});

describe("applyKimiOAuthExtrasToModel", () => {
  it("applies server capabilities to the registered Kimi model", () => {
    const model: Model<Api> = {
      id: "kimi-for-coding",
      name: "Kimi for Coding",
      provider: "kimi-coding",
      api: "kimi-anthropic-messages" as Api,
      baseUrl: "https://api.kimi.com/coding",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32000,
    };

    const result = applyKimiOAuthExtrasToModel(model, {
      wireModelId: "kimi-k2-next",
      modelDisplay: "Kimi K2 Next",
      contextLength: 1048576,
      supportsReasoning: true,
      supportsImageIn: true,
      protocol: "anthropic",
    }) as Model<Api> & { wireModelId?: string; wireProtocol?: string; input: string[] };

    assert.equal(result.name, "Kimi K2 Next");
    assert.equal(result.contextWindow, 1048576);
    assert.equal(result.wireModelId, "kimi-k2-next");
    assert.equal(result.wireProtocol, "anthropic");
    assert.equal(result.reasoning, true);
    assert.deepEqual(result.input, ["text", "image"]);
  });

  it("sets supportsThinkingType on the model when present in extras", () => {
    const model: Model<Api> = {
      id: "kimi-for-coding",
      name: "Kimi for Coding",
      provider: "kimi-coding",
      api: "kimi-openai-completions" as Api,
      baseUrl: "https://api.kimi.com/coding/v1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32000,
    };

    const onlyResult = applyKimiOAuthExtrasToModel(model, {
      supportsThinkingType: "only",
    }) as Model<Api> & { supportsThinkingType?: "only" | "no" | "both" };
    assert.equal(onlyResult.reasoning, true);
    assert.equal(onlyResult.supportsThinkingType, "only");

    const noResult = applyKimiOAuthExtrasToModel(model, {
      supportsThinkingType: "no",
    }) as Model<Api> & { supportsThinkingType?: "only" | "no" | "both" };
    assert.equal(noResult.reasoning, false);
    assert.equal(noResult.supportsThinkingType, "no");

    const bothResult = applyKimiOAuthExtrasToModel(model, {
      supportsThinkingType: "both",
    }) as Model<Api> & { supportsThinkingType?: "only" | "no" | "both" };
    assert.equal(bothResult.reasoning, true);
    assert.equal(bothResult.supportsThinkingType, "both");
  });

  it("preserves image input when only video support is reported false", () => {
    const model: Model<Api> = {
      id: "kimi-for-coding",
      name: "Kimi for Coding",
      provider: "kimi-coding",
      api: "kimi-openai-completions" as Api,
      baseUrl: "https://api.kimi.com/coding/v1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32000,
    };

    const result = applyKimiOAuthExtrasToModel(model, {
      supportsVideoIn: false,
    }) as Model<Api> & { input: string[] };

    assert.deepEqual(result.input, ["text", "image"]);
  });

  it("does not set supportsThinkingType when not in extras", () => {
    const model: Model<Api> = {
      id: "kimi-for-coding",
      name: "Kimi for Coding",
      provider: "kimi-coding",
      api: "kimi-openai-completions" as Api,
      baseUrl: "https://api.kimi.com/coding/v1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32000,
    };

    const result = applyKimiOAuthExtrasToModel(model, {
      supportsReasoning: true,
    }) as Model<Api> & { supportsThinkingType?: "only" | "no" | "both" };
    assert.equal(result.reasoning, true);
    assert.equal(result.supportsThinkingType, undefined);
  });

  it("clears supportsThinkingType when extras has supportsReasoning but not supportsThinkingType", () => {
    const model: Model<Api> & { supportsThinkingType?: "only" | "no" | "both" } = {
      id: "kimi-for-coding",
      name: "Kimi for Coding",
      provider: "kimi-coding",
      api: "kimi-openai-completions" as Api,
      baseUrl: "https://api.kimi.com/coding/v1",
      reasoning: true,
      supportsThinkingType: "only",
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32000,
    };

    const result = applyKimiOAuthExtrasToModel(model, {
      supportsReasoning: false,
    }) as Model<Api> & { supportsThinkingType?: "only" | "no" | "both" };
    assert.equal(result.reasoning, false);
    assert.equal(result.supportsThinkingType, undefined);
  });
});

describe("resolveKimiModelConfig", () => {
  it("preserves configured image input when only video support is reported false", () => {
    const result = resolveKimiModelConfig(DEFAULT_KIMI_CODE_CONFIG.model, {
      supportsVideoIn: false,
    });

    assert.deepEqual(result.input, ["text", "image"]);
  });
});

describe("DEFAULT_KIMI_MODEL_INPUT", () => {
  it("advertises text and image input by default", () => {
    assert.deepEqual([...DEFAULT_KIMI_MODEL_INPUT], ["text", "image"]);
  });
});

describe("device authorization", () => {
  it("accepts responses that only include verification_uri", async () => {
    mock = mockFetch(() =>
      jsonResponse({
        user_code: "ABCD-EFGH",
        device_code: "device-1",
        verification_uri: "https://auth.example.com/device",
        expires_in: 600,
        interval: 5,
      }),
    );

    const auth = await requestDeviceAuthorization();

    assert.equal(auth.verification_uri, "https://auth.example.com/device");
    assert.equal(auth.verification_uri_complete, "https://auth.example.com/device");
  });

  it("treats slow_down as a polling state", async () => {
    mock = mockFetch(() => jsonResponse({ error: "slow_down" }, 400));

    const result = await requestDeviceToken({
      user_code: "ABCD-EFGH",
      device_code: "device-1",
      verification_uri: "https://auth.example.com/device",
      verification_uri_complete: "https://auth.example.com/device?user_code=ABCD-EFGH",
      expires_in: 600,
      interval: 5,
    });

    assert.equal(result, "slow_down");
  });
});

describe("refreshAccessToken", () => {
  it("retries retryable refresh failures before returning the token", async () => {
    let attempts = 0;
    mock = mockFetch(() => {
      attempts++;
      if (attempts === 1) return new Response("busy", { status: 503 });
      return jsonResponse({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
        scope: "",
        token_type: "Bearer",
      });
    });

    const waits: number[] = [];
    const token = await refreshAccessToken("refresh-1", {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    assert.equal(attempts, 2);
    assert.deepEqual(waits, [1000]);
    assert.equal(token.access_token, "access-2");
  });

  it("does not retry unauthorized refresh responses", async () => {
    let attempts = 0;
    mock = mockFetch(() => {
      attempts++;
      return new Response("revoked", { status: 401 });
    });

    await assert.rejects(
      refreshAccessToken("refresh-1", {
        sleep: async () => {},
      }),
      /Kimi Code authorization is no longer valid/,
    );
    assert.equal(attempts, 1);
  });
});

describe("refreshKimiAuthToken", () => {
  function withTempAuthFile(
    credential: Record<string, unknown>,
    kimiCredential?: Record<string, unknown>,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "pi-kimi-auth-"));
    const kimiHome = join(dir, "kimi-code");
    const kimiCredentialPath = join(kimiHome, "credentials", "kimi-code.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ [PROVIDER_ID]: credential }), "utf8");
    if (kimiCredential) {
      mkdirSync(join(kimiHome, "credentials"), { recursive: true });
      writeFileSync(kimiCredentialPath, JSON.stringify(kimiCredential), "utf8");
    }
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.KIMI_CODE_HOME = kimiHome;
    process.env.KIMI_SHARE_DIR = join(dir, "no-legacy-credentials");
    return {
      dir,
      readCredential() {
        return JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))[PROVIDER_ID];
      },
      readKimiCredential() {
        return JSON.parse(readFileSync(kimiCredentialPath, "utf8"));
      },
      cleanup() {
        rmSync(dir, { recursive: true, force: true });
        delete process.env.PI_CODING_AGENT_DIR;
        delete process.env.KIMI_CODE_HOME;
        delete process.env.KIMI_SHARE_DIR;
      },
    };
  }

  it("reuses a newer on-disk access token without calling the refresh endpoint", async () => {
    const auth = withTempAuthFile({
      type: "oauth",
      access: "newer-access",
      refresh: "refresh-1",
      expires: Date.now() + 60_000,
    });
    mock = mockFetch(() => {
      throw new Error("fetch should not be called");
    });

    try {
      const result = await refreshKimiAuthToken("stale-access");
      assert.equal(result, "newer-access");
      assert.equal(mock.calls.length, 0);
    } finally {
      auth.cleanup();
    }
  });

  it("refreshes stale OAuth credentials without writing Pi auth storage", async () => {
    const auth = withTempAuthFile({
      type: "oauth",
      access: "stale-access",
      refresh: "refresh-1",
      expires: Date.now() - 1,
      wireModelId: "kimi-for-coding",
      modelDisplay: "Kimi For Coding",
    });
    mock = mockFetch(() =>
      jsonResponse({
        access_token: "fresh-access",
        refresh_token: "refresh-2",
        expires_in: 900,
        scope: "kimi-code",
        token_type: "Bearer",
      }),
    );

    try {
      const result = await refreshKimiAuthToken("stale-access");
      assert.equal(result, "fresh-access");
      const stored = auth.readCredential();
      assert.equal(stored.access, "stale-access");
      assert.equal(stored.refresh, "refresh-1");
      assert.equal(stored.wireModelId, "kimi-for-coding");
      assert.equal(auth.readKimiCredential().refresh_token, "refresh-2");
    } finally {
      auth.cleanup();
    }
  });

  it("regression: uses Pi credentials as the canonical runtime access token", () => {
    const auth = withTempAuthFile(
      {
        type: "oauth",
        access: "pi-access",
        refresh: "pi-refresh",
        expires: Date.now() + 60_000,
      },
      {
        access_token: "stale-kimi-access",
        refresh_token: "stale-kimi-refresh",
        expires_at: Math.floor(Date.now() / 1000) + 60,
      },
    );

    try {
      assert.equal(
        getKimiApiKey({
          access: "pi-access",
          refresh: "pi-refresh",
          expires: Date.now() + 60_000,
        }),
        "pi-access",
      );
    } finally {
      auth.cleanup();
    }
  });

  it("regression: uses Pi credentials as the canonical proactive-refresh source", async () => {
    const auth = withTempAuthFile(
      {
        type: "oauth",
        access: "pi-stale-access",
        refresh: "pi-valid-refresh",
        expires: Date.now() - 1,
      },
      {
        access_token: "kimi-stale-access",
        refresh_token: "kimi-revoked-refresh",
        expires_at: 1,
      },
    );
    const refreshTokens: string[] = [];
    mock = mockFetch(({ url, init }) => {
      if (url.endsWith("/models")) return jsonResponse({ data: [] });
      const body = new URLSearchParams(String(init?.body));
      refreshTokens.push(body.get("refresh_token") ?? "");
      assert.equal(body.get("refresh_token"), "pi-valid-refresh");
      return jsonResponse({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 900,
        scope: "kimi-code",
        token_type: "Bearer",
      });
    });

    try {
      const result = await refreshKimiCodeToken({
        access: "pi-stale-access",
        refresh: "pi-valid-refresh",
        expires: Date.now() - 1,
      });

      assert.equal(result.access, "fresh-access");
      assert.deepEqual(refreshTokens, ["pi-valid-refresh"]);
      assert.equal(auth.readKimiCredential().refresh_token, "fresh-refresh");
    } finally {
      auth.cleanup();
    }
  });

  it("regression: uses Pi credentials as the canonical forced-refresh source", async () => {
    const auth = withTempAuthFile(
      {
        type: "oauth",
        access: "shared-stale-access",
        refresh: "pi-valid-refresh",
        expires: Date.now() - 1,
      },
      {
        access_token: "shared-stale-access",
        refresh_token: "kimi-revoked-refresh",
        expires_at: 1,
      },
    );

    const refreshTokens: string[] = [];
    mock = mockFetch(({ init }) => {
      const body = new URLSearchParams(String(init?.body));
      refreshTokens.push(body.get("refresh_token") ?? "");
      if (body.get("refresh_token") === "kimi-revoked-refresh") {
        return jsonResponse(
          {
            error: "invalid_grant",
            error_description: "The provided authorization grant is invalid",
          },
          400,
        );
      }
      assert.equal(body.get("refresh_token"), "pi-valid-refresh");
      return jsonResponse({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 900,
        scope: "kimi-code",
        token_type: "Bearer",
      });
    });

    try {
      const result = await refreshKimiAuthToken("shared-stale-access");

      assert.equal(result, "fresh-access");
      assert.deepEqual(refreshTokens, ["pi-valid-refresh"]);
      assert.equal(auth.readCredential().refresh, "pi-valid-refresh");
      assert.equal(auth.readKimiCredential().refresh_token, "fresh-refresh");
    } finally {
      auth.cleanup();
    }
  });

  it("regression: replaces invalid_grant details with an actionable login message", async () => {
    const auth = withTempAuthFile(
      {
        type: "oauth",
        access: "revoked-access",
        refresh: "revoked-refresh",
        expires: Date.now() - 1,
      },
      {
        access_token: "revoked-access",
        refresh_token: "revoked-refresh",
        expires_at: 1,
      },
    );
    mock = mockFetch(() =>
      jsonResponse(
        {
          error: "invalid_grant",
          error_description: "The provided authorization grant is invalid",
        },
        400,
      ),
    );
    const originalError = console.error;
    const logs: string[] = [];
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      const result = await refreshKimiAuthToken("revoked-access");

      assert.equal(result, null);
      assert.equal(
        logs.at(-1),
        "[kimi-coding] Kimi Code authorization is no longer valid. Sign in again with /login kimi-coding.",
      );
      assert.doesNotMatch(logs.join("\n"), /400|invalid_grant|authorization grant/i);
    } finally {
      console.error = originalError;
      auth.cleanup();
    }
  });
});

describe("isKimiAuthErrorMessage", () => {
  it("recognizes auth failures that should trigger token refresh", () => {
    assert.equal(isKimiAuthErrorMessage("401 Unauthorized"), true);
    assert.equal(isKimiAuthErrorMessage("incorrect API KEY"), true);
    assert.equal(isKimiAuthErrorMessage("invalid api key"), true);
  });

  it("does not classify membership permission failures as auth failures", () => {
    assert.equal(
      isKimiAuthErrorMessage(
        "401 Your current subscription does not have access to k3. Upgrade to a Moderato plan or above.",
      ),
      false,
    );
    assert.equal(
      isKimiAuthErrorMessage(
        "401 Your current plan supports only kimi-k3 up to 256K context. 1M context is available on higher-tier plans.",
      ),
      false,
    );
    assert.equal(
      isKimiAuthErrorMessage(
        "401 Your current subscription does not have access to kimi-for-coding-highspeed.",
      ),
      false,
    );
  });

  it("does not classify transient or generic errors as auth failures", () => {
    assert.equal(isKimiAuthErrorMessage("500 internal server error"), false);
    assert.equal(isKimiAuthErrorMessage("429 rate limited"), false);
    assert.equal(isKimiAuthErrorMessage("network socket closed"), false);
  });
});
