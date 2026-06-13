// Configuration for the Kimi Code provider. Two-tier JSON file lookup
// (home + project, deep-merge project-over-home). Files live under
// .pi/providers/kimi-coding/config.json — each provider owns its directory.
// The schema covers:
//   - model:    Capability fallbacks + user-adjustable knobs (maxTokens,
//               reasoningMap, thinkingKeep, generation). Server-reported
//               values always win over config fallbacks at discovery time.
//   - tools:    Moonshot tool on/off + TUI collapse defaults
//   - uploads:  File-upload threshold
//   - protocol: openai | anthropic
//
// Strict validation: every field at every depth is required. Missing or
// invalid fields throw ConfigError with a JSON pointer. The code carries
// zero defaults for any field. KIMI_CODE_CONFIG_TEMPLATE is only used
// by ensureKimiCodeConfig for one-time bootstrap; it is never a fallback.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROVIDER_ID } from "./constants.ts";

// =============================================================================
// Public types
// =============================================================================

export type KimiInputModality = "text" | "image" | "video";

export interface ModelReasoningEntry {
  effort: string | null;
  enabled: boolean;
}

export type ModelReasoningMap = Record<string, ModelReasoningEntry>;

export interface ModelGeneration {
  temperature?: number | null;
  topP?: number | null;
  maxCompletionTokens?: number | null;
}

export interface ModelConfig {
  contextWindow: number;
  maxTokens: number;
  input: KimiInputModality[];
  reasoning: boolean;
  reasoningMap: ModelReasoningMap;
  thinkingKeep: "all" | "last" | "none" | null;
  generation: ModelGeneration;
}

/** Carried on the model object for stream/payload consumption.
 *  Extends config with server-discovered fields. */
export interface KimiResolvedModelConfig extends ModelConfig {
  thinkingType?: string; // from server: "only" | "optional" | "none"
}

export interface KimiCodeConfig {
  model: ModelConfig;
  tools: {
    moonshot_search: { enabled: boolean; default_collapsed: boolean };
    moonshot_fetch: { enabled: boolean; default_collapsed: boolean };
  };
  uploads: { thresholdBytes: number };
  protocol: "openai" | "anthropic";
}

// =============================================================================
// Errors
// =============================================================================

export class ConfigError extends Error {
  public readonly configPath: string;

  constructor(message: string, configPath: string) {
    super(`${configPath}: ${message}`);
    this.name = "ConfigError";
    this.configPath = configPath;
  }
}

// =============================================================================
// Bootstrap template (the ONLY source of seed values)
// =============================================================================

export const KIMI_CODE_CONFIG_TEMPLATE: KimiCodeConfig = {
  model: {
    contextWindow: 262144,
    maxTokens: 32000,
    input: ["text", "image"],
    reasoning: true,
    reasoningMap: {
      none: { effort: null, enabled: false },
      off: { effort: null, enabled: false },
      low: { effort: "low", enabled: true },
      medium: { effort: "medium", enabled: true },
      high: { effort: "high", enabled: true },
      xhigh: { effort: "high", enabled: true },
    },
    thinkingKeep: "all",
    generation: { temperature: null, topP: null, maxCompletionTokens: null },
  },
  tools: {
    moonshot_search: { enabled: false, default_collapsed: true },
    moonshot_fetch: { enabled: false, default_collapsed: true },
  },
  uploads: { thresholdBytes: 1048576 },
  protocol: "openai",
};

// =============================================================================
// File I/O
// =============================================================================

export function kimiCodeConfigPath(home: string): string {
  return join(home, ".pi", "providers", PROVIDER_ID, "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new ConfigError(
      `config file must be a JSON object`,
      path,
    );
  }
  return parsed;
}

// =============================================================================
// Bootstrap
// =============================================================================

/** Writes KIMI_CODE_CONFIG_TEMPLATE to the home config path if the file
 *  does not already exist. Returns true if created, false if the file
 *  already existed. Never overwrites. */
export function ensureKimiCodeConfig(home: string): boolean {
  const path = kimiCodeConfigPath(home);
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(KIMI_CODE_CONFIG_TEMPLATE, null, 2)}\n`, "utf8");
  console.error(`[kimi-coding] created default config at ${path}`);
  return true;
}

// =============================================================================
// Strict field validators
//
// Every validator throws ConfigError on missing, invalid, or wrong-type
// input. No code-side fallbacks exist for any field. The path argument
// is a JSON pointer for error reporting.
// =============================================================================

function requireNumber(raw: unknown, path: string): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  throw new ConfigError(
    `expected a positive number, got ${JSON.stringify(raw)}`,
    path,
  );
}

function requireBoolean(raw: unknown, path: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ConfigError(
    `expected a boolean, got ${JSON.stringify(raw)}`,
    path,
  );
}

function requireInputArray(raw: unknown, path: string): KimiInputModality[] {
  const VALID: readonly string[] = ["text", "image", "video"];
  if (!Array.isArray(raw)) {
    throw new ConfigError(`expected an array, got ${typeof raw}`, path);
  }
  if (raw.length === 0) {
    throw new ConfigError("expected a non-empty array", path);
  }
  return raw.map((v, i) => {
    if (typeof v !== "string" || !VALID.includes(v)) {
      throw new ConfigError(
        `invalid modality at index ${i}: ${JSON.stringify(v)}; expected one of ${VALID.join(", ")}`,
        `${path}[${i}]`,
      );
    }
    return v as KimiInputModality;
  });
}

function requireReasoningMap(raw: unknown, path: string): ModelReasoningMap {
  if (!isRecord(raw)) {
    throw new ConfigError(`expected an object, got ${typeof raw}`, path);
  }
  const result: ModelReasoningMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      throw new ConfigError(
        `expected an object at key "${key}"`,
        `${path}["${key}"]`,
      );
    }
    const enabled = value.enabled;
    if (typeof enabled !== "boolean") {
      throw new ConfigError(
        `enabled must be a boolean, got ${typeof enabled}`,
        `${path}["${key}"].enabled`,
      );
    }
    const effort = value.effort;
    if (effort !== null && typeof effort !== "string") {
      throw new ConfigError(
        `effort must be a string or null, got ${typeof effort}`,
        `${path}["${key}"].effort`,
      );
    }
    result[key] = { effort: effort as string | null, enabled };
  }
  return result;
}

function requireThinkingKeep(
  raw: unknown,
  path: string,
): "all" | "last" | "none" | null {
  if (raw === null) return null;
  if (raw === "all" || raw === "last" || raw === "none") return raw;
  throw new ConfigError(
    `expected "all" | "last" | "none" | null, got ${JSON.stringify(raw)}`,
    path,
  );
}

function requireGeneration(raw: unknown, path: string): ModelGeneration {
  if (!isRecord(raw)) {
    throw new ConfigError(`expected an object, got ${typeof raw}`, path);
  }
  const result: ModelGeneration = {};
  for (const key of ["temperature", "topP", "maxCompletionTokens"]) {
    const v = (raw as Record<string, unknown>)[key];
    if (v !== undefined && v !== null && typeof v !== "number") {
      throw new ConfigError(
        `${key} must be a number or null, got ${typeof v}`,
        `${path}.${key}`,
      );
    }
    result[key as keyof ModelGeneration] = (v as number | null) ?? null;
  }
  return result;
}

function requireProtocol(raw: unknown, path: string): "openai" | "anthropic" {
  if (raw === "openai" || raw === "anthropic") return raw;
  throw new ConfigError(
    `expected "openai" | "anthropic", got ${JSON.stringify(raw)}`,
    path,
  );
}

// =============================================================================
// Top-level loader
// =============================================================================

export function loadKimiCodeConfig(home: string): KimiCodeConfig {
  // Bootstrap: write template if home config is missing. Never overwrites.
  ensureKimiCodeConfig(home);

  const homeConfig = readConfigFile(kimiCodeConfigPath(home));
  const merged: Record<string, unknown> = homeConfig;

  // ── tools ──────────────────────────────────────────────────────
  if (!isRecord(merged.tools)) {
    throw new ConfigError("required field missing", "tools");
  }
  const tools = merged.tools;

  if (!isRecord(tools.moonshot_search)) {
    throw new ConfigError("required field missing", "tools.moonshot_search");
  }
  if (!isRecord(tools.moonshot_fetch)) {
    throw new ConfigError("required field missing", "tools.moonshot_fetch");
  }

  const moonshotSearch = tools.moonshot_search;
  const moonshotFetch = tools.moonshot_fetch;

  const moSearchEnabled = requireBoolean(moonshotSearch.enabled, "tools.moonshot_search.enabled");
  const moSearchCollapsed = requireBoolean(
    moonshotSearch.default_collapsed,
    "tools.moonshot_search.default_collapsed",
  );
  const moFetchEnabled = requireBoolean(moonshotFetch.enabled, "tools.moonshot_fetch.enabled");
  const moFetchCollapsed = requireBoolean(
    moonshotFetch.default_collapsed,
    "tools.moonshot_fetch.default_collapsed",
  );

  // ── model ──────────────────────────────────────────────────────
  if (!isRecord(merged.model)) {
    throw new ConfigError("required field missing", "model");
  }
  const rawModel = merged.model;

  const model: ModelConfig = {
    contextWindow: requireNumber(rawModel.contextWindow, "model.contextWindow"),
    maxTokens: requireNumber(rawModel.maxTokens, "model.maxTokens"),
    input: requireInputArray(rawModel.input, "model.input"),
    reasoning: requireBoolean(rawModel.reasoning, "model.reasoning"),
    reasoningMap: requireReasoningMap(rawModel.reasoningMap, "model.reasoningMap"),
    thinkingKeep: requireThinkingKeep(rawModel.thinkingKeep, "model.thinkingKeep"),
    generation: requireGeneration(rawModel.generation, "model.generation"),
  };

  // ── uploads ────────────────────────────────────────────────────
  if (!isRecord(merged.uploads)) {
    throw new ConfigError("required field missing", "uploads");
  }
  const uploads = {
    thresholdBytes: requireNumber(merged.uploads.thresholdBytes, "uploads.thresholdBytes"),
  };

  // ── protocol ───────────────────────────────────────────────────
  const protocol = requireProtocol(merged.protocol, "protocol");

  return {
    tools: {
      moonshot_search: { enabled: moSearchEnabled, default_collapsed: moSearchCollapsed },
      moonshot_fetch: { enabled: moFetchEnabled, default_collapsed: moFetchCollapsed },
    },
    model,
    uploads,
    protocol,
  };
}

// =============================================================================
// Save
// =============================================================================

export function saveKimiCodeConfig(home: string, config: KimiCodeConfig): void {
  const path = kimiCodeConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
