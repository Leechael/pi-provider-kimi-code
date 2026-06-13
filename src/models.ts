// Model identity: discovery against the server's /v1/models endpoint, plus the
// extras-merging helpers used by both the OAuth modifyModels hook and the
// shared cold-start discovery at provider registration.

import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";

import { getBaseUrl } from "./constants.ts";
import { getCommonHeaders } from "./device.ts";

export interface KimiOAuthExtras {
  wireModelId?: string;
  modelDisplay?: string;
  contextLength?: number;
  supportsReasoning?: boolean;
  supportsImageIn?: boolean;
  supportsVideoIn?: boolean;
  thinkingType?: string;
}

export type KimiOAuthCredentials = OAuthCredentials & KimiOAuthExtras;

interface KimiServerModel {
  id?: unknown;
  display_name?: unknown;
  context_length?: unknown;
  supports_reasoning?: unknown;
  supports_image_in?: unknown;
  supports_video_in?: unknown;
  supports_thinking_type?: unknown;
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
    const preferred = list.find((m) => typeof m.id === "string" && m.id === "kimi-for-coding");
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
    if (typeof preferred.supports_video_in === "boolean") {
      extras.supportsVideoIn = preferred.supports_video_in;
    }
    if (typeof preferred.supports_thinking_type === "string") {
      extras.thinkingType = preferred.supports_thinking_type;
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

  // Build input from server capabilities. Image and video are additive —
  // if the server reports them, they're available regardless of config.input.
  const input = ["text"];
  if (typeof extras.supportsImageIn === "boolean" && extras.supportsImageIn) {
    input.push("image");
  }
  if (typeof extras.supportsVideoIn === "boolean" && extras.supportsVideoIn) {
    input.push("video");
  }
  (next as unknown as { input: string[] }).input = input;

  // Carry resolved config on the model for stream/payload consumption.
  // At this stage only thinkingType comes from the server; the full
  // resolvedConfig (reasoningMap, thinkingKeep, generation) is attached in
  // index.ts at registration time.
  const existing = (model as Model<Api> & { resolvedConfig?: Record<string, unknown> })
    .resolvedConfig;
  (next as Model<Api> & { resolvedConfig?: Record<string, unknown> }).resolvedConfig = {
    ...existing,
    ...(extras.thinkingType !== undefined ? { thinkingType: extras.thinkingType } : {}),
  };

  return next;
}

