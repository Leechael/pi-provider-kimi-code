import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { applyKimiPayloadMutations, type JsonRecord, type KimiPayloadContext } from "../index.ts";

const baseCtx = (overrides: Partial<KimiPayloadContext> = {}): KimiPayloadContext => ({
  api: "anthropic-messages",
  cacheRetention: "short",
  envOverrides: {},
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
      baseCtx({ reasoning: "high", thinkingKeep: "all" }),
    );
    assert.deepEqual(enabledPayload.extra_body, {
      thinking: { type: "enabled", keep: "all" },
    });

    const disabledPayload: JsonRecord = {
      messages: [{ role: "user", content: "hi" }],
    };
    await applyKimiPayloadMutations(
      disabledPayload,
      baseCtx({ reasoning: "none" as ThinkingLevel, thinkingKeep: "all" }),
    );
    assert.deepEqual(disabledPayload.extra_body, {
      thinking: { type: "disabled" },
    });
  });
});
