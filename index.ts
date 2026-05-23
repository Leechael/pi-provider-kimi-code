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
  loadKimiCodeConfig,
  saveProjectKimiCodeConfig,
} from "./src/config.ts";
import {
  DEFAULT_KIMI_MODEL_INPUT,
  KIMI_API_TYPE,
  PROVIDER_ID,
  getBaseUrl,
} from "./src/constants.ts";
import { getCommonHeaders } from "./src/device.ts";
import {
  type KimiOAuthCredentials,
  applyKimiEnvOverridesToModel,
  applyKimiOAuthExtrasToModel,
} from "./src/models.ts";
import { loginKimiCode, refreshKimiCodeToken } from "./src/oauth.ts";
import { streamSimpleKimi } from "./src/stream.ts";
import { buildMoonshotFetchTool, buildMoonshotSearchTool } from "./src/tools/moonshot.ts";

const MOONSHOT_TOOL_NAMES = ["moonshot_search", "moonshot_fetch"] as const;
type MoonshotToolName = (typeof MOONSHOT_TOOL_NAMES)[number];

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
  const rows: UsageRow[] = [];
  const summary = parseUsageRow(record.usage, "Weekly limit");
  if (summary) rows.push(summary);

  if (Array.isArray(record.limits)) {
    for (const [index, item] of record.limits.entries()) {
      const detail =
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? ((item as Record<string, unknown>).detail ?? item)
          : item;
      const row = parseUsageRow(detail, `Limit #${index + 1}`);
      if (row) rows.push(row);
    }
  }

  if (rows.length === 0) return "Usage: no usage data";
  return rows
    .map((row) => {
      if (row.limit <= 0) return `${row.label}: ${row.used} used`;
      const remaining = Math.max(0, Math.min(row.limit - row.used, row.limit));
      const percent = Math.round((remaining / row.limit) * 100);
      return `${row.label}: ${percent}% left (${remaining}/${row.limit})`;
    })
    .join("\n");
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
  let config = loadKimiCodeConfig({ cwd: ctx.cwd, home: os.homedir() });

  while (true) {
    const usage = await fetchKimiUsageSummary();
    const title = `Kimi Code\n\n${usage}\n\n${moonshotStatus(config)}`;
    const choice = await ctx.ui.select(title, [
      "Toggle moonshot_search enabled",
      "Toggle moonshot_search collapsed",
      "Toggle moonshot_fetch enabled",
      "Toggle moonshot_fetch collapsed",
      "Refresh",
      "Done",
    ]);

    if (!choice || choice === "Done") return;
    if (choice === "Refresh") continue;

    if (choice === "Toggle moonshot_search enabled") {
      config = toggleEnabled(config, "moonshot_search");
    } else if (choice === "Toggle moonshot_search collapsed") {
      config = toggleCollapsed(config, "moonshot_search");
    } else if (choice === "Toggle moonshot_fetch enabled") {
      config = toggleEnabled(config, "moonshot_fetch");
    } else if (choice === "Toggle moonshot_fetch collapsed") {
      config = toggleCollapsed(config, "moonshot_fetch");
    }

    saveProjectKimiCodeConfig(ctx.cwd, config);
    registerConfiguredMoonshotTools(pi, config, { updateActiveTools: true });
    ctx.ui.notify("Kimi config updated", "info");
  }
}

export default function (pi: ExtensionAPI) {
  const config = loadKimiCodeConfig({ cwd: process.cwd(), home: os.homedir() });

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: getBaseUrl(),
    apiKey: "KIMI_API_KEY",
    api: KIMI_API_TYPE,
    streamSimple: streamSimpleKimi,

    headers: getCommonHeaders(),

    models: [
      applyKimiEnvOverridesToModel({
        id: "kimi-for-coding",
        name: "Kimi for Coding",
        reasoning: true,
        input: [...DEFAULT_KIMI_MODEL_INPUT] as unknown as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32000,
      } as Model<Api>),
    ],

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
        return models.map((model) => {
          if (model.id !== "kimi-for-coding") return model;
          return applyKimiEnvOverridesToModel(applyKimiOAuthExtrasToModel(model, extras));
        });
      },
    },
  });

  registerConfiguredMoonshotTools(pi, config, { updateActiveTools: false });

  pi.registerCommand("kimi", {
    description: "Show Kimi usage and configure optional Kimi tools",
    handler: async (_args, ctx) => {
      await runKimiCommand(pi, ctx);
    },
  });
}
