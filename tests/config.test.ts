import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadKimiCodeConfig, saveProjectKimiCodeConfig } from "../src/config.ts";

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

describe("loadKimiCodeConfig", () => {
  it("returns defaults when no config files exist", () => {
    const cwd = tempDir("kimi-config-cwd");
    const home = tempDir("kimi-config-home");

    assert.deepEqual(loadKimiCodeConfig({ cwd, home }), {
      tools: {
        moonshot_search: { enabled: false, default_collapsed: true },
        moonshot_fetch: { enabled: false, default_collapsed: true },
      },
    });
  });

  it("reads global config", () => {
    const cwd = tempDir("kimi-config-cwd");
    const home = tempDir("kimi-config-home");
    writeJson(join(home, ".pi", "agent", "pi-provider-kimi-code.json"), {
      tools: { moonshot_search: { enabled: true } },
    });

    assert.deepEqual(loadKimiCodeConfig({ cwd, home }), {
      tools: {
        moonshot_search: { enabled: true, default_collapsed: true },
        moonshot_fetch: { enabled: false, default_collapsed: true },
      },
    });
  });

  it("deep-merges project config over global config", () => {
    const cwd = tempDir("kimi-config-cwd");
    const home = tempDir("kimi-config-home");
    writeJson(join(home, ".pi", "agent", "pi-provider-kimi-code.json"), {
      tools: {
        moonshot_search: { enabled: true },
        moonshot_fetch: { enabled: false },
      },
    });
    writeJson(join(cwd, ".pi", "pi-provider-kimi-code.json"), {
      tools: { moonshot_fetch: { enabled: true } },
    });

    assert.deepEqual(loadKimiCodeConfig({ cwd, home }), {
      tools: {
        moonshot_search: { enabled: true, default_collapsed: true },
        moonshot_fetch: { enabled: true, default_collapsed: true },
      },
    });
  });

  it("reads default_collapsed when explicitly configured", () => {
    const cwd = tempDir("kimi-config-cwd");
    const home = tempDir("kimi-config-home");
    writeJson(join(cwd, ".pi", "pi-provider-kimi-code.json"), {
      tools: {
        moonshot_search: { enabled: true, default_collapsed: false },
        moonshot_fetch: { enabled: false, default_collapsed: true },
      },
    });

    assert.deepEqual(loadKimiCodeConfig({ cwd, home }), {
      tools: {
        moonshot_search: { enabled: true, default_collapsed: false },
        moonshot_fetch: { enabled: false, default_collapsed: true },
      },
    });
  });

  it("lets project config disable a globally enabled tool", () => {
    const cwd = tempDir("kimi-config-cwd");
    const home = tempDir("kimi-config-home");
    writeJson(join(home, ".pi", "agent", "pi-provider-kimi-code.json"), {
      tools: { moonshot_search: { enabled: true } },
    });
    writeJson(join(cwd, ".pi", "pi-provider-kimi-code.json"), {
      tools: { moonshot_search: { enabled: false } },
    });

    assert.deepEqual(loadKimiCodeConfig({ cwd, home }), {
      tools: {
        moonshot_search: { enabled: false, default_collapsed: true },
        moonshot_fetch: { enabled: false, default_collapsed: true },
      },
    });
  });

  it("ignores malformed JSON and logs an error", () => {
    const cwd = tempDir("kimi-config-cwd");
    const home = tempDir("kimi-config-home");
    const configPath = join(home, ".pi", "agent", "pi-provider-kimi-code.json");
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, "{", "utf8");

    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      assert.deepEqual(loadKimiCodeConfig({ cwd, home }), {
        tools: {
          moonshot_search: { enabled: false, default_collapsed: true },
          moonshot_fetch: { enabled: false, default_collapsed: true },
        },
      });
      assert.equal(errors.length, 1);
    } finally {
      console.error = originalError;
    }
  });

  it("returns the full default-shaped object when one nested key is set", () => {
    const cwd = tempDir("kimi-config-cwd");
    const home = tempDir("kimi-config-home");
    writeJson(join(cwd, ".pi", "pi-provider-kimi-code.json"), {
      tools: { moonshot_search: { enabled: true } },
    });

    assert.deepEqual(loadKimiCodeConfig({ cwd, home }), {
      tools: {
        moonshot_search: { enabled: true, default_collapsed: true },
        moonshot_fetch: { enabled: false, default_collapsed: true },
      },
    });
  });

  it("saves project config and preserves unrelated keys", () => {
    const cwd = tempDir("kimi-config-cwd");
    const configPath = join(cwd, ".pi", "pi-provider-kimi-code.json");
    writeJson(configPath, {
      model: { name: "custom" },
      tools: {
        other_tool: { enabled: true },
        moonshot_search: { enabled: true, default_collapsed: false },
      },
    });

    saveProjectKimiCodeConfig(cwd, {
      tools: {
        moonshot_search: { enabled: false, default_collapsed: true },
        moonshot_fetch: { enabled: true, default_collapsed: false },
      },
    });

    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      model: { name: "custom" },
      tools: {
        other_tool: { enabled: true },
        moonshot_search: { enabled: false, default_collapsed: true },
        moonshot_fetch: { enabled: true, default_collapsed: false },
      },
    });
  });

  it("overwrites a malformed project config with the resolved shape", () => {
    const cwd = tempDir("kimi-config-cwd");
    const configPath = join(cwd, ".pi", "pi-provider-kimi-code.json");
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, "{", "utf8");

    saveProjectKimiCodeConfig(cwd, {
      tools: {
        moonshot_search: { enabled: true, default_collapsed: true },
        moonshot_fetch: { enabled: false, default_collapsed: false },
      },
    });

    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      tools: {
        moonshot_search: { enabled: true, default_collapsed: true },
        moonshot_fetch: { enabled: false, default_collapsed: false },
      },
    });
  });
});
