// Module-level constants and env-driven configuration shared across the
// provider's modules. Anything env-dependent that we read once at module load
// time lives here; helpers that need to be evaluated per request go in env.ts
// (not yet split).

import os from "node:os";
import { join } from "node:path";

export const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

// Region profiles mirror upstream kimi-code's packages/oauth region.ts: a
// region is a bundle of the managed API base origin and the OAuth host. The
// region only picks the DEFAULT endpoints — explicit env overrides
// (KIMI_CODE_BASE_URL / KIMI_CODE_OAUTH_HOST) always win. Global users with
// kimi.ai credentials otherwise hit 401s against the hardcoded .com defaults
// (issue #77).
export type KimiRegion = "mainland-cn" | "global";

export const KIMI_REGION_PROFILES: Record<KimiRegion, { apiBase: string; oauthHost: string }> = {
  "mainland-cn": { apiBase: "https://api.kimi.com", oauthHost: "https://auth.kimi.com" },
  global: { apiBase: "https://api.kimi.ai", oauthHost: "https://auth.kimi.ai" },
};

export function parseKimiRegion(value: string | undefined): KimiRegion {
  if (value === "global" || value === "mainland-cn") return value;
  return "mainland-cn";
}

export const ENV_KIMI_CODE_REGION: KimiRegion = parseKimiRegion(process.env.KIMI_CODE_REGION);

// Bridge the selected region into pi core's built-in Kimi OAuth: pi-ai reads
// KIMI_CODE_OAUTH_HOST at call time, so filling it makes /login follow
// KIMI_CODE_REGION even when the login runs through pi's own kimi-coding auth
// path instead of this extension's. Only fills the variable when the region
// is non-default and the user has not configured an explicit override.
export function applyKimiRegionEnvBridge(
  env: NodeJS.ProcessEnv = process.env,
  region: KimiRegion = ENV_KIMI_CODE_REGION,
): boolean {
  if (region === "mainland-cn") return false;
  if (env.KIMI_CODE_OAUTH_HOST || env.KIMI_OAUTH_HOST) return false;
  env.KIMI_CODE_OAUTH_HOST = KIMI_REGION_PROFILES[region].oauthHost;
  return true;
}

export const DEFAULT_OAUTH_HOST = KIMI_REGION_PROFILES[ENV_KIMI_CODE_REGION].oauthHost;

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

export function getDefaultBaseUrl(
  protocol: KimiWireProtocol,
  region: KimiRegion = ENV_KIMI_CODE_REGION,
): string {
  const apiBase = KIMI_REGION_PROFILES[region].apiBase;
  return protocol === "anthropic" ? `${apiBase}/coding` : `${apiBase}/coding/v1`;
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
