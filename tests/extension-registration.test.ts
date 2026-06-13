import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderConfig,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import registerKimiCodeExtension from "../index.ts";
import { kimiCodeConfigPath } from "../src/config.ts";

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

async function withCwd<T>(cwd: string, fn: () => T | Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

function makePi() {
  const tools: ToolDefinition[] = [];
  const providers: string[] = [];
  const providerConfigs = new Map<string, ProviderConfig>();
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  let activeTools: string[] = [];
  const pi = {
    registerProvider(name: string, config: ProviderConfig) {
      providers.push(name);
      providerConfigs.set(name, config);
    },
    registerTool(tool: ToolDefinition) {
      const index = tools.findIndex((registered) => registered.name === tool.name);
      if (index === -1) {
        tools.push(tool);
      } else {
        tools[index] = tool;
      }
    },
    registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      commands.set(name, command);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(toolNames: string[]) {
      activeTools = [...toolNames];
    },
  } as unknown as ExtensionAPI;
  return {
    commands,
    pi,
    providers,
    providerConfigs,
    tools,
    getActiveTools: () => activeTools,
    setActiveTools: (toolNames: string[]) => {
      activeTools = [...toolNames];
    },
  };
}

describe("extension tool registration", () => {
  const originalHome = process.env.HOME;
  const home = tempDir("kimi-extension-home");
  process.env.HOME = home;
  process.on("exit", () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  function writeHomeConfig(value: unknown): void {
    const path = kimiCodeConfigPath(home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(value), "utf8");
  }

  function readHomeConfig(): unknown {
    return JSON.parse(readFileSync(kimiCodeConfigPath(home), "utf8"));
  }

  it("does not register Moonshot tools when config is missing", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { commands, pi, providers, tools } = makePi();

    await withCwd(cwd, () => registerKimiCodeExtension(pi));

    assert.deepEqual(providers, ["kimi-coding"]);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [],
    );
    assert.ok(commands.has("kimi-settings"));
  });

  it("registers KIMI_API_KEY with explicit pi config-value env syntax", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { pi, providerConfigs } = makePi();

    await withCwd(cwd, () => registerKimiCodeExtension(pi));

    assert.equal(providerConfigs.get("kimi-coding")?.apiKey, "$KIMI_API_KEY");
  });

  it("does not register dynamic Kimi identity headers as pi config values", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { pi, providerConfigs } = makePi();

    await withCwd(cwd, () => registerKimiCodeExtension(pi));

    assert.equal(providerConfigs.get("kimi-coding")?.headers, undefined);
  });

  it("registers only enabled Moonshot tools", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    writeHomeConfig({
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
        moonshot_search: { enabled: true, default_collapsed: false },
        moonshot_fetch: { enabled: false, default_collapsed: true },
      },
      uploads: { thresholdBytes: 1048576 },
      protocol: "openai",
    });
    const { pi, tools } = makePi();

    await withCwd(cwd, () => registerKimiCodeExtension(pi));

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["moonshot_search"],
    );
    const component = tools[0].renderResult!(
      {
        content: [{ type: "text", text: "full json" }],
        details: [{ title: "Example", url: "https://example.com", snippet: "Summary" }],
      },
      { expanded: false, isPartial: false },
      undefined as never,
      undefined as never,
    );
    assert.match(component.render(80).join("\n"), /"url": "https:\/\/example.com"/);
  });

  it("updates active tools from /kimi-settings", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    writeHomeConfig({
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
    });
    const { commands, getActiveTools, pi, setActiveTools, tools } = makePi();
    setActiveTools(["shell", "moonshot_fetch"]);
    const choices = [
      "Edit config",
      "moonshot_search -> disabled, default collapsed",
      "Enable moonshot_search",
      "Back",
      "moonshot_fetch -> disabled, default collapsed",
      "Expand previews by default",
      "Back",
      "Back",
      "Done",
    ];
    const titles: string[] = [];
    const notifications: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalKimiApiKey = process.env.KIMI_API_KEY;
    process.env.KIMI_API_KEY = "test-key";
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          user: { membership: { level: "LEVEL_INTERMEDIATE" } },
          usage: { limit: 100, remaining: 80 },
          limits: [{ detail: { limit: 200, used: 50 } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );

    try {
      await withCwd(cwd, () => registerKimiCodeExtension(pi));
      const kimiCommand = commands.get("kimi-settings");
      assert.ok(kimiCommand);

      await kimiCommand.handler("", {
        cwd,
        ui: {
          select: async (title: string) => {
            titles.push(title);
            return choices.shift();
          },
          notify: (message: string) => {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionCommandContext);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKimiApiKey === undefined) {
        delete process.env.KIMI_API_KEY;
      } else {
        process.env.KIMI_API_KEY = originalKimiApiKey;
      }
    }

    assert.doesNotMatch(titles[0], /Membership: Allegretto/);
    assert.match(notifications[0], /Membership: Allegretto \(LEVEL_INTERMEDIATE\)/);
    assert.match(notifications[0], /Weekly limit: \[################----\] 80% left \(80\/100\)/);
    assert.match(notifications[0], /5h rate limit: \[###############-----\] 75% left \(150\/200\)/);
    assert.equal(titles[0], "Kimi settings");
    assert.deepEqual(readHomeConfig(), {
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
        moonshot_search: { enabled: true, default_collapsed: true },
        moonshot_fetch: { enabled: false, default_collapsed: false },
      },
      uploads: { thresholdBytes: 1048576 },
      protocol: "openai",
    });
    assert.deepEqual(getActiveTools(), ["shell", "moonshot_search"]);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["moonshot_search"],
    );
    assert.deepEqual(notifications, [
      "Membership: Allegretto (LEVEL_INTERMEDIATE)\nWeekly limit: [################----] 80% left (80/100)\n5h rate limit: [###############-----] 75% left (150/200)",
      "Saved moonshot_search config",
      "Saved moonshot_fetch config",
    ]);
  });
});
