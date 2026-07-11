// Module-level constants and env-driven configuration shared across the
// provider's modules. Anything env-dependent that we read once at module load
// time lives here; helpers that need to be evaluated per request go in env.ts
// (not yet split).

import os from "node:os";
import { join } from "node:path";

export const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";

export type KimiWireProtocol = "openai" | "anthropic";

// KIMI_CODE_PROTOCOL supports two values: "openai" (default) and "anthropic".
export const ENV_KIMI_CODE_PROTOCOL: KimiWireProtocol =
  process.env.KIMI_CODE_PROTOCOL === "anthropic" ? "anthropic" : "openai";

export const IS_OPENAI_PROTOCOL = ENV_KIMI_CODE_PROTOCOL === "openai";

export function getApiProtocol(
  protocol: KimiWireProtocol,
): "openai-completions" | "anthropic-messages" {
  return protocol === "openai" ? "openai-completions" : "anthropic-messages";
}

export const PROTOCOL = getApiProtocol(ENV_KIMI_CODE_PROTOCOL);

export function getKimiApiType(
  protocol: KimiWireProtocol,
): "kimi-openai-completions" | "kimi-anthropic-messages" {
  return protocol === "openai" ? "kimi-openai-completions" : "kimi-anthropic-messages";
}

// Use a custom api identifier so this provider never conflicts with the
// built-in "anthropic-messages" or "openai-completions" stream handlers.
export const KIMI_API_TYPE = getKimiApiType(ENV_KIMI_CODE_PROTOCOL);

export function getDefaultBaseUrl(protocol: KimiWireProtocol): string {
  return protocol === "openai" ? "https://api.kimi.com/coding/v1" : "https://api.kimi.com/coding";
}

export const DEFAULT_BASE_URL = getDefaultBaseUrl(ENV_KIMI_CODE_PROTOCOL);

export const PROVIDER_VERSION = "0.6.4";

// Upstream kimi-code CLI version — used in User-Agent and X-Msh-Version
// headers to match the official client's identity. Update this when
// syncing with https://github.com/anthropics/kimi-code.
export const KIMI_UPSTREAM_VERSION = "0.23.4";
export const KIMI_CODE_USER_AGENT = `kimi-code-cli/${KIMI_UPSTREAM_VERSION}`;
export const KIMI_PLATFORM = "kimi_code_cli";

export function getKimiCodeHome(): string {
  const value = process.env.KIMI_CODE_HOME?.trim();
  return value || join(os.homedir(), ".kimi-code");
}

export const DEVICE_ID_PATH = join(getKimiCodeHome(), "device_id");

export const DEFAULT_KIMI_MODEL_INPUT = ["text", "image"] as const;

export const RETRYABLE_REFRESH_STATUSES = new Set([429, 500, 502, 503, 504]);

export const PROVIDER_ID = "kimi-coding";

export function getOAuthHost(): string {
  const value =
    process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || DEFAULT_OAUTH_HOST;
  return value.trim() || DEFAULT_OAUTH_HOST;
}

export function getBaseUrl(protocol: KimiWireProtocol = ENV_KIMI_CODE_PROTOCOL): string {
  const defaultBaseUrl = getDefaultBaseUrl(protocol);
  const value = process.env.KIMI_CODE_BASE_URL || process.env.KIMI_BASE_URL || defaultBaseUrl;
  return value.trim() || defaultBaseUrl;
}
