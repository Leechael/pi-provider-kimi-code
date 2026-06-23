import os from "node:os";
import { relative } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SettingsListTheme } from "@earendil-works/pi-tui";

import {
  type KimiCodeConfig,
  type KimiCodeConfigSources,
  KIMI_TOOL_NAMES,
  type KimiToolName,
  getGlobalKimiCodeConfigPath,
  getProjectKimiCodeConfigPath,
} from "./config.ts";
import { PROVIDER_VERSION } from "./constants.ts";
import type { KimiOAuthExtras } from "./models.ts";

export type KimiConfigScope = "project" | "home";

export function moonshotStatus(config: KimiCodeConfig): string {
  return KIMI_TOOL_NAMES.map((toolName) => {
    const tool = config.tools[toolName];
    const enabled = tool.enabled ? "enabled" : "disabled";
    const collapsed = tool.default_collapsed ? "collapsed" : "expanded";
    return `${toolName}: ${enabled}, default ${collapsed}`;
  }).join("\n");
}

export function toggleEnabled(config: KimiCodeConfig, toolName: KimiToolName): KimiCodeConfig {
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

export function toggleCollapsed(config: KimiCodeConfig, toolName: KimiToolName): KimiCodeConfig {
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

export function setProtocol(
  config: KimiCodeConfig,
  protocol: KimiCodeConfig["protocol"],
): KimiCodeConfig {
  return { ...config, protocol };
}

export function setUploadThreshold(config: KimiCodeConfig, thresholdBytes: number): KimiCodeConfig {
  return { ...config, uploads: { ...config.uploads, thresholdBytes } };
}

export function buildKimiMainTitle(
  config: KimiCodeConfig,
  extras: KimiOAuthExtras,
  sources: KimiCodeConfigSources,
): string {
  const modelName = extras.modelDisplay || "kimi-for-coding";
  return [
    `Kimi settings (provider v${PROVIDER_VERSION})`,
    "",
    `Model: ${modelName}`,
    `Protocol: ${config.protocol} (${sources.protocol})`,
    `Upload threshold: ${formatByteSize(config.uploads.thresholdBytes)} (${sources.uploads.thresholdBytes})`,
    "",
    "Effective tools:",
    ...KIMI_TOOL_NAMES.map((toolName) => {
      const enabled = config.tools[toolName].enabled ? "enabled" : "disabled";
      return `- ${toolName}: ${enabled} (${sources.tools[toolName].enabled})`;
    }),
  ].join("\n");
}

export function buildConfigScopeTitle(
  scope: KimiConfigScope,
  config: KimiCodeConfig,
  filePath: string,
): string {
  return [
    `Edit ${scope} config`,
    `File: ${filePath}`,
    "",
    formatProtocolStatus(config),
    formatUploadThresholdStatus(config),
    "",
    moonshotStatus(config),
  ].join("\n");
}

export function buildSettingsTheme(theme: Theme): SettingsListTheme {
  return {
    label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
    value: (text: string, selected: boolean) =>
      selected ? theme.bold(theme.fg("accent", text)) : theme.fg("muted", text),
    description: (text: string) => theme.fg("dim", text),
    cursor: theme.fg("accent", "> "),
    hint: (text: string) => theme.fg("dim", text),
  };
}

export function formatScopeDescription(
  scope: KimiConfigScope,
  cwd: string,
  home = os.homedir(),
): string {
  const filePath =
    scope === "project" ? getProjectKimiCodeConfigPath(cwd) : getGlobalKimiCodeConfigPath(home);
  const displayPath = scope === "home" ? homeRelative(filePath, home) : relative(cwd, filePath);
  return `Writes to the ${scope} config file: ${displayPath}`;
}

export function homeRelative(filePath: string, home = os.homedir()): string {
  const normalizedHome = home.replace(/[\\/]+$/, "");
  if (filePath === normalizedHome) return "~";

  const slashPrefix = `${normalizedHome}/`;
  if (filePath.startsWith(slashPrefix)) return `~/${filePath.slice(slashPrefix.length)}`;

  const backslashPrefix = `${normalizedHome}\\`;
  if (filePath.startsWith(backslashPrefix)) return `~\\${filePath.slice(backslashPrefix.length)}`;

  return filePath;
}

export function toolMenuItem(config: KimiCodeConfig, toolName: KimiToolName): string {
  return `${toolName} -> ${formatToolStatus(config, toolName)}`;
}

export function protocolMenuItem(config: KimiCodeConfig): string {
  return `Protocol -> ${config.protocol}`;
}

export function uploadThresholdMenuItem(config: KimiCodeConfig): string {
  return `Upload threshold -> ${formatByteSize(config.uploads.thresholdBytes)}`;
}

export function formatByteSize(bytes: number): string {
  const units = [
    { suffix: "GiB", size: 1024 ** 3 },
    { suffix: "MiB", size: 1024 ** 2 },
    { suffix: "KiB", size: 1024 },
  ];
  for (const unit of units) {
    if (bytes >= unit.size && bytes % unit.size === 0) {
      return `${bytes / unit.size} ${unit.suffix}`;
    }
  }
  for (const unit of units) {
    if (bytes >= unit.size) {
      return `${(bytes / unit.size).toFixed(2).replace(/\.00$/, "")} ${unit.suffix}`;
    }
  }
  return `${bytes} B`;
}

export function parseByteSizeInput(input: string): number | undefined {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(b|bytes?|kib|kb|mib|mb|gib|gb)?$/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = (match[2] ?? "mib").toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    byte: 1,
    bytes: 1,
    kib: 1024,
    kb: 1000,
    mib: 1024 ** 2,
    mb: 1000 ** 2,
    gib: 1024 ** 3,
    gb: 1000 ** 3,
  };
  const multiplier = multipliers[unit];
  if (!multiplier) return undefined;
  const bytes = Math.round(value * multiplier);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

export function formatProtocolStatus(config: KimiCodeConfig): string {
  return `protocol: ${config.protocol}`;
}

export function formatUploadThresholdStatus(config: KimiCodeConfig): string {
  return `upload threshold: ${formatByteSize(config.uploads.thresholdBytes)}`;
}

export function formatToolStatus(config: KimiCodeConfig, toolName: KimiToolName): string {
  const tool = config.tools[toolName];
  const enabled = tool.enabled ? "enabled" : "disabled";
  const collapsed = tool.default_collapsed ? "default collapsed" : "default expanded";
  return `${enabled}, ${collapsed}`;
}
