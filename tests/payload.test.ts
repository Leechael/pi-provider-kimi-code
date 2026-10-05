import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { DEFAULT_KIMI_CODE_CONFIG, type KimiResolvedModelConfig } from "../src/config.ts";
import {
  applyInlineMediaBudget,
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
  overrideStreamSimpleForTests,
  resolveKimiApiKey,
  setStoreResolvedKimiConfig,
  streamSimpleKimi,
} from "../src/stream.ts";

const defaultModelConfig: KimiResolvedModelConfig = { ...DEFAULT_KIMI_CODE_CONFIG.model };

const baseCtx = (overrides: Partial<KimiPayloadContext> = {}): KimiPayloadContext => ({
  api: "anthropic-messages",
  uploadCacheScope: "test-account",
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
    const second = makePayload();
    await applyKimiPayloadMutations(second, baseCtx({ api: "anthropic-messages", upload }));

    assert.equal(invocations, 1);
    const messages = second.messages as JsonRecord[];
    const content = messages[0]?.content as JsonRecord[];
    const source = (content[0] as JsonRecord).source as JsonRecord;
    assert.equal(source.type, "url");
    assert.equal(source.url, "ms://anthropic-persisted");
  });

  it("does not reuse uploads across cache scopes", async () => {
    let invocations = 0;
    const upload = async () => `ms://account-${++invocations}`;
    const makePayload = (): JsonRecord => ({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,SCOPED" } }],
        },
      ],
    });

    await applyKimiPayloadMutations(
      makePayload(),
      baseCtx({ api: "openai-completions", upload, uploadCacheScope: "account-a" }),
    );
    const second = makePayload();
    await applyKimiPayloadMutations(
      second,
      baseCtx({ api: "openai-completions", upload, uploadCacheScope: "account-b" }),
    );

    assert.equal(invocations, 2);
    const messages = second.messages as JsonRecord[];
    const content = messages[0]?.content as JsonRecord[];
    const imageUrl = (content[0] as JsonRecord).image_url as JsonRecord;
    assert.equal(imageUrl.url, "ms://account-2");
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

  it("omits temperature and top_p when not explicitly configured (official default)", async () => {
    // The official kimi-code client sends neither unless KIMI_MODEL_TEMPERATURE /
    // KIMI_MODEL_TOP_P are set; any value pi-ai seeded must be dropped, including
    // the previously pinned 1.0 / 0.95.
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.4,
      top_p: 0.8,
    };
    await applyKimiPayloadMutations(payload, baseCtx());
    assert.equal(payload.temperature, undefined);
    assert.equal(payload.top_p, undefined);

    const pinned: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      temperature: 1,
      top_p: 0.95,
    };
    await applyKimiPayloadMutations(pinned, baseCtx());
    assert.equal(pinned.temperature, undefined);
    assert.equal(pinned.top_p, undefined);
  });

  it("sends temperature and top_p only when explicitly configured", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
    };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        modelConfig: { ...defaultModelConfig, generation: { temperature: 0.7, topP: 0.9 } },
      }),
    );
    assert.equal(payload.temperature, 0.7);
    assert.equal(payload.top_p, 0.9);
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

  it("keeps pi-ai's adaptive thinking shape and maps effort into output_config", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", display: "summarized" },
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        reasoning: "high",
        modelConfig: { ...defaultModelConfig, supportEfforts: ["low", "high"] },
      }),
    );

    assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(payload.output_config, { effort: "high" });
  });

  it("disables adaptive thinking when the level maps to off", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        reasoning: "minimal",
        modelConfig: {
          ...defaultModelConfig,
          reasoningMap: {
            ...defaultModelConfig.reasoningMap,
            minimal: { effort: null, enabled: false },
          },
          supportEfforts: ["low", "high"],
        },
      }),
    );

    assert.deepEqual(payload.thinking, { type: "disabled" });
    assert.equal(payload.output_config, undefined);
  });

  it("drops adaptive output_config when the mapped effort is not advertised", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "stale" },
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        reasoning: "high",
        modelConfig: { ...defaultModelConfig, supportEfforts: ["low"] },
      }),
    );

    assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
    assert.equal(payload.output_config, undefined);
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

describe("output cap policy (upstream #4091)", () => {
  // Window-tracked: what buildKimiModelFromConfig produces for an unset cap.
  const windowTrackedConfig: KimiResolvedModelConfig = {
    ...defaultModelConfig,
    maxTokens: defaultModelConfig.contextWindow,
  };

  it("omits the seeded cap on openai-completions when the model cap is window-tracked", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 258048,
    };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({ api: "openai-completions", modelConfig: windowTrackedConfig }),
    );
    assert.equal(payload.max_completion_tokens, undefined);
    assert.equal(payload.max_tokens, undefined);
  });

  it("omits the seeded cap on openai-responses when the model cap is window-tracked", async () => {
    const payload: JsonRecord = {
      input: [{ role: "user", content: "hi" }],
      max_output_tokens: 258048,
    };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({ api: "openai-responses", modelConfig: windowTrackedConfig }),
    );
    assert.equal(payload.max_output_tokens, undefined);
  });

  it("keeps a user-configured model.maxTokens cap on the OpenAI wires", async () => {
    const explicitConfig: KimiResolvedModelConfig = {
      ...defaultModelConfig,
      maxTokens: 16384,
    };
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 16384,
    };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({ api: "openai-completions", modelConfig: explicitConfig }),
    );
    assert.equal(payload.max_completion_tokens, 16384);
  });

  it("honors generation.maxCompletionTokens by preserving an existing lower OpenAI cap", async () => {
    const cappedConfig: KimiResolvedModelConfig = {
      ...windowTrackedConfig,
      generation: { maxCompletionTokens: 8000 },
    };
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 5000,
    };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({ api: "openai-completions", modelConfig: cappedConfig }),
    );
    assert.equal(payload.max_completion_tokens, 5000);
  });

  it("fills generation.maxCompletionTokens when no OpenAI cap is seeded", async () => {
    const cappedConfig: KimiResolvedModelConfig = {
      ...windowTrackedConfig,
      generation: { maxCompletionTokens: 8000 },
    };
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
    };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({ api: "openai-completions", modelConfig: cappedConfig }),
    );
    assert.equal(payload.max_completion_tokens, 8000);
  });

  it("keeps a per-request options.maxTokens cap on openai-completions", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 12345,
    };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        api: "openai-completions",
        modelConfig: windowTrackedConfig,
        requestMaxTokens: 12345,
      }),
    );
    assert.equal(payload.max_completion_tokens, 12345);
  });

  it("keeps an extra_body cap on openai-completions", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      extra_body: { max_completion_tokens: 12345 },
    };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({ api: "openai-completions", modelConfig: windowTrackedConfig }),
    );
    assert.equal(payload.extra_body, undefined);
    assert.equal(payload.max_completion_tokens, 12345);
  });

  it("keeps a per-request cap on openai-responses", async () => {
    const payload: JsonRecord = {
      input: [{ role: "user", content: "hi" }],
      max_output_tokens: 12345,
    };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        api: "openai-responses",
        modelConfig: windowTrackedConfig,
        requestMaxTokens: 12345,
      }),
    );
    assert.equal(payload.max_output_tokens, 12345);
  });

  it("keeps max_tokens on anthropic-messages, which requires it", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 258048,
    };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({ api: "anthropic-messages", modelConfig: windowTrackedConfig }),
    );
    assert.equal(payload.max_tokens, 258048);
  });
});

describe("applyInlineMediaBudget (upstream #3784)", () => {
  let uniqueCounter = 0;
  // The budget dedupes by content, so every test image needs unique bytes.
  const dataUrl = (bytes: number, mime = "image/png") => {
    uniqueCounter += 1;
    return `data:${mime};base64,${uniqueCounter}${"A".repeat(bytes)}`;
  };

  const openaiPayloadWith = (urls: string[]): JsonRecord => ({
    messages: urls.map((url) => ({
      role: "user",
      content: [{ type: "image_url", image_url: { url } }],
    })),
  });

  it("leaves payloads under the budget untouched", async () => {
    const payload = openaiPayloadWith([dataUrl(64), dataUrl(64)]);
    const originalContent = JSON.parse(
      JSON.stringify((payload.messages as JsonRecord[]).map((message) => message.content)),
    );
    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-completions" }));
    const messages = payload.messages as JsonRecord[];
    assert.deepEqual(
      messages.map((message) => message.content),
      originalContent,
    );
  });

  it("drops the oldest media until the total is under the low-water mark", () => {
    const payload = openaiPayloadWith([dataUrl(40), dataUrl(40), dataUrl(40)]);
    // Each data URL is 62 bytes: total 186 > 150, so the two oldest drop and
    // the newest survives once the total (62) is under the low-water mark.
    const changed = applyInlineMediaBudget(payload, "openai-completions", 150, 100);
    assert.equal(changed, true);
    const messages = payload.messages as JsonRecord[];
    const block = (index: number): JsonRecord => (messages[index].content as JsonRecord[])[0];
    assert.deepEqual(block(0), {
      type: "text",
      text: "[image omitted: dropped to fit the request media budget]",
    });
    assert.deepEqual(block(1), block(0));
    assert.equal((block(2) as JsonRecord).type, "image_url");
  });

  it("counts string-form image URLs and videos, with a video placeholder", () => {
    const payload: JsonRecord = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: dataUrl(40) },
            { type: "video_url", video_url: { url: dataUrl(40, "video/mp4") } },
          ],
        },
      ],
    };
    // Two 62-byte items total 124 > 100; both drop to reach 0 <= 50.
    applyInlineMediaBudget(payload, "openai-completions", 100, 50);
    const blocks = (payload.messages as JsonRecord[])[0].content as JsonRecord[];
    assert.equal(blocks[0].type, "text");
    assert.equal(blocks[0].text, "[image omitted: dropped to fit the request media budget]");
    assert.equal(blocks[1].type, "text");
    assert.equal(blocks[1].text, "[video omitted: dropped to fit the request media budget]");
  });

  it("deduplicates repeated media so it counts once and drops everywhere", () => {
    const shared = dataUrl(60);
    const payload = openaiPayloadWith([shared, dataUrl(30), shared]);
    // The shared image (82 bytes) dedupes to one entry: 82 + 52 = 134 > 100,
    // dropping the shared key leaves 52 <= 60, so the unique image survives.
    applyInlineMediaBudget(payload, "openai-completions", 100, 60);
    const messages = payload.messages as JsonRecord[];
    const block = (index: number): JsonRecord => (messages[index].content as JsonRecord[])[0];
    assert.equal(block(0).type, "text");
    assert.equal(block(2).type, "text");
    assert.equal(block(1).type, "image_url");
  });

  it("ignores ms:// references left by the upload transforms", () => {
    const payload = openaiPayloadWith(["ms://file-1", "ms://file-2"]);
    const changed = applyInlineMediaBudget(payload, "openai-completions", 1, 1);
    assert.equal(changed, false);
  });

  it("drops anthropic base64 images, including inside tool_result content", () => {
    const payload: JsonRecord = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "A".repeat(40) },
            },
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "B".repeat(40) },
                },
              ],
            },
          ],
        },
      ],
    };
    applyInlineMediaBudget(payload, "anthropic-messages", 60, 30);
    const blocks = (payload.messages as JsonRecord[])[0].content as JsonRecord[];
    assert.deepEqual(blocks[0], {
      type: "text",
      text: "[image omitted: dropped to fit the request media budget]",
    });
    const nested = (blocks[1] as JsonRecord).content as JsonRecord[];
    assert.equal(nested[0].type, "text");
    assert.match(String(nested[0].text), /image omitted/);
  });

  it("drops anthropic base64 videos with a video placeholder", () => {
    const payload: JsonRecord = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "video",
              source: { type: "base64", media_type: "video/mp4", data: "A".repeat(40) },
            },
          ],
        },
      ],
    };
    const changed = applyInlineMediaBudget(payload, "anthropic-messages", 20, 10);
    assert.equal(changed, true);
    const block = ((payload.messages as JsonRecord[])[0].content as JsonRecord[])[0];
    assert.deepEqual(block, {
      type: "text",
      text: "[video omitted: dropped to fit the request media budget]",
    });
  });

  it("keeps anthropic payloads under the budget untouched", () => {
    const payload: JsonRecord = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
      ],
    };
    const originalContent = JSON.parse(
      JSON.stringify((payload.messages as JsonRecord[])[0].content),
    );
    const changed = applyInlineMediaBudget(payload, "anthropic-messages");
    assert.equal(changed, false);
    assert.deepEqual((payload.messages as JsonRecord[])[0].content, originalContent);
  });
});

describe("openai-responses payload", () => {
  it("strips empty text parts replayed from text-less assistant turns (issue #78)", async () => {
    const payload: JsonRecord = {
      input: [
        { role: "user", content: "run the tool" },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "" },
            { type: "function_call", name: "bash", arguments: "{}" },
          ],
        },
        { role: "user", content: "next" },
      ],
    };

    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-responses" }));

    const input = payload.input as JsonRecord[];
    assert.equal(input.length, 3);
    const assistant = input[1];
    assert.equal(assistant.role, "assistant");
    assert.deepEqual(assistant.content, [{ type: "function_call", name: "bash", arguments: "{}" }]);
  });

  it("drops assistant messages left with no content after stripping", async () => {
    const payload: JsonRecord = {
      input: [
        {
          role: "assistant",
          content: [{ type: "output_text", text: "   " }],
        },
        {
          role: "assistant",
          content: "",
        },
        { role: "user", content: "hi" },
      ],
    };

    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-responses" }));

    const input = payload.input as JsonRecord[];
    assert.deepEqual(
      input.map((item) => item.role),
      ["user"],
    );
  });

  it("keeps user/system text parts and non-message items untouched", async () => {
    const payload: JsonRecord = {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "" },
            { type: "input_text", text: "hello" },
          ],
        },
        { role: "system", content: [{ type: "text", text: "be helpful" }] },
        { type: "function_call", name: "bash", arguments: "{}" },
        { type: "reasoning", reasoning: "thinking" },
      ],
    };

    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-responses" }));

    const input = payload.input as JsonRecord[];
    assert.equal(input.length, 4);
    assert.deepEqual(input[0].content, [{ type: "input_text", text: "hello" }]);
    assert.equal(input[1].role, "system");
    assert.deepEqual(input[1].content, [{ type: "text", text: "be helpful" }]);
    assert.equal(input[2].type, "function_call");
    assert.equal(input[3].type, "reasoning");
  });

  it("drops assistant items that arrive already contentless", async () => {
    const payload: JsonRecord = {
      input: [
        { role: "assistant", content: [] },
        { role: "assistant" },
        { type: "message", role: "assistant", content: [] },
        { role: "user", content: "hi" },
      ],
    };

    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-responses" }));

    const input = payload.input as JsonRecord[];
    assert.deepEqual(
      input.map((item) => item.role),
      ["user"],
    );
  });

  it("does not rewrite input when nothing is empty", async () => {
    const payload: JsonRecord = {
      input: [
        { role: "assistant", content: [{ type: "output_text", text: "done" }] },
        { type: "function_call", name: "bash", arguments: "{}" },
      ],
    };
    const original = JSON.parse(JSON.stringify(payload.input));

    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-responses" }));

    assert.deepEqual(payload.input, original);
  });

  it("strips prompt_cache_retention and Completions thinking fields", async () => {
    const payload: JsonRecord = {
      input: [{ role: "user", content: "hi" }],
      prompt_cache_retention: "24h",
      thinking: { type: "enabled", effort: "high" },
      reasoning_effort: "high",
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        api: "openai-responses",
        reasoning: "high",
        modelConfig: { ...defaultModelConfig, supportEfforts: ["low", "high", "max"] },
      }),
    );

    assert.equal(payload.prompt_cache_retention, undefined);
    assert.equal(payload.thinking, undefined);
    assert.equal(payload.reasoning_effort, undefined);
    assert.deepEqual(payload.reasoning, { effort: "high", summary: "auto" });
  });

  it("clamps tool_choice to the string auto, including object forms", async () => {
    for (const toolChoice of ["none", { type: "auto" }, { type: "function", name: "read" }]) {
      const payload: JsonRecord = {
        input: [{ role: "user", content: "hi" }],
        tool_choice: toolChoice,
      };
      await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-responses" }));
      assert.equal(payload.tool_choice, "auto");
    }
  });

  it("drops upstream reasoning.effort none when the caller omits reasoning", async () => {
    const payload: JsonRecord = {
      input: [{ role: "user", content: "hi" }],
      reasoning: { effort: "none" },
    };
    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-responses" }));
    assert.equal(payload.reasoning, undefined);
  });

  it("replaces upstream none with the catalog default effort when reasoning is omitted", async () => {
    const payload: JsonRecord = {
      input: [{ role: "user", content: "hi" }],
      reasoning: { effort: "none" },
    };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        api: "openai-responses",
        modelConfig: {
          ...defaultModelConfig,
          supportEfforts: ["low", "high", "max"],
          defaultEffort: "max",
        },
      }),
    );
    assert.deepEqual(payload.reasoning, { effort: "max", summary: "auto" });
  });

  it("renames output caps to max_output_tokens", async () => {
    const payload: JsonRecord = {
      input: [{ role: "user", content: "hi" }],
      max_tokens: 64000,
    };
    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        api: "openai-responses",
        modelConfig: { ...defaultModelConfig, generation: { maxCompletionTokens: 32000 } },
      }),
    );
    assert.equal(payload.max_tokens, undefined);
    assert.equal(payload.max_completion_tokens, undefined);
    assert.equal(payload.max_output_tokens, 32000);
  });

  it("does not upload inline images on the Responses path", async () => {
    let calls = 0;
    const upload = async () => {
      calls += 1;
      return "ms://should-not-upload";
    };
    const payload: JsonRecord = {
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
        },
      ],
    };
    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-responses", upload }));
    assert.equal(calls, 0);
  });

  it("omits temperature unless explicitly configured", async () => {
    const payload: JsonRecord = {
      input: [{ role: "user", content: "hi" }],
      temperature: 1,
    };
    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-responses" }));
    assert.equal(payload.temperature, undefined);
  });

  it("fills missing tool parameter schema types on the flat Responses shape", async () => {
    const payload: JsonRecord = {
      input: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          name: "search",
          parameters: {
            type: "object",
            properties: {
              mode: { enum: ["smart", "full"] },
            },
          },
        },
      ],
    };

    await applyKimiPayloadMutations(payload, baseCtx({ api: "openai-responses" }));

    const tools = payload.tools as JsonRecord[];
    const parameters = tools[0]?.parameters as JsonRecord;
    const properties = parameters.properties as Record<string, JsonRecord>;
    assert.equal(properties.mode.type, "string");
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

  it("drains the unauthorized response before retrying", async () => {
    const staleResponse = unauthorizedResponse();
    let fetchCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      fetchCalls++;
      return fetchCalls === 1 ? staleResponse : fileResponse("file-1");
    };

    const result = await uploadKimiFile("old-token", "image/png", PNG_BASE64, 0, {
      fetch: fakeFetch,
      refreshAccessToken: async () => "new-token",
    });

    assert.equal(result, "ms://file-1");
    assert.equal(staleResponse.bodyUsed, true);
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

  it("returns null without retrying when refresh returns the current token", async () => {
    let fetchCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      fetchCalls++;
      return unauthorizedResponse();
    };

    const result = await uploadKimiFile("old-token", "image/png", PNG_BASE64, 0, {
      fetch: fakeFetch,
      refreshAccessToken: async () => "old-token",
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
    assert.equal(headers["X-Msh-Platform"], "pi");
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

    // pi-ai >=0.82 + the compat.forceAdaptiveThinking flag streamSimpleKimi
    // sets on the anthropic runtime model: enabled thinking arrives (and is
    // kept) in the adaptive shape rather than {type:"enabled", keep}.
    assert.equal((payload.thinking as JsonRecord).type, "adaptive");
  });

  it("suppresses prompt_cache_retention on the responses wire", async () => {
    setStoreResolvedKimiConfig({
      model: defaultModelConfig,
      protocol: "responses",
      uploads: DEFAULT_KIMI_CODE_CONFIG.uploads,
    });

    const payload = await capturePayload(
      streamModel({
        api: "openai-responses" as Api,
        reasoning: true,
      }),
    );

    assert.equal(payload.prompt_cache_retention, undefined);
    assert.equal(payload.store, false);
    assert.equal(payload.thinking, undefined);
  });

  it("surfaces a missing pi-ai stream entry point as a stream error event", async () => {
    // pi <=0.79 has no responses entry point at all; selecting the protocol
    // there must fail as a stream error event, not an unhandled rejection.
    setStoreResolvedKimiConfig({
      model: defaultModelConfig,
      protocol: "responses",
      uploads: DEFAULT_KIMI_CODE_CONFIG.uploads,
    });
    const restore = overrideStreamSimpleForTests("responses", undefined);
    try {
      const events = await collectAsyncIterable(
        streamSimpleKimi(streamModel(), { messages: [] }, { apiKey: "test-key" }),
      );
      const error = events.find((event) => event.type === "error");
      assert.ok(error, "expected an error event");
      assert.match(
        (error as { error?: { errorMessage?: string } }).error?.errorMessage ?? "",
        /no streamSimple entry point/,
      );
    } finally {
      restore();
    }
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
