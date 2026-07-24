import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { DEFAULT_KIMI_CODE_CONFIG, type KimiResolvedModelConfig } from "../src/config.ts";
import {
  applyKimiPayloadMutations,
  clearKimiUploadedFileCache,
  type JsonRecord,
  type KimiPayloadContext,
  resolveCacheRetention,
  resolveReasoningForLevel,
  uploadKimiFile,
} from "../src/payload.ts";
import {
  filterEmptyResponseStream,
  mergeKimiRequestHeaders,
  resolveKimiApiKey,
  setStoreResolvedKimiConfig,
  streamSimpleKimi,
} from "../src/stream.ts";

const defaultModelConfig: KimiResolvedModelConfig = { ...DEFAULT_KIMI_CODE_CONFIG.model };

const baseCtx = (overrides: Partial<KimiPayloadContext> = {}): KimiPayloadContext => ({
  api: "anthropic-messages",
  cacheRetention: "short",
  modelConfig: defaultModelConfig,
  ...overrides,
});

describe("applyKimiPayloadMutations", () => {
  beforeEach(() => {
    clearKimiUploadedFileCache();
  });

  it('rewrites role: "developer" to "system" so Kimi accepts the message', async () => {
    const payload: JsonRecord = {
      messages: [
        { role: "developer", content: "rules" },
        { role: "user", content: "hi" },
      ],
    };
    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-completions" }));
    const messages = payload.messages as JsonRecord[];
    assert.equal(messages[0]?.role, "system");
    assert.equal(messages[1]?.role, "user");
  });

  it("injects prompt_cache_key from cacheKey when cacheRetention is not 'none'", async () => {
    const payload: JsonRecord = { messages: [{ role: "user", content: "hi" }] };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({ cacheKey: "sess-1", cacheRetention: "short" }),
    );
    assert.equal(payload.prompt_cache_key, "sess-1");
  });

  it("does not inject prompt_cache_key when cacheRetention is 'none'", async () => {
    const payload: JsonRecord = { messages: [{ role: "user", content: "hi" }] };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({ cacheKey: "sess-1", cacheRetention: "none" }),
    );
    assert.equal(payload.prompt_cache_key, undefined);
  });

  it("honors PI_CACHE_RETENTION=none when no option override is provided", () => {
    const old = process.env.PI_CACHE_RETENTION;
    try {
      process.env.PI_CACHE_RETENTION = "none";
      assert.equal(resolveCacheRetention(undefined), "none");
    } finally {
      if (old === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = old;
    }
  });

  it("respects an existing payload.prompt_cache_key (caller has final say)", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      prompt_cache_key: "explicit-key",
    };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({ cacheKey: "sess-1", cacheRetention: "short" }),
    );
    assert.equal(payload.prompt_cache_key, "explicit-key");
  });

  it("uploads inline base64 images in openai payloads and replaces the URL with the uploader's id", async () => {
    const calls: Array<{ mimeType: string; data: string }> = [];
    const upload = async (mimeType: string, data: string) => {
      calls.push({ mimeType, data });
      return "ms://abc123";
    };

    const payload: JsonRecord = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
            },
          ],
        },
      ],
    };

    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-completions", upload }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.mimeType, "image/png");
    assert.equal(calls[0]?.data, "AAAA");
    const messages = payload.messages as JsonRecord[];
    const content = messages[0]?.content as JsonRecord[];
    const block = content[0] as JsonRecord;
    const imageUrl = block.image_url as JsonRecord;
    assert.equal(imageUrl.url, "ms://abc123");
  });

  it("uploads inline base64 videos in openai payloads and replaces the URL with the uploader's id", async () => {
    const calls: Array<{ mimeType: string; data: string }> = [];
    const upload = async (mimeType: string, data: string) => {
      calls.push({ mimeType, data });
      return "ms://video-id";
    };

    const payload: JsonRecord = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "video_url",
              video_url: { url: "data:video/mp4;base64,AAAA" },
            },
          ],
        },
      ],
    };

    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-completions", upload }));

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.mimeType, "video/mp4");
    assert.equal(calls[0]?.data, "AAAA");
    const messages = payload.messages as JsonRecord[];
    const content = messages[0]?.content as JsonRecord[];
    const block = content[0] as JsonRecord;
    const videoUrl = block.video_url as JsonRecord;
    assert.equal(videoUrl.url, "ms://video-id");
  });

  it("leaves non-data video_url values untouched", async () => {
    let invocations = 0;
    const upload = async () => {
      invocations++;
      return "ms://never";
    };

    const payload: JsonRecord = {
      messages: [
        {
          role: "user",
          content: [
            { type: "video_url", video_url: { url: "ms://already-uploaded" } },
            { type: "video_url", video_url: { url: "https://example.com/clip.mp4" } },
          ],
        },
      ],
    };

    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-completions", upload }));

    assert.equal(invocations, 0);
    const messages = payload.messages as JsonRecord[];
    const content = messages[0]?.content as JsonRecord[];
    const block = content[0] as JsonRecord;
    const videoUrl = block.video_url as JsonRecord;
    assert.equal(videoUrl.url, "ms://already-uploaded");
    const httpBlock = content[1] as JsonRecord;
    assert.equal((httpBlock.video_url as JsonRecord).url, "https://example.com/clip.mp4");
  });

  it("drops empty assistant content when OpenAI tool calls are present", async () => {
    const payload: JsonRecord = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "  " }],
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "x", arguments: "{}" } },
          ],
        },
      ],
    };

    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-completions" }));

    const messages = payload.messages as JsonRecord[];
    assert.equal(messages[0]?.content, undefined);
  });

  it("fills missing OpenAI tool parameter schema types", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            parameters: {
              type: "object",
              properties: {
                mode: { enum: ["smart", "full"] },
                limit: { minimum: 1 },
                filters: {
                  properties: {
                    tag: { const: "code" },
                  },
                },
                choice: {
                  anyOf: [{ enum: ["a"] }, { enum: ["b"] }],
                },
              },
            },
          },
        },
      ],
    };

    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-completions" }));

    const tools = payload.tools as JsonRecord[];
    const tool = tools[0] as JsonRecord;
    const fn = tool.function as JsonRecord;
    const parameters = fn.parameters as JsonRecord;
    const properties = parameters.properties as Record<string, JsonRecord>;
    assert.equal(properties.mode.type, "string");
    assert.equal(properties.limit.type, "number");
    assert.equal(properties.filters.type, "object");
    const filtersProperties = properties.filters.properties as Record<string, JsonRecord>;
    assert.equal(filtersProperties.tag.type, "string");
    assert.equal(properties.choice.type, undefined);
  });

  it("uploads inline base64 images in anthropic payloads and rewrites source type to 'url'", async () => {
    const upload = async () => "ms://anthropic-id";
    const payload: JsonRecord = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "BBBB" },
            },
          ],
        },
      ],
    };

    await applyKimiPayloadMutations(payload, baseCtx({ api: "anthropic-messages", upload }));
    const messages = payload.messages as JsonRecord[];
    const content = messages[0]?.content as JsonRecord[];
    const block = content[0] as JsonRecord;
    const source = block.source as JsonRecord;
    assert.equal(source.type, "url");
    assert.equal(source.url, "ms://anthropic-id");
  });

  it("reuses uploaded ms:// results across requests without re-uploading", async () => {
    let invocations = 0;
    const upload = async () => {
      invocations++;
      return "ms://persisted";
    };
    const makePayload = (): JsonRecord => ({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,REUSE" } }],
        },
      ],
    });

    await applyKimiPayloadMutations(makePayload(), baseCtx({ api: "openai-completions", upload }));
    const second = makePayload();
    await applyKimiPayloadMutations(second, baseCtx({ api: "openai-completions", upload }));

    assert.equal(invocations, 1);
    const messages = second.messages as JsonRecord[];
    const content = messages[0]?.content as JsonRecord[];
    const imageUrl = (content[0] as JsonRecord).image_url as JsonRecord;
    assert.equal(imageUrl.url, "ms://persisted");
  });

  it("reuses uploads across requests for anthropic payloads too", async () => {
    let invocations = 0;
    const upload = async () => {
      invocations++;
      return "ms://anthropic-persisted";
    };
    const makePayload = (): JsonRecord => ({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "CCCC" } },
          ],
        },
      ],
    });

    await applyKimiPayloadMutations(makePayload(), baseCtx({ api: "anthropic-messages", upload }));
    await applyKimiPayloadMutations(makePayload(), baseCtx({ api: "anthropic-messages", upload }));

    assert.equal(invocations, 1);
  });

  it("caches uploads so the same image is uploaded only once per request", async () => {
    let invocations = 0;
    const upload = async () => {
      invocations++;
      return "ms://cached";
    };
    const payload: JsonRecord = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,SAME" } },
            { type: "image_url", image_url: { url: "data:image/png;base64,SAME" } },
          ],
        },
      ],
    };

    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-completions", upload }));
    assert.equal(invocations, 1);
  });

  it("leaves unrelated payload fields untouched", async () => {
    const payload: JsonRecord = {
      model: "kimi-for-coding",
      messages: [{ role: "user", content: "hi" }],
      seed: 42,
    };
    await applyKimiPayloadMutations(payload, baseCtx());
    assert.equal(payload.model, "kimi-for-coding");
    assert.equal(payload.seed, 42);
  });

  it("strips temperature and top_p values rejected by K2.7 Code", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.4,
      top_p: 0.8,
    };
    await applyKimiPayloadMutations(payload, baseCtx());
    assert.equal(payload.temperature, undefined);
    assert.equal(payload.top_p, undefined);
  });

  it("keeps temperature 1 and top_p 0.95 (K2.7 defaults)", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      temperature: 1,
      top_p: 0.95,
    };
    await applyKimiPayloadMutations(payload, baseCtx());
    assert.equal(payload.temperature, 1);
    assert.equal(payload.top_p, 0.95);
  });

  it("clamps tool_choice to auto for K2.7 Code", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "required",
    };
    await applyKimiPayloadMutations(payload, baseCtx());
    assert.equal(payload.tool_choice, "auto");
  });

  it("omits effort when the model does not advertise supported efforts", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      extra_body: { thinking: { keep: "all" } },
    };

    await applyKimiPayloadMutations(payload, baseCtx({ reasoning: "high" }));

    assert.equal(payload.reasoning_effort, undefined);
    assert.equal(payload.extra_body, undefined);
    assert.deepEqual(payload.thinking, { keep: "all", type: "enabled" });
  });

  it("sends effort inside thinking when the model advertises it", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        reasoning: "high",
        modelConfig: { ...defaultModelConfig, supportEfforts: ["low", "high"] },
      }),
    );

    assert.equal(payload.reasoning_effort, undefined);
    assert.deepEqual(payload.thinking, { type: "enabled", effort: "high", keep: "all" });
  });

  it("sends K3 max effort for Pi max and xhigh levels", async () => {
    for (const reasoning of ["max", "xhigh"] as ThinkingLevel[]) {
      const payload: JsonRecord = { messages: [{ role: "user", content: "hi" }] };
      await applyKimiPayloadMutations(
        payload,
        baseCtx({
          reasoning,
          modelConfig: {
            ...defaultModelConfig,
            supportEfforts: ["max"],
            defaultEffort: "max",
          },
        }),
      );
      assert.deepEqual(payload.thinking, { type: "enabled", effort: "max", keep: "all" });
    }
  });

  it("applies thinkingKeep only when reasoning is enabled", async () => {
    const enabledPayload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
    };
    await applyKimiPayloadMutations(
      enabledPayload,
      baseCtx({ reasoning: "high", modelConfig: { ...defaultModelConfig, thinkingKeep: "all" } }),
    );
    assert.deepEqual(enabledPayload.thinking, { type: "enabled", keep: "all" });

    const disabledPayload: JsonRecord = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "ok" },
      ],
      extra_body: { thinking: { keep: "all" } },
    };
    await applyKimiPayloadMutations(
      disabledPayload,
      baseCtx({
        reasoning: "none" as ThinkingLevel,
        modelConfig: { ...defaultModelConfig, thinkingKeep: "all" },
      }),
    );
    assert.deepEqual(disabledPayload.thinking, { type: "disabled" });
    assert.equal(disabledPayload.reasoning_effort, undefined);
    assert.equal((disabledPayload.messages as JsonRecord[])[0]?.reasoning_content, undefined);
  });

  it("replays empty reasoning for preserved-thinking assistant history", async () => {
    const payload: JsonRecord = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "ok" },
      ],
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        api: "openai-completions",
        reasoning: "high",
        modelConfig: { ...defaultModelConfig, thinkingKeep: "all" },
      }),
    );

    const messages = payload.messages as JsonRecord[];
    assert.equal(messages[0]?.reasoning_content, "");
  });

  it("renames deprecated max_tokens to max_completion_tokens on OpenAI path", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 128,
    };

    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-completions" }));

    assert.equal(payload.max_tokens, undefined);
    assert.equal(payload.max_completion_tokens, 128);
  });

  it("preserves max_tokens on Anthropic path", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 128,
    };

    await applyKimiPayloadMutations(payload, baseCtx({ api: "anthropic-messages" }));

    assert.equal(payload.max_tokens, 128);
    assert.equal(payload.max_completion_tokens, undefined);
  });

  it("caps Anthropic max_tokens without adding OpenAI fields", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 64000,
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        api: "anthropic-messages",
        modelConfig: { ...defaultModelConfig, generation: { maxCompletionTokens: 32000 } },
      }),
    );

    assert.equal(payload.max_tokens, 32000);
    assert.equal(payload.max_completion_tokens, undefined);
  });

  it("preserves a lower Anthropic output cap supplied through extra_body", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      extra_body: { max_tokens: 128 },
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        api: "anthropic-messages",
        modelConfig: { ...defaultModelConfig, generation: { maxCompletionTokens: 32000 } },
      }),
    );

    assert.equal(payload.extra_body, undefined);
    assert.equal(payload.max_tokens, 128);
    assert.equal(payload.max_completion_tokens, undefined);
  });

  it("keeps the lower request-time output cap when config sets a larger maximum", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 128,
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        api: "openai-completions",
        modelConfig: { ...defaultModelConfig, generation: { maxCompletionTokens: 32000 } },
      }),
    );

    assert.equal(payload.max_tokens, undefined);
    assert.equal(payload.max_completion_tokens, 128);

    const largerPayload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 64000,
    };
    await applyKimiPayloadMutations(
      largerPayload,
      baseCtx({
        api: "openai-completions",
        modelConfig: { ...defaultModelConfig, generation: { maxCompletionTokens: 32000 } },
      }),
    );
    assert.equal(largerPayload.max_completion_tokens, 32000);
  });

  it("suppresses reasoning fields when supportsThinkingType is 'no'", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
      thinking: { type: "enabled", effort: "high" },
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        reasoning: "high",
        modelConfig: { ...defaultModelConfig, supportsThinkingType: "no" },
      }),
    );

    assert.equal(payload.reasoning_effort, undefined);
    assert.equal(payload.thinking, undefined);
  });

  it("forces thinking enabled when supportsThinkingType is 'only' and caller asks for off", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        reasoning: "none" as ThinkingLevel,
        modelConfig: { ...defaultModelConfig, supportsThinkingType: "only" },
      }),
    );

    assert.equal(payload.reasoning_effort, undefined);
    assert.deepEqual(payload.thinking, { type: "enabled", keep: "all" });
  });

  it("preserves caller reasoning when supportsThinkingType is 'only' and caller already enabled", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        reasoning: "high",
        modelConfig: { ...defaultModelConfig, supportsThinkingType: "only" },
      }),
    );

    assert.equal(payload.reasoning_effort, undefined);
    assert.deepEqual(payload.thinking, { type: "enabled", keep: "all" });
  });

  it("forces thinking enabled when supportsThinkingType is 'only' and reasoning is missing", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        modelConfig: {
          ...defaultModelConfig,
          supportsThinkingType: "only",
          supportEfforts: ["medium", "high"],
          defaultEffort: "high",
        },
      }),
    );

    assert.equal(payload.reasoning_effort, undefined);
    assert.deepEqual(payload.thinking, { type: "enabled", effort: "high", keep: "all" });
  });

  it("behaves normally when supportsThinkingType is 'both'", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        reasoning: "high",
        modelConfig: { ...defaultModelConfig, supportsThinkingType: "both" },
      }),
    );

    assert.equal(payload.reasoning_effort, undefined);
    assert.deepEqual(payload.thinking, { type: "enabled", keep: "all" });
  });
});

describe("uploadKimiFile", () => {
  const PNG_BASE64 = "aGVsbG8=";
  const fileResponse = (id: string) => new Response(JSON.stringify({ id }), { status: 200 });
  const unauthorizedResponse = () =>
    new Response(
      JSON.stringify({ error: { message: "invalid", type: "invalid_authentication_error" } }),
      {
        status: 401,
      },
    );

  it("retries with a refreshed token when the files endpoint returns 401", async () => {
    const authHeaders: Array<string | undefined> = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      authHeaders.push(headers?.Authorization);
      return authHeaders.length === 1 ? unauthorizedResponse() : fileResponse("file-1");
    };
    const refreshCalls: string[] = [];
    const refreshAccessToken = async (token: string) => {
      refreshCalls.push(token);
      return "new-token";
    };

    const result = await uploadKimiFile("old-token", "image/png", PNG_BASE64, 0, {
      fetch: fakeFetch,
      refreshAccessToken,
    });

    assert.equal(result, "ms://file-1");
    assert.deepEqual(refreshCalls, ["old-token"]);
    assert.deepEqual(authHeaders, ["Bearer old-token", "Bearer new-token"]);
  });

  it("returns null without retrying when refresh does not yield a new token", async () => {
    let fetchCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      fetchCalls++;
      return unauthorizedResponse();
    };

    const result = await uploadKimiFile("old-token", "image/png", PNG_BASE64, 0, {
      fetch: fakeFetch,
      refreshAccessToken: async () => null,
    });

    assert.equal(result, null);
    assert.equal(fetchCalls, 1);
  });

  it("uploads videos with purpose=video regardless of the inline threshold", async () => {
    let form: FormData | undefined;
    const fakeFetch: typeof fetch = async (_url, init) => {
      form = init?.body as FormData;
      return fileResponse("video-1");
    };

    const result = await uploadKimiFile("token", "video/mp4", PNG_BASE64, 10 * 1024 * 1024, {
      fetch: fakeFetch,
      refreshAccessToken: async () => null,
    });

    assert.equal(result, "ms://video-1");
    assert.ok(form);
    assert.equal(form.get("purpose"), "video");
    assert.equal((form.get("file") as File).name, "upload.mp4");
  });

  it("still rejects non-media mime types without fetching", async () => {
    let fetchCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      fetchCalls++;
      return fileResponse("nope");
    };

    const result = await uploadKimiFile("token", "application/pdf", PNG_BASE64, 0, {
      fetch: fakeFetch,
      refreshAccessToken: async () => null,
    });

    assert.equal(result, null);
    assert.equal(fetchCalls, 0);
  });

  it("does not attempt refresh on non-401 failures", async () => {
    let refreshCalls = 0;
    const fakeFetch: typeof fetch = async () => new Response("server error", { status: 500 });

    const result = await uploadKimiFile("token", "image/png", PNG_BASE64, 0, {
      fetch: fakeFetch,
      refreshAccessToken: async () => {
        refreshCalls++;
        return "unused";
      },
    });

    assert.equal(result, null);
    assert.equal(refreshCalls, 0);
  });
});

describe("resolveReasoningForLevel", () => {
  it("returns mapped reasoning entries from model config", () => {
    assert.deepEqual(resolveReasoningForLevel("none", defaultModelConfig), {
      effort: null,
      enabled: false,
    });
    assert.deepEqual(resolveReasoningForLevel("off", defaultModelConfig), {
      effort: null,
      enabled: false,
    });
    assert.deepEqual(resolveReasoningForLevel("minimal", defaultModelConfig), {
      effort: "low",
      enabled: true,
    });
    assert.deepEqual(resolveReasoningForLevel("xhigh", defaultModelConfig), {
      effort: "max",
      enabled: true,
    });
  });

  it("returns undefined for unknown reasoning levels", () => {
    assert.equal(resolveReasoningForLevel("unknown", defaultModelConfig), undefined);
  });
});

describe("resolveKimiApiKey", () => {
  it("resolves explicit pi env syntax when old pi passes it through literally", () => {
    const original = process.env.KIMI_API_KEY;
    try {
      process.env.KIMI_API_KEY = "env-key";

      assert.equal(resolveKimiApiKey("$KIMI_API_KEY"), "env-key");
      assert.equal(resolveKimiApiKey("${KIMI_API_KEY}"), "env-key");
    } finally {
      if (original === undefined) delete process.env.KIMI_API_KEY;
      else process.env.KIMI_API_KEY = original;
    }
  });

  it("preserves resolved OAuth and API keys", () => {
    assert.equal(resolveKimiApiKey("oauth-token"), "oauth-token");
    assert.equal(resolveKimiApiKey("sk-api-key"), "sk-api-key");
  });
});

describe("mergeKimiRequestHeaders", () => {
  it("adds Kimi identity headers while preserving caller overrides", () => {
    const headers = mergeKimiRequestHeaders({ "User-Agent": "custom-agent", "X-Custom": "yes" });

    assert.equal(headers["User-Agent"], "custom-agent");
    assert.equal(headers["X-Msh-Platform"], "kimi_code_cli");
    assert.equal(headers["X-Custom"], "yes");
  });
});

async function collectAsyncIterable<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("streamSimpleKimi", () => {
  const streamModel = (overrides: Partial<Model<Api>> = {}): Model<Api> =>
    ({
      id: "kimi-for-coding-highspeed",
      name: "Kimi for Coding High Speed",
      api: "anthropic-messages",
      provider: "kimi-coding",
      baseUrl: "https://example.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32000,
      ...overrides,
    }) as Model<Api>;

  const capturePayload = async (model: Model<Api>): Promise<JsonRecord> => {
    let captured: JsonRecord | undefined;
    const stream = streamSimpleKimi(
      model,
      { messages: [] },
      {
        apiKey: "test-key",
        reasoning: "high",
        onPayload: (payload) => {
          captured = payload as JsonRecord;
          throw new Error("payload captured");
        },
      },
    );
    await collectAsyncIterable(stream);
    assert.ok(captured);
    return captured;
  };

  it("uses the selected model's disabled reasoning capability at request time", async () => {
    setStoreResolvedKimiConfig({
      model: { ...defaultModelConfig, reasoning: true, supportsThinkingType: "only" },
      protocol: "anthropic",
      uploads: DEFAULT_KIMI_CODE_CONFIG.uploads,
    });

    const payload = await capturePayload(streamModel({ reasoning: false }));

    assert.equal(payload.thinking, undefined);
  });

  it("uses the selected model's thinking capability instead of the standard model's", async () => {
    setStoreResolvedKimiConfig({
      model: { ...defaultModelConfig, reasoning: false, supportsThinkingType: "no" },
      protocol: "anthropic",
      uploads: DEFAULT_KIMI_CODE_CONFIG.uploads,
    });
    const model = streamModel() as Model<Api> & { supportsThinkingType?: "only" };
    model.supportsThinkingType = "only";

    const payload = await capturePayload(model);

    assert.equal((payload.thinking as JsonRecord).type, "enabled");
    assert.equal((payload.thinking as JsonRecord).keep, "all");
  });
});

describe("filterEmptyResponseStream", () => {
  it("suppresses Kimi empty-response text blocks and cleans the final message", async () => {
    const events = [
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "(Empty response:" },
      {
        type: "text_end",
        contentIndex: 0,
        content: "(Empty response: {'content': [{'type': 'thinking'}]})",
      },
      {
        type: "done",
        message: {
          content: [
            { type: "text", text: "(Empty response: {'content': []})" },
            { type: "tool_use", id: "tool-1" },
          ],
        },
      },
    ];

    const out = await collectAsyncIterable(filterEmptyResponseStream(events as never));

    assert.deepEqual(
      out.map((event) => (event as { type: string }).type),
      ["done"],
    );
    const done = out[0] as { message: { content: unknown[] } };
    assert.deepEqual(done.message.content, [{ type: "tool_use", id: "tool-1" }]);
  });

  it("passes normal text blocks through unchanged", async () => {
    const events = [
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "hello" },
      { type: "text_end", contentIndex: 0, content: "hello" },
    ];

    const out = await collectAsyncIterable(filterEmptyResponseStream(events as never));

    assert.deepEqual(out, events);
  });

  it("flushes normal text before text_end so answer text streams", async () => {
    let releaseTextEnd: (() => void) | undefined;
    const textEndReady = new Promise<void>((resolve) => {
      releaseTextEnd = resolve;
    });
    const events = [
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "hello" },
      { type: "text_end", contentIndex: 0, content: "hello" },
    ];
    async function* upstream() {
      yield events[0];
      yield events[1];
      await textEndReady;
      yield events[2];
    }

    const iterator = filterEmptyResponseStream(upstream() as never)[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { value: events[0], done: false });
    assert.deepEqual(await iterator.next(), { value: events[1], done: false });
    releaseTextEnd?.();
    assert.deepEqual(await iterator.next(), { value: events[2], done: false });
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  });
});
