// Module-level constants and env-driven configuration shared across the
// provider's modules. Anything env-dependent that we read once at module load
// time lives here; helpers that need to be evaluated per request go in env.ts
// (not yet split).

import os from "node:os";
import { join } from "node:path";

export const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";

export const PROTOCOL =
  process.env.KIMI_CODE_PROTOCOL === "openai" ? "openai-completions" : "anthropic-messages";

// Use a custom api identifier so this provider never conflicts with the
// built-in "anthropic-messages" or "openai-completions" stream handlers.
export const KIMI_API_TYPE =
  PROTOCOL === "openai-completions" ? "kimi-openai-completions" : "kimi-anthropic-messages";

export const DEFAULT_BASE_URL =
  PROTOCOL === "openai-completions"
    ? "https://api.kimi.com/coding/v1"
    : "https://api.kimi.com/coding";

export const KIMI_CLI_VERSION = "1.44.0";
export const KIMI_CLI_USER_AGENT = `KimiCLI/${KIMI_CLI_VERSION}`;
export const KIMI_PLATFORM = "kimi_cli";

export const DEVICE_ID_PATH = join(os.homedir(), ".pi", "providers", "kimi-coding", "device_id");

export const DEFAULT_KIMI_MODEL_INPUT = ["text", "image"] as const;

export const RETRYABLE_REFRESH_STATUSES = new Set([429, 500, 502, 503, 504]);

export const PROVIDER_ID = "kimi-coding";

export function getOAuthHost(): string {
  const value =
    process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || DEFAULT_OAUTH_HOST;
  return value.trim() || DEFAULT_OAUTH_HOST;
}

export function getBaseUrl(): string {
  const value = process.env.KIMI_CODE_BASE_URL || process.env.KIMI_BASE_URL || DEFAULT_BASE_URL;
  return value.trim() || DEFAULT_BASE_URL;
}
