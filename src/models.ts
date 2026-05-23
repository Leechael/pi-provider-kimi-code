// Model identity: discovery against the server's /v1/models endpoint, plus the
// extras-merging helpers used by both the OAuth modifyModels hook and the
// `KIMI_MODEL_*` env-override path.

import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";

import { getBaseUrl } from "./constants.ts";
import { getCommonHeaders } from "./device.ts";

export interface KimiOAuthExtras {
  wireModelId?: string;
  modelDisplay?: string;
  contextLength?: number;
  supportsReasoning?: boolean;
  supportsImageIn?: boolean;
}

export type KimiOAuthCredentials = OAuthCredentials & KimiOAuthExtras;

interface KimiServerModel {
  id?: unknown;
  display_name?: unknown;
  context_length?: unknown;
  supports_reasoning?: unknown;
  supports_image_in?: unknown;
}

export function buildModelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

function getModelsUrl(): string {
  return buildModelsUrl(getBaseUrl());
}

export async function discoverKimiModelMetadata(accessToken: string): Promise<KimiOAuthExtras> {
  if (!accessToken) return {};
  try {
    const response = await fetch(getModelsUrl(), {
      headers: {
        ...getCommonHeaders(),
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return {};
    const json = (await response.json()) as { data?: unknown };
    const list = Array.isArray(json.data) ? (json.data as KimiServerModel[]) : [];
    const preferred =
      list.find((m) => typeof m.id === "string" && m.id === "kimi-for-coding") ?? list[0];
    if (!preferred || typeof preferred.id !== "string") return {};
    const extras: KimiOAuthExtras = { wireModelId: preferred.id };
    if (typeof preferred.display_name === "string") extras.modelDisplay = preferred.display_name;
    if (typeof preferred.context_length === "number" && preferred.context_length > 0) {
      extras.contextLength = preferred.context_length;
    }
    if (typeof preferred.supports_reasoning === "boolean") {
      extras.supportsReasoning = preferred.supports_reasoning;
    }
    if (typeof preferred.supports_image_in === "boolean") {
      extras.supportsImageIn = preferred.supports_image_in;
    }
    return extras;
  } catch {
    return {};
  }
}

export function applyKimiOAuthExtrasToModel(
  model: Model<Api>,
  extras: KimiOAuthExtras,
): Model<Api> {
  const next: Model<Api> & { wireModelId?: string } = { ...model };
  if (typeof extras.modelDisplay === "string" && extras.modelDisplay) {
    next.name = extras.modelDisplay;
  }
  if (typeof extras.contextLength === "number" && extras.contextLength > 0) {
    next.contextWindow = extras.contextLength;
  }
  if (typeof extras.wireModelId === "string" && extras.wireModelId) {
    next.wireModelId = extras.wireModelId;
  }
  if (typeof extras.supportsReasoning === "boolean") {
    next.reasoning = extras.supportsReasoning;
  }
  if (typeof extras.supportsImageIn === "boolean") {
    const input = ["text"];
    if (extras.supportsImageIn) input.push("image");
    (next as unknown as { input: string[] }).input = input;
  }
  return next;
}

function parseKimiModelCapabilities(value: string | undefined): KimiOAuthExtras | null {
  if (!value) return null;
  const caps = new Set(
    value
      .split(",")
      .map((cap) => cap.trim().toLowerCase())
      .filter(Boolean),
  );
  return {
    supportsReasoning: caps.has("thinking") || caps.has("always_thinking"),
    supportsImageIn: caps.has("image_in"),
  };
}

export function applyKimiEnvOverridesToModel(model: Model<Api>): Model<Api> {
  const extras: KimiOAuthExtras = {};
  const modelName = process.env.KIMI_MODEL_NAME?.trim();
  if (modelName) {
    extras.wireModelId = modelName;
    extras.modelDisplay = modelName;
  }

  const maxContextSize = process.env.KIMI_MODEL_MAX_CONTEXT_SIZE?.trim();
  if (maxContextSize) {
    const parsed = parseInt(maxContextSize, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      extras.contextLength = parsed;
    }
  }

  const capabilities = parseKimiModelCapabilities(process.env.KIMI_MODEL_CAPABILITIES);
  if (capabilities) Object.assign(extras, capabilities);

  return applyKimiOAuthExtrasToModel(model, extras);
}
