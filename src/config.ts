import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { PROVIDER_ID } from "./constants.ts";

export const KIMI_TOOL_NAMES = ["moonshot_search", "moonshot_fetch", "kimi_datasource"] as const;

export type KimiToolName = (typeof KIMI_TOOL_NAMES)[number];

export type KimiConfigSource = "runtime" | "env" | "project" | "home" | "default";

export type KimiInputModality = "text" | "image" | "video";

export interface ModelReasoningEntry {
  effort: string | null;
  enabled: boolean;
}

export type ModelReasoningMap = Record<string, ModelReasoningEntry>;

export interface ModelGeneration {
  temperature?: number;
  topP?: number;
  maxCompletionTokens?: number;
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

export interface KimiResolvedModelConfig extends ModelConfig {
  supportsThinkingType?: "only" | "no" | "both";
}

export interface KimiCodeConfig {
  model: ModelConfig;
  tools: Record<KimiToolName, { enabled: boolean; default_collapsed: boolean }>;
  uploads: { thresholdBytes: number };
  protocol: "openai" | "anthropic";
}

export type KimiCodeConfigPatch = Partial<{
  model: Partial<{
    contextWindow: unknown;
    maxTokens: unknown;
    input: unknown;
    reasoning: unknown;
    reasoningMap: unknown;
    thinkingKeep: unknown;
    generation: unknown;
  }>;
  tools: Partial<Record<KimiToolName, Partial<{ enabled: unknown; default_collapsed: unknown }>>>;
  uploads: Partial<{ thresholdBytes: unknown }>;
  protocol: unknown;
}>;

export interface KimiCodeConfigSources {
  model: {
    contextWindow: KimiConfigSource;
    maxTokens: KimiConfigSource;
    input: KimiConfigSource;
    reasoning: KimiConfigSource;
    reasoningMap: KimiConfigSource;
    thinkingKeep: KimiConfigSource;
    generation: {
      temperature: KimiConfigSource;
      topP: KimiConfigSource;
      maxCompletionTokens: KimiConfigSource;
    };
  };
  tools: Record<KimiToolName, { enabled: KimiConfigSource; default_collapsed: KimiConfigSource }>;
  uploads: { thresholdBytes: KimiConfigSource };
  protocol: KimiConfigSource;
}

export interface LoadKimiCodeConfigOptions {
  cwd: string;
  home: string;
  env?: NodeJS.ProcessEnv;
}

export class ConfigError extends Error {
  public readonly configPath: string;
  public readonly pointer?: string;

  constructor(message: string, configPath: string, pointer?: string) {
    super(pointer ? `${configPath}${pointer}: ${message}` : `${configPath}: ${message}`);
    this.name = "ConfigError";
    this.configPath = configPath;
    this.pointer = pointer;
  }
}

function makeDefaultTools(): KimiCodeConfig["tools"] {
  const tools = {} as KimiCodeConfig["tools"];
  for (const name of KIMI_TOOL_NAMES) {
    tools[name] = { enabled: false, default_collapsed: true };
  }
  return tools;
}

export const DEFAULT_KIMI_CODE_CONFIG: KimiCodeConfig = {
  model: {
    contextWindow: 262144,
    maxTokens: 32000,
    input: ["text", "image"],
    reasoning: true,
    reasoningMap: {
      none: { effort: null, enabled: false },
      off: { effort: null, enabled: false },
      minimal: { effort: "low", enabled: true },
      low: { effort: "low", enabled: true },
      medium: { effort: "medium", enabled: true },
      high: { effort: "high", enabled: true },
      xhigh: { effort: "high", enabled: true },
    },
    thinkingKeep: "all",
    generation: {},
  },
  tools: makeDefaultTools(),
  uploads: { thresholdBytes: 1048576 },
  protocol: "openai",
};

let runtimeOverride: KimiCodeConfigPatch = {};

export function setRuntimeKimiCodeConfigOverride(patch: KimiCodeConfigPatch): void {
  runtimeOverride = mergeConfigPatch(runtimeOverride, patch);
}

export function replaceRuntimeKimiCodeConfigOverride(patch: KimiCodeConfigPatch): void {
  runtimeOverride = patch;
}

export function clearRuntimeKimiCodeConfigOverride(): void {
  runtimeOverride = {};
}

export function getRuntimeKimiCodeConfigOverride(): KimiCodeConfigPatch {
  return clone(runtimeOverride) as KimiCodeConfigPatch;
}

export function getGlobalKimiCodeConfigPath(home: string): string {
  return join(home, ".pi", "providers", PROVIDER_ID, "config.json");
}

export function getProjectKimiCodeConfigPath(cwd: string): string {
  return join(cwd, ".pi", "providers", PROVIDER_ID, "config.json");
}

export function kimiCodeConfigPath(home: string): string {
  return getGlobalKimiCodeConfigPath(home);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      `failed to read config: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }

  try {
    const parsed = JSON.parse(contents) as unknown;
    if (isRecord(parsed)) return parsed;
    throw new ConfigError("config file must be a JSON object", path);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
}

function readConfigFileQuiet(path: string): Record<string, unknown> {
  try {
    return readConfigFile(path);
  } catch (error) {
    console.error(`[kimi-coding] failed to read config file ${path}:`, error);
    return {};
  }
}

function mergeConfigPatch<T extends Record<string, unknown>>(
  base: T,
  patch: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = mergeConfigPatch(current, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

function envConfigPatch(env: NodeJS.ProcessEnv): KimiCodeConfigPatch {
  const patch: KimiCodeConfigPatch = {};

  const maxContext = parsePositiveNumber(env.KIMI_MODEL_MAX_CONTEXT_SIZE);
  if (maxContext !== undefined) patch.model = { ...patch.model, contextWindow: maxContext };

  const temp = parseFiniteNumber(env.KIMI_MODEL_TEMPERATURE);
  const topP = parseFiniteNumber(env.KIMI_MODEL_TOP_P);
  const maxCompletionTokens = parsePositiveNumber(env.KIMI_MODEL_MAX_COMPLETION_TOKENS);
  const thinkingKeep = env.KIMI_MODEL_THINKING_KEEP?.trim();
  if (
    temp !== undefined ||
    topP !== undefined ||
    maxCompletionTokens !== undefined ||
    thinkingKeep
  ) {
    patch.model = {
      ...patch.model,
      ...(thinkingKeep ? { thinkingKeep } : {}),
      generation: {
        ...(temp !== undefined ? { temperature: temp } : {}),
        ...(topP !== undefined ? { topP } : {}),
        ...(maxCompletionTokens !== undefined ? { maxCompletionTokens } : {}),
      },
    };
  }

  const uploadThreshold = parsePositiveNumber(env.KIMI_CODE_UPLOAD_THRESHOLD_BYTES);
  if (uploadThreshold !== undefined) patch.uploads = { thresholdBytes: uploadThreshold };

  const protocol = env.KIMI_CODE_PROTOCOL?.trim();
  if (protocol) patch.protocol = protocol;

  const capabilities = env.KIMI_MODEL_CAPABILITIES;
  if (capabilities) {
    const caps = new Set(
      capabilities
        .split(",")
        .map((cap) => cap.trim().toLowerCase())
        .filter(Boolean),
    );
    patch.model = {
      ...patch.model,
      reasoning: caps.has("thinking") || caps.has("always_thinking"),
      input: caps.has("image_in") ? ["text", "image"] : ["text"],
    };
  }

  return patch;
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseFiniteNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fail(configPath: string, pointer: string, message: string): never {
  throw new ConfigError(message, configPath, pointer);
}

function requireRecord(raw: unknown, configPath: string, pointer: string): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  return fail(
    configPath,
    pointer,
    `expected an object, got ${Array.isArray(raw) ? "array" : typeof raw}`,
  );
}

function requirePositiveNumber(raw: unknown, configPath: string, pointer: string): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  return fail(configPath, pointer, `expected a positive number, got ${JSON.stringify(raw)}`);
}

function requireBoolean(raw: unknown, configPath: string, pointer: string): boolean {
  if (typeof raw === "boolean") return raw;
  return fail(configPath, pointer, `expected a boolean, got ${JSON.stringify(raw)}`);
}

function requireProtocol(
  raw: unknown,
  configPath: string,
  pointer: string,
): KimiCodeConfig["protocol"] {
  if (raw === "openai" || raw === "anthropic") return raw;
  return fail(configPath, pointer, `expected "openai" | "anthropic", got ${JSON.stringify(raw)}`);
}

function requireInputArray(raw: unknown, configPath: string, pointer: string): KimiInputModality[] {
  const valid = new Set(["text", "image", "video"]);
  if (!Array.isArray(raw)) return fail(configPath, pointer, `expected an array, got ${typeof raw}`);
  if (raw.length === 0) return fail(configPath, pointer, "expected a non-empty array");
  return raw.map((value, index) => {
    if (typeof value !== "string" || !valid.has(value)) {
      return fail(
        configPath,
        `${pointer}/${index}`,
        `expected one of text, image, video, got ${JSON.stringify(value)}`,
      );
    }
    return value as KimiInputModality;
  });
}

function requireReasoningMap(raw: unknown, configPath: string, pointer: string): ModelReasoningMap {
  const record = requireRecord(raw, configPath, pointer);
  const result: ModelReasoningMap = {};
  for (const [key, value] of Object.entries(record)) {
    const entryPointer = `${pointer}/${key}`;
    const entry = requireRecord(value, configPath, entryPointer);
    result[key] = {
      effort:
        entry.effort === null || typeof entry.effort === "string"
          ? entry.effort
          : fail(configPath, `${entryPointer}/effort`, "expected a string or null"),
      enabled: requireBoolean(entry.enabled, configPath, `${entryPointer}/enabled`),
    };
  }
  return result;
}

function requireThinkingKeep(
  raw: unknown,
  configPath: string,
  pointer: string,
): ModelConfig["thinkingKeep"] {
  if (raw === null || raw === "all" || raw === "last" || raw === "none") return raw;
  return fail(
    configPath,
    pointer,
    `expected "all" | "last" | "none" | null, got ${JSON.stringify(raw)}`,
  );
}

function requireGeneration(raw: unknown, configPath: string, pointer: string): ModelGeneration {
  const record = requireRecord(raw, configPath, pointer);
  const result: ModelGeneration = {};
  const knownKeys = ["temperature", "topP", "maxCompletionTokens"] as const;
  for (const key of knownKeys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(configPath, `${pointer}/${key}`, `expected a number, got ${JSON.stringify(value)}`);
    }
    result[key] = value;
  }
  return result;
}

function validateModelConfig(raw: unknown, configPath: string, pointer: string): ModelConfig {
  const model = requireRecord(raw, configPath, pointer);
  return {
    contextWindow: requirePositiveNumber(
      model.contextWindow,
      configPath,
      `${pointer}/contextWindow`,
    ),
    maxTokens: requirePositiveNumber(model.maxTokens, configPath, `${pointer}/maxTokens`),
    input: requireInputArray(model.input, configPath, `${pointer}/input`),
    reasoning: requireBoolean(model.reasoning, configPath, `${pointer}/reasoning`),
    reasoningMap: requireReasoningMap(model.reasoningMap, configPath, `${pointer}/reasoningMap`),
    thinkingKeep: requireThinkingKeep(model.thinkingKeep, configPath, `${pointer}/thinkingKeep`),
    generation: requireGeneration(model.generation, configPath, `${pointer}/generation`),
  };
}

function validateToolsConfig(
  raw: unknown,
  configPath: string,
  pointer: string,
): KimiCodeConfig["tools"] {
  const tools = requireRecord(raw, configPath, pointer);
  const result = {} as KimiCodeConfig["tools"];
  for (const name of KIMI_TOOL_NAMES) {
    const tool = requireRecord(tools[name], configPath, `${pointer}/${name}`);
    result[name] = {
      enabled: requireBoolean(tool.enabled, configPath, `${pointer}/${name}/enabled`),
      default_collapsed: requireBoolean(
        tool.default_collapsed,
        configPath,
        `${pointer}/${name}/default_collapsed`,
      ),
    };
  }
  return result;
}

export function validateKimiCodeConfig(
  raw: unknown,
  configPath = "<kimi-code-config>",
): KimiCodeConfig {
  const config = requireRecord(raw, configPath, "");
  return {
    model: validateModelConfig(config.model, configPath, "/model"),
    tools: validateToolsConfig(config.tools, configPath, "/tools"),
    uploads: {
      thresholdBytes: requirePositiveNumber(
        requireRecord(config.uploads, configPath, "/uploads").thresholdBytes,
        configPath,
        "/uploads/thresholdBytes",
      ),
    },
    protocol: requireProtocol(config.protocol, configPath, "/protocol"),
  };
}

function hasPath(config: Record<string, unknown>, path: readonly string[]): boolean {
  let current: unknown = config;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

function sourceForPath(
  layers: Array<{ source: KimiConfigSource; config: Record<string, unknown> }>,
  path: readonly string[],
): KimiConfigSource {
  for (let i = layers.length - 1; i >= 0; i--) {
    if (hasPath(layers[i].config, path)) return layers[i].source;
  }
  return "default";
}

function buildSources(
  layers: Array<{ source: KimiConfigSource; config: Record<string, unknown> }>,
): KimiCodeConfigSources {
  const tools = {} as KimiCodeConfigSources["tools"];
  for (const name of KIMI_TOOL_NAMES) {
    tools[name] = {
      enabled: sourceForPath(layers, ["tools", name, "enabled"]),
      default_collapsed: sourceForPath(layers, ["tools", name, "default_collapsed"]),
    };
  }
  return {
    model: {
      contextWindow: sourceForPath(layers, ["model", "contextWindow"]),
      maxTokens: sourceForPath(layers, ["model", "maxTokens"]),
      input: sourceForPath(layers, ["model", "input"]),
      reasoning: sourceForPath(layers, ["model", "reasoning"]),
      reasoningMap: sourceForPath(layers, ["model", "reasoningMap"]),
      thinkingKeep: sourceForPath(layers, ["model", "thinkingKeep"]),
      generation: {
        temperature: sourceForPath(layers, ["model", "generation", "temperature"]),
        topP: sourceForPath(layers, ["model", "generation", "topP"]),
        maxCompletionTokens: sourceForPath(layers, ["model", "generation", "maxCompletionTokens"]),
      },
    },
    tools,
    uploads: { thresholdBytes: sourceForPath(layers, ["uploads", "thresholdBytes"]) },
    protocol: sourceForPath(layers, ["protocol"]),
  };
}

function loadLayers(
  options: LoadKimiCodeConfigOptions,
): Array<{ source: KimiConfigSource; config: Record<string, unknown> }> {
  return [
    { source: "home", config: readConfigFile(getGlobalKimiCodeConfigPath(options.home)) },
    { source: "project", config: readConfigFile(getProjectKimiCodeConfigPath(options.cwd)) },
    {
      source: "env",
      config: envConfigPatch(options.env ?? process.env) as Record<string, unknown>,
    },
    { source: "runtime", config: runtimeOverride as Record<string, unknown> },
  ];
}

export function loadKimiCodeConfig(options: LoadKimiCodeConfigOptions): KimiCodeConfig {
  let merged = clone(DEFAULT_KIMI_CODE_CONFIG) as unknown as Record<string, unknown>;
  for (const layer of loadLayers(options)) {
    merged = mergeConfigPatch(merged, layer.config);
  }
  return validateKimiCodeConfig(merged);
}

export function loadKimiCodeConfigSources(
  options: LoadKimiCodeConfigOptions,
): KimiCodeConfigSources {
  return buildSources(loadLayers(options));
}

export function ensureKimiCodeConfig(pathOrHome: string): boolean {
  const path = pathOrHome.endsWith(".json") ? pathOrHome : getGlobalKimiCodeConfigPath(pathOrHome);
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(DEFAULT_KIMI_CODE_CONFIG, null, 2)}\n`, "utf8");
  return true;
}

export function loadProjectKimiCodeConfig(cwd: string): KimiCodeConfig {
  return validateKimiCodeConfig(
    mergeConfigPatch(
      clone(DEFAULT_KIMI_CODE_CONFIG) as unknown as Record<string, unknown>,
      readConfigFileQuiet(getProjectKimiCodeConfigPath(cwd)),
    ),
  );
}

export function loadHomeKimiCodeConfig(home: string): KimiCodeConfig {
  return validateKimiCodeConfig(
    mergeConfigPatch(
      clone(DEFAULT_KIMI_CODE_CONFIG) as unknown as Record<string, unknown>,
      readConfigFileQuiet(getGlobalKimiCodeConfigPath(home)),
    ),
  );
}

export function saveProjectKimiCodeConfig(cwd: string, config: KimiCodeConfig): void {
  saveKimiCodeConfigFile(getProjectKimiCodeConfigPath(cwd), config);
}

export function saveHomeKimiCodeConfig(home: string, config: KimiCodeConfig): void {
  saveKimiCodeConfigFile(getGlobalKimiCodeConfigPath(home), config);
}

function saveKimiCodeConfigFile(path: string, config: KimiCodeConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(validateKimiCodeConfig(config, path), null, 2)}\n`, "utf8");
}
