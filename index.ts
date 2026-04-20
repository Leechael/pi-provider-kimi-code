/**
 * Kimi Code Provider Extension
 *
 * Provides access to Kimi models via OAuth device code flow.
 * API endpoint: https://api.kimi.com/coding (Anthropic Messages compatible)
 *
 * Usage:
 *   pi -e ~/workshop/pi-provider-kimi-code
 *   # Then /login kimi-coding, or set KIMI_API_KEY=...
 */

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  AssistantMessageEvent,
  CacheRetention,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
} from "@mariozechner/pi-ai";
import {
  streamSimpleAnthropic,
  streamSimpleOpenAICompletions,
  AssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, OAuthCredential } from "@mariozechner/pi-coding-agent";
import { AuthStorage } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const PROTOCOL =
  process.env.KIMI_CODE_PROTOCOL === "openai" ? "openai-completions" : "anthropic-messages";
const DEFAULT_BASE_URL =
  PROTOCOL === "openai-completions"
    ? "https://api.kimi.com/coding/v1"
    : "https://api.kimi.com/coding";
const KIMI_CLI_VERSION = "1.30.0";
const KIMI_CLI_USER_AGENT = `KimiCLI/${KIMI_CLI_VERSION}`;
const KIMI_PLATFORM = "kimi_cli";
const DEVICE_ID_PATH = join(os.homedir(), ".pi", "providers", "kimi-coding", "device_id");

// =============================================================================
// Device identification
// =============================================================================

function getOAuthHost(): string {
  const value =
    process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || DEFAULT_OAUTH_HOST;
  return value.trim() || DEFAULT_OAUTH_HOST;
}

function getBaseUrl(): string {
  const value = process.env.KIMI_CODE_BASE_URL || DEFAULT_BASE_URL;
  return value.trim() || DEFAULT_BASE_URL;
}

function createDeviceId(): string {
  return randomBytes(16).toString("hex");
}

function ensurePrivateFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Ignore chmod failures on platforms/filesystems that do not support it.
  }
}

function readPersistedDeviceId(): string | null {
  try {
    if (!existsSync(DEVICE_ID_PATH)) return null;
    const deviceId = readFileSync(DEVICE_ID_PATH, "utf8").trim();
    return deviceId || null;
  } catch {
    return null;
  }
}

function persistDeviceId(deviceId: string): void {
  try {
    mkdirSync(dirname(DEVICE_ID_PATH), { recursive: true });
    writeFileSync(DEVICE_ID_PATH, deviceId, "utf8");
    ensurePrivateFile(DEVICE_ID_PATH);
  } catch {
    // Ignore persistence failures and fall back to the in-memory device id.
  }
}

function getMacOSVersion(): string {
  try {
    return execSync("sw_vers -productVersion", { encoding: "utf8" }).trim();
  } catch {
    return os.release();
  }
}

function getDeviceModel(): string {
  const platform = process.platform;
  const arch = os.machine() || process.arch;
  if (platform === "darwin") {
    const version = getMacOSVersion();
    return version && arch ? `macOS ${version} ${arch}` : `macOS ${arch}`;
  }
  if (platform === "win32") {
    const release = os.release();
    return release && arch ? `Windows ${release} ${arch}` : `Windows ${arch}`;
  }
  const release = os.release();
  return release && arch ? `${platform} ${release} ${arch}` : `${platform} ${arch}`;
}

function asciiHeaderValue(value: string, fallback = "unknown"): string {
  const trimmed = value.trim();
  /* oxlint-disable-next-line no-control-regex */
  if (/^[\x00-\x7F]*$/.test(trimmed)) {
    return trimmed;
  }
  /* oxlint-disable-next-line no-control-regex */
  const sanitized = trimmed.replace(/[^\x00-\x7F]/g, "").trim();
  return sanitized || fallback;
}

const DEVICE_MODEL = getDeviceModel();
let DEVICE_ID: string | null = null;

function getStableDeviceId(): string {
  if (DEVICE_ID) {
    return DEVICE_ID;
  }

  const persisted = readPersistedDeviceId();
  if (persisted) {
    DEVICE_ID = persisted;
    return DEVICE_ID;
  }

  DEVICE_ID = createDeviceId();
  persistDeviceId(DEVICE_ID);
  return DEVICE_ID;
}

function getCommonHeaders(): Record<string, string> {
  const headers = {
    "User-Agent": KIMI_CLI_USER_AGENT,
    "X-Msh-Platform": KIMI_PLATFORM,
    "X-Msh-Version": KIMI_CLI_VERSION,
    "X-Msh-Device-Name": os.hostname(),
    "X-Msh-Device-Model": DEVICE_MODEL,
    "X-Msh-Os-Version": os.release(),
    "X-Msh-Device-Id": getStableDeviceId(),
  };
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, asciiHeaderValue(value)]),
  ) as Record<string, string>;
}

// =============================================================================
// OAuth Implementation
// =============================================================================

interface DeviceAuthorization {
  user_code: string;
  device_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

async function requestDeviceAuthorization(): Promise<DeviceAuthorization> {
  const response = await fetch(`${getOAuthHost()}/api/oauth/device_authorization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...getCommonHeaders(),
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Device authorization failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    user_code?: string;
    device_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };

  if (!data.user_code || !data.device_code || !data.verification_uri_complete) {
    throw new Error("Invalid device authorization response");
  }

  return {
    user_code: data.user_code,
    device_code: data.device_code,
    verification_uri: data.verification_uri || "",
    verification_uri_complete: data.verification_uri_complete,
    expires_in: data.expires_in || 1800,
    interval: data.interval || 5,
  };
}

async function requestDeviceToken(auth: DeviceAuthorization): Promise<TokenResponse | null> {
  const response = await fetch(`${getOAuthHost()}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...getCommonHeaders(),
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      device_code: auth.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

  if (response.status === 200) {
    const data = (await response.json()) as TokenResponse;
    if (data.access_token && data.refresh_token) {
      return data;
    }
    throw new Error("Token response missing required fields");
  }

  if (response.status === 400) {
    const data = (await response.json()) as { error?: string; error_description?: string };
    if (data.error === "authorization_pending") {
      return null;
    }
    if (data.error === "expired_token") {
      throw new Error("expired_token");
    }
    throw new Error(`Token request failed: ${data.error_description || data.error || "unknown"}`);
  }

  const text = await response.text().catch(() => "");
  throw new Error(`Token request failed: ${response.status} ${text}`);
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${getOAuthHost()}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...getCommonHeaders(),
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Token refresh unauthorized: ${text}`);
    }
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as TokenResponse;
  if (!data.access_token || !data.refresh_token) {
    throw new Error("Token refresh response missing required fields");
  }

  return data;
}

// =============================================================================
// OAuth login / refresh for extension registration
// =============================================================================

async function loginKimiCode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  // Keep trying until we get a token (handles expired device codes)
  while (true) {
    const auth = await requestDeviceAuthorization();

    callbacks.onAuth({
      url: auth.verification_uri_complete,
      instructions: `Please visit the URL to authorize. Your code: ${auth.user_code}`,
    });

    const interval = Math.max(auth.interval, 1) * 1000;
    const expiresAt = Date.now() + auth.expires_in * 1000;

    let token: TokenResponse | null = null;
    let printedWaiting = false;

    while (Date.now() < expiresAt) {
      try {
        token = await requestDeviceToken(auth);
        if (token) break;
      } catch (error) {
        if (error instanceof Error && error.message === "expired_token") {
          // Device code expired, restart the flow
          if (callbacks.onProgress) {
            callbacks.onProgress("Device code expired, restarting...");
          }
          break;
        }
        throw error;
      }

      if (!printedWaiting) {
        if (callbacks.onProgress) {
          callbacks.onProgress("Waiting for authorization...");
        }
        printedWaiting = true;
      }

      // Check for abort
      if (callbacks.signal?.aborted) {
        throw new Error("Authorization aborted");
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    if (token) {
      return {
        access: token.access_token,
        refresh: token.refresh_token,
        expires: Date.now() + token.expires_in * 1000,
      };
    }

    // If we get here without a token, the device code expired - loop will retry
  }
}

async function refreshKimiCodeToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const token = await refreshAccessToken(credentials.refresh);
  return {
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000,
  };
}

// =============================================================================
// Payload / stream helpers: types + pure utilities
// =============================================================================

const EMPTY_RESPONSE_PREFIX = "(Empty response:";
const DEFAULT_KIMI_INLINE_UPLOAD_THRESHOLD_BYTES = 1 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type Uploader = (mimeType: string, data: string) => Promise<string | null>;

interface KimiEnvOverrides {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

function resolveCacheRetention(value?: CacheRetention): CacheRetention {
  if (value === "none" || value === "short" || value === "long") return value;
  if (process.env.PI_CACHE_RETENTION === "long") return "long";
  return "short";
}

interface KimiPayloadContext {
  api: "anthropic-messages" | "openai-completions";
  upload?: Uploader;
  cacheKey?: string;
  cacheRetention: CacheRetention;
  reasoning?: ThinkingLevel;
  envOverrides: KimiEnvOverrides;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapThinkingLevel(level?: string): { effort: string | null; enabled: boolean } | undefined {
  if (!level) return undefined;
  if (level === "none" || level === "off") return { effort: null, enabled: false };
  if (level === "minimal" || level === "low") return { effort: "low", enabled: true };
  if (level === "medium") return { effort: "medium", enabled: true };
  if (level === "high" || level === "xhigh") return { effort: "high", enabled: true };
  return undefined;
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
    "video/mp4": "upload.mp4",
    "video/quicktime": "upload.mov",
  };
  return map[mimeType] ?? (mimeType.startsWith("video/") ? "upload.mp4" : "upload.bin");
}

function readEnvOverrides(): KimiEnvOverrides {
  const out: KimiEnvOverrides = {};
  const temp = process.env.KIMI_MODEL_TEMPERATURE;
  if (temp) out.temperature = parseFloat(temp);
  const topP = process.env.KIMI_MODEL_TOP_P;
  if (topP) out.topP = parseFloat(topP);
  const maxTokens = process.env.KIMI_MODEL_MAX_TOKENS;
  if (maxTokens) out.maxTokens = parseInt(maxTokens, 10);
  return out;
}

// =============================================================================
// File upload (I/O edge)
// =============================================================================

async function uploadKimiFile(
  apiKey: string,
  mimeType: string,
  data: string,
): Promise<string | null> {
  const buffer = Buffer.from(data, "base64");
  const isVideo = mimeType.startsWith("video/");
  const threshold = parseInlineUploadThreshold(process.env.KIMI_CODE_UPLOAD_THRESHOLD_BYTES);
  if (!isVideo && buffer.length <= threshold) return null;

  const filename = getUploadFilename(mimeType);
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimeType }), filename);
  formData.append("purpose", isVideo ? "video" : "image");

  const baseUrl = process.env.KIMI_CODE_BASE_URL || DEFAULT_BASE_URL;
  const uploadUrl = `${deriveFilesBaseUrl(baseUrl)}/files`;
  const debug = process.env.KIMI_CODE_DEBUG === "1";
  if (debug) {
    console.log(
      `\n[kimi-coding] Uploading ${filename} to ${uploadUrl} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`,
    );
  }

  try {
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, ...getCommonHeaders() },
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
// =============================================================================
// These walk the provider-specific payload shape and replace inline base64
// image/video blocks with ms:// references returned by the injected uploader.
// They take an Uploader rather than an apiKey so they can be unit-tested with
// a fake uploader; all network I/O stays behind that boundary.

async function transformOpenAIPayloadFiles(payload: JsonRecord, upload: Uploader): Promise<void> {
  if (!Array.isArray(payload.messages)) return;
  const cache = new Map<string, string>();

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

      const uploaded = cache.get(urlValue) ?? (await upload(parsed.mimeType, parsed.data));
      if (!uploaded) continue;
      cache.set(urlValue, uploaded);

      block[key] =
        typeof field === "string" ? uploaded : { ...(field as JsonRecord), url: uploaded };
    }
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
// =============================================================================
// Applies all Kimi-specific mutations to a provider payload in place.
// Pure given its context: no process.env / fs / network access of its own —
// every side effect enters via ctx.upload or pre-read values in ctx.
// This makes the five steps below testable with fixture payloads.

async function applyKimiPayloadMutations(
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

  // 4. Env-level hyperparameter overrides (pre-parsed into numbers by caller).
  const { temperature, topP, maxTokens } = ctx.envOverrides;
  if (temperature !== undefined) payload.temperature = temperature;
  if (topP !== undefined) payload.top_p = topP;
  if (maxTokens !== undefined) payload.max_tokens = maxTokens;

  // 5. Reasoning effort mapping.
  if (ctx.reasoning) {
    const mapped = mapThinkingLevel(ctx.reasoning);
    if (mapped) {
      payload.reasoning_effort = mapped.effort;
      const extraBody = isRecord(payload.extra_body) ? payload.extra_body : {};
      extraBody.thinking = { type: mapped.enabled ? "enabled" : "disabled" };
      payload.extra_body = extraBody;
    }
  }
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

async function* filterEmptyResponseStream(
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
// Auth refresh: recover from server-side token invalidation
// =============================================================================
// pi-coding-agent only refreshes an OAuth token when the locally cached
// `expires` is in the past. If the server rotates/revokes the access token
// before that (common with short-lived session tokens), every request keeps
// returning 401. We detect that situation by inspecting the first event of
// the upstream stream, force a refresh through AuthStorage (which persists
// the new credentials under a file lock), and retry once.

const PROVIDER_ID = "kimi-coding";

async function refreshKimiAuthToken(currentKey: string): Promise<string | null> {
  try {
    const storage = AuthStorage.create();
    const cred = storage.get(PROVIDER_ID);
    if (!cred || cred.type !== "oauth") {
      console.error(
        `[kimi-coding] auth refresh skipped: no OAuth credentials for ${PROVIDER_ID} on disk`,
      );
      return null;
    }

    // If disk already has a different valid token (e.g., another process or a
    // previous retry refreshed it while the caller's in-memory cache went
    // stale), reuse it without hitting the OAuth endpoint.
    if (cred.access !== currentKey && Date.now() < cred.expires) {
      console.error("[kimi-coding] auth refresh: reusing newer on-disk token");
      return cred.access;
    }

    console.error("[kimi-coding] auth refresh: requesting new access token");
    const refreshed = await refreshAccessToken(cred.refresh);
    const newCred: OAuthCredential = {
      type: "oauth",
      access: refreshed.access_token,
      refresh: refreshed.refresh_token,
      expires: Date.now() + refreshed.expires_in * 1000,
    };
    storage.set(PROVIDER_ID, newCred);
    console.error("[kimi-coding] auth refresh: new token persisted");
    return newCred.access;
  } catch (err) {
    console.error("[kimi-coding] auth refresh failed:", err);
    return null;
  }
}

// =============================================================================
// Stream wrapper: orchestrates payload mutation + event filter
// =============================================================================
// Reads every side-effect source (process.env, options, apiKey) at the top
// and hands a plain KimiPayloadContext to applyKimiPayloadMutations. The only
// thing this function itself "does" is wire SDK streaming + filter + error
// fallback; the actual logic lives in the pure units above.

function streamSimpleKimi(
  model: Model<"anthropic-messages" | "openai-completions">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const filtered = new AssistantMessageEventStream();
  const initialKey = options?.apiKey || process.env.KIMI_API_KEY || "";

  const cacheKeyOverride = (
    options as (SimpleStreamOptions & { prompt_cache_key?: unknown }) | undefined
  )?.prompt_cache_key;
  const cacheKey = (typeof cacheKeyOverride === "string" && cacheKeyOverride) || options?.sessionId;
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const envOverrides = readEnvOverrides();
  const originalOnPayload = options?.onPayload;

  const buildPatchedOptions = (apiKey: string): SimpleStreamOptions => {
    const upload: Uploader | undefined = apiKey
      ? (mimeType, data) => uploadKimiFile(apiKey, mimeType, data)
      : undefined;
    return {
      ...options,
      apiKey,
      onPayload: async (payload, modelData) => {
        let nextPayload: unknown = payload;

        if (isRecord(nextPayload)) {
          await applyKimiPayloadMutations(nextPayload, {
            api: model.api,
            upload,
            cacheKey,
            cacheRetention,
            reasoning: options?.reasoning,
            envOverrides,
          });
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
      const upstream =
        model.api === "openai-completions"
          ? streamSimpleOpenAICompletions(
              model as Model<"openai-completions">,
              context,
              patchedOptions,
            )
          : streamSimpleAnthropic(model as Model<"anthropic-messages">, context, patchedOptions);

      let pushedAny = false;
      let shouldRetry = false;

      try {
        for await (const event of filterEmptyResponseStream(upstream)) {
          // If the upstream terminates with an error before we've emitted
          // anything downstream, speculatively try an OAuth refresh and
          // retry once. This handles the common case of a server-side token
          // invalidation before the local `expires` lapses, without having
          // to pattern-match every possible error-message format.
          //
          // Non-auth errors (overflow, network, rate-limit, etc.) still
          // trigger one wasted refresh, but the retried request fails the
          // same way and we forward it — pi-coding-agent's own recovery
          // paths (compaction, retry) take over from there.
          if (!pushedAny && attempt === 0 && event.type === "error") {
            console.error(
              `[kimi-coding] upstream error on first event, attempting refresh: ${event.error?.errorMessage?.slice(0, 200)}`,
            );
            const refreshed = await refreshKimiAuthToken(currentKey);
            if (refreshed && refreshed !== currentKey) {
              console.error("[kimi-coding] retrying stream with refreshed token");
              currentKey = refreshed;
              shouldRetry = true;
              break;
            }
            console.error(
              "[kimi-coding] refresh did not yield a new token, forwarding original error",
            );
          }
          filtered.push(event);
          pushedAny = true;
        }
      } catch (err) {
        console.error("[kimi-coding] stream error:", err);
        filtered.push({
          type: "error",
          reason: "error",
          error: {
            content: [],
            stopReason: "error",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          },
        } as AssistantMessageEvent & { type: "error" });
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

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerProvider("kimi-coding", {
    baseUrl: getBaseUrl(),
    apiKey: "KIMI_API_KEY",
    api: PROTOCOL,
    streamSimple: streamSimpleKimi,

    headers: getCommonHeaders(),

    models: [
      {
        id: "kimi-for-coding",
        name: "Kimi for Coding",
        reasoning: true,
        input: ["text", "image", "video"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32000,
      },
      {
        id: "kimi-k2.6-code-preview",
        name: "Kimi K2.6 Code Preview",
        reasoning: true,
        input: ["text", "image", "video"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32000,
      },
      {
        id: "kimi-code",
        name: "Kimi Code (kimi-k2.5)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32000,
      },
      {
        id: "kimi-k2.5",
        name: "Kimi K2.5",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32000,
      },
      {
        id: "kimi-k2-thinking-turbo",
        name: "Kimi K2 Thinking Turbo",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32000,
      },
    ],

    oauth: {
      name: "Kimi Code (OAuth)",
      login: loginKimiCode,
      refreshToken: refreshKimiCodeToken,
      getApiKey: (cred) => cred.access,
    },
  });
}
