import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_KIMI_MODEL_INPUT } from "../src/constants.ts";
import {
  applyKimiEnvOverridesToModel,
  applyKimiOAuthExtrasToModel,
  discoverKimiModelMetadata,
} from "../src/models.ts";
import {
  isKimiAuthErrorMessage,
  refreshAccessToken,
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

  it("prefers the entry with id 'kimi-for-coding' even when other models are present", async () => {
    mock = mockFetch(() =>
      jsonResponse({
        data: [
          { id: "k2p7-beta", display_name: "Beta K2.7" },
          {
            id: "kimi-for-coding",
            display_name: "Kimi For Coding",
            context_length: 262144,
            supports_reasoning: true,
            supports_image_in: true,
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
  });

  it("falls back to the first entry when no kimi-for-coding is present", async () => {
    mock = mockFetch(() =>
      jsonResponse({
        data: [{ id: "k2p7-beta", display_name: "Beta K2.7", context_length: 1048576 }],
      }),
    );

    const result = await discoverKimiModelMetadata("tok-1");
    assert.equal(result.wireModelId, "k2p7-beta");
    assert.equal(result.modelDisplay, "Beta K2.7");
    assert.equal(result.contextLength, 1048576);
  });

  it("returns empty when the server replies non-2xx", async () => {
    mock = mockFetch(() => new Response("nope", { status: 401 }));
    const result = await discoverKimiModelMetadata("tok-1");
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

  it("omits optional fields when the server does not provide them", async () => {
    mock = mockFetch(() => jsonResponse({ data: [{ id: "kimi-for-coding" }] }));
    const result = await discoverKimiModelMetadata("tok-1");
    assert.deepEqual(result, { wireModelId: "kimi-for-coding" });
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
    }) as Model<Api> & { wireModelId?: string; input: string[] };

    assert.equal(result.name, "Kimi K2 Next");
    assert.equal(result.contextWindow, 1048576);
    assert.equal(result.wireModelId, "kimi-k2-next");
    assert.equal(result.reasoning, true);
    assert.deepEqual(result.input, ["text", "image"]);
  });
});

describe("DEFAULT_KIMI_MODEL_INPUT", () => {
  it("advertises text and image input by default", () => {
    assert.deepEqual([...DEFAULT_KIMI_MODEL_INPUT], ["text", "image"]);
  });
});

describe("applyKimiEnvOverridesToModel", () => {
  it("applies official Kimi model env overrides to the registered model", () => {
    process.env.KIMI_MODEL_NAME = "kimi-k2-custom";
    process.env.KIMI_MODEL_MAX_CONTEXT_SIZE = "1048576";
    process.env.KIMI_MODEL_CAPABILITIES = "thinking,image_in,video_in";

    const model: Model<Api> = {
      id: "kimi-for-coding",
      name: "Kimi for Coding",
      provider: "kimi-coding",
      api: "kimi-openai-completions" as Api,
      baseUrl: "https://api.kimi.com/coding/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32000,
    };

    const result = applyKimiEnvOverridesToModel(model) as Model<Api> & {
      wireModelId?: string;
      input: string[];
    };

    assert.equal(result.id, "kimi-for-coding");
    assert.equal(result.name, "kimi-k2-custom");
    assert.equal(result.wireModelId, "kimi-k2-custom");
    assert.equal(result.contextWindow, 1048576);
    assert.equal(result.reasoning, true);
    assert.deepEqual(result.input, ["text", "image"]);
  });

  it("maps official capabilities exactly when provided", () => {
    process.env.KIMI_MODEL_CAPABILITIES = "image_in";

    const model: Model<Api> = {
      id: "kimi-for-coding",
      name: "Kimi for Coding",
      provider: "kimi-coding",
      api: "kimi-openai-completions" as Api,
      baseUrl: "https://api.kimi.com/coding/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32000,
    };

    const result = applyKimiEnvOverridesToModel(model) as Model<Api> & { input: string[] };

    assert.equal(result.reasoning, false);
    assert.deepEqual(result.input, ["text", "image"]);
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
      /Token refresh unauthorized: revoked/,
    );
    assert.equal(attempts, 1);
  });
});

describe("isKimiAuthErrorMessage", () => {
  it("recognizes auth failures that should trigger token refresh", () => {
    assert.equal(isKimiAuthErrorMessage("401 Unauthorized"), true);
    assert.equal(isKimiAuthErrorMessage("incorrect API KEY"), true);
    assert.equal(isKimiAuthErrorMessage("invalid api key"), true);
  });

  it("does not classify transient or generic errors as auth failures", () => {
    assert.equal(isKimiAuthErrorMessage("500 internal server error"), false);
    assert.equal(isKimiAuthErrorMessage("429 rate limited"), false);
    assert.equal(isKimiAuthErrorMessage("network socket closed"), false);
  });
});
