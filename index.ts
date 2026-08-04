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
 *   src/project-trust.ts — project config approval compatibility helpers
 *   src/stream.ts     — empty-response filter + streamSimpleKimi orchestrator
 */

import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Input, SettingsList, type SettingItem, truncateToWidth } from "@earendil-works/pi-tui";
import os from "node:os";

// pi-ai <=0.79 has no "./compat"
const piAiCompatModule = "@earendil-works/pi-ai/compat";

import {
  type KimiCodeConfig,
  type KimiCodeConfigPatch,
  KIMI_TOOL_NAMES,
  loadHomeKimiCodeConfig,
  loadKimiCodeConfig,
  loadProjectKimiCodeConfig,
  saveHomeKimiCodeConfig,
  saveProjectKimiCodeConfig,
  type KimiToolName,
} from "./src/config.ts";
import {
  KIMI_GLOBAL_FALLBACK_SOURCE_ID,
  PROVIDER_ID,
  PROVIDER_VERSION,
  getBaseUrl,
  getKimiApiType,
} from "./src/constants.ts";
import {
  type KimiOAuthCredentials,
  type KimiOAuthExtras,
  buildKimiModelFromConfig,
  applyKimiOAuthExtrasToModel,
  KIMI_CODING_HIGHSPEED_MODEL_ID,
  KIMI_CODING_MODEL_ID,
  KIMI_K3_MODEL_ID,
  KIMI_MODEL_CATALOG_VERSION,
  discoverKimiModelMetadata,
  getKimiModelMetadata,
  hasKimiModelMetadata,
  resolveKimiModelConfig,
} from "./src/models.ts";
import {
  getKimiApiKey,
  loginKimiCode,
  refreshKimiAuthToken,
  refreshKimiCodeToken,
} from "./src/oauth.ts";
import { isKimiProjectConfigApproved } from "./src/project-trust.ts";
import {
  type KimiConfigScope,
  buildSettingsTheme,
  formatByteSize,
  formatScopeDescription,
  parseByteSizeInput,
} from "./src/settings-ui.ts";
import { setStoreResolvedKimiConfig, streamSimpleKimi } from "./src/stream.ts";
import { fetchKimiUsageSnapshot, getKimiUsageToken } from "./src/usage.ts";
import { buildMoonshotFetchTool, buildMoonshotSearchTool } from "./src/tools/moonshot.ts";
import { buildKimiDatasourceTool } from "./src/tools/datasource.ts";
interface KimiRuntimeState {
  cwd: string;
  config: KimiCodeConfig;
  fallbackSourceId: string;
  modelExtras: KimiOAuthExtras;
  projectTrusted: boolean;
  overrides?: KimiCodeConfigPatch;
}

function buildKimiTool(toolName: KimiToolName, config: KimiCodeConfig) {
  const opts = { defaultCollapsed: config.tools[toolName].default_collapsed };
  if (toolName === "moonshot_search") return buildMoonshotSearchTool(opts);
  if (toolName === "moonshot_fetch") return buildMoonshotFetchTool(opts);
  if (toolName === "kimi_datasource") return buildKimiDatasourceTool(opts);
  return undefined;
}

function registerConfiguredMoonshotTools(
  pi: ExtensionAPI,
  config: KimiCodeConfig,
  options: { updateActiveTools: boolean },
): void {
  for (const toolName of KIMI_TOOL_NAMES) {
    if (config.tools[toolName].enabled) {
      const tool = buildKimiTool(toolName, config);
      if (tool) pi.registerTool(tool);
    }
  }

  if (!options.updateActiveTools) return;

  const activeTools = new Set(pi.getActiveTools());
  for (const toolName of KIMI_TOOL_NAMES) {
    if (config.tools[toolName].enabled) {
      activeTools.add(toolName);
    } else {
      activeTools.delete(toolName);
    }
  }
  pi.setActiveTools([...activeTools]);
}

function reloadEffectiveKimiRuntimeConfig(
  state: KimiRuntimeState,
  cwd: string,
  projectTrusted: boolean,
): KimiCodeConfig {
  const config = loadKimiCodeConfig(
    { cwd, home: os.homedir(), includeProject: projectTrusted },
    state.overrides,
  );
  state.cwd = cwd;
  state.config = config;
  state.projectTrusted = projectTrusted;
  setStoreResolvedKimiConfig({
    model: resolveKimiModelConfig(
      config.model,
      getKimiModelMetadata(state.modelExtras, KIMI_CODING_MODEL_ID),
    ),
    protocol: config.protocol,
    uploads: config.uploads,
  });
  return config;
}

function applyEffectiveKimiRuntimeConfig(
  pi: ExtensionAPI,
  state: KimiRuntimeState,
  cwd: string,
  options: { updateActiveTools: boolean; projectTrusted: boolean },
): KimiCodeConfig {
  const config = reloadEffectiveKimiRuntimeConfig(state, cwd, options.projectTrusted);
  registerConfiguredMoonshotTools(pi, config, options);
  return config;
}

async function refreshModelExtras(
  state: KimiRuntimeState,
  token = getKimiUsageToken(),
): Promise<boolean> {
  if (!token) return false;
  const extras = await discoverKimiModelMetadata(token, state.config.protocol, {
    refreshAccessToken: refreshKimiAuthToken,
  });
  if (Object.keys(extras).length === 0) return false;
  Object.assign(state.modelExtras, extras);
  return true;
}

// Discovery can lose a race with a concurrent OAuth refresh: the token it
// started with may already be dead by the time the request goes out. Retry
// once, but only when the stored token actually changed underneath us.
async function discoverModelExtras(state: KimiRuntimeState): Promise<boolean> {
  const token = getKimiUsageToken();
  if (await refreshModelExtras(state, token)) return true;
  const refreshedToken = getKimiUsageToken();
  if (!refreshedToken || refreshedToken === token) return false;
  return refreshModelExtras(state, refreshedToken);
}

async function openSettingsMenu(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: KimiRuntimeState,
): Promise<void> {
  const modelDiscoveryToken = getKimiUsageToken();
  const [usageSnapshot, initialModelsRefreshed] = await Promise.all([
    fetchKimiUsageSnapshot(),
    refreshModelExtras(state),
  ]);
  let modelsRefreshed = initialModelsRefreshed;
  const refreshedToken = getKimiUsageToken();
  if (!modelsRefreshed && refreshedToken && refreshedToken !== modelDiscoveryToken) {
    modelsRefreshed = await refreshModelExtras(state);
  }
  if (modelsRefreshed) await registerKimiProvider(pi, state);
  const usage = usageSnapshot.summary;

  const projectTrusted = await isKimiProjectConfigApproved(ctx, ctx.cwd);
  const homeDraft = loadHomeKimiCodeConfig(os.homedir());
  const drafts: Record<KimiConfigScope, KimiCodeConfig> = {
    project: projectTrusted ? loadProjectKimiCodeConfig(ctx.cwd) : homeDraft,
    home: homeDraft,
  };
  let scope: KimiConfigScope = projectTrusted ? "project" : "home";
  let dirty = false;

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const settingsTheme = buildSettingsTheme(theme);

    let list: SettingsList;

    const toolLabel = (toolName: KimiToolName) => {
      if (toolName === "moonshot_search") return "Search tool";
      if (toolName === "moonshot_fetch") return "Fetch tool";
      return "Real-world data API";
    };

    const formatToolMenuValue = (toolName: KimiToolName) => {
      const tool = drafts[scope].tools[toolName];
      if (!tool.enabled) return "disabled";
      return tool.default_collapsed ? "enabled without preview" : "enabled with preview";
    };

    const refreshDisplays = () => {
      scopeItem.description = formatScopeDescription(scope, ctx.cwd);
      for (const toolName of KIMI_TOOL_NAMES) {
        list.updateValue(toolName, formatToolMenuValue(toolName));
      }
      list.updateValue("protocol", drafts[scope].protocol);
      list.updateValue("uploadThreshold", formatByteSize(drafts[scope].uploads.thresholdBytes));
    };

    const save = () => {
      if (scope === "project" && !projectTrusted) {
        ctx.ui.notify("Project config cannot be saved until the project is trusted.", "warning");
        return;
      }
      try {
        saveScopeKimiCodeConfig(scope, ctx.cwd, drafts[scope]);
        applyEffectiveKimiRuntimeConfig(pi, state, ctx.cwd, {
          updateActiveTools: true,
          projectTrusted: scope === "project" ? true : projectTrusted,
        });
        dirty = true;
      } catch (error: unknown) {
        ctx.ui.notify((error as Error).message, "error");
      }
    };

    const onChange = (id: string, newValue: string) => {
      if (id === "scope") {
        scope = newValue as KimiConfigScope;
        refreshDisplays();
        return;
      }
      if (id === "protocol") {
        drafts[scope].protocol = newValue as KimiCodeConfig["protocol"];
        list.updateValue(id, newValue);
        save();
        return;
      }
      if (id === "uploadThreshold") {
        const bytes = parseByteSizeInput(newValue);
        if (bytes === undefined || bytes <= 0) {
          ctx.ui.notify("Upload threshold must be a positive size, for example 2 MiB", "error");
          return;
        }
        drafts[scope].uploads.thresholdBytes = bytes;
        list.updateValue(id, formatByteSize(bytes));
        save();
        return;
      }
      const toolMatch = /^(?<tool>.+):(?<field>enabled|collapsed)$/.exec(id);
      if (toolMatch?.groups) {
        const toolName = toolMatch.groups.tool as KimiToolName;
        const field = toolMatch.groups.field as "enabled" | "collapsed";
        if (field === "enabled") {
          drafts[scope].tools[toolName].enabled = newValue === "true";
        } else {
          drafts[scope].tools[toolName].default_collapsed = newValue !== "true";
        }
        list.updateValue(toolName, formatToolMenuValue(toolName));
        save();
      }
    };

    const scopeItem: SettingItem = {
      id: "scope",
      label: "Config scope",
      description: projectTrusted
        ? formatScopeDescription(scope, ctx.cwd)
        : "Project config disabled until the project is trusted; editing home config only",
      currentValue: scope,
      values: projectTrusted ? ["project", "home"] : ["home"],
    };

    const items: SettingItem[] = [scopeItem];
    for (const toolName of KIMI_TOOL_NAMES) {
      items.push({
        id: toolName,
        label: toolLabel(toolName),
        description: `Configure ${toolName} registration and preview defaults`,
        currentValue: formatToolMenuValue(toolName),
        submenu: (_current, submenuDone) =>
          new SettingsList(
            [
              {
                id: `${toolName}:enabled`,
                label: "Enabled",
                description: `Register ${toolName} at session start`,
                currentValue: String(drafts[scope].tools[toolName].enabled),
                values: ["true", "false"],
              },
              {
                id: `${toolName}:collapsed`,
                label: "Show preview",
                description: `Show ${toolName} result previews by default`,
                currentValue: String(!drafts[scope].tools[toolName].default_collapsed),
                values: ["true", "false"],
              },
            ],
            2,
            settingsTheme,
            onChange,
            () => submenuDone(),
          ),
      });
    }
    items.push({
      id: "protocol",
      label: "Protocol",
      description: "API protocol for Kimi requests",
      currentValue: drafts[scope].protocol,
      values: ["openai", "anthropic"],
    });
    items.push({
      id: "uploadThreshold",
      label: "Upload threshold",
      description: "Max size for inline file uploads",
      currentValue: formatByteSize(drafts[scope].uploads.thresholdBytes),
      submenu: (_current, submenuDone) => {
        const input = new Input();
        input.setValue(formatByteSize(drafts[scope].uploads.thresholdBytes));
        input.onSubmit = (value) => {
          const bytes = parseByteSizeInput(value);
          if (bytes === undefined || bytes <= 0) {
            ctx.ui.notify("Upload threshold must be a positive size, for example 2 MiB", "error");
            submenuDone();
            return;
          }
          submenuDone(formatByteSize(bytes));
        };
        input.onEscape = () => submenuDone();
        return input;
      },
    });

    list = new SettingsList(items, items.length, settingsTheme, onChange, () => done(), {
      enableSearch: true,
    });

    return {
      items,
      onChange,
      render(width: number) {
        const usageLines = usage.split("\n").map((line) => truncateToWidth(`  ${line}`, width));
        return [
          truncateToWidth(
            theme.fg("accent", theme.bold(`Kimi settings (provider v${PROVIDER_VERSION})`)),
            width,
          ),
          "",
          truncateToWidth(theme.fg("accent", theme.bold("Kimi usage")), width),
          ...usageLines,
          "",
          ...list.render(width),
        ];
      },
      handleInput(data: string) {
        list.handleInput?.(data);
        tui.requestRender();
      },
      invalidate() {
        list.invalidate();
      },
    };
  });

  if (dirty) await ctx.reload();
}

function saveScopeKimiCodeConfig(
  scope: KimiConfigScope,
  cwd: string,
  config: KimiCodeConfig,
): void {
  if (scope === "project") {
    saveProjectKimiCodeConfig(cwd, config);
  } else {
    saveHomeKimiCodeConfig(os.homedir(), config);
  }
}

function filterAvailableKimiModels<T extends { id: string }>(
  models: T[],
  extras: KimiOAuthExtras,
): T[] {
  const available =
    extras.modelCatalogVersion === KIMI_MODEL_CATALOG_VERSION && extras.modelCatalog
      ? new Set(Object.keys(extras.modelCatalog))
      : null;
  return models.filter((model) => !available || available.has(model.id));
}

function catalogModelIds(extras: KimiOAuthExtras): string[] {
  if (extras.modelCatalogVersion === KIMI_MODEL_CATALOG_VERSION && extras.modelCatalog) {
    return Object.keys(extras.modelCatalog);
  }
  return [KIMI_CODING_MODEL_ID, KIMI_CODING_HIGHSPEED_MODEL_ID, KIMI_K3_MODEL_ID];
}

function buildKimiCatalogModels(state: KimiRuntimeState) {
  return catalogModelIds(state.modelExtras).map((modelId) =>
    applyKimiOAuthExtrasToModel(
      buildKimiModelFromConfig(state.config.model, modelId),
      getKimiModelMetadata(state.modelExtras, modelId),
      state.config.model.reasoningMap,
    ),
  );
}

// Node reports a missing subpath export (pi-ai <=0.79) and a missing package
// with these codes. All mean "this pi-ai has no compat layer", which is an
// expected configuration rather than a failure worth reporting: the fallback
// simply does not exist there.
//
// MODULE_NOT_FOUND (the CJS code, without the ERR_ prefix) covers pi's jiti
// extension loader on old pi versions: it aliases the bare "@earendil-works/pi-ai"
// specifier straight to dist/index.js, so the "/compat" subpath degrades into
// the bogus file path "dist/index.js/compat" and fails legacy CJS resolution
// instead of exports-map resolution.
const MODULE_UNAVAILABLE_CODES = new Set([
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "MODULE_NOT_FOUND",
]);

// Every api id this extension can hand out, not only the one for the currently
// configured protocol: sessions persist the api id that was current when the
// model was resolved, so a session created before a protocol switch still
// carries the other id and would keep crashing. streamSimpleKimi routes on the
// model's wireProtocol / the resolved runtime config and never on model.api, so
// both ids dispatch identically.
const KIMI_FALLBACK_APIS = [getKimiApiType("openai"), getKimiApiType("anthropic")];

type PiAiApiRegistry = {
  registerApiProvider: (
    provider: {
      api: string;
      stream: typeof streamSimpleKimi;
      streamSimple: typeof streamSimpleKimi;
    },
    sourceId: string,
  ) => void;
  unregisterApiProviders: (sourceId: string) => void;
  getApiProvider: (api: string) => unknown;
};

async function loadPiAiApiRegistry(action: string): Promise<PiAiApiRegistry | null> {
  try {
    return (await import(piAiCompatModule)) as PiAiApiRegistry;
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && MODULE_UNAVAILABLE_CODES.has(code)) return null;
    console.error(
      `[pi-provider-kimi-code] failed to ${action} the global api fallback:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

let nextFallbackSourceId = 0;
const liveFallbackSources = new Set<string>();

function createKimiGlobalFallbackSourceId(): string {
  nextFallbackSourceId += 1;
  return `${KIMI_GLOBAL_FALLBACK_SOURCE_ID}:${nextFallbackSourceId}`;
}

async function registerKimiGlobalApiFallback(sourceId: string): Promise<void> {
  if (!liveFallbackSources.has(sourceId)) return;
  const registry = await loadPiAiApiRegistry("register");
  if (!registry) return;
  for (const api of KIMI_FALLBACK_APIS) {
    // Never displace an entry someone else owns: this is a shared,
    // process-wide table and the fallback only exists to fill a hole, not to
    // win a conflict. pi-ai installs its own builtins under the same rule.
    if (registry.getApiProvider(api)) continue;
    registry.registerApiProvider(
      { api, stream: streamSimpleKimi, streamSimple: streamSimpleKimi },
      sourceId,
    );
  }
}

// The registry outlives each session. Remove only the entries owned by the
// retiring runtime, then hand any holes to another live runtime.
async function unregisterKimiGlobalApiFallback(sourceId: string): Promise<void> {
  if (!liveFallbackSources.delete(sourceId)) return;
  const registry = await loadPiAiApiRegistry("unregister");
  if (!registry) return;
  registry.unregisterApiProviders(sourceId);
  const successor = liveFallbackSources.values().next().value;
  if (successor) await registerKimiGlobalApiFallback(successor);
}

async function registerKimiProvider(pi: ExtensionAPI, state: KimiRuntimeState): Promise<void> {
  await registerKimiGlobalApiFallback(state.fallbackSourceId);
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: getBaseUrl(state.config.protocol),
    apiKey: "$KIMI_API_KEY",
    api: getKimiApiType(state.config.protocol),
    streamSimple: streamSimpleKimi,

    models: filterAvailableKimiModels(buildKimiCatalogModels(state), state.modelExtras),

    oauth: {
      name: "Kimi Code (OAuth)",
      login: async (callbacks) => {
        const credentials = await loginKimiCode(callbacks);
        return credentials;
      },
      refreshToken: async (credentials) => {
        const refreshed = await refreshKimiCodeToken(credentials);
        return refreshed;
      },
      getApiKey: getKimiApiKey,
      // Reflect server-side model identity on the registered model after login
      // / refresh. We never rewrite the model id (pi-side `/model` selections
      // and persisted sessions reference it); only the human-facing name, the
      // context window, and an out-of-band `wireModelId` carried into the
      // request payload by streamSimpleKimi.
      modifyModels: (models, cred) => {
        const extras = cred as KimiOAuthCredentials;
        // Retain previously discovered extras when this credential carries
        // none (legacy format or failed discovery): applying empty metadata
        // would strip thinking levels the startup discovery already found.
        if (hasKimiModelMetadata(extras)) state.modelExtras = extras;
        reloadEffectiveKimiRuntimeConfig(state, state.cwd, state.projectTrusted);
        const available =
          extras.modelCatalogVersion === KIMI_MODEL_CATALOG_VERSION && extras.modelCatalog
            ? new Set(Object.keys(extras.modelCatalog))
            : null;
        if (!available) {
          return [
            ...models.filter((model) => model.provider !== PROVIDER_ID),
            ...models
              .filter((model) => model.provider === PROVIDER_ID)
              .map((model) => {
                const metadata = getKimiModelMetadata(extras, model.id);
                if (!hasKimiModelMetadata(metadata)) return model;
                return applyKimiOAuthExtrasToModel(
                  model,
                  metadata,
                  state.config.model.reasoningMap,
                );
              }),
          ];
        }
        const catalogModels = catalogModelIds(extras).map((modelId) => {
          const existing = models.find(
            (model) => model.provider === PROVIDER_ID && model.id === modelId,
          );
          return applyKimiOAuthExtrasToModel(
            existing ?? {
              ...buildKimiModelFromConfig(state.config.model, modelId),
              api: getKimiApiType(state.config.protocol),
              provider: PROVIDER_ID,
              baseUrl: getBaseUrl(state.config.protocol),
            },
            getKimiModelMetadata(extras, modelId),
            state.config.model.reasoningMap,
          );
        });
        let insertedCatalog = false;
        return models.flatMap((model) => {
          if (model.provider !== PROVIDER_ID) return [model];
          if (insertedCatalog) return [];
          insertedCatalog = true;
          return catalogModels;
        });
      },
    },
  });
}

// What pi throws from any `pi` method once the extension runtime behind it has
// been retired, which is what a /reload does. Same wording on every version
// this extension supports (0.78.1 through 0.83.0); if it ever changes, the
// worst case is that a reload race gets logged instead of ignored.
const STALE_EXTENSION_RUNTIME_PREFIX = "This extension ctx is stale";

let pendingModelDiscovery: Promise<void> = Promise.resolve();

/**
 * Resolves once the discovery started by the most recent extension load has
 * settled. Nothing in the runtime waits for it; it exists so tests can observe
 * the deferred registration without polling.
 */
export function kimiModelDiscoverySettled(): Promise<void> {
  return pendingModelDiscovery;
}

// pi's extension loader awaits this factory before it builds the session, and
// the TUI only draws its first frame after that returns, so a network round
// trip here is a stall the user sees on every launch and every /reload. The
// stored OAuth credential already carries the last known catalog (pi replays it
// through oauth.modifyModels), so register what the config describes right away
// and fold the fresh metadata in when it lands.
function startModelDiscovery(pi: ExtensionAPI, state: KimiRuntimeState): void {
  pendingModelDiscovery = discoverModelExtras(state)
    .then((discovered) => {
      if (!discovered) return;
      reloadEffectiveKimiRuntimeConfig(state, state.cwd, state.projectTrusted);
      return registerKimiProvider(pi, state);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // A /reload retires this extension runtime while discovery may still be
      // in flight, and registering against a retired runtime throws. The
      // reloaded factory runs its own discovery, so there is nothing to redo.
      if (message.startsWith(STALE_EXTENSION_RUNTIME_PREFIX)) return;
      // Anything else used to surface as an extension load failure, back when
      // this ran inside the factory. Deferring it must not make it invisible:
      // the provider stays registered with the metadata it already had, and
      // the user needs to know why it stopped refreshing.
      console.error("[kimi-coding] deferred model discovery failed:", message);
    });
}

export function KimiCode(overrides?: KimiCodeConfigPatch): ExtensionFactory {
  return async (pi: ExtensionAPI) => {
    const cwd = process.cwd();
    const config = loadKimiCodeConfig(
      { cwd, home: os.homedir(), includeProject: false },
      overrides,
    );
    const state: KimiRuntimeState = {
      cwd,
      config,
      fallbackSourceId: createKimiGlobalFallbackSourceId(),
      modelExtras: {},
      projectTrusted: false,
      overrides,
    };
    reloadEffectiveKimiRuntimeConfig(state, cwd, false);
    liveFallbackSources.add(state.fallbackSourceId);
    try {
      await registerKimiProvider(pi, state);
    } catch (error) {
      liveFallbackSources.delete(state.fallbackSourceId);
      throw error;
    }

    registerConfiguredMoonshotTools(pi, state.config, { updateActiveTools: false });

    pi.on("session_start", async (_event, ctx) => {
      const projectTrusted = await isKimiProjectConfigApproved(ctx, ctx.cwd);
      applyEffectiveKimiRuntimeConfig(pi, state, ctx.cwd, {
        updateActiveTools: true,
        projectTrusted,
      });
      await registerKimiProvider(pi, state);
    });

    pi.on("session_shutdown", async () => {
      await unregisterKimiGlobalApiFallback(state.fallbackSourceId);
    });

    pi.registerCommand("kimi-settings", {
      description: "Show Kimi usage and configure optional Kimi tools",
      handler: async (_args, ctx) => {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/kimi-settings requires TUI mode", "error");
          return;
        }
        await openSettingsMenu(pi, ctx, state);
      },
    });

    startModelDiscovery(pi, state);
  };
}

export default KimiCode();
