// Model identity: discovery against the server's /v1/models endpoint, plus the
// extras-merging helpers used by both registration and the OAuth modifyModels hook.

import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { KimiInputModality, KimiResolvedModelConfig, ModelConfig } from "./config.ts";

import { type KimiWireProtocol, getBaseUrl } from "./constants.ts";
import { getCommonHeaders } from "./device.ts";

export interface KimiOAuthExtras {
  wireModelId?: string;
  modelDisplay?: string;
  contextLength?: number;
  supportsReasoning?: boolean;
  supportsImageIn?: boolean;
  supportsVideoIn?: boolean;
  supportsThinkingType?: "only" | "no" | "both";
}

export type KimiOAuthCredentials = OAuthCredentials & KimiOAuthExtras;

const DEFAULT_DISCOVERY_TIMEOUT_MS = 2500;

export interface DiscoverKimiModelMetadataOptions {
  timeoutMs?: number;
}

function mergeInputModalities(
  input: readonly KimiInputModality[],
  extras: Partial<Pick<KimiOAuthExtras, "supportsImageIn" | "supportsVideoIn">>,
): KimiInputModality[] {
  const next = new Set<KimiInputModality>(input);
  next.add("text");
  if (typeof extras.supportsImageIn === "boolean") {
    if (extras.supportsImageIn) next.add("image");
    else next.delete("image");
  }
  if (typeof extras.supportsVideoIn === "boolean") {
    if (extras.supportsVideoIn) next.add("video");
    else next.delete("video");
  }
  return (["text", "image", "video"] as const).filter((modality) => next.has(modality));
}

// Pricing per million tokens in USD (CNY converted at ~7.25).
// Source: https://platform.kimi.com/docs/pricing/chat-k27-code
const COST_STANDARD = { input: 0.897, output: 3.724, cacheRead: 0.179, cacheWrite: 0.897 };
const COST_HIGH_SPEED = { input: 1.793, output: 7.448, cacheRead: 0.359, cacheWrite: 1.793 };

export const KIMI_CODING_MODEL_ID = "kimi-for-coding";
export const KIMI_CODING_HIGHSPEED_MODEL_ID = "kimi-for-coding-highspeed";

function resolveModelCost(modelDisplay: string | undefined): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  if (modelDisplay && /high\s*speed/i.test(modelDisplay)) return COST_HIGH_SPEED;
  return COST_STANDARD;
}

export function buildKimiModelFromConfig(
  config: ModelConfig,
  modelId = KIMI_CODING_MODEL_ID,
): Model<Api> {
  const isHighSpeed = modelId === KIMI_CODING_HIGHSPEED_MODEL_ID;
  return {
    id: modelId,
    name: isHighSpeed ? "Kimi for Coding High Speed" : "Kimi for Coding",
    reasoning: config.reasoning,
    input: [...config.input] as unknown as ("text" | "image" | "video")[],
    cost: { ...(isHighSpeed ? COST_HIGH_SPEED : COST_STANDARD) },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
  } as Model<Api>;
}

export function resolveKimiModelConfig(
  config: ModelConfig,
  extras: Partial<KimiOAuthExtras>,
): KimiResolvedModelConfig {
  const resolved: KimiResolvedModelConfig = { ...config, input: [...config.input] };
  if (typeof extras.contextLength === "number" && extras.contextLength > 0) {
    resolved.contextWindow = extras.contextLength;
  }
  if (typeof extras.supportsThinkingType === "string") {
    resolved.supportsThinkingType = extras.supportsThinkingType;
    resolved.reasoning = extras.supportsThinkingType !== "no";
  } else if (typeof extras.supportsReasoning === "boolean") {
    resolved.reasoning = extras.supportsReasoning;
  }
  if (typeof extras.supportsImageIn === "boolean" || typeof extras.supportsVideoIn === "boolean") {
    resolved.input = mergeInputModalities(resolved.input, extras);
  }
  return resolved;
}

interface KimiServerModel {
  id?: unknown;
  display_name?: unknown;
  context_length?: unknown;
  supports_reasoning?: unknown;
  supports_image_in?: unknown;
  supports_video_in?: unknown;
  supports_thinking_type?: unknown;
}

function parseSupportsThinkingType(value: unknown): "only" | "no" | "both" | undefined {
  if (value === "only" || value === "no" || value === "both") return value;
  return undefined;
}

export function buildModelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

function getModelsUrl(protocol?: KimiWireProtocol): string {
  return buildModelsUrl(getBaseUrl(protocol));
}

export async function discoverKimiModelMetadata(
  accessToken: string,
  protocol?: KimiWireProtocol,
  options: DiscoverKimiModelMetadataOptions = {},
): Promise<KimiOAuthExtras> {
  if (!accessToken) return {};
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs).unref() : undefined;
  try {
    const response = await fetch(getModelsUrl(protocol), {
      signal: controller.signal,
      headers: {
        ...getCommonHeaders(),
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return {};
    const json = (await response.json()) as { data?: unknown };
    const list = Array.isArray(json.data) ? (json.data as KimiServerModel[]) : [];
    const preferred = list.find((m) => typeof m.id === "string" && m.id === KIMI_CODING_MODEL_ID);
    if (!preferred || typeof preferred.id !== "string") return {};
    const extras: KimiOAuthExtras = { wireModelId: preferred.id };
    if (typeof preferred.display_name === "string") extras.modelDisplay = preferred.display_name;
    if (typeof preferred.context_length === "number" && preferred.context_length > 0) {
      extras.contextLength = preferred.context_length;
    }
    const thinkingType = parseSupportsThinkingType(preferred.supports_thinking_type);
    if (thinkingType) {
      extras.supportsThinkingType = thinkingType;
    } else if (typeof preferred.supports_reasoning === "boolean") {
      extras.supportsReasoning = preferred.supports_reasoning;
    }
    if (typeof preferred.supports_image_in === "boolean") {
      extras.supportsImageIn = preferred.supports_image_in;
    }
    if (typeof preferred.supports_video_in === "boolean") {
      extras.supportsVideoIn = preferred.supports_video_in;
    }
    return extras;
  } catch {
    return {};
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function applyKimiOAuthExtrasToModel(
  model: Model<Api>,
  extras: KimiOAuthExtras,
): Model<Api> {
  const next: Model<Api> & { wireModelId?: string; supportsThinkingType?: "only" | "no" | "both" } =
    { ...model };
  if (typeof extras.modelDisplay === "string" && extras.modelDisplay) {
    next.name = extras.modelDisplay;
    next.cost = resolveModelCost(extras.modelDisplay);
  }
  if (typeof extras.contextLength === "number" && extras.contextLength > 0) {
    next.contextWindow = extras.contextLength;
  }
  if (typeof extras.wireModelId === "string" && extras.wireModelId) {
    next.wireModelId = extras.wireModelId;
  }
  if (typeof extras.supportsThinkingType === "string") {
    next.reasoning = extras.supportsThinkingType !== "no";
    next.supportsThinkingType = extras.supportsThinkingType;
  } else if (typeof extras.supportsReasoning === "boolean") {
    next.reasoning = extras.supportsReasoning;
    next.supportsThinkingType = undefined;
  }
  if (typeof extras.supportsImageIn === "boolean" || typeof extras.supportsVideoIn === "boolean") {
    const input = mergeInputModalities(next.input as KimiInputModality[], extras);
    (next as unknown as { input: string[] }).input = input;
  }
  return next;
}
