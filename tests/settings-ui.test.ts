import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_KIMI_CODE_CONFIG,
  type KimiCodeConfig,
  type KimiCodeConfigSources,
} from "../src/config.ts";
import { PROVIDER_VERSION } from "../src/constants.ts";
import {
  buildConfigScopeTitle,
  buildKimiMainTitle,
  buildSettingsTheme,
  formatByteSize,
  formatProtocolStatus,
  formatScopeDescription,
  formatToolStatus,
  formatUploadThresholdStatus,
  homeRelative,
  moonshotStatus,
  parseByteSizeInput,
  protocolMenuItem,
  setProtocol,
  setUploadThreshold,
  toggleCollapsed,
  toggleEnabled,
  toolMenuItem,
  uploadThresholdMenuItem,
} from "../src/settings-ui.ts";

function config(overrides: Partial<KimiCodeConfig> = {}): KimiCodeConfig {
  return {
    ...DEFAULT_KIMI_CODE_CONFIG,
    ...overrides,
    model: { ...DEFAULT_KIMI_CODE_CONFIG.model, ...overrides.model },
    tools: { ...DEFAULT_KIMI_CODE_CONFIG.tools, ...overrides.tools },
    uploads: { ...DEFAULT_KIMI_CODE_CONFIG.uploads, ...overrides.uploads },
  };
}

function sources(overrides: Partial<KimiCodeConfigSources> = {}): KimiCodeConfigSources {
  return {
    model: {
      contextWindow: "default",
      maxTokens: "default",
      input: "default",
      reasoning: "default",
      reasoningMap: "default",
      thinkingKeep: "default",
      generation: {
        temperature: "default",
        topP: "default",
        maxCompletionTokens: "default",
      },
    },
    tools: {
      moonshot_search: { enabled: "home", default_collapsed: "home" },
      moonshot_fetch: { enabled: "project", default_collapsed: "default" },
      kimi_datasource: { enabled: "default", default_collapsed: "default" },
    },
    uploads: { thresholdBytes: "runtime" },
    protocol: "env",
    ...overrides,
  };
}

describe("byte size helpers", () => {
  it("formats byte sizes without changing existing labels", () => {
    assert.equal(formatByteSize(512), "512 B");
    assert.equal(formatByteSize(1024), "1 KiB");
    assert.equal(formatByteSize(1536), "1.50 KiB");
    assert.equal(formatByteSize(1024 ** 2), "1 MiB");
    assert.equal(formatByteSize(1_500_000), "1.43 MiB");
  });

  it("parses byte size input units and defaults plain numbers to MiB", () => {
    assert.equal(parseByteSizeInput("2"), 2 * 1024 ** 2);
    assert.equal(parseByteSizeInput("512 KiB"), 512 * 1024);
    assert.equal(parseByteSizeInput("1.5 MB"), 1_500_000);
    assert.equal(parseByteSizeInput("1 kb"), 1000);
    assert.equal(parseByteSizeInput("0"), undefined);
    assert.equal(parseByteSizeInput("n/a"), undefined);
  });
});

describe("settings title, status, and menu helpers", () => {
  const effectiveConfig = config({
    protocol: "anthropic",
    uploads: { thresholdBytes: 1536 },
    tools: {
      moonshot_search: { enabled: true, default_collapsed: false },
      moonshot_fetch: { enabled: false, default_collapsed: true },
      kimi_datasource: { enabled: true, default_collapsed: true },
    },
  });

  it("builds the main settings title from supplied config sources", () => {
    assert.equal(
      buildKimiMainTitle(effectiveConfig, { modelDisplay: "Kimi K2" }, sources()),
      [
        `Kimi settings (provider v${PROVIDER_VERSION})`,
        "",
        "Model: Kimi K2",
        "Protocol: anthropic (env)",
        "Upload threshold: 1.50 KiB (runtime)",
        "",
        "Effective tools:",
        "- moonshot_search: enabled (home)",
        "- moonshot_fetch: disabled (project)",
        "- kimi_datasource: enabled (default)",
      ].join("\n"),
    );
  });

  it("builds scope title, status text, and menu labels", () => {
    assert.equal(
      buildConfigScopeTitle("home", effectiveConfig, "~/.pi/providers/kimi-coding/config.json"),
      [
        "Edit home config",
        "File: ~/.pi/providers/kimi-coding/config.json",
        "",
        "protocol: anthropic",
        "upload threshold: 1.50 KiB",
        "",
        "moonshot_search: enabled, default expanded",
        "moonshot_fetch: disabled, default collapsed",
        "kimi_datasource: enabled, default collapsed",
      ].join("\n"),
    );
    assert.equal(formatProtocolStatus(effectiveConfig), "protocol: anthropic");
    assert.equal(formatUploadThresholdStatus(effectiveConfig), "upload threshold: 1.50 KiB");
    assert.equal(formatToolStatus(effectiveConfig, "moonshot_search"), "enabled, default expanded");
    assert.equal(
      toolMenuItem(effectiveConfig, "moonshot_search"),
      "moonshot_search -> enabled, default expanded",
    );
    assert.equal(protocolMenuItem(effectiveConfig), "Protocol -> anthropic");
    assert.equal(uploadThresholdMenuItem(effectiveConfig), "Upload threshold -> 1.50 KiB");
    assert.equal(
      moonshotStatus(effectiveConfig),
      [
        "moonshot_search: enabled, default expanded",
        "moonshot_fetch: disabled, default collapsed",
        "kimi_datasource: enabled, default collapsed",
      ].join("\n"),
    );
    assert.equal(
      homeRelative("/tmp/kimi-home/.pi/config.json", "/tmp/kimi-home"),
      "~/.pi/config.json",
    );
    assert.equal(
      homeRelative("/tmp/other/.pi/config.json", "/tmp/kimi-home"),
      "/tmp/other/.pi/config.json",
    );
    assert.equal(
      homeRelative("C:\\Users\\kimi\\.pi\\providers\\kimi-coding\\config.json", "C:\\Users\\kimi"),
      "~\\.pi\\providers\\kimi-coding\\config.json",
    );
  });
});

describe("settings config mutators", () => {
  it("returns updated copies for tool, protocol, and upload edits", () => {
    const base = config();

    const enabled = toggleEnabled(base, "moonshot_search");
    const expanded = toggleCollapsed(base, "moonshot_search");
    const protocol = setProtocol(base, "anthropic");
    const threshold = setUploadThreshold(base, 2048);

    assert.equal(base.tools.moonshot_search.enabled, false);
    assert.equal(enabled.tools.moonshot_search.enabled, true);
    assert.equal(expanded.tools.moonshot_search.default_collapsed, false);
    assert.equal(protocol.protocol, "anthropic");
    assert.equal(threshold.uploads.thresholdBytes, 2048);
  });
});

describe("SettingsList helpers", () => {
  it("builds a theme that delegates to the supplied theme", () => {
    const calls: string[] = [];
    const theme = {
      fg: (color: string, text: string) => {
        calls.push(`fg:${color}:${text}`);
        return text;
      },
      bold: (text: string) => `bold:${text}`,
    } as unknown as import("@earendil-works/pi-coding-agent").Theme;

    const settingsTheme = buildSettingsTheme(theme);
    assert.equal(settingsTheme.label("hello", false), "hello");
    assert.equal(settingsTheme.label("hello", true), "hello");
    assert.equal(settingsTheme.value("world", false), "world");
    assert.equal(settingsTheme.value("world", true), "bold:world");
    assert.equal(settingsTheme.description("desc"), "desc");
    assert.equal(settingsTheme.hint("hint"), "hint");
    assert.deepEqual(calls, [
      "fg:accent:> ",
      "fg:accent:hello",
      "fg:muted:world",
      "fg:accent:world",
      "fg:dim:desc",
      "fg:dim:hint",
    ]);
  });

  it("formats scope description with the config file path", () => {
    assert.equal(
      formatScopeDescription("home", "/tmp/project", "/tmp/home"),
      "Writes to the home config file: ~/.pi/providers/kimi-coding/config.json",
    );
    assert.equal(
      formatScopeDescription("project", "/tmp/project", "/tmp/home"),
      "Writes to the project config file: .pi/providers/kimi-coding/config.json",
    );
  });
});
