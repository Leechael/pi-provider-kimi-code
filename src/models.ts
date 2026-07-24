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
  // 401 recovery for runtime callers (extension startup, settings menu).
  // oauth.ts's login/refresh flows must NOT pass this: they call discovery
  // while holding the OAuth lock, and refreshKimiAuthToken would re-enter it.
  refreshAccessToken?: (currentToken: string) => Promise<string | null>;
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

// Pricing per million tokens in USD.
// Sources: https://www.kimi.com/resources/kimi-k2-7-code-pricing
//          https://www.kimi.com/resources/kimi-k3-pricing
const COST_STANDARD = { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0.95 };
const COST_HIGH_SPEED = { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 1.9 };
const COST_K3 = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 };

export const KIMI_CODING_MODEL_ID = "kimi-for-coding";
export const KIMI_CODING_HIGHSPEED_MODEL_ID = "kimi-for-coding-highspeed";
export const KIMI_K3_MODEL_ID = "k3";
export const KIMI_MODEL_CATALOG_VERSION = 1;

function resolveModelCost(
  modelId: string,
  modelDisplay?: string,
): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  if (modelId === KIMI_K3_MODEL_ID) return COST_K3;
  if (modelId === KIMI_CODING_MODEL_ID) return COST_STANDARD;
  if (modelId === KIMI_CODING_HIGHSPEED_MODEL_ID || /high\s*speed/i.test(modelDisplay ?? "")) {
    return COST_HIGH_SPEED;
  }
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
        : modelId === KIMI_CODING_MODEL_ID
          ? "Kimi for Coding"
          : modelId;
  return {
    id: modelId,
    name,
    reasoning: config.reasoning,
    input: [...config.input] as unknown as ("text" | "image" | "video")[],
    cost: { ...resolveModelCost(modelId) },
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

export function isOfficialKimiModelsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://api.kimi.com" && parsed.pathname === "/coding/v1/models";
  } catch {
    return false;
  }
}

export async function discoverKimiModelMetadata(
  accessToken: string,
  protocol?: KimiWireProtocol,
  options: DiscoverKimiModelMetadataOptions = {},
): Promise<KimiOAuthExtras> {
  if (!accessToken) return {};
  const modelsUrl = getModelsUrl(protocol);
  if (!isOfficialKimiModelsUrl(modelsUrl)) return {};
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs).unref() : undefined;
  const requestModels = (token: string) =>
    fetch(modelsUrl, {
      signal: controller.signal,
      headers: {
        ...getKimiProviderHeaders(),
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  try {
    let response = await requestModels(accessToken);
    if (response.status === 401 && options.refreshAccessToken) {
      const refreshed = await options.refreshAccessToken(accessToken);
      if (refreshed && refreshed !== accessToken) {
        response = await requestModels(refreshed);
      }
    }
    if (!response.ok) return {};
    const json = (await response.json()) as { data?: unknown };
    const list = Array.isArray(json.data) ? (json.data as KimiServerModel[]) : [];
    const modelCatalog: Record<string, KimiModelMetadata> = {};
    for (const model of list) {
      const metadata = parseKimiModelMetadata(model);
      if (metadata) modelCatalog[metadata.wireModelId!] = metadata;
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

const KIMI_DISCOVERY_KEYS = [
  "wireModelId",
  "modelDisplay",
  "contextLength",
  "supportsReasoning",
  "supportsImageIn",
  "supportsVideoIn",
  "supportsThinkingType",
  "protocol",
  "supportEfforts",
  "defaultEffort",
  "modelCatalog",
] as const;

// Credentials always carry access/refresh/expires, so discovery presence must
// be checked on the metadata fields themselves. Empty means either a legacy
// pre-discovery credential or a failed discovery during login/refresh.
export function hasKimiModelMetadata(extras: KimiOAuthExtras): boolean {
  return KIMI_DISCOVERY_KEYS.some((key) => extras[key] !== undefined);
}

export function buildKimiThinkingLevelMap(
  reasoningMap: ModelReasoningMap,
  extras: Pick<KimiModelMetadata, "supportEfforts" | "supportsThinkingType">,
): ThinkingLevelMap | undefined {
  if (!extras.supportEfforts?.length) return undefined;
  const map = {
    off: extras.supportsThinkingType === "only" ? null : "off",
  } as ThinkingLevelMap & Record<string, string | null>;
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const entry = reasoningMap[level];
    map[level] =
      entry?.enabled && entry.effort && extras.supportEfforts.includes(entry.effort)
        ? entry.effort
        : null;
  }
  return map;
}

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
    next.cost = resolveModelCost(model.id, extras.modelDisplay);
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
