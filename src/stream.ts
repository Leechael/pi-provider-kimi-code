// Stream wrapper + empty-response filter. Reads every side-effect source
// (process.env, options, apiKey) at the top and hands a plain
// KimiPayloadContext to applyKimiPayloadMutations. The actual logic lives in
// the pure units in payload.ts; this file just wires SDK streaming + filter +
// error fallback together.

import type {
  Api,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  streamSimpleAnthropic,
  streamSimpleOpenAICompletions,
} from "@earendil-works/pi-ai";
import {
  DEFAULT_KIMI_CODE_CONFIG,
  type KimiCodeConfig,
  type KimiResolvedModelConfig,
} from "./config.ts";

import { ENV_KIMI_CODE_PROTOCOL, getApiProtocol, getBaseUrl } from "./constants.ts";
import { getKimiProviderHeaders } from "./device.ts";
import { isKimiAuthErrorMessage, refreshKimiAuthToken } from "./oauth.ts";
import {
  type Uploader,
  applyKimiPayloadMutations,
  isRecord,
  resolveCacheRetention,
  uploadKimiFile,
} from "./payload.ts";

interface KimiStreamRuntimeConfig {
  model: KimiResolvedModelConfig;
  protocol: KimiCodeConfig["protocol"];
  uploads: KimiCodeConfig["uploads"];
}

let resolvedStore: KimiStreamRuntimeConfig | null = null;

export function setStoreResolvedKimiConfig(config: KimiStreamRuntimeConfig): void {
  resolvedStore = config;
}

// =============================================================================
// Event stream filter: suppress Kimi "(Empty response: ...)" text blocks
// =============================================================================
// The Kimi API wraps thinking-only responses (no text content) into a text
// block like: (Empty response: {'content': [{'type': 'thinking', ...}]}).
// This leaks internal state to the user. We buffer text_start/text_delta
// events and drop the whole block if text_end starts with the marker.
// Pure async generator — no closure dependencies, testable with synthetic
// event arrays.

const EMPTY_RESPONSE_PREFIX = "(Empty response:";

export async function* filterEmptyResponseStream(
  upstream: AsyncIterable<AssistantMessageEvent>,
): AsyncIterable<AssistantMessageEvent> {
  const suppressedIndices = new Set<number>();
  let textBuffer: AssistantMessageEvent[] = [];
  let bufferedText = "";
  let bufferingIndex: number | null = null;

  const suppressBufferedTextBlock = (): void => {
    if (bufferingIndex !== null) suppressedIndices.add(bufferingIndex);
    textBuffer = [];
    bufferedText = "";
    bufferingIndex = null;
  };

  const flushBufferedTextBlock = async function* (): AsyncIterable<AssistantMessageEvent> {
    for (const buffered of textBuffer) yield buffered;
    textBuffer = [];
    bufferedText = "";
    bufferingIndex = null;
  };

  for await (const event of upstream) {
    // Start buffering only long enough to decide whether this text block is
    // Kimi's synthetic "(Empty response: ...)" wrapper. Normal text is flushed
    // as soon as it diverges from the marker so output still streams.
    if (event.type === "text_start") {
      bufferingIndex = event.contentIndex;
      textBuffer = [event];
      bufferedText = "";
      continue;
    }

    if (
      bufferingIndex !== null &&
      "contentIndex" in event &&
      event.contentIndex === bufferingIndex
    ) {
      if (event.type === "text_delta") {
        bufferedText += event.delta;
        textBuffer.push(event);
        if (bufferedText.startsWith(EMPTY_RESPONSE_PREFIX)) {
          suppressBufferedTextBlock();
          continue;
        }
        if (EMPTY_RESPONSE_PREFIX.startsWith(bufferedText)) {
          continue;
        }
        yield* flushBufferedTextBlock();
        continue;
      }
      if (event.type === "text_end") {
        if (event.content.startsWith(EMPTY_RESPONSE_PREFIX)) {
          // Suppress entire text block. Do NOT splice the message content
          // array: it is a shared reference into session state, and mutating
          // it would shift subsequent contentIndex values, corrupting the
          // stream.
          suppressBufferedTextBlock();
        } else {
          yield* flushBufferedTextBlock();
          yield event;
        }
        continue;
      }
    }

    // Skip any event targeting an already-suppressed content index.
    if ("contentIndex" in event && suppressedIndices.has(event.contentIndex)) {
      continue;
    }

    // Clean suppressed blocks out of the final message.
    if (event.type === "done" && suppressedIndices.size > 0) {
      event.message.content = event.message.content.filter(
        (block) =>
          !(
            block.type === "text" &&
            typeof block.text === "string" &&
            block.text.startsWith(EMPTY_RESPONSE_PREFIX)
          ),
      );
    }

    yield event;
  }

  if (bufferingIndex !== null) {
    yield* flushBufferedTextBlock();
  }
}

// =============================================================================
// Stream wrapper: orchestrates payload mutation + event filter
// =============================================================================

const KIMI_API_KEY_ENV_REFERENCES = new Set(["$KIMI_API_KEY", "${KIMI_API_KEY}"]);

export function resolveKimiApiKey(apiKey: string | undefined): string {
  if (apiKey !== undefined && KIMI_API_KEY_ENV_REFERENCES.has(apiKey)) {
    return process.env.KIMI_API_KEY?.trim() || "";
  }
  return apiKey || process.env.KIMI_API_KEY || "";
}

export function mergeKimiRequestHeaders(headers?: Record<string, string>): Record<string, string> {
  return { ...getKimiProviderHeaders(), ...headers };
}

export function streamSimpleKimi(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const filtered = createAssistantMessageEventStream();
  const initialKey = resolveKimiApiKey(options?.apiKey);

  const cacheKeyOverride = (
    options as (SimpleStreamOptions & { prompt_cache_key?: unknown }) | undefined
  )?.prompt_cache_key;
  const cacheKey = (typeof cacheKeyOverride === "string" && cacheKeyOverride) || options?.sessionId;
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const streamConfig = resolvedStore ?? {
    model: {
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: ["text"],
      reasoning: model.reasoning,
      reasoningMap: {},
      thinkingKeep: null,
      generation: {},
    },
    protocol: ENV_KIMI_CODE_PROTOCOL,
    uploads: DEFAULT_KIMI_CODE_CONFIG.uploads,
  };
  const discoveredModel = model as Model<Api> & {
    supportsThinkingType?: "only" | "no" | "both";
    wireProtocol?: KimiCodeConfig["protocol"];
    supportEfforts?: string[];
    defaultEffort?: string;
  };
  const modelConfig: KimiResolvedModelConfig = {
    ...streamConfig.model,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: [...model.input],
    reasoning: model.reasoning,
    supportsThinkingType:
      discoveredModel.supportsThinkingType ?? (model.reasoning ? undefined : "no"),
    supportEfforts: discoveredModel.supportEfforts
      ? [...discoveredModel.supportEfforts]
      : undefined,
    defaultEffort: discoveredModel.defaultEffort,
  };
  const wireProtocol = discoveredModel.wireProtocol ?? streamConfig.protocol;
  const apiProtocol = getApiProtocol(wireProtocol);
  const originalOnPayload = options?.onPayload;
  // The pi-side model id ("kimi-for-coding") is what users select via /model
  // and what gets persisted into sessions. The wire model id discovered at
  // OAuth login (e.g. a versioned alias the server exposes) gets carried on
  // the model object via modifyModels and rewritten into the request payload
  // here so /v1/chat/completions and /v1/messages see the real wire id.
  const wireModelId = (model as Model<Api> & { wireModelId?: unknown }).wireModelId;
  const buildPatchedOptions = (apiKey: string): SimpleStreamOptions => {
    const upload: Uploader | undefined = apiKey
      ? (mimeType, data) =>
          uploadKimiFile(apiKey, mimeType, data, streamConfig.uploads.thresholdBytes)
      : undefined;
    // Only forward apiKey if we actually have one — never override the
    // caller's credential (e.g. Claude Code OAuth token) with an empty string.
    const apiKeyOverride = apiKey ? { apiKey } : {};
    return {
      ...options,
      ...apiKeyOverride,
      headers: mergeKimiRequestHeaders(options?.headers),
      onPayload: async (payload, modelData) => {
        let nextPayload: unknown = payload;

        if (isRecord(nextPayload)) {
          await applyKimiPayloadMutations(nextPayload, {
            api: apiProtocol,
            upload,
            cacheKey,
            cacheRetention,
            reasoning: options?.reasoning,
            modelConfig,
          });
          if (
            typeof wireModelId === "string" &&
            wireModelId &&
            nextPayload.model === "kimi-for-coding"
          ) {
            nextPayload.model = wireModelId;
          }
        }

        if (originalOnPayload) {
          const res = await originalOnPayload(nextPayload, modelData);
          if (res !== undefined) nextPayload = res;
        }

        return nextPayload;
      },
    };
  };

  void (async () => {
    let attempt = 0;
    let currentKey = initialKey;

    while (true) {
      const patchedOptions = buildPatchedOptions(currentKey);
      // Route by the module-level protocol flag, not model.api, since we
      // register with a custom api type (kimi-openai-completions /
      // kimi-anthropic-messages) to avoid overriding the built-in
      // Anthropic/OpenAI stream handlers.
      const runtimeModel = {
        ...model,
        api: apiProtocol,
        baseUrl: getBaseUrl(wireProtocol),
      } as Model<Api>;
      const upstream =
        wireProtocol === "openai"
          ? streamSimpleOpenAICompletions(
              runtimeModel as Model<"openai-completions">,
              context,
              patchedOptions,
            )
          : streamSimpleAnthropic(
              runtimeModel as Model<"anthropic-messages">,
              context,
              patchedOptions,
            );

      let shouldRetry = false;
      let prefixBuffer: AssistantMessageEvent[] = [];

      try {
        for await (const event of filterEmptyResponseStream(upstream)) {
          // streamAnthropic emits a synthetic "start" event synchronously,
          // before the for-await loop begins iterating and therefore before
          // the HTTP request is actually made.  If the request 401s, the loop
          // throws and the catch block emits "error".  Without buffering, the
          // "start" event (which carries an empty AssistantMessage) leaks into
          // the session history and the TUI, leaving a phantom empty assistant
          // bubble.  We buffer "start" events and only flush them once we see
          // a non-error event that proves the stream is alive.
          if (event.type === "start") {
            prefixBuffer.push(event);
            continue;
          }

          // Speculative OAuth refresh on the first auth error. We retry once
          // so short-lived Kimi tokens invalidated before the local expires
          // timestamp lapses don't surface as raw 401s to the user.
          if (
            attempt === 0 &&
            event.type === "error" &&
            isKimiAuthErrorMessage(event.error?.errorMessage)
          ) {
            console.error(
              `[kimi-coding] upstream error on first event, attempting refresh: ${event.error?.errorMessage?.slice(0, 200)}`,
            );
            const refreshed = await refreshKimiAuthToken(currentKey);
            if (refreshed && refreshed !== currentKey) {
              console.error("[kimi-coding] retrying stream with refreshed token");
              currentKey = refreshed;
              shouldRetry = true;
              break; // discard prefixBuffer — don't leak the stale start
            }
            console.error(
              "[kimi-coding] refresh did not yield a new token, forwarding original error",
            );
          }

          // First non-start, non-retry event: flush buffered prefix, then
          // stream normally.
          for (const e of prefixBuffer) filtered.push(e);
          prefixBuffer = [];
          filtered.push(event);
        }

        // Stream ended normally: flush any remaining buffered starts.
        if (!shouldRetry) {
          for (const e of prefixBuffer) filtered.push(e);
        }
      } catch (err) {
        // Upstream threw rather than emitting a stream `error` event. This can
        // be the same stale-token 401 surfaced as an exception (depending on
        // the SDK path / network layer), so mirror the in-stream refresh
        // branch: on attempt 0, try one OAuth refresh + retry. Either way,
        // discard `prefixBuffer` — we never confirmed the stream actually
        // started, and flushing the buffered `start` would resurrect the
        // phantom empty assistant message this PR set out to fix.
        console.error("[kimi-coding] stream error:", err);
        if (attempt === 0 && isKimiAuthErrorMessage(err instanceof Error ? err.message : err)) {
          const refreshed = await refreshKimiAuthToken(currentKey);
          if (refreshed && refreshed !== currentKey) {
            console.error("[kimi-coding] retrying stream after thrown error with refreshed token");
            currentKey = refreshed;
            shouldRetry = true;
          }
        }
        if (!shouldRetry) {
          filtered.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              content: [],
              stopReason: "error",
              errorMessage: err instanceof Error ? err.message : String(err),
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              timestamp: Date.now(),
            },
          });
        }
      }

      if (shouldRetry) {
        attempt++;
        continue;
      }
      break;
    }
  })();

  return filtered;
}
