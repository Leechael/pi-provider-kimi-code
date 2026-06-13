import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadKimiCodeConfig,
  saveKimiCodeConfig,
  ensureKimiCodeConfig,
  ConfigError,
  KIMI_CODE_CONFIG_TEMPLATE,
  kimiCodeConfigPath,
} from "../src/config.ts";

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function fullConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: {
      contextWindow: 262144,
      maxTokens: 32000,
      input: ["text", "image"],
      reasoning: true,
      reasoningMap: {
        none: { effort: null, enabled: false },
        low: { effort: "low", enabled: true },
        medium: { effort: "medium", enabled: true },
        high: { effort: "high", enabled: true },
        xhigh: { effort: "high", enabled: true },
      },
      thinkingKeep: "all",
      generation: {},
    },
    tools: {
      moonshot_search: { enabled: false, default_collapsed: true },
      moonshot_fetch: { enabled: false, default_collapsed: true },
    },
    uploads: { thresholdBytes: 1048576 },
    protocol: "openai",
    ...overrides,
  };
}

const REASONING_MAP = {
  none: { effort: null, enabled: false },
  low: { effort: "low", enabled: true },
  medium: { effort: "medium", enabled: true },
  high: { effort: "high", enabled: true },
  xhigh: { effort: "high", enabled: true },
};

describe("loadKimiCodeConfig", () => {
  it("throws ConfigError when no config file exists and bootstrap writes template", () => {
    const home = tempDir("kimi-config-home");

    const created = ensureKimiCodeConfig(home);
    assert.equal(created, true);

    const loaded = loadKimiCodeConfig(home);
    assert.deepEqual(loaded.model, KIMI_CODE_CONFIG_TEMPLATE.model);
    assert.deepEqual(loaded.tools, KIMI_CODE_CONFIG_TEMPLATE.tools);
    assert.deepEqual(loaded.uploads, KIMI_CODE_CONFIG_TEMPLATE.uploads);
    assert.equal(loaded.protocol, KIMI_CODE_CONFIG_TEMPLATE.protocol);
  });

  it("reads complete config", () => {
    const home = tempDir("kimi-config-home");
    writeJson(kimiCodeConfigPath(home), fullConfig({
      tools: {
        moonshot_search: { enabled: true, default_collapsed: true },
        moonshot_fetch: { enabled: false, default_collapsed: true },
      },
      model: {
        ...(fullConfig().model as Record<string, unknown>),
        maxTokens: 64000,
      },
    }));

    const loaded = loadKimiCodeConfig(home);
    assert.equal(loaded.model.maxTokens, 64000);
    assert.equal(loaded.tools.moonshot_search.enabled, true);
  });

  it("reads default_collapsed from config", () => {
    const home = tempDir("kimi-config-home");
    writeJson(kimiCodeConfigPath(home), fullConfig({
      tools: {
        moonshot_search: { enabled: true, default_collapsed: false },
        moonshot_fetch: { enabled: false, default_collapsed: true },
      },
    }));

    const loaded = loadKimiCodeConfig(home);
    assert.equal(loaded.tools.moonshot_search.default_collapsed, false);
    assert.equal(loaded.tools.moonshot_fetch.default_collapsed, true);
  });

  it("throws on missing 'model' top-level field", () => {
    const home = tempDir("kimi-config-home");
    writeJson(kimiCodeConfigPath(home), {
      tools: fullConfig().tools,
      uploads: fullConfig().uploads,
      protocol: "openai",
    });

    assert.throws(
      () => loadKimiCodeConfig(home),
      (e: unknown) => e instanceof ConfigError && e.message.includes("model"),
    );
  });

  it("throws on missing 'uploads' top-level field", () => {
    const home = tempDir("kimi-config-home");
    writeJson(kimiCodeConfigPath(home), {
      model: fullConfig().model,
      tools: fullConfig().tools,
      protocol: "openai",
    });

    assert.throws(
      () => loadKimiCodeConfig(home),
      (e: unknown) => e instanceof ConfigError && e.message.includes("uploads"),
    );
  });

  it("throws on missing 'protocol' top-level field", () => {
    const home = tempDir("kimi-config-home");
    writeJson(kimiCodeConfigPath(home), {
      model: fullConfig().model,
      tools: fullConfig().tools,
      uploads: fullConfig().uploads,
    });

    assert.throws(
      () => loadKimiCodeConfig(home),
      (e: unknown) => e instanceof ConfigError && e.message.includes("protocol"),
    );
  });

  it("throws on v1 config file (tools only)", () => {
    const home = tempDir("kimi-config-home");
    writeJson(kimiCodeConfigPath(home), {
      tools: fullConfig().tools,
    });

    assert.throws(
      () => loadKimiCodeConfig(home),
      (e: unknown) => e instanceof ConfigError,
    );
  });

  it("throws on model.maxTokens as string", () => {
    const home = tempDir("kimi-config-home");
    writeJson(kimiCodeConfigPath(home), fullConfig({
      model: {
        ...(fullConfig().model as Record<string, unknown>),
        maxTokens: "32000",
      },
    }));

    assert.throws(
      () => loadKimiCodeConfig(home),
      (e: unknown) =>
        e instanceof ConfigError &&
        e.configPath === "model.maxTokens" &&
        e.message.includes("positive number"),
    );
  });

  it("throws on model.input containing invalid modality", () => {
    const home = tempDir("kimi-config-home");
    writeJson(kimiCodeConfigPath(home), fullConfig({
      model: {
        ...(fullConfig().model as Record<string, unknown>),
        input: ["text", "image", "drawing"],
      },
    }));

    assert.throws(
      () => loadKimiCodeConfig(home),
      (e: unknown) =>
        e instanceof ConfigError &&
        e.message.includes("drawing"),
    );
  });

  it("throws on model.reasoningMap entry with wrong types", () => {
    const home = tempDir("kimi-config-home");
    writeJson(kimiCodeConfigPath(home), fullConfig({
      model: {
        ...(fullConfig().model as Record<string, unknown>),
        reasoningMap: {
          ...REASONING_MAP,
          xhigh: { effort: "high", enabled: "yes" },
        },
      },
    }));

    assert.throws(
      () => loadKimiCodeConfig(home),
      (e: unknown) =>
        e instanceof ConfigError &&
        e.configPath.includes("enabled"),
    );
  });

  it("throws on model.thinkingKeep with invalid value", () => {
    const home = tempDir("kimi-config-home");
    writeJson(kimiCodeConfigPath(home), fullConfig({
      model: {
        ...(fullConfig().model as Record<string, unknown>),
        thinkingKeep: "everything",
      },
    }));

    assert.throws(
      () => loadKimiCodeConfig(home),
      (e: unknown) =>
        e instanceof ConfigError &&
        e.configPath === "model.thinkingKeep",
    );
  });

  it("throws on uploads.thresholdBytes zero", () => {
    const home = tempDir("kimi-config-home");
    writeJson(kimiCodeConfigPath(home), fullConfig({
      uploads: { thresholdBytes: 0 },
    }));

    assert.throws(
      () => loadKimiCodeConfig(home),
      (e: unknown) =>
        e instanceof ConfigError &&
        e.configPath === "uploads.thresholdBytes",
    );
  });

  it("throws on protocol with invalid value", () => {
    const home = tempDir("kimi-config-home");
    writeJson(kimiCodeConfigPath(home), fullConfig({
      protocol: "grpc",
    }));

    assert.throws(
      () => loadKimiCodeConfig(home),
      (e: unknown) =>
        e instanceof ConfigError &&
        e.configPath === "protocol",
    );
  });

  it("throws on tools.moonshot_search.enabled missing", () => {
    const home = tempDir("kimi-config-home");
    const base = fullConfig();
    writeJson(kimiCodeConfigPath(home), {
      ...base,
      tools: {
        moonshot_fetch: { enabled: false, default_collapsed: true },
      },
    });

    assert.throws(
      () => loadKimiCodeConfig(home),
      (e: unknown) =>
        e instanceof ConfigError &&
        e.message.includes("moonshot_search"),
    );
  });

  it("throws on malformed JSON config file", () => {
    const home = tempDir("kimi-config-home");
    const configPath = kimiCodeConfigPath(home);
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, "{", "utf8");

    assert.throws(
      () => loadKimiCodeConfig(home),
      (e: unknown) => e instanceof ConfigError || (e instanceof SyntaxError),
    );
  });

  it("throws on config file that is not a JSON object", () => {
    const home = tempDir("kimi-config-home");
    const configPath = kimiCodeConfigPath(home);
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, "[]", "utf8");

    assert.throws(
      () => loadKimiCodeConfig(home),
      (e: unknown) => e instanceof ConfigError,
    );
  });
});

describe("ensureKimiCodeConfig", () => {
  it("writes template when file missing", () => {
    const home = tempDir("kimi-config-home");
    const configPath = kimiCodeConfigPath(home);

    const created = ensureKimiCodeConfig(home);
    assert.equal(created, true);

    const content = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(content, JSON.parse(JSON.stringify(KIMI_CODE_CONFIG_TEMPLATE)));
  });

  it("does not overwrite existing file", () => {
    const home = tempDir("kimi-config-home");
    const configPath = kimiCodeConfigPath(home);
    writeJson(configPath, fullConfig({
      model: {
        ...(fullConfig().model as Record<string, unknown>),
        maxTokens: 99999,
      },
    }));

    const created = ensureKimiCodeConfig(home);
    assert.equal(created, false);

    const content = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(content.model.maxTokens, 99999);
  });
});

describe("saveKimiCodeConfig", () => {
  it("writes the full config to the home file", () => {
    const home = tempDir("kimi-config-home");
    const configPath = kimiCodeConfigPath(home);

    saveKimiCodeConfig(home, KIMI_CODE_CONFIG_TEMPLATE);

    const content = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(content, JSON.parse(JSON.stringify(KIMI_CODE_CONFIG_TEMPLATE)));
  });

  it("overwrites a malformed file with the full config", () => {
    const home = tempDir("kimi-config-home");
    const configPath = kimiCodeConfigPath(home);
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, "{", "utf8");

    const cfg = {
      ...KIMI_CODE_CONFIG_TEMPLATE,
      tools: {
        moonshot_search: { enabled: true, default_collapsed: true },
        moonshot_fetch: { enabled: false, default_collapsed: false },
      },
    };

    saveKimiCodeConfig(home, cfg);

    const content = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(content, JSON.parse(JSON.stringify(cfg)));
  });
});
