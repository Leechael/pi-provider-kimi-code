// Module-level constants and env-driven configuration shared across the
// provider's modules. Anything env-dependent that we read once at module load
// time lives here; helpers that need to be evaluated per request go in env.ts
// (not yet split).

import os from "node:os";
import { join } from "node:path";

export const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";

export const KIMI_WIRE_PROTOCOLS = ["openai", "anthropic", "responses"] as const;
export type KimiWireProtocol = (typeof KIMI_WIRE_PROTOCOLS)[number];
export type KimiApiProtocol = "openai-completions" | "anthropic-messages" | "openai-responses";
export type KimiApiType =
  | "kimi-openai-completions"
  | "kimi-anthropic-messages"
  | "kimi-openai-responses";

// KIMI_CODE_PROTOCOL supports openai (default), anthropic, and responses.
// Unknown values fall back to openai, matching the previous two-protocol parser.
export function parseKimiWireProtocol(value: string | undefined): KimiWireProtocol {
  if (value === "anthropic" || value === "responses") return value;
  return "openai";
}

export const ENV_KIMI_CODE_PROTOCOL: KimiWireProtocol = parseKimiWireProtocol(
  process.env.KIMI_CODE_PROTOCOL,
);

export const IS_OPENAI_PROTOCOL = ENV_KIMI_CODE_PROTOCOL === "openai";

export function getApiProtocol(protocol: KimiWireProtocol): KimiApiProtocol {
  if (protocol === "anthropic") return "anthropic-messages";
  if (protocol === "responses") return "openai-responses";
  return "openai-completions";
}

export const PROTOCOL = getApiProtocol(ENV_KIMI_CODE_PROTOCOL);

export function getKimiApiType(protocol: KimiWireProtocol): KimiApiType {
  if (protocol === "anthropic") return "kimi-anthropic-messages";
  if (protocol === "responses") return "kimi-openai-responses";
  return "kimi-openai-completions";
}

// Use a custom api identifier so this provider never conflicts with the
// built-in anthropic-messages / openai-completions / openai-responses handlers.
export const KIMI_API_TYPE = getKimiApiType(ENV_KIMI_CODE_PROTOCOL);

export function getDefaultBaseUrl(protocol: KimiWireProtocol): string {
  return protocol === "anthropic"
    ? "https://api.kimi.com/coding"
    : "https://api.kimi.com/coding/v1";
}

export const DEFAULT_BASE_URL = getDefaultBaseUrl(ENV_KIMI_CODE_PROTOCOL);

export const PROVIDER_VERSION = "0.6.12";

export const KIMI_CODE_USER_AGENT = `pi-provider-kimi-code/${PROVIDER_VERSION}`;
export const KIMI_PLATFORM = "pi";

export function getKimiCodeHome(): string {
  const value = process.env.KIMI_CODE_HOME?.trim();
  return value || join(os.homedir(), ".kimi-code");
}

export const DEVICE_ID_PATH = join(getKimiCodeHome(), "device_id");

export const DEFAULT_KIMI_MODEL_INPUT = ["text", "image"] as const;

export const RETRYABLE_REFRESH_STATUSES = new Set([429, 500, 502, 503, 504]);

export const PROVIDER_ID = "kimi-coding";

// Owner tag for the entries this extension adds to pi-ai's global api-provider
// registry, so they can be identified and removed as a group.
export const KIMI_GLOBAL_FALLBACK_SOURCE_ID = "pi-provider-kimi-code-global-fallback";

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
