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
const KIMI_CLI_VERSION = "1.28.0";
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

function getDeviceModel(): string {
  const platform = process.platform;
  const arch = os.machine() || process.arch;
  const release = os.release();
  if (platform === "darwin") {
    return release && arch ? `macOS ${release} ${arch}` : `macOS ${arch}`;
  }
  if (platform === "win32") {
    return release && arch ? `Windows ${release} ${arch}` : `Windows ${arch}`;
  }
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

function mapThinkingLevel(level?: string): string | undefined {
  if (!level) return undefined;
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium") return "medium";
  if (level === "high" || level === "xhigh") return "high";
  return undefined;
}

async function transformContextFiles(context: Context, apiKey: string): Promise<Context> {
  const transformedMessages = [];
  for (const message of context.messages) {
    if (message.role === "user" && Array.isArray(message.content)) {
      const newContent = [];
      for (const block of message.content) {
        if (block.type === "image") {
          // If the image is extremely large or if it's actually a video masquerading as an image,
          // upload it to Kimi's /v1/files endpoint.
          // For Kimi, images > 5MB or videos should be uploaded. We'll use 5MB threshold.
          const buffer = Buffer.from(block.data, "base64");
          if (buffer.length > 5 * 1024 * 1024 || block.mimeType.startsWith("video/")) {
            const formData = new FormData();
            const filename = block.mimeType.startsWith("video/") ? "upload.mp4" : "upload.png";
            formData.append("file", new Blob([buffer], { type: block.mimeType }), filename);
            formData.append(
              "purpose",
              block.mimeType.startsWith("video/") ? "video" : "file-extract",
            );

            const uploadUrl = "https://api.kimi.com/coding/v1/files";
            if (process.env.KIMI_CODE_DEBUG === "1") {
              console.log(
                `\n[kimi-coding] Uploading ${filename} to ${uploadUrl} (size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB)...`,
              );
            }
            const response = await fetch(uploadUrl, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "x-api-key": apiKey,
                ...getCommonHeaders(),
              },
              body: formData,
            });

            if (response.ok) {
              const fileObj = (await response.json()) as any;
              if (process.env.KIMI_CODE_DEBUG === "1") {
                console.log(
                  `[kimi-coding] Upload success. File ID/URL: ${fileObj.url || fileObj.id}`,
                );
              }
              // Replace the block with Kimi's specific reference
              if (block.mimeType.startsWith("video/")) {
                newContent.push({
                  type: "video_url" as any,
                  video_url: { url: fileObj.url || fileObj.id },
                });
              } else {
                newContent.push({
                  type: "file_url" as any,
                  file_url: { url: fileObj.url || fileObj.id },
                });
              }
              continue;
            } else {
              console.error("Failed to upload file to Kimi API", await response.text());
            }
          }
        }
        newContent.push(block);
      }
      transformedMessages.push({ ...message, content: newContent });
    } else {
      transformedMessages.push(message);
    }
  }
  return { ...context, messages: transformedMessages };
}

function streamSimpleKimi(
  model: Model<"anthropic-messages" | "openai-completions">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  // Pre-process context files: upload large images/videos to Kimi API
  const filtered = new AssistantMessageEventStream();
  const apiKey = options?.apiKey || process.env.KIMI_API_KEY || "";

  void (async () => {
    let finalContext = context;
    try {
      if (apiKey) {
        finalContext = await transformContextFiles(context, apiKey);
      }
    } catch (e) {
      console.error("Error transforming context files", e);
    }

    // Intercept the payload to inject Kimi's proprietary prompt_cache_key
    // because Kimi's Anthropic compatibility endpoint requires it alongside cache_control.
    const originalOnPayload = options?.onPayload;
    const patchedOptions: SimpleStreamOptions = {
      ...options,
      onPayload: async (payload: any, modelData) => {
        let nextPayload = payload;
        if (originalOnPayload) {
          const res = await originalOnPayload(payload, modelData);
          if (res !== undefined) nextPayload = res;
        }

        // Inject prompt_cache_key to fulfill Kimi's dual-lock cache requirement.
        // Allow explicit override via payload or options. Fallback to stable sessionId.
        if (nextPayload && typeof nextPayload === "object") {
          const cacheKey =
            nextPayload.prompt_cache_key ||
            (options as any)?.prompt_cache_key ||
            options?.sessionId;
          if (cacheKey) {
            nextPayload = { ...nextPayload, prompt_cache_key: cacheKey };
          }

          // Environment overrides
          const envTemp = process.env.KIMI_MODEL_TEMPERATURE;
          if (envTemp) nextPayload.temperature = parseFloat(envTemp);

          const envTopP = process.env.KIMI_MODEL_TOP_P;
          if (envTopP) nextPayload.top_p = parseFloat(envTopP);

          const envMaxTokens = process.env.KIMI_MODEL_MAX_TOKENS;
          if (envMaxTokens) nextPayload.max_tokens = parseInt(envMaxTokens, 10);

          // Reasoning effort mapping
          const reasoningLevel = (options as any)?.reasoning;
          if (reasoningLevel) {
            const mappedEffort = mapThinkingLevel(reasoningLevel);
            if (mappedEffort) {
              nextPayload.reasoning_effort = mappedEffort;
              nextPayload.extra_body = nextPayload.extra_body || {};
              nextPayload.extra_body.thinking = { type: "enabled" };
            }
          }
        }
        return nextPayload;
      },
    };

    const upstream =
      model.api === "openai-completions"
        ? streamSimpleOpenAICompletions(model as any, finalContext, patchedOptions)
        : streamSimpleAnthropic(model as any, finalContext, patchedOptions);

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
    } catch {
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
        maxTokens: 32768,
      },
      {
        id: "kimi-k2.5",
        name: "Kimi K2.5",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
      },
      {
        id: "kimi-k2-thinking-turbo",
        name: "Kimi K2 Thinking Turbo",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
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
