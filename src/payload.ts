// Payload pipeline: shared types, pure utilities, file-upload IO edge,
// per-protocol message transforms, OpenAI tool-call / tool-schema normalizers,
// and the top-level applyKimiPayloadMutations that orchestrates them.

import type { CacheRetention, ThinkingLevel } from "@earendil-works/pi-ai";
import type { KimiResolvedModelConfig, ModelReasoningEntry } from "./config.ts";

import { getBaseUrl } from "./constants.ts";
import { getKimiProviderHeaders } from "./device.ts";
import { optimizeToolSchemas } from "./schema-dedup.ts";

// =============================================================================
// Shared types + small utilities
// =============================================================================

const DEFAULT_KIMI_INLINE_UPLOAD_THRESHOLD_BYTES = 1 * 1024 * 1024;

export type JsonRecord = Record<string, unknown>;
export type Uploader = (mimeType: string, data: string) => Promise<string | null>;

export function resolveCacheRetention(value?: CacheRetention): CacheRetention {
  if (value === "none" || value === "short" || value === "long") return value;
  const envRetention = process.env.PI_CACHE_RETENTION;
  if (envRetention === "none" || envRetention === "short" || envRetention === "long") {
    return envRetention;
  }
  return "short";
}

export interface KimiPayloadContext {
  api: "anthropic-messages" | "openai-completions";
  upload?: Uploader;
  cacheKey?: string;
  cacheRetention: CacheRetention;
  reasoning?: ThinkingLevel;
  modelConfig: KimiResolvedModelConfig;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveReasoningForLevel(
  level: string,
  config: KimiResolvedModelConfig,
): ModelReasoningEntry | undefined {
  return config.reasoningMap[level];
}

function resolveThinkingLevel(ctx: KimiPayloadContext): ThinkingLevel | undefined {
  if (ctx.modelConfig.supportsThinkingType === "no") return undefined;
  if (ctx.modelConfig.supportsThinkingType === "only") {
    if (!ctx.reasoning) return "low";
    const mapped = resolveReasoningForLevel(ctx.reasoning, ctx.modelConfig);
    if (mapped && !mapped.enabled) return "low";
  }
  return ctx.reasoning;
}

function parseInlineUploadThreshold(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_KIMI_INLINE_UPLOAD_THRESHOLD_BYTES;
}

function deriveFilesBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  return match ? { mimeType: match[1], data: match[2] } : null;
}

function getUploadFilename(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "upload.jpg",
    "image/png": "upload.png",
    "image/gif": "upload.gif",
    "image/webp": "upload.webp",
  };
  return map[mimeType] ?? "upload.bin";
}

// =============================================================================
// File upload (I/O edge)
// =============================================================================

export async function uploadKimiFile(
  apiKey: string,
  mimeType: string,
  data: string,
  thresholdBytes?: number,
): Promise<string | null> {
  const buffer = Buffer.from(data, "base64");
  if (!mimeType.startsWith("image/")) return null;
  const threshold =
    thresholdBytes ?? parseInlineUploadThreshold(process.env.KIMI_CODE_UPLOAD_THRESHOLD_BYTES);
  if (buffer.length <= threshold) return null;

  const filename = getUploadFilename(mimeType);
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimeType }), filename);
  formData.append("purpose", "image");

  const uploadUrl = `${deriveFilesBaseUrl(getBaseUrl())}/files`;
  const debug = process.env.KIMI_CODE_DEBUG === "1";
  if (debug) {
    console.log(
      `\n[kimi-coding] Uploading ${filename} to ${uploadUrl} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`,
    );
  }

  try {
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: { ...getKimiProviderHeaders(), Authorization: `Bearer ${apiKey}` },
      body: formData,
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const fileObj = (await response.json()) as { id?: string };
    if (!fileObj.id) throw new Error("missing file id");
    const fileUrl = `ms://${fileObj.id}`;
    if (debug) console.log(`[kimi-coding] Upload success: ${fileUrl}`);
    return fileUrl;
  } catch (err) {
    console.error("[kimi-coding] Upload failed:", err);
    return null;
  }
}

// =============================================================================
// Payload file transformers (pure given an Uploader)
//
// These walk the provider-specific payload shape and replace inline base64
// image blocks with ms:// references returned by the injected uploader. They
// take an Uploader rather than an apiKey so they can be unit-tested with a
// fake uploader; all network I/O stays behind that boundary.
// =============================================================================

async function transformOpenAIPayloadFiles(payload: JsonRecord, upload: Uploader): Promise<void> {
  if (!Array.isArray(payload.messages)) return;
  const cache = new Map<string, string>();

  for (const message of payload.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;

    for (const block of message.content) {
      if (!isRecord(block)) continue;
      const key = block.type === "image_url" ? "image_url" : null;
      if (!key) continue;

      const field = block[key];
      const urlValue =
        typeof field === "string"
          ? field
          : isRecord(field) && typeof field.url === "string"
            ? field.url
            : null;
      if (!urlValue || urlValue.startsWith("ms://")) continue;

      const parsed = parseDataUrl(urlValue);
      if (!parsed) continue;

      const uploaded = cache.get(urlValue) ?? (await upload(parsed.mimeType, parsed.data));
      if (!uploaded) continue;
      cache.set(urlValue, uploaded);

      block[key] =
        typeof field === "string" ? uploaded : { ...(field as JsonRecord), url: uploaded };
    }
  }
}

function isEffectivelyEmptyOpenAIContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim() === "";
  if (!Array.isArray(content)) return false;
  for (const part of content) {
    if (!isRecord(part) || part.type !== "text") return false;
    if (typeof part.text === "string" && part.text.trim()) return false;
  }
  return true;
}

function normalizeOpenAIAssistantToolCalls(payload: JsonRecord): void {
  if (!Array.isArray(payload.messages)) return;
  for (const message of payload.messages) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue;
    if (isEffectivelyEmptyOpenAIContent(message.content)) {
      delete message.content;
    }
  }
}

// -----------------------------------------------------------------------------
// JSON Schema property-type normalizer (mirrors kosong's ensure_property_types).
// Moonshot's tool schema validator rejects property schemas that omit `type`;
// this walks the schema and back-fills a type from `enum` / `const` / nested
// structure hints, defaulting to "string" when nothing else applies.
// -----------------------------------------------------------------------------

const JSON_SCHEMA_COMBINATOR_KEYS = new Set([
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
]);

const JSON_SCHEMA_OBJECT_KEYS = new Set([
  "properties",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "required",
  "minProperties",
  "maxProperties",
]);
const JSON_SCHEMA_ARRAY_KEYS = new Set([
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
]);
const JSON_SCHEMA_STRING_KEYS = new Set(["minLength", "maxLength", "pattern", "format"]);
const JSON_SCHEMA_NUMERIC_KEYS = new Set([
  "minimum",
  "maximum",
  "multipleOf",
  "exclusiveMinimum",
  "exclusiveMaximum",
]);

function hasAnyKey(record: JsonRecord, keys: Set<string>): boolean {
  return Object.keys(record).some((key) => keys.has(key));
}

function inferJsonSchemaTypeFromValues(values: unknown[]): string {
  const inferred = new Set<string>();
  for (const value of values) {
    if (typeof value === "boolean") inferred.add("boolean");
    else if (typeof value === "number")
      inferred.add(Number.isInteger(value) ? "integer" : "number");
    else if (typeof value === "string") inferred.add("string");
    else if (value === null) inferred.add("null");
    else if (Array.isArray(value)) inferred.add("array");
    else if (isRecord(value)) inferred.add("object");
    else return "string";
  }
  if (inferred.size === 1) return [...inferred][0] ?? "string";
  if (inferred.size === 2 && inferred.has("integer") && inferred.has("number")) return "number";
  return "string";
}

function inferJsonSchemaTypeFromStructure(node: JsonRecord): string {
  if (hasAnyKey(node, JSON_SCHEMA_OBJECT_KEYS)) return "object";
  if (hasAnyKey(node, JSON_SCHEMA_ARRAY_KEYS)) return "array";
  if (hasAnyKey(node, JSON_SCHEMA_STRING_KEYS)) return "string";
  if (hasAnyKey(node, JSON_SCHEMA_NUMERIC_KEYS)) return "number";
  return "string";
}

function normalizeJsonSchemaPropertyTypes(node: unknown): void {
  if (!isRecord(node)) return;

  if (
    node.type === undefined &&
    !Object.keys(node).some((key) => JSON_SCHEMA_COMBINATOR_KEYS.has(key))
  ) {
    if (Array.isArray(node.enum) && node.enum.length > 0) {
      node.type = inferJsonSchemaTypeFromValues(node.enum);
    } else if ("const" in node) {
      node.type = inferJsonSchemaTypeFromValues([node.const]);
    } else {
      node.type = inferJsonSchemaTypeFromStructure(node);
    }
  }

  recurseJsonSchemaPropertyTypes(node);
}

function recurseJsonSchemaPropertyTypes(node: unknown): void {
  if (!isRecord(node)) return;

  if (isRecord(node.properties)) {
    for (const value of Object.values(node.properties)) {
      normalizeJsonSchemaPropertyTypes(value);
    }
  }

  if (isRecord(node.items)) {
    normalizeJsonSchemaPropertyTypes(node.items);
  } else if (Array.isArray(node.items)) {
    for (const value of node.items) {
      normalizeJsonSchemaPropertyTypes(value);
    }
  }

  if (isRecord(node.additionalProperties)) {
    normalizeJsonSchemaPropertyTypes(node.additionalProperties);
  }

  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const value of branches) {
      normalizeJsonSchemaPropertyTypes(value);
    }
  }
}

function normalizeOpenAIToolSchemas(payload: JsonRecord): void {
  if (!Array.isArray(payload.tools)) return;
  for (const tool of payload.tools) {
    if (!isRecord(tool) || !isRecord(tool.function)) continue;
    const parameters = tool.function.parameters;
    if (!isRecord(parameters)) continue;
    recurseJsonSchemaPropertyTypes(parameters);
  }
}

async function transformAnthropicPayloadFiles(
  payload: JsonRecord,
  upload: Uploader,
): Promise<void> {
  if (!Array.isArray(payload.messages)) return;
  const cache = new Map<string, string>();

  const transformImageBlock = async (block: unknown): Promise<unknown> => {
    if (!isRecord(block) || block.type !== "image") return block;
    const source = block.source;
    if (!isRecord(source) || source.type !== "base64") return block;
    const mediaType = source.media_type;
    const data = source.data;
    if (typeof mediaType !== "string" || typeof data !== "string") return block;

    const cacheKey = `${mediaType}:${data}`;
    const uploaded = cache.get(cacheKey) ?? (await upload(mediaType, data));
    if (!uploaded) return block;
    cache.set(cacheKey, uploaded);

    const next: JsonRecord = { type: "image", source: { type: "url", url: uploaded } };
    if (block.cache_control !== undefined) next.cache_control = block.cache_control;
    return next;
  };

  for (const message of payload.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;

    for (let i = 0; i < message.content.length; i++) {
      const block = message.content[i];
      if (isRecord(block) && block.type === "tool_result" && Array.isArray(block.content)) {
        for (let j = 0; j < block.content.length; j++) {
          block.content[j] = await transformImageBlock(block.content[j]);
        }
        continue;
      }
      message.content[i] = await transformImageBlock(block);
    }
  }
}

// =============================================================================
// Payload mutation pipeline
//
// Applies all Kimi-specific mutations to a provider payload in place. Pure
// given its context: no process.env / fs / network access of its own — every
// side effect enters via ctx.upload or pre-read values in ctx. This makes the
// steps below testable with fixture payloads.
// =============================================================================

export async function applyKimiPayloadMutations(
  payload: JsonRecord,
  ctx: KimiPayloadContext,
): Promise<void> {
  // 1. Map unsupported roles: Kimi does not recognize "developer" (OpenAI-specific).
  if (Array.isArray(payload.messages)) {
    payload.messages = payload.messages.map((msg) =>
      isRecord(msg) && msg.role === "developer" ? { ...msg, role: "system" } : msg,
    );
  }

  // 2. File upload dispatch (protocol-specific).
  if (ctx.upload) {
    if (ctx.api === "openai-completions") {
      await transformOpenAIPayloadFiles(payload, ctx.upload);
    } else if (ctx.api === "anthropic-messages") {
      await transformAnthropicPayloadFiles(payload, ctx.upload);
    }
  }
  if (ctx.api === "openai-completions") {
    normalizeOpenAIAssistantToolCalls(payload);
    normalizeOpenAIToolSchemas(payload);
  }
  if (Array.isArray(payload.tools)) {
    payload.tools = optimizeToolSchemas(payload.tools);
  }

  // 3. prompt_cache_key injection. Respect any key already on the payload,
  //    otherwise fall back to the caller-provided cacheKey (sessionId or
  //    explicit options.prompt_cache_key override). Skipped entirely when
  //    cacheRetention is "none" (via options.cacheRetention or
  //    PI_CACHE_RETENTION) so callers can truly disable caching — otherwise
  //    Kimi's native session cache would still fire even if pi-ai's
  //    Anthropic-style cache_control markers are omitted.
  if (ctx.cacheRetention !== "none") {
    const existing = payload.prompt_cache_key;
    const resolved = (typeof existing === "string" && existing) || ctx.cacheKey;
    if (resolved) payload.prompt_cache_key = resolved;
  }

  // 4. Request usage stats on streaming responses (OpenAI only —
  //    Anthropic /messages does not support stream_options).
  if (ctx.api === "openai-completions" && payload.stream === true) {
    payload.stream_options = isRecord(payload.stream_options)
      ? { ...(payload.stream_options as JsonRecord), include_usage: true }
      : { include_usage: true };
  }

  // 5. Normalize deprecated max_tokens (OpenAI path only — Anthropic
  //    /messages uses max_tokens natively).
  if (ctx.api === "openai-completions") {
    if (payload.max_completion_tokens === undefined && typeof payload.max_tokens === "number") {
      payload.max_completion_tokens = payload.max_tokens;
    }
    delete payload.max_tokens;
  }

  const generation = ctx.modelConfig.generation;
  if (generation.temperature !== undefined) payload.temperature = generation.temperature;
  if (generation.topP !== undefined) payload.top_p = generation.topP;
  if (generation.maxCompletionTokens !== undefined) {
    const maxTokensKey = ctx.api === "anthropic-messages" ? "max_tokens" : "max_completion_tokens";
    const currentMaxTokens = payload[maxTokensKey];
    payload[maxTokensKey] =
      typeof currentMaxTokens === "number"
        ? Math.min(currentMaxTokens, generation.maxCompletionTokens)
        : generation.maxCompletionTokens;
  }

  // 5. Spread extra_body into top-level payload before reasoning mapping,
  //    matching upstream (Kimi expects thinking etc. at the root).
  if (isRecord(payload.extra_body)) {
    const extraBody = payload.extra_body as JsonRecord;
    delete payload.extra_body;
    for (const [key, value] of Object.entries(extraBody)) {
      if (payload[key] === undefined) {
        payload[key] = value;
      }
    }
  }

  // 6. Reasoning effort mapping. Kimi now accepts effort only inside the
  //    thinking object, and only for values advertised by the model catalog.
  delete payload.reasoning_effort;
  if (ctx.modelConfig.supportsThinkingType === "no") {
    delete payload.thinking;
  }
  const resolvedReasoning = resolveThinkingLevel(ctx);
  if (resolvedReasoning) {
    const mapped = resolveReasoningForLevel(resolvedReasoning, ctx.modelConfig);
    if (mapped) {
      const oldThinking = isRecord(payload.thinking) ? payload.thinking : {};
      const thinking: JsonRecord = {
        ...oldThinking,
        type: mapped.enabled ? "enabled" : "disabled",
      };
      delete thinking.effort;
      const effort = ctx.reasoning
        ? mapped.effort
        : (ctx.modelConfig.defaultEffort ?? mapped.effort);
      if (mapped.enabled && effort !== null && ctx.modelConfig.supportEfforts?.includes(effort)) {
        thinking.effort = effort;
      }
      if (mapped.enabled && ctx.modelConfig.thinkingKeep) {
        thinking.keep = ctx.modelConfig.thinkingKeep;
      }
      payload.thinking = thinking;
    }
  }

  // 7. K2.7 Code API constraints: the server rejects non-default values for
  //    temperature (must be 1.0) and top_p (must be 0.95), and tool_choice
  //    "required" / function-specific when thinking is enabled (always-on).
  if (payload.temperature !== undefined && payload.temperature !== 1) {
    delete payload.temperature;
  }
  if (payload.top_p !== undefined && payload.top_p !== 0.95) {
    delete payload.top_p;
  }
  if (payload.tool_choice !== undefined) {
    const tc = payload.tool_choice;
    const isAllowed =
      tc === "auto" ||
      tc === "none" ||
      (isRecord(tc) && (tc.type === "auto" || tc.type === "none"));
    if (!isAllowed) {
      payload.tool_choice = isRecord(tc) ? { type: "auto" } : "auto";
    }
  }
}
