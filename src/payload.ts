// Payload pipeline: shared types, pure utilities, file-upload IO edge,
// per-protocol message transforms, OpenAI tool-call / tool-schema normalizers,
// and the top-level applyKimiPayloadMutations that orchestrates them.

import { createHash } from "node:crypto";

import type { CacheRetention, ThinkingLevel } from "@earendil-works/pi-ai";
import type { KimiResolvedModelConfig, ModelReasoningEntry } from "./config.ts";

import { getBaseUrl } from "./constants.ts";
import { getKimiProviderHeaders } from "./device.ts";
import { refreshKimiAuthToken } from "./oauth.ts";
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
  api: "anthropic-messages" | "openai-completions" | "openai-responses";
  upload?: Uploader;
  uploadCacheScope?: string;
  cacheKey?: string;
  cacheRetention: CacheRetention;
  reasoning?: ThinkingLevel;
  /** Per-request cap from the caller (pi options.maxTokens); wins over the omission policy. */
  requestMaxTokens?: number;
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
    // Video extensions mirror upstream kimi-code's MIME_TO_EXT
    // (packages/kosong/src/providers/kimi-files.ts).
    "video/mp4": "upload.mp4",
    "video/mpeg": "upload.mpeg",
    "video/quicktime": "upload.mov",
    "video/webm": "upload.webm",
    "video/x-matroska": "upload.mkv",
    "video/x-msvideo": "upload.avi",
    "video/x-flv": "upload.flv",
    "video/3gpp": "upload.3gp",
  };
  return map[mimeType] ?? "upload.bin";
}

// =============================================================================
// File upload (I/O edge)
// =============================================================================

export interface UploadKimiFileDeps {
  fetch?: typeof fetch;
  refreshAccessToken?: (currentToken: string) => Promise<string | null>;
}

export async function uploadKimiFile(
  apiKey: string,
  mimeType: string,
  data: string,
  thresholdBytes?: number,
  deps?: UploadKimiFileDeps,
): Promise<string | null> {
  const fetchImpl = deps?.fetch ?? fetch;
  const refreshAccessToken = deps?.refreshAccessToken ?? refreshKimiAuthToken;
  const buffer = Buffer.from(data, "base64");
  const isVideo = mimeType.startsWith("video/");
  if (!mimeType.startsWith("image/") && !isVideo) return null;
  const threshold =
    thresholdBytes ?? parseInlineUploadThreshold(process.env.KIMI_CODE_UPLOAD_THRESHOLD_BYTES);
  // The inline threshold applies to images only: the Kimi API has no inline
  // video path (upstream kimi-code uploads every video via /files), so videos
  // always upload.
  if (!isVideo && buffer.length <= threshold) return null;

  const filename = getUploadFilename(mimeType);
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimeType }), filename);
  formData.append("purpose", isVideo ? "video" : "image");

  const uploadUrl = `${deriveFilesBaseUrl(getBaseUrl())}/files`;
  const debug = process.env.KIMI_CODE_DEBUG === "1";
  if (debug) {
    console.log(
      `\n[kimi-coding] Uploading ${filename} to ${uploadUrl} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`,
    );
  }

  const postUpload = (token: string) =>
    fetchImpl(uploadUrl, {
      method: "POST",
      headers: { ...getKimiProviderHeaders(), Authorization: `Bearer ${token}` },
      body: formData,
    });

  try {
    let response = await postUpload(apiKey);
    // Kimi access tokens are short-lived and invalidated server-side as soon
    // as any peer process rotates them, so a 401 here usually means our key
    // snapshot went stale mid-session, not that login is broken. Mirror the
    // chat-stream recovery: force one refresh and retry once.
    let responseText: string | undefined;
    if (response.status === 401) {
      responseText = await response.text();
      const refreshed = await refreshAccessToken(apiKey);
      if (refreshed && refreshed !== apiKey) {
        console.error("[kimi-coding] upload got 401, retrying with refreshed token");
        response = await postUpload(refreshed);
        responseText = undefined;
      }
    }
    if (!response.ok)
      throw new Error(`${response.status} ${responseText ?? (await response.text())}`);
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
// Payload file transformers
//
// These walk the provider-specific payload shape and replace inline base64
// image blocks with ms:// references returned by the injected uploader. They
// take an Uploader rather than an apiKey so they can be unit-tested with a
// fake uploader; all network I/O stays behind that boundary.
//
// Successful uploads are remembered in a module-level cache shared across
// requests: payloads are rebuilt from session context every request, so
// without it a conversation's images would re-upload on every turn. Keys are
// content hashes rather than the data URLs themselves so the cache does not
// retain every image's base64 payload in memory. Failures are not cached and
// retry on the next request.
// =============================================================================

const MAX_UPLOADED_FILE_CACHE_ENTRIES = 512;
const uploadedFileCache = new Map<string, string>();

function uploadedFileCacheKey(cacheScope: string, mimeType: string, data: string): string {
  return createHash("sha256")
    .update(cacheScope)
    .update("\0")
    .update(mimeType)
    .update("\0")
    .update(data)
    .digest("hex");
}

function rememberUploadedFile(
  uploadCache: Map<string, string>,
  cacheKey: string,
  url: string,
): void {
  if (
    uploadCache === uploadedFileCache &&
    !uploadCache.has(cacheKey) &&
    uploadCache.size >= MAX_UPLOADED_FILE_CACHE_ENTRIES
  ) {
    const oldest = uploadCache.keys().next().value;
    if (oldest !== undefined) uploadCache.delete(oldest);
  }
  uploadCache.set(cacheKey, url);
}

export function clearKimiUploadedFileCache(): void {
  uploadedFileCache.clear();
}

async function transformOpenAIPayloadFiles(
  payload: JsonRecord,
  upload: Uploader,
  uploadCache: Map<string, string>,
  uploadCacheScope: string,
): Promise<void> {
  if (!Array.isArray(payload.messages)) return;

  for (const message of payload.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;

    for (const block of message.content) {
      if (!isRecord(block)) continue;
      const key =
        block.type === "image_url" ? "image_url" : block.type === "video_url" ? "video_url" : null;
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

      const cacheKey = uploadedFileCacheKey(uploadCacheScope, parsed.mimeType, parsed.data);
      const uploaded = uploadCache.get(cacheKey) ?? (await upload(parsed.mimeType, parsed.data));
      if (!uploaded) continue;
      rememberUploadedFile(uploadCache, cacheKey, uploaded);

      block[key] =
        typeof field === "string" ? uploaded : { ...(field as JsonRecord), url: uploaded };
    }
  }
}

// -----------------------------------------------------------------------------
// Per-request inline media budget (upstream kimi-code #3784,
// mediaResolverService.applyMediaBudget): accumulated inline media count
// against a 20 MB per-request budget; when exceeded, the oldest items are
// dropped until the total is under the 10 MB low-water mark and replaced with
// an omission placeholder. Uploaded ms:// references are tiny and never
// counted. Media is deduped by content hash so a repeated image counts once
// and every occurrence is dropped together.
// -----------------------------------------------------------------------------

const REQUEST_MEDIA_BUDGET_BYTES = 20 * 1024 * 1024;
const REQUEST_MEDIA_BUDGET_LOW_BYTES = 10 * 1024 * 1024;

interface InlineMediaBudgetEntry {
  kind: "image" | "video";
  key: string;
  bytes: number;
  /** Indices into messages[...].content[...] (a third index addresses a tool_result's content). */
  path: number[];
}

function inlineMediaKey(kind: string, payload: string): string {
  return createHash("sha256").update(kind).update("\0").update(payload).digest("hex");
}

function collectOpenAIInlineMedia(payload: JsonRecord): InlineMediaBudgetEntry[] {
  const entries: InlineMediaBudgetEntry[] = [];
  if (!Array.isArray(payload.messages)) return entries;
  for (const [messageIndex, message] of payload.messages.entries()) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const [blockIndex, block] of (message.content as unknown[]).entries()) {
      if (!isRecord(block)) continue;
      const field =
        block.type === "image_url" ? "image_url" : block.type === "video_url" ? "video_url" : null;
      if (!field) continue;
      const kind = block.type === "image_url" ? "image" : "video";
      const value = block[field];
      const url =
        typeof value === "string"
          ? value
          : isRecord(value) && typeof value.url === "string"
            ? value.url
            : null;
      if (!url || !url.startsWith("data:")) continue;
      entries.push({
        kind,
        key: inlineMediaKey(kind, url),
        bytes: url.length,
        path: [messageIndex, blockIndex],
      });
    }
  }
  return entries;
}

function collectAnthropicInlineMedia(payload: JsonRecord): InlineMediaBudgetEntry[] {
  const entries: InlineMediaBudgetEntry[] = [];
  if (!Array.isArray(payload.messages)) return entries;
  const collect = (messageIndex: number, path: number[], block: unknown): void => {
    if (!isRecord(block)) return;
    if (
      block.type === "image" &&
      isRecord(block.source) &&
      block.source.type === "base64" &&
      typeof block.source.media_type === "string" &&
      typeof block.source.data === "string"
    ) {
      const data = block.source.data;
      entries.push({
        kind: "image",
        key: inlineMediaKey("image", `${block.source.media_type}\0${data}`),
        bytes: data.length,
        path: [messageIndex, ...path],
      });
    }
  };
  for (const [messageIndex, message] of payload.messages.entries()) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const [blockIndex, block] of (message.content as unknown[]).entries()) {
      if (isRecord(block) && block.type === "tool_result" && Array.isArray(block.content)) {
        for (const [nestedIndex, nested] of (block.content as unknown[]).entries()) {
          collect(messageIndex, [blockIndex, nestedIndex], nested);
        }
        continue;
      }
      collect(messageIndex, [blockIndex], block);
    }
  }
  return entries;
}

export function applyInlineMediaBudget(
  payload: JsonRecord,
  api: "anthropic-messages" | "openai-completions",
  budgetBytes: number = REQUEST_MEDIA_BUDGET_BYTES,
  lowBytes: number = REQUEST_MEDIA_BUDGET_LOW_BYTES,
): boolean {
  const entries =
    api === "anthropic-messages"
      ? collectAnthropicInlineMedia(payload)
      : collectOpenAIInlineMedia(payload);
  if (entries.length === 0) return false;

  // Deduplicate by content: repeated media counts once, drops hit every copy.
  const bytesByKey = new Map<string, number>();
  for (const entry of entries) {
    if (!bytesByKey.has(entry.key)) bytesByKey.set(entry.key, entry.bytes);
  }
  let total = 0;
  for (const bytes of bytesByKey.values()) total += bytes;
  if (total <= budgetBytes) return false;

  const dropped = new Set<string>();
  for (const [key, bytes] of bytesByKey) {
    if (total <= lowBytes) break;
    if (bytes === 0) continue;
    dropped.add(key);
    total -= bytes;
  }

  const messages = payload.messages as unknown[];
  let droppedCount = 0;
  for (const entry of entries) {
    if (!dropped.has(entry.key)) continue;
    const message = messages[entry.path[0]] as JsonRecord;
    const content = message.content as unknown[];
    const placeholder = {
      type: "text",
      text: `[${entry.kind} omitted: dropped to fit the request media budget]`,
    };
    if (entry.path.length === 2) {
      content[entry.path[1]] = placeholder;
    } else {
      const toolResult = content[entry.path[1]] as JsonRecord;
      (toolResult.content as unknown[])[entry.path[2]] = placeholder;
    }
    droppedCount += 1;
  }
  console.warn(
    `[kimi-coding] inline media exceeded the ${String(budgetBytes / (1024 * 1024))} MB ` +
      `per-request budget; ${String(droppedCount)} media item(s) omitted`,
  );
  return true;
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
    if (!isRecord(tool)) continue;
    // Chat Completions nests the schema under tool.function.parameters;
    // Responses function tools carry parameters at the top level.
    const holder: JsonRecord = isRecord(tool.function) ? tool.function : tool;
    if (!isRecord(holder.parameters)) continue;
    recurseJsonSchemaPropertyTypes(holder.parameters);
  }
}

async function transformAnthropicPayloadFiles(
  payload: JsonRecord,
  upload: Uploader,
  uploadCache: Map<string, string>,
  uploadCacheScope: string,
): Promise<void> {
  if (!Array.isArray(payload.messages)) return;

  const transformImageBlock = async (block: unknown): Promise<unknown> => {
    if (!isRecord(block) || block.type !== "image") return block;
    const source = block.source;
    if (!isRecord(source) || source.type !== "base64") return block;
    const mediaType = source.media_type;
    const data = source.data;
    if (typeof mediaType !== "string" || typeof data !== "string") return block;

    const cacheKey = uploadedFileCacheKey(uploadCacheScope, mediaType, data);
    const uploaded = uploadCache.get(cacheKey) ?? (await upload(mediaType, data));
    if (!uploaded) return block;
    rememberUploadedFile(uploadCache, cacheKey, uploaded);

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

const RESPONSES_EFFORTS = new Set(["low", "high", "max"]);

function responsesSupportedEfforts(ctx: KimiPayloadContext): string[] {
  const advertised = ctx.modelConfig.supportEfforts;
  if (advertised?.length) return advertised.filter((effort) => RESPONSES_EFFORTS.has(effort));
  return [...RESPONSES_EFFORTS];
}

function setResponsesReasoning(payload: JsonRecord, effort: string | null): void {
  const oldReasoning = isRecord(payload.reasoning) ? payload.reasoning : {};
  if (!effort) {
    delete payload.reasoning;
    return;
  }
  const reasoning: JsonRecord = { ...oldReasoning, effort };
  if (reasoning.summary === undefined) reasoning.summary = "auto";
  payload.reasoning = reasoning;
}

function normalizeResponsesUpstreamEffort(payload: JsonRecord, ctx: KimiPayloadContext): void {
  const supported = responsesSupportedEfforts(ctx);
  const oldEffort = isRecord(payload.reasoning) ? payload.reasoning.effort : undefined;
  if (typeof oldEffort === "string" && supported.includes(oldEffort)) return;
  if (typeof oldEffort === "string") {
    const mapped = resolveReasoningForLevel(oldEffort, ctx.modelConfig);
    if (mapped?.enabled && mapped.effort && supported.includes(mapped.effort)) {
      setResponsesReasoning(payload, mapped.effort);
      return;
    }
  }
  const fallback = ctx.modelConfig.defaultEffort;
  setResponsesReasoning(payload, fallback && supported.includes(fallback) ? fallback : null);
}

function applyResponsesThinking(payload: JsonRecord, ctx: KimiPayloadContext): void {
  delete payload.thinking;
  delete payload.reasoning_effort;
  delete payload.output_config;
  if (ctx.modelConfig.supportsThinkingType === "no") {
    delete payload.reasoning;
    return;
  }
  const resolvedReasoning = resolveThinkingLevel(ctx);
  if (!resolvedReasoning) {
    normalizeResponsesUpstreamEffort(payload, ctx);
    return;
  }
  const mapped = resolveReasoningForLevel(resolvedReasoning, ctx.modelConfig);
  if (!mapped) {
    normalizeResponsesUpstreamEffort(payload, ctx);
    return;
  }
  if (!mapped.enabled) {
    delete payload.reasoning;
    return;
  }
  const effort = ctx.reasoning ? mapped.effort : (ctx.modelConfig.defaultEffort ?? mapped.effort);
  const supported = responsesSupportedEfforts(ctx);
  const oldReasoning = isRecord(payload.reasoning) ? payload.reasoning : {};
  const reasoning: JsonRecord = { ...oldReasoning };
  delete reasoning.effort;
  if (effort !== null && supported.includes(effort)) reasoning.effort = effort;
  if (reasoning.summary === undefined) reasoning.summary = "auto";
  payload.reasoning = reasoning;
}

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
    const uploadCache = ctx.uploadCacheScope ? uploadedFileCache : new Map<string, string>();
    const uploadCacheScope = ctx.uploadCacheScope ?? "request";
    if (ctx.api === "openai-completions") {
      await transformOpenAIPayloadFiles(payload, ctx.upload, uploadCache, uploadCacheScope);
    } else if (ctx.api === "anthropic-messages") {
      await transformAnthropicPayloadFiles(payload, ctx.upload, uploadCache, uploadCacheScope);
    }
  }
  if (ctx.api === "openai-completions" || ctx.api === "anthropic-messages") {
    // Runs after the upload transforms so media already promoted to ms://
    // references (tiny URLs) are never counted against the budget.
    applyInlineMediaBudget(payload, ctx.api);
  }
  if (ctx.api === "openai-completions") {
    normalizeOpenAIAssistantToolCalls(payload);
  }
  if (ctx.api === "openai-completions" || ctx.api === "openai-responses") {
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

  // 5. Spread extra_body into the top-level payload before normalization and
  //    config caps. Top-level fields retain precedence over extra_body.
  let extraBodyHadCap = false;
  if (isRecord(payload.extra_body)) {
    const extraBody = payload.extra_body as JsonRecord;
    extraBodyHadCap = ["max_tokens", "max_completion_tokens", "max_output_tokens"].some(
      (key) => typeof extraBody[key] === "number",
    );
    delete payload.extra_body;
    for (const [key, value] of Object.entries(extraBody)) {
      if (payload[key] === undefined) {
        payload[key] = value;
      }
    }
  }

  // 6. Normalize output-token field names per protocol.
  if (ctx.api === "openai-completions") {
    if (payload.max_completion_tokens === undefined && typeof payload.max_tokens === "number") {
      payload.max_completion_tokens = payload.max_tokens;
    }
    delete payload.max_tokens;
  } else if (ctx.api === "openai-responses") {
    if (payload.max_output_tokens === undefined) {
      if (typeof payload.max_completion_tokens === "number") {
        payload.max_output_tokens = payload.max_completion_tokens;
      } else if (typeof payload.max_tokens === "number") {
        payload.max_output_tokens = payload.max_tokens;
      }
    }
    delete payload.max_tokens;
    delete payload.max_completion_tokens;
    delete payload.prompt_cache_retention;
  }

  const generation = ctx.modelConfig.generation;
  // Output cap policy (mirrors upstream kimi-code #4091): omit the completion
  // cap on the OpenAI wires unless explicitly configured. pi-ai seeds a cap
  // clamped to the context window (clampMaxTokensToContext), and forwarding
  // that value breaks strict serving stacks (e.g. bare vLLM) that reject a
  // cap above the model's real output limit with repeated 400s. A cap counts
  // as explicit when generation.maxCompletionTokens is configured
  // (KIMI_MODEL_MAX_COMPLETION_TOKENS / config generation.maxCompletionTokens),
  // model.maxTokens holds a non-window value, or the caller supplies a
  // per-request cap through options.maxTokens / extra_body. Anthropic /messages requires
  // max_tokens, so that wire keeps pi-ai's window-clamped cap — the same
  // window - usedContextTokens value upstream fills in when unset.
  if (ctx.api === "openai-completions" || ctx.api === "openai-responses") {
    const capKey = ctx.api === "openai-responses" ? "max_output_tokens" : "max_completion_tokens";
    const explicitModelCap =
      typeof ctx.modelConfig.maxTokens === "number" &&
      ctx.modelConfig.maxTokens > 0 &&
      ctx.modelConfig.maxTokens !== ctx.modelConfig.contextWindow;
    const explicitRequestCap =
      extraBodyHadCap || (typeof ctx.requestMaxTokens === "number" && ctx.requestMaxTokens > 0);
    if (generation.maxCompletionTokens === undefined && !explicitModelCap && !explicitRequestCap) {
      delete payload[capKey];
    }
  }
  // Official kimi-code sends temperature/top_p only when explicitly configured
  // (env KIMI_MODEL_TEMPERATURE / KIMI_MODEL_TOP_P → generation.*); otherwise it
  // omits them and lets the server apply its own defaults. Mirror that exactly:
  // drop any value pi-ai seeded by default when the user hasn't configured one
  // (the official client does not pin these to 1.0 / 0.95).
  if (generation.temperature !== undefined) payload.temperature = generation.temperature;
  else delete payload.temperature;
  if (generation.topP !== undefined) payload.top_p = generation.topP;
  else delete payload.top_p;
  // Output cap: an explicit cap (KIMI_MODEL_MAX_COMPLETION_TOKENS / config →
  // generation.maxCompletionTokens) is honored as a hardCap on the request value.
  if (generation.maxCompletionTokens !== undefined) {
    const maxTokensKey =
      ctx.api === "anthropic-messages"
        ? "max_tokens"
        : ctx.api === "openai-responses"
          ? "max_output_tokens"
          : "max_completion_tokens";
    const currentMaxTokens = payload[maxTokensKey];
    payload[maxTokensKey] =
      typeof currentMaxTokens === "number"
        ? Math.min(currentMaxTokens, generation.maxCompletionTokens)
        : generation.maxCompletionTokens;
  }

  // 7. Reasoning effort mapping.
  // Completions/Anthropic: effort lives in thinking / output_config.
  // Responses: pi-ai's native transport uses reasoning.effort; drop the
  // Completions thinking object and clamp effort to the catalog.
  if (ctx.api === "openai-responses") {
    applyResponsesThinking(payload, ctx);
  } else {
    delete payload.reasoning_effort;
    if (ctx.modelConfig.supportsThinkingType === "no") {
      delete payload.thinking;
    }
    const resolvedReasoning = resolveThinkingLevel(ctx);
    if (resolvedReasoning) {
      const mapped = resolveReasoningForLevel(resolvedReasoning, ctx.modelConfig);
      if (mapped) {
        const oldThinking = isRecord(payload.thinking) ? payload.thinking : {};
        const effort = ctx.reasoning
          ? mapped.effort
          : (ctx.modelConfig.defaultEffort ?? mapped.effort);
        const effortSupported =
          effort !== null && ctx.modelConfig.supportEfforts?.includes(effort) === true;
        if (ctx.api === "anthropic-messages" && oldThinking.type === "adaptive") {
          // pi-ai >=0.82 builds adaptive thinking for models carrying
          // compat.forceAdaptiveThinking (streamSimpleKimi sets it on the
          // anthropic runtime model). Keep the adaptive shape — effort lives in
          // top-level output_config there, not inside thinking — and only
          // replace it with an explicit disable when the level maps to off.
          if (mapped.enabled) {
            if (effortSupported) payload.output_config = { effort };
            else delete payload.output_config;
          } else {
            payload.thinking = { type: "disabled" };
            delete payload.output_config;
          }
        } else {
          const thinking: JsonRecord = {
            ...oldThinking,
            type: mapped.enabled ? "enabled" : "disabled",
          };
          delete thinking.effort;
          if (!mapped.enabled) delete thinking.keep;
          if (mapped.enabled && effortSupported) {
            thinking.effort = effort;
          }
          if (mapped.enabled && ctx.modelConfig.thinkingKeep) {
            thinking.keep = ctx.modelConfig.thinkingKeep;
          }
          payload.thinking = thinking;
        }
      }
    }

    // Preserved-thinking Kimi endpoints require every replayed assistant turn to
    // carry reasoning_content, including turns whose reasoning delta was empty.
    // pi-ai drops empty thinking blocks while building Chat Completions history,
    // so restore the explicit empty field after the final thinking mode is known.
    if (
      ctx.api === "openai-completions" &&
      isRecord(payload.thinking) &&
      payload.thinking.type !== "disabled" &&
      payload.thinking.keep === "all" &&
      Array.isArray(payload.messages)
    ) {
      for (const message of payload.messages) {
        if (
          isRecord(message) &&
          message.role === "assistant" &&
          message.reasoning_content === undefined
        ) {
          message.reasoning_content = "";
        }
      }
    }
  }

  // 8. K2.7 Code API constraints: the server rejects tool_choice "required" /
  //    function-specific when thinking is enabled (always-on). Responses only
  //    accepts auto. temperature/top_p are handled in step 6 — omitted unless
  //    explicitly configured, matching the official kimi-code client rather
  //    than pinned to 1.0/0.95.
  if (payload.tool_choice !== undefined) {
    if (ctx.api === "openai-responses") {
      payload.tool_choice = "auto";
    } else {
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
}
