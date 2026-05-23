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

import { PROTOCOL } from "./constants.ts";
import { isKimiAuthErrorMessage, refreshKimiAuthToken } from "./oauth.ts";
import {
  type Uploader,
  applyKimiPayloadMutations,
  isRecord,
  readEnvOverrides,
  resolveCacheRetention,
  uploadKimiFile,
} from "./payload.ts";

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
  let bufferingIndex: number | null = null;

  for await (const event of upstream) {
    // Start buffering when a new text block begins.
    if (event.type === "text_start") {
      bufferingIndex = event.contentIndex;
      textBuffer = [event];
      continue;
    }

    // Accumulate text deltas + detect the empty-response marker on text_end.
    if (
      bufferingIndex !== null &&
      "contentIndex" in event &&
      event.contentIndex === bufferingIndex
    ) {
      if (event.type === "text_delta") {
        textBuffer.push(event);
        continue;
      }
      if (event.type === "text_end") {
        if (event.content.startsWith(EMPTY_RESPONSE_PREFIX)) {
          // Suppress entire text block. Do NOT splice the message content
          // array: it is a shared reference into session state, and mutating
          // it would shift subsequent contentIndex values, corrupting the
          // stream.
          suppressedIndices.add(bufferingIndex);
        } else {
          // Legitimate text block — flush buffered events + end event.
          for (const buffered of textBuffer) yield buffered;
          yield event;
        }
        textBuffer = [];
        bufferingIndex = null;
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
}

// =============================================================================
// Stream wrapper: orchestrates payload mutation + event filter
// =============================================================================

export function streamSimpleKimi(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const filtered = createAssistantMessageEventStream();
  const initialKey = options?.apiKey || process.env.KIMI_API_KEY || "";

  const cacheKeyOverride = (
    options as (SimpleStreamOptions & { prompt_cache_key?: unknown }) | undefined
  )?.prompt_cache_key;
  const cacheKey = (typeof cacheKeyOverride === "string" && cacheKeyOverride) || options?.sessionId;
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const envOverrides = readEnvOverrides();
  const thinkingKeep = process.env.KIMI_MODEL_THINKING_KEEP;
  const originalOnPayload = options?.onPayload;
  // The pi-side model id ("kimi-for-coding") is what users select via /model
  // and what gets persisted into sessions. The wire model id discovered at
  // OAuth login (e.g. a versioned alias the server exposes) gets carried on
  // the model object via modifyModels and rewritten into the request payload
  // here so /v1/chat/completions and /v1/messages see the real wire id.
  const wireModelId = (model as Model<Api> & { wireModelId?: unknown }).wireModelId;

  const buildPatchedOptions = (apiKey: string): SimpleStreamOptions => {
    const upload: Uploader | undefined = apiKey
      ? (mimeType, data) => uploadKimiFile(apiKey, mimeType, data)
      : undefined;
    // Only forward apiKey if we actually have one — never override the
    // caller's credential (e.g. Claude Code OAuth token) with an empty string.
    const apiKeyOverride = apiKey ? { apiKey } : {};
    return {
      ...options,
      ...apiKeyOverride,
      onPayload: async (payload, modelData) => {
        let nextPayload: unknown = payload;

        if (isRecord(nextPayload)) {
          await applyKimiPayloadMutations(nextPayload, {
            api: PROTOCOL,
            upload,
            cacheKey,
            cacheRetention,
            reasoning: options?.reasoning,
            thinkingKeep,
            envOverrides,
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
      // Route by the module-level PROTOCOL, not model.api, since we register
      // with a custom api type (kimi-openai-completions / kimi-anthropic-messages)
      // to avoid overriding the built-in Anthropic/OpenAI stream handlers.
      const upstream =
        PROTOCOL === "openai-completions"
          ? streamSimpleOpenAICompletions(
              model as Model<"openai-completions">,
              context,
              patchedOptions,
            )
          : streamSimpleAnthropic(model as Model<"anthropic-messages">, context, patchedOptions);

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
