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
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import {
  streamSimpleAnthropic,
  streamSimpleOpenAICompletions,
  AssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
// Stream wrapper: strip "(Empty response: ...)" text blocks from Kimi API
// =============================================================================
// The Kimi API wraps thinking-only responses (no text content) into a text
// block like: (Empty response: {'content': [{'type': 'thinking', ...}]})
// This leaks internal state to the user. We detect and suppress such blocks.

const EMPTY_RESPONSE_PREFIX = "(Empty response:";

function mapThinkingLevel(level?: string): { effort: string | null; enabled: boolean } | undefined {
  if (!level) return undefined;
  if (level === "none" || level === "off") return { effort: null, enabled: false };
  if (level === "minimal" || level === "low") return { effort: "low", enabled: true };
  if (level === "medium") return { effort: "medium", enabled: true };
  if (level === "high" || level === "xhigh") return { effort: "high", enabled: true };
  return undefined;
}

const DEFAULT_KIMI_INLINE_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getInlineUploadThresholdBytes(): number {
  const parsed = Number.parseInt(process.env.KIMI_CODE_UPLOAD_THRESHOLD_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_KIMI_INLINE_UPLOAD_THRESHOLD_BYTES;
}

function getFilesBaseUrl(): string {
  const base = (process.env.KIMI_CODE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
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

async function uploadKimiFile(
  apiKey: string,
  mimeType: string,
  data: string,
): Promise<string | null> {
  const buffer = Buffer.from(data, "base64");
  const isVideo = mimeType.startsWith("video/");
  if (!isVideo && buffer.length <= getInlineUploadThresholdBytes()) return null;

  const filename = getUploadFilename(mimeType);
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimeType }), filename);
  formData.append("purpose", isVideo ? "video" : "image");

  const uploadUrl = `${getFilesBaseUrl()}/files`;
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

async function transformOpenAIPayloadFiles(payload: JsonRecord, apiKey: string): Promise<void> {
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

      const uploaded =
        cache.get(urlValue) ?? (await uploadKimiFile(apiKey, parsed.mimeType, parsed.data));
      if (!uploaded) continue;
      cache.set(urlValue, uploaded);

      block[key] =
        typeof field === "string" ? uploaded : { ...(field as JsonRecord), url: uploaded };
    }
  }
}

async function transformAnthropicPayloadFiles(payload: JsonRecord, apiKey: string): Promise<void> {
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
    const uploaded = cache.get(cacheKey) ?? (await uploadKimiFile(apiKey, mediaType, data));
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

function streamSimpleKimi(
  model: Model<"anthropic-messages" | "openai-completions">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const filtered = new AssistantMessageEventStream();
  const apiKey = options?.apiKey || process.env.KIMI_API_KEY || "";

  void (async () => {
    // Intercept the payload to inject Kimi's proprietary prompt_cache_key
    // because Kimi's Anthropic compatibility endpoint requires it alongside cache_control.
    const originalOnPayload = options?.onPayload;
    const cacheKeyOverride = (
      options as (SimpleStreamOptions & { prompt_cache_key?: unknown }) | undefined
    )?.prompt_cache_key;
    const patchedOptions: SimpleStreamOptions = {
      ...options,
      onPayload: async (payload, modelData) => {
        let nextPayload: unknown = payload;

        if (isRecord(nextPayload)) {
          // Map unsupported roles: Kimi does not recognize "developer" (OpenAI-specific).
          if (Array.isArray(nextPayload.messages)) {
            nextPayload.messages = nextPayload.messages.map((msg) =>
              isRecord(msg) && msg.role === "developer" ? { ...msg, role: "system" } : msg,
            );
          }

          if (apiKey) {
            if (model.api === "openai-completions") {
              await transformOpenAIPayloadFiles(nextPayload, apiKey);
            } else if (model.api === "anthropic-messages") {
              await transformAnthropicPayloadFiles(nextPayload, apiKey);
            }
          }

          // Inject prompt_cache_key: allow explicit override, fallback to stable sessionId.
          const existing = nextPayload.prompt_cache_key;
          const cacheKey =
            (typeof existing === "string" && existing) ||
            (typeof cacheKeyOverride === "string" && cacheKeyOverride) ||
            options?.sessionId;
          if (cacheKey) nextPayload.prompt_cache_key = cacheKey;

          // Environment overrides
          const envTemp = process.env.KIMI_MODEL_TEMPERATURE;
          if (envTemp) nextPayload.temperature = parseFloat(envTemp);

          const envTopP = process.env.KIMI_MODEL_TOP_P;
          if (envTopP) nextPayload.top_p = parseFloat(envTopP);

          const envMaxTokens = process.env.KIMI_MODEL_MAX_TOKENS;
          if (envMaxTokens) nextPayload.max_tokens = parseInt(envMaxTokens, 10);

          // Reasoning effort mapping
          if (options?.reasoning) {
            const mapped = mapThinkingLevel(options.reasoning);
            if (mapped) {
              nextPayload.reasoning_effort = mapped.effort;
              const extraBody = isRecord(nextPayload.extra_body) ? nextPayload.extra_body : {};
              extraBody.thinking = { type: mapped.enabled ? "enabled" : "disabled" };
              nextPayload.extra_body = extraBody;
            }
          }
        }

        if (originalOnPayload) {
          const res = await originalOnPayload(nextPayload, modelData);
          if (res !== undefined) nextPayload = res;
        }

        return nextPayload;
      },
    };

    const upstream =
      model.api === "openai-completions"
        ? streamSimpleOpenAICompletions(
            model as Model<"openai-completions">,
            context,
            patchedOptions,
          )
        : streamSimpleAnthropic(model as Model<"anthropic-messages">, context, patchedOptions);

    // Buffer text block events so we can suppress the entire block if it
    // turns out to be a Kimi "(Empty response: ...)" wrapper.
    const suppressedIndices = new Set<number>();
    let textBuffer: AssistantMessageEvent[] = [];
    let bufferingIndex: number | null = null;

    try {
      for await (const event of upstream) {
        // Start buffering when a new text block begins
        if (event.type === "text_start") {
          bufferingIndex = event.contentIndex;
          textBuffer = [event];
          continue;
        }

        // Accumulate text deltas while buffering
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
              // Suppress entire text block — discard buffered events.
              // Do NOT splice content array: it is a shared reference
              // into session state, and mutating it shifts subsequent
              // contentIndex values, corrupting the stream.
              suppressedIndices.add(bufferingIndex);
            } else {
              // Legitimate text block — flush buffer + end event
              for (const buffered of textBuffer) filtered.push(buffered);
              filtered.push(event);
            }
            textBuffer = [];
            bufferingIndex = null;
            continue;
          }
        }

        // Skip events for already-suppressed indices
        if ("contentIndex" in event && suppressedIndices.has(event.contentIndex)) {
          continue;
        }

        // Clean suppressed blocks from the final message
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

        filtered.push(event);
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
        id: "kimi-code",
        name: "Kimi Code (powered by kimi-k2.5)",
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
