// Model identity: discovery against the server's /v1/models endpoint, plus the
// extras-merging helpers used by both registration and the OAuth modifyModels hook.

import type { Api, Model, OAuthCredentials, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type {
  KimiInputModality,
  KimiResolvedModelConfig,
  ModelConfig,
  ModelReasoningMap,
} from "./config.ts";

import { type KimiWireProtocol, getBaseUrl } from "./constants.ts";
import { getKimiProviderHeaders } from "./device.ts";

export interface KimiModelMetadata {
  wireModelId?: string;
  modelDisplay?: string;
  contextLength?: number;
  supportsReasoning?: boolean;
  supportsImageIn?: boolean;
  supportsVideoIn?: boolean;
  supportsThinkingType?: "only" | "no" | "both";
  protocol?: KimiWireProtocol;
  supportEfforts?: string[];
  defaultEffort?: string;
}

export interface KimiOAuthExtras extends KimiModelMetadata {
  modelCatalog?: Record<string, KimiModelMetadata>;
  modelCatalogVersion?: number;
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
export const KIMI_K3_MODEL_ID = "k3";
export const KIMI_MODEL_CATALOG_VERSION = 1;

const KIMI_K3_MODERATO_CONTEXT_WINDOW = 262144;
const KIMI_MEMBERSHIP_RANK: Readonly<Record<string, number>> = {
  LEVEL_FREE: 0,
  LEVEL_BASIC: 1,
  LEVEL_STANDARD: 2,
  LEVEL_INTERMEDIATE: 3,
  LEVEL_ADVANCED: 4,
  LEVEL_PREMIUM: 5,
};
const KIMI_MODERATO_RANK = KIMI_MEMBERSHIP_RANK.LEVEL_STANDARD;
const KIMI_ALLEGRETTO_RANK = KIMI_MEMBERSHIP_RANK.LEVEL_INTERMEDIATE;

export function isKimiModelAvailableForMembership(
  modelId: string,
  membershipLevel: string | null | undefined,
): boolean | undefined {
  if (!membershipLevel) return undefined;
  const rank = KIMI_MEMBERSHIP_RANK[membershipLevel];
  if (rank === undefined) return undefined;
  if (modelId === KIMI_K3_MODEL_ID) return rank >= KIMI_MODERATO_RANK;
  if (modelId === KIMI_CODING_HIGHSPEED_MODEL_ID) return rank >= KIMI_ALLEGRETTO_RANK;
  return true;
}

export function applyKimiMembershipLimitsToModel(
  model: Model<Api>,
  membershipLevel: string | null | undefined,
): Model<Api> {
  const rank = membershipLevel ? KIMI_MEMBERSHIP_RANK[membershipLevel] : undefined;
  if (model.id !== KIMI_K3_MODEL_ID || rank === undefined || rank >= KIMI_ALLEGRETTO_RANK) {
    return model;
  }
  return {
    ...model,
    contextWindow: Math.min(model.contextWindow, KIMI_K3_MODERATO_CONTEXT_WINDOW),
  };
}

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
  const name =
    modelId === KIMI_K3_MODEL_ID
      ? "Kimi K3"
      : isHighSpeed
        ? "Kimi for Coding High Speed"
        : "Kimi for Coding";
  return {
    id: modelId,
    name,
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
  if (extras.supportEfforts) resolved.supportEfforts = [...extras.supportEfforts];
  if (extras.defaultEffort) resolved.defaultEffort = extras.defaultEffort;
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
  protocol?: unknown;
  think_efforts?: unknown;
}

function parseSupportsThinkingType(value: unknown): "only" | "no" | "both" | undefined {
  if (value === "only" || value === "no" || value === "both") return value;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseThinkEfforts(value: unknown): {
  supportEfforts?: string[];
  defaultEffort?: string;
} {
  if (!isRecord(value) || value.support !== true) return {};
  const validEfforts = Array.isArray(value.valid_efforts)
    ? value.valid_efforts.filter(
        (effort): effort is string => typeof effort === "string" && !!effort,
      )
    : [];
  return {
    ...(validEfforts.length > 0 ? { supportEfforts: validEfforts } : {}),
    ...(typeof value.default_effort === "string" && value.default_effort
      ? { defaultEffort: value.default_effort }
      : {}),
  };
}

function parseKimiModelMetadata(model: KimiServerModel): KimiModelMetadata | undefined {
  if (typeof model.id !== "string" || !model.id) return undefined;
  const metadata: KimiModelMetadata = { wireModelId: model.id };
  if (typeof model.display_name === "string") metadata.modelDisplay = model.display_name;
  if (typeof model.context_length === "number" && model.context_length > 0) {
    metadata.contextLength = model.context_length;
  }
  const thinkingType = parseSupportsThinkingType(model.supports_thinking_type);
  if (thinkingType) {
    metadata.supportsThinkingType = thinkingType;
  } else if (typeof model.supports_reasoning === "boolean") {
    metadata.supportsReasoning = model.supports_reasoning;
  }
  if (typeof model.supports_image_in === "boolean") {
    metadata.supportsImageIn = model.supports_image_in;
  }
  if (typeof model.supports_video_in === "boolean") {
    metadata.supportsVideoIn = model.supports_video_in;
  }
  if (model.protocol === "openai" || model.protocol === "anthropic") {
    metadata.protocol = model.protocol;
  }
  Object.assign(metadata, parseThinkEfforts(model.think_efforts));
  return metadata;
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
        ...getKimiProviderHeaders(),
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return {};
    const json = (await response.json()) as { data?: unknown };
    const list = Array.isArray(json.data) ? (json.data as KimiServerModel[]) : [];
    const supportedIds = new Set([
      KIMI_CODING_MODEL_ID,
      KIMI_CODING_HIGHSPEED_MODEL_ID,
      KIMI_K3_MODEL_ID,
    ]);
    const modelCatalog: Record<string, KimiModelMetadata> = {};
    for (const model of list) {
      if (typeof model.id !== "string" || !supportedIds.has(model.id)) continue;
      const metadata = parseKimiModelMetadata(model);
      if (metadata) modelCatalog[model.id] = metadata;
    }
    const preferred = modelCatalog[KIMI_CODING_MODEL_ID];
    if (!preferred) {
      return Object.keys(modelCatalog).length > 0
        ? { modelCatalog, modelCatalogVersion: KIMI_MODEL_CATALOG_VERSION }
        : {};
    }
    return { ...preferred, modelCatalog, modelCatalogVersion: KIMI_MODEL_CATALOG_VERSION };
  } catch {
    return {};
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function getKimiModelMetadata(extras: KimiOAuthExtras, modelId: string): KimiModelMetadata {
  const discovered = extras.modelCatalog?.[modelId];
  if (discovered) return discovered;
  return modelId === KIMI_CODING_MODEL_ID ? extras : {};
}

// pi-ai's thinking-level selector only offers xhigh/max when the model sets
// an explicit thinkingLevelMap entry, and hides levels mapped to null. Derive
// the map from the configured reasoningMap, restricted to the efforts the
// server advertised for this model, so the selector exposes exactly the levels
// the account can use (K3 advertises [low, high, max] → minimal..max).
// Returns undefined when the server advertised no effort control, preserving
// pi's default level set (off..high) for those models.
export function buildKimiThinkingLevelMap(
  reasoningMap: ModelReasoningMap,
  extras: Pick<KimiModelMetadata, "supportEfforts" | "supportsThinkingType">,
): ThinkingLevelMap | undefined {
  if (!extras.supportEfforts || extras.supportEfforts.length === 0) return undefined;
  const map: ThinkingLevelMap = {};
  // Thinking-only models cannot disable reasoning; everything else keeps off.
  map.off = extras.supportsThinkingType === "only" ? null : "off";
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const entry = reasoningMap[level];
    const effort = entry?.enabled ? entry.effort : null;
    map[level] =
      effort !== null && effort !== undefined && extras.supportEfforts.includes(effort)
        ? effort
        : null;
  }
  return map;
}

// Merges server-discovered extras onto a model. Rebuild-safe: fields derived
// from extras are DELETED when the new extras omit them, because modifyModels
// re-applies this onto previously modified models. Always pass reasoningMap
// (all runtime call sites do) — the 2-arg form exists only for pre-existing
// tests and skips thinkingLevelMap maintenance entirely, including clearing.
export function applyKimiOAuthExtrasToModel(
  model: Model<Api>,
  extras: KimiModelMetadata,
  reasoningMap?: ModelReasoningMap,
): Model<Api> {
  const next: Model<Api> & {
    wireModelId?: string;
    supportsThinkingType?: "only" | "no" | "both";
    wireProtocol?: KimiWireProtocol;
    supportEfforts?: string[];
    defaultEffort?: string;
  } = { ...model };
  if (typeof extras.modelDisplay === "string" && extras.modelDisplay) {
    next.name =
      model.id === KIMI_K3_MODEL_ID && /^k3$/i.test(extras.modelDisplay)
        ? "Kimi K3"
        : extras.modelDisplay;
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
  if (extras.protocol) next.wireProtocol = extras.protocol;
  // Clear on omission: modifyModels re-applies extras onto previously
  // modified models, so a catalog refresh that drops effort control must not
  // retain the stale map/efforts (selector would keep offering — and the
  // payload keep sending — a no-longer-advertised effort like max).
  if (extras.supportEfforts) next.supportEfforts = [...extras.supportEfforts];
  else delete next.supportEfforts;
  if (extras.defaultEffort) next.defaultEffort = extras.defaultEffort;
  else delete next.defaultEffort;
  if (reasoningMap) {
    const thinkingLevelMap = buildKimiThinkingLevelMap(reasoningMap, extras);
    if (thinkingLevelMap) next.thinkingLevelMap = thinkingLevelMap;
    else delete next.thinkingLevelMap;
  }
  return next;
}
