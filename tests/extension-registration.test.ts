import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import registerKimiCodeExtension from "../index.ts";

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

function withCwd<T>(cwd: string, fn: () => T): T {
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(originalCwd);
  }
}

function makePi() {
  const tools: ToolDefinition[] = [];
  const providers: string[] = [];
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  let activeTools: string[] = [];
  const pi = {
    registerProvider(name: string) {
      providers.push(name);
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
    tools,
    getActiveTools: () => activeTools,
    setActiveTools: (toolNames: string[]) => {
      activeTools = [...toolNames];
    },
  };
}

describe("extension tool registration", () => {
  it("does not register Moonshot tools when config is missing", () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { commands, pi, providers, tools } = makePi();

    withCwd(cwd, () => registerKimiCodeExtension(pi));

    assert.deepEqual(providers, ["kimi-coding"]);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [],
    );
    assert.ok(commands.has("kimi"));
  });

  it("registers only enabled Moonshot tools", () => {
    const cwd = tempDir("kimi-extension-cwd");
    const configPath = join(cwd, ".pi", "pi-provider-kimi-code.json");
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        tools: {
          moonshot_search: { enabled: true, default_collapsed: false },
          moonshot_fetch: { enabled: false },
        },
      }),
      "utf8",
    );
    const { pi, tools } = makePi();

    withCwd(cwd, () => registerKimiCodeExtension(pi));

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

  it("writes project config and updates active tools from /kimi", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const configPath = join(cwd, ".pi", "pi-provider-kimi-code.json");
    const { commands, getActiveTools, pi, setActiveTools, tools } = makePi();
    setActiveTools(["shell", "moonshot_fetch"]);
    const choices = ["Toggle moonshot_search enabled", "Toggle moonshot_fetch collapsed", "Done"];
    const titles: string[] = [];
    const notifications: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalKimiApiKey = process.env.KIMI_API_KEY;
    process.env.KIMI_API_KEY = "test-key";
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ usage: { limit: 100, remaining: 80 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    try {
      withCwd(cwd, () => registerKimiCodeExtension(pi));
      const kimiCommand = commands.get("kimi");
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

    assert.match(titles[0], /Weekly limit: 80% left \(80\/100\)/);
    assert.match(titles[0], /moonshot_search: disabled, default collapsed/);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      tools: {
        moonshot_search: { enabled: true, default_collapsed: true },
        moonshot_fetch: { enabled: false, default_collapsed: false },
      },
    });
    assert.deepEqual(getActiveTools(), ["shell", "moonshot_search"]);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["moonshot_search"],
    );
    assert.deepEqual(notifications, ["Kimi config updated", "Kimi config updated"]);
  });
});
