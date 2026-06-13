/**
 * Kimi Code Provider Extension
 *
 * Provides access to Kimi models via OAuth device code flow.
 * API endpoint: https://api.kimi.com/coding (Anthropic Messages compatible)
 *
 * Usage:
 *   pi -e ~/workshop/pi-provider-kimi-code
 *   # Then /login kimi-coding, or set KIMI_API_KEY=...
 *
 * Source layout:
 *   src/constants.ts  — module-level consts + env-driven configuration
 *   src/device.ts     — device id + kimi-cli-compatible request headers
 *   src/oauth.ts      — device flow, token refresh, kimi-cli reuse,
 *                       login/refresh handlers, stream-level auth refresh
 *   src/models.ts     — /v1/models discovery + extras-merging helpers
 *   src/payload.ts    — payload pipeline + file upload + transforms
 *   src/stream.ts     — empty-response filter + streamSimpleKimi orchestrator
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import os from "node:os";

import {
  type KimiCodeConfig,
  kimiCodeConfigPath,
  loadKimiCodeConfig,
  saveKimiCodeConfig,
} from "./src/config.ts";
import {
  KIMI_API_TYPE,
  PROVIDER_ID,
  getBaseUrl,
} from "./src/constants.ts";
import { getCommonHeaders } from "./src/device.ts";
import {
  type KimiOAuthCredentials,
  applyKimiOAuthExtrasToModel,
  discoverKimiModelMetadata,
} from "./src/models.ts";
import { loginKimiCode, refreshKimiCodeToken } from "./src/oauth.ts";
import { streamSimpleKimi } from "./src/stream.ts";
import { buildMoonshotFetchTool, buildMoonshotSearchTool } from "./src/tools/moonshot.ts";

const MOONSHOT_TOOL_NAMES = ["moonshot_search", "moonshot_fetch"] as const;
type MoonshotToolName = (typeof MOONSHOT_TOOL_NAMES)[number];
const MEMBERSHIP_LEVEL_NAMES: Record<string, string> = {
  LEVEL_FREE: "Free",
  LEVEL_BASIC: "Adagio",
  LEVEL_STANDARD: "Moderato",
  LEVEL_INTERMEDIATE: "Allegretto",
  LEVEL_ADVANCED: "Allegro",
  LEVEL_PREMIUM: "Vivace",
};

interface UsageRow {
  label: string;
  used: number;
  limit: number;
}

function registerConfiguredMoonshotTools(
  pi: ExtensionAPI,
  config: KimiCodeConfig,
  options: { updateActiveTools: boolean },
): void {
  if (config.tools.moonshot_search.enabled) {
    pi.registerTool(
      buildMoonshotSearchTool({
        defaultCollapsed: config.tools.moonshot_search.default_collapsed,
      }),
    );
  }
  if (config.tools.moonshot_fetch.enabled) {
    pi.registerTool(
      buildMoonshotFetchTool({
        defaultCollapsed: config.tools.moonshot_fetch.default_collapsed,
      }),
    );
  }

  if (!options.updateActiveTools) return;

  const activeTools = new Set(pi.getActiveTools());
  for (const toolName of MOONSHOT_TOOL_NAMES) {
    if (config.tools[toolName].enabled) {
      activeTools.add(toolName);
    } else {
      activeTools.delete(toolName);
    }
  }
  pi.setActiveTools([...activeTools]);
}

function getKimiUsageToken(): string | null {
  const credential = AuthStorage.create().get(PROVIDER_ID);
  if (credential?.type === "oauth" && credential.access) return credential.access;
  const apiKey = process.env.KIMI_API_KEY?.trim();
  return apiKey || null;
}

function toNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseUsageRow(value: unknown, fallbackLabel: string): UsageRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const limit = toNumber(record.limit);
  const usedValue = toNumber(record.used);
  const remaining = toNumber(record.remaining);
  const used = usedValue ?? (limit !== null && remaining !== null ? limit - remaining : null);
  if (limit === null && used === null) return null;
  return {
    label: String(record.name || record.title || fallbackLabel),
    used: used ?? 0,
    limit: limit ?? 0,
  };
}

function parseUsageSummary(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "Usage: unavailable";
  }

  const record = payload as Record<string, unknown>;
  const lines: string[] = [];
  const membership = parseMembership(record);
  if (membership) lines.push(membership);

  const rows: UsageRow[] = [];
  const summary = parseUsageRow(record.usage, "Weekly limit");
  if (summary) rows.push(summary);

  if (Array.isArray(record.limits)) {
    for (const [index, item] of record.limits.entries()) {
      const detail =
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? ((item as Record<string, unknown>).detail ?? item)
          : item;
      const row = parseUsageRow(detail, index === 0 ? "5h rate limit" : `Limit #${index + 1}`);
      if (row) rows.push(row);
    }
  }

  lines.push(...rows.map(formatUsageRow));
  return lines.length === 0 ? "Usage: no usage data" : lines.join("\n");
}

function parseMembership(record: Record<string, unknown>): string | null {
  const user = record.user;
  if (typeof user !== "object" || user === null || Array.isArray(user)) return null;
  const membership = (user as Record<string, unknown>).membership;
  if (typeof membership !== "object" || membership === null || Array.isArray(membership)) {
    return null;
  }
  const level = (membership as Record<string, unknown>).level;
  if (typeof level !== "string" || !level) return null;
  const name = MEMBERSHIP_LEVEL_NAMES[level];
  return name ? `Membership: ${name} (${level})` : `Membership: ${level}`;
}

function formatUsageRow(row: UsageRow): string {
  if (row.limit <= 0) return `${row.label}: ${row.used} used`;
  const remaining = Math.max(0, Math.min(row.limit - row.used, row.limit));
  const percent = Math.round((remaining / row.limit) * 100);
  return `${row.label}: ${quotaBar(remaining, row.limit)} ${percent}% left (${remaining}/${row.limit})`;
}

function quotaBar(remaining: number, limit: number): string {
  const width = 20;
  const filled = Math.max(0, Math.min(width, Math.round((remaining / limit) * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

async function fetchKimiUsageSummary(): Promise<string> {
  const token = getKimiUsageToken();
  if (!token) return "Usage: missing credentials. Run /login kimi-coding.";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch("https://api.kimi.com/coding/v1/usages", {
      method: "GET",
      headers: {
        ...getCommonHeaders(),
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return `Usage: fetch failed (${response.status})`;
    return parseUsageSummary(await response.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Usage: fetch failed (${message})`;
  } finally {
    clearTimeout(timeout);
  }
}

function moonshotStatus(config: KimiCodeConfig): string {
  return MOONSHOT_TOOL_NAMES.map((toolName) => {
    const tool = config.tools[toolName];
    const enabled = tool.enabled ? "enabled" : "disabled";
    const collapsed = tool.default_collapsed ? "collapsed" : "expanded";
    return `${toolName}: ${enabled}, default ${collapsed}`;
  }).join("\n");
}

function toggleEnabled(config: KimiCodeConfig, toolName: MoonshotToolName): KimiCodeConfig {
  return {
    ...config,
    tools: {
      ...config.tools,
      [toolName]: {
        ...config.tools[toolName],
        enabled: !config.tools[toolName].enabled,
      },
    },
  };
}

function toggleCollapsed(config: KimiCodeConfig, toolName: MoonshotToolName): KimiCodeConfig {
  return {
    ...config,
    tools: {
      ...config.tools,
      [toolName]: {
        ...config.tools[toolName],
        default_collapsed: !config.tools[toolName].default_collapsed,
      },
    },
  };
}

async function runKimiCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const home = os.homedir();
  let config = loadKimiCodeConfig(home);
  let usage = await fetchKimiUsageSummary();
  ctx.ui.notify(usage);

  while (true) {
    const choice = await ctx.ui.select("Kimi settings", [
      "Edit config",
      "Refresh usage",
      "Done",
    ]);

    if (!choice || choice === "Done") return;
    if (choice === "Refresh usage") {
      usage = await fetchKimiUsageSummary();
      ctx.ui.notify(usage);
      continue;
    }
    config = await editConfigMenu(pi, ctx, home, config);
  }
}

async function editConfigMenu(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  home: string,
  config: KimiCodeConfig,
): Promise<KimiCodeConfig> {
  let current = config;
  while (true) {
    const path = kimiCodeConfigPath(home);
    const title = [
      `Edit config`,
      `File: ${homeRelative(path)}`,
      "",
      moonshotStatus(current),
    ].join("\n");
    const choice = await ctx.ui.select(title, [
      toolMenuItem(current, "moonshot_search"),
      toolMenuItem(current, "moonshot_fetch"),
      "Back",
    ]);
    if (!choice || choice === "Back") return loadKimiCodeConfig(home);
    if (choice.startsWith("moonshot_search")) {
      current = await editMoonshotTool(pi, ctx, home, current, "moonshot_search");
    } else if (choice.startsWith("moonshot_fetch")) {
      current = await editMoonshotTool(pi, ctx, home, current, "moonshot_fetch");
    }
  }
}

async function editMoonshotTool(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  home: string,
  config: KimiCodeConfig,
  toolName: MoonshotToolName,
): Promise<KimiCodeConfig> {
  let current = config;
  while (true) {
    const tool = current.tools[toolName];
    const choice = await ctx.ui.select(
      `Edit ${toolName}\n\n${formatToolStatus(current, toolName)}`,
      [
        tool.enabled ? `Disable ${toolName}` : `Enable ${toolName}`,
        tool.default_collapsed ? "Expand previews by default" : "Collapse previews by default",
        "Back",
      ],
    );
    if (!choice || choice === "Back") return current;
    if (choice.startsWith("Enable") || choice.startsWith("Disable")) {
      current = toggleEnabled(current, toolName);
    } else if (choice.endsWith("previews by default")) {
      current = toggleCollapsed(current, toolName);
    }
    saveKimiCodeConfig(home, current);
    const effective = loadKimiCodeConfig(home);
    registerConfiguredMoonshotTools(pi, effective, { updateActiveTools: true });
    ctx.ui.notify(`Saved ${toolName} config`, "info");
  }
}

function homeRelative(filePath: string): string {
  const home = os.homedir();
  return filePath.startsWith(`${home}/`) ? `~/${filePath.slice(home.length + 1)}` : filePath;
}

function toolMenuItem(config: KimiCodeConfig, toolName: MoonshotToolName): string {
  return `${toolName} -> ${formatToolStatus(config, toolName)}`;
}

function formatToolStatus(config: KimiCodeConfig, toolName: MoonshotToolName): string {
  const tool = config.tools[toolName];
  const enabled = tool.enabled ? "enabled" : "disabled";
  const collapsed = tool.default_collapsed ? "default collapsed" : "default expanded";
  return `${enabled}, ${collapsed}`;
}

export default async function (pi: ExtensionAPI) {
  const config = loadKimiCodeConfig(os.homedir());

  // Build the initial model entry from config.model.
  const baseModel: Model<Api> = {
    id: "kimi-for-coding",
    name: "Kimi for Coding",
    reasoning: config.model.reasoning,
    input: [...config.model.input] as unknown as ("text" | "image" | "video")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.model.contextWindow,
    maxTokens: config.model.maxTokens,
  } as Model<Api>;

  // Shared cold-start discovery: resolve an auth token (API key env or
  // cached OAuth cred) and call /v1/models. Server values layer over
  // config fallbacks.
  let model = baseModel;
  const token = getKimiUsageToken();
  if (token) {
    const extras = await discoverKimiModelMetadata(token);
    model = applyKimiOAuthExtrasToModel(baseModel, extras);
  }

  // Attach the full resolved config for stream/payload consumption.
  (model as Model<Api> & { resolvedConfig?: Record<string, unknown> }).resolvedConfig = {
    ...config.model,
    ...((model as Model<Api> & { resolvedConfig?: Record<string, unknown> }).resolvedConfig),
  };

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: getBaseUrl(),
    apiKey: "$KIMI_API_KEY",
    api: KIMI_API_TYPE,
    streamSimple: streamSimpleKimi,

    models: [model],

    oauth: {
      name: "Kimi Code (OAuth)",
      login: loginKimiCode,
      refreshToken: refreshKimiCodeToken,
      getApiKey: (cred) => cred.access,
      // Reflect server-side model identity on the registered model after login
      // / refresh. We never rewrite the model id (pi-side `/model` selections
      // and persisted sessions reference it); only the human-facing name, the
      // context window, and an out-of-band `wireModelId` carried into the
      // request payload by streamSimpleKimi.
      modifyModels: (models, cred) => {
        const extras = cred as KimiOAuthCredentials;
        return models.map((m) => {
          if (m.id !== "kimi-for-coding") return m;
          return applyKimiOAuthExtrasToModel(m, extras);
        });
      },
    },
  });

  registerConfiguredMoonshotTools(pi, config, { updateActiveTools: false });

  pi.registerCommand("kimi-settings", {
    description: "Show Kimi usage and configure optional Kimi tools",
    handler: async (_args, ctx) => {
      await runKimiCommand(pi, ctx);
    },
  });
}
