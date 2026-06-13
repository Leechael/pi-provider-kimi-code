import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { KimiResolvedModelConfig } from "../src/config.ts";
import {
  applyKimiPayloadMutations,
  type JsonRecord,
  type KimiPayloadContext,
  resolveCacheRetention,
  resolveReasoningForLevel,
} from "../src/payload.ts";
import {
  filterEmptyResponseStream,
  mergeKimiRequestHeaders,
  resolveKimiApiKey,
} from "../src/stream.ts";

const defaultModelConfig: KimiResolvedModelConfig = {
  contextWindow: 262144,
  maxTokens: 32000,
  input: ["text", "image"],
  reasoning: true,
  reasoningMap: {
    off: { effort: null, enabled: false },
    minimal: { effort: "low", enabled: true },
    low: { effort: "low", enabled: true },
    medium: { effort: "medium", enabled: true },
    high: { effort: "high", enabled: true },
    xhigh: { effort: "high", enabled: true },
  },
  thinkingKeep: null,
  generation: {},
};

const baseCtx = (overrides: Partial<KimiPayloadContext> = {}): KimiPayloadContext => ({
  api: "anthropic-messages",
  cacheRetention: "short",
  modelConfig: defaultModelConfig,
  ...overrides,
});

describe("applyKimiPayloadMutations", () => {
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

  it("does not treat OpenAI video_url blocks as uploadable content", async () => {
    let invocations = 0;
    const upload = async () => {
      invocations++;
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

    assert.equal(invocations, 0);
    const messages = payload.messages as JsonRecord[];
    const content = messages[0]?.content as JsonRecord[];
    const block = content[0] as JsonRecord;
    const videoUrl = block.video_url as JsonRecord;
    assert.equal(videoUrl.url, "data:video/mp4;base64,AAAA");
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
      temperature: 0.4,
    };
    await applyKimiPayloadMutations(payload, baseCtx());
    assert.equal(payload.model, "kimi-for-coding");
    assert.equal(payload.temperature, 0.4);
  });

  it("merges reasoning type into existing extra_body.thinking fields", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      extra_body: { thinking: { keep: "all" } },
    };

    await applyKimiPayloadMutations(payload, baseCtx({ reasoning: "high" }));

    assert.equal(payload.reasoning_effort, "high");
    assert.deepEqual(payload.extra_body, {
      thinking: { keep: "all", type: "enabled" },
    });
  });

  it("applies thinkingKeep only when reasoning is enabled", async () => {
    const enabledPayload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
    };
    await applyKimiPayloadMutations(
      enabledPayload,
      baseCtx({ reasoning: "high", modelConfig: { ...defaultModelConfig, thinkingKeep: "all" } }),
    );
    assert.deepEqual(enabledPayload.extra_body, {
      thinking: { type: "enabled", keep: "all" },
    });

    const disabledPayload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
    };
    await applyKimiPayloadMutations(
      disabledPayload,
      baseCtx({ reasoning: "off" as ThinkingLevel, modelConfig: { ...defaultModelConfig, thinkingKeep: "all" } }),
    );
    assert.deepEqual(disabledPayload.extra_body, {
      thinking: { type: "disabled" },
    });
  });

  it("renames deprecated max_tokens to max_completion_tokens", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 128,
    };

    await applyKimiPayloadMutations(payload, baseCtx());

    assert.equal(payload.max_tokens, undefined);
    assert.equal(payload.max_completion_tokens, 128);
  });

  it("lets model config maxCompletionTokens override payload max_tokens", async () => {
    const payload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 128,
    };

    await applyKimiPayloadMutations(
      payload,
      baseCtx({
        modelConfig: { ...defaultModelConfig, generation: { maxCompletionTokens: 32000 } },
      }),
    );

    assert.equal(payload.max_tokens, undefined);
    assert.equal(payload.max_completion_tokens, 32000);
  });
});

describe("resolveReasoningForLevel", () => {
  it("returns the mapped entry for known levels", () => {
    const cfg = defaultModelConfig;
    assert.deepEqual(resolveReasoningForLevel("off", cfg), { effort: null, enabled: false });
    assert.deepEqual(resolveReasoningForLevel("minimal", cfg), { effort: "low", enabled: true });
    assert.deepEqual(resolveReasoningForLevel("low", cfg), { effort: "low", enabled: true });
    assert.deepEqual(resolveReasoningForLevel("medium", cfg), { effort: "medium", enabled: true });
    assert.deepEqual(resolveReasoningForLevel("xhigh", cfg), { effort: "high", enabled: true });
  });

  it("normalizes known aliases", () => {
    const cfg = defaultModelConfig;
    assert.deepEqual(resolveReasoningForLevel("off", cfg), {
      effort: null,
      enabled: false,
    });
    assert.deepEqual(resolveReasoningForLevel("minimal", cfg), {
      effort: "low",
      enabled: true,
    });
  });

  it("returns undefined for unknown levels", () => {
    const cfg = defaultModelConfig;
    assert.equal(resolveReasoningForLevel("unknown", cfg), undefined);
    assert.equal(resolveReasoningForLevel("none", cfg), undefined);
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
