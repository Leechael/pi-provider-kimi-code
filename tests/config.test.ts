import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigError,
  DEFAULT_KIMI_CODE_CONFIG,
  KIMI_TOOL_NAMES,
  clearRuntimeKimiCodeConfigOverride,
  ensureKimiCodeConfig,
  getGlobalKimiCodeConfigPath,
  getProjectKimiCodeConfigPath,
  loadHomeKimiCodeConfig,
  loadKimiCodeConfig,
  loadKimiCodeConfigSources,
  loadProjectKimiCodeConfig,
  replaceRuntimeKimiCodeConfigOverride,
  saveHomeKimiCodeConfig,
  saveProjectKimiCodeConfig,
  setRuntimeKimiCodeConfigOverride,
  validateKimiCodeConfig,
  type KimiCodeConfig,
} from "../src/config.ts";

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function config(overrides: Partial<KimiCodeConfig> = {}): KimiCodeConfig {
  return {
    ...DEFAULT_KIMI_CODE_CONFIG,
    ...overrides,
    model: { ...DEFAULT_KIMI_CODE_CONFIG.model, ...overrides.model },
    tools: { ...DEFAULT_KIMI_CODE_CONFIG.tools, ...overrides.tools },
    uploads: { ...DEFAULT_KIMI_CODE_CONFIG.uploads, ...overrides.uploads },
  };
}

describe("loadKimiCodeConfig", () => {
  it("returns defaults when no config files exist", () => {
    const cwd = tempDir("kimi-config-cwd");
    const home = tempDir("kimi-config-home");

    assert.deepEqual(loadKimiCodeConfig({ cwd, home, env: {} }), DEFAULT_KIMI_CODE_CONFIG);
  });

  it("merges home, project, env, and runtime overrides in priority order", () => {
    const cwd = tempDir("kimi-config-cwd");
    const home = tempDir("kimi-config-home");
    writeJson(getGlobalKimiCodeConfigPath(home), {
      model: { maxTokens: 16000 },
      tools: { moonshot_search: { enabled: true } },
    });
    writeJson(getProjectKimiCodeConfigPath(cwd), {
      model: { maxTokens: 24000 },
      tools: { moonshot_search: { default_collapsed: false } },
    });

    try {
      setRuntimeKimiCodeConfigOverride({ model: { generation: { maxCompletionTokens: 64000 } } });
      const loaded = loadKimiCodeConfig({
        cwd,
        home,
        env: { KIMI_MODEL_MAX_COMPLETION_TOKENS: "32000" },
      });

      assert.equal(loaded.model.maxTokens, 24000);
      assert.equal(loaded.model.generation.maxCompletionTokens, 64000);
      assert.equal(loaded.tools.moonshot_search.enabled, true);
      assert.equal(loaded.tools.moonshot_search.default_collapsed, false);
    } finally {
      clearRuntimeKimiCodeConfigOverride();
    }
  });

  it("reports effective field sources", () => {
    const cwd = tempDir("kimi-config-cwd");
    const home = tempDir("kimi-config-home");
    writeJson(getGlobalKimiCodeConfigPath(home), {
      tools: { moonshot_search: { enabled: true, default_collapsed: false } },
    });
    writeJson(getProjectKimiCodeConfigPath(cwd), {
      tools: { moonshot_fetch: { enabled: false } },
    });

    try {
      replaceRuntimeKimiCodeConfigOverride({ uploads: { thresholdBytes: 2048 } });
      const sources = loadKimiCodeConfigSources({
        cwd,
        home,
        env: { KIMI_MODEL_MAX_COMPLETION_TOKENS: "32000" },
      });

      assert.equal(sources.tools.moonshot_search.enabled, "home");
      assert.equal(sources.tools.moonshot_fetch.enabled, "project");
      assert.equal(sources.model.generation.maxCompletionTokens, "env");
      assert.equal(sources.uploads.thresholdBytes, "runtime");
      assert.equal(sources.tools.kimi_datasource.enabled, "default");
    } finally {
      clearRuntimeKimiCodeConfigOverride();
    }
  });

  it("maps KIMI_MODEL_* env vars into config", () => {
    const cwd = tempDir("kimi-config-cwd");
    const home = tempDir("kimi-config-home");

    const loaded = loadKimiCodeConfig({
      cwd,
      home,
      env: {
        KIMI_MODEL_MAX_CONTEXT_SIZE: "512000",
        KIMI_MODEL_TEMPERATURE: "0.2",
        KIMI_MODEL_TOP_P: "0.8",
        KIMI_MODEL_MAX_COMPLETION_TOKENS: "12345",
        KIMI_MODEL_THINKING_KEEP: "last",
        KIMI_CODE_UPLOAD_THRESHOLD_BYTES: "4096",
      },
    });

    assert.equal(loaded.model.contextWindow, 512000);
    assert.deepEqual(loaded.model.generation, {
      temperature: 0.2,
      topP: 0.8,
      maxCompletionTokens: 12345,
    });
    assert.equal(loaded.model.thinkingKeep, "last");
    assert.equal(loaded.uploads.thresholdBytes, 4096);
  });

  it("throws ConfigError with a JSON pointer for invalid merged config", () => {
    const cwd = tempDir("kimi-config-cwd");
    const home = tempDir("kimi-config-home");
    writeJson(getProjectKimiCodeConfigPath(cwd), {
      model: { maxTokens: "32000" },
    });

    assert.throws(
      () => loadKimiCodeConfig({ cwd, home, env: {} }),
      (error: unknown) => error instanceof ConfigError && error.pointer === "/model/maxTokens",
    );
  });

  it("throws on malformed JSON config files", () => {
    const cwd = tempDir("kimi-config-cwd");
    const home = tempDir("kimi-config-home");
    const path = getGlobalKimiCodeConfigPath(home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{", "utf8");

    assert.throws(
      () => loadKimiCodeConfig({ cwd, home, env: {} }),
      (error: unknown) => error instanceof ConfigError && error.message.includes("invalid JSON"),
    );
  });
});

describe("validateKimiCodeConfig", () => {
  it("accepts complete config and skips null generation values", () => {
    const loaded = validateKimiCodeConfig(
      config({
        model: { ...DEFAULT_KIMI_CODE_CONFIG.model, generation: { temperature: null as never } },
      }),
    );

    assert.deepEqual(loaded.model.generation, {});
  });

  it("preserves all known tools", () => {
    const loaded = validateKimiCodeConfig(DEFAULT_KIMI_CODE_CONFIG);

    assert.deepEqual(Object.keys(loaded.tools).sort(), [...KIMI_TOOL_NAMES].sort());
  });
});

describe("layer config file helpers", () => {
  it("bootstraps config file when missing", () => {
    const home = tempDir("kimi-config-home");
    const path = getGlobalKimiCodeConfigPath(home);

    assert.equal(ensureKimiCodeConfig(home), true);
    assert.equal(ensureKimiCodeConfig(home), false);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), DEFAULT_KIMI_CODE_CONFIG);
  });

  it("loads and saves home config", () => {
    const home = tempDir("kimi-config-home");
    const next = config({ model: { ...DEFAULT_KIMI_CODE_CONFIG.model, maxTokens: 12345 } });

    saveHomeKimiCodeConfig(home, next);

    assert.deepEqual(loadHomeKimiCodeConfig(home), next);
  });

  it("loads and saves project config", () => {
    const cwd = tempDir("kimi-config-cwd");
    const next = config({ uploads: { thresholdBytes: 2048 } });

    saveProjectKimiCodeConfig(cwd, next);

    assert.deepEqual(loadProjectKimiCodeConfig(cwd), next);
  });
});
