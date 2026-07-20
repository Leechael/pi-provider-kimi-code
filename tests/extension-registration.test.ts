import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderConfig,
  RegisteredCommand,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";
import {
  DEFAULT_KIMI_CODE_CONFIG,
  KIMI_TOOL_NAMES,
  getProjectKimiCodeConfigPath,
} from "../src/config.ts";
import { PROVIDER_ID } from "../src/constants.ts";
import registerKimiCodeExtension from "../index.ts";

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

async function withCwd<T>(cwd: string, fn: () => T | Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  process.chdir(cwd);
  process.env.HOME = cwd;
  try {
    return await fn();
  } finally {
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
}

async function withAgentDir<T>(agentDir: string, fn: () => T | Promise<T>): Promise<T> {
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await fn();
  } finally {
    if (originalDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalDir;
    }
  }
}

function writeProjectTrust(agentDir: string, cwd: string, trusted = true): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "trust.json"),
    JSON.stringify({ [realpathSync(cwd)]: trusted }),
    "utf8",
  );
}

function withTempAuthFile(credential: Record<string, unknown>) {
  const dir = tempDir("pi-kimi-auth");
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ [PROVIDER_ID]: credential }), "utf8");
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  const originalKimiCodeHome = process.env.KIMI_CODE_HOME;
  const originalKimiShareDir = process.env.KIMI_SHARE_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.KIMI_CODE_HOME = join(dir, "no-kimi-code");
  process.env.KIMI_SHARE_DIR = join(dir, "no-kimi-share");
  return {
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
      if (originalDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = originalDir;
      }
      if (originalKimiCodeHome === undefined) {
        delete process.env.KIMI_CODE_HOME;
      } else {
        process.env.KIMI_CODE_HOME = originalKimiCodeHome;
      }
      if (originalKimiShareDir === undefined) {
        delete process.env.KIMI_SHARE_DIR;
      } else {
        process.env.KIMI_SHARE_DIR = originalKimiShareDir;
      }
    },
  };
}

function makePi() {
  const tools: ToolDefinition[] = [];
  const providers: string[] = [];
  const providerConfigs = new Map<string, ProviderConfig>();
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const eventHandlers = new Map<
    string,
    Array<(event: unknown, ctx: unknown) => Promise<void> | void>
  >();
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
    on(eventName: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
      const handlers = eventHandlers.get(eventName) ?? [];
      handlers.push(handler);
      eventHandlers.set(eventName, handlers);
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
    emit: async (eventName: string, event: unknown, ctx: unknown) => {
      for (const handler of eventHandlers.get(eventName) ?? []) {
        await handler(event, ctx);
      }
    },
    getActiveTools: () => activeTools,
    setActiveTools: (toolNames: string[]) => {
      activeTools = [...toolNames];
    },
  };
}

function mockTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

type TestSettingItem = {
  id: string;
  label?: string;
  currentValue: string;
  values?: string[];
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => SettingsList;
};

type SettingsOperation = (list: SettingsList, done: () => void) => void;

async function runSettingsHandler(
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
  ctx: ExtensionCommandContext,
  operation: SettingsOperation,
): Promise<void> {
  const customCtx = {
    ...ctx,
    ui: {
      ...ctx.ui,
      custom: async (
        factory: (tui: unknown, theme: Theme, keybindings: unknown, done: () => void) => unknown,
      ) => {
        let resolveCustom: (() => void) | undefined;
        let doneCalled = false;
        const done = () => {
          doneCalled = true;
          if (resolveCustom) resolveCustom();
        };
        const component = factory(undefined, mockTheme(), undefined, done);
        operation(component as SettingsList, done);
        return new Promise<void>((resolve) => {
          resolveCustom = resolve;
          if (doneCalled) resolve();
        });
      },
    },
  } as unknown as ExtensionCommandContext;

  await handler("", customCtx);
}

describe("extension tool registration", () => {
  it("loads the extension module against installed Pi package exports", () => {
    assert.equal(typeof registerKimiCodeExtension, "function");
  });

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

  it("registers all Coding models as separate selections", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { pi, providerConfigs } = makePi();

    await withCwd(cwd, () => registerKimiCodeExtension(pi));

    const models = providerConfigs.get("kimi-coding")?.models ?? [];
    assert.deepEqual(
      models.map((model) => model.id),
      ["kimi-for-coding", "kimi-for-coding-highspeed", "k3"],
    );
    assert.equal(models[0]?.cost.input, 0.95);
    assert.equal(models[1]?.cost.input, 1.9);
    assert.equal(models[2]?.name, "Kimi K3");
    assert.equal(models[2]?.cost.input, 3);
  });

  it("applies discovered metadata to each registered Coding model", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { pi, providerConfigs } = makePi();

    await withCwd(cwd, () => registerKimiCodeExtension(pi));

    const provider = providerConfigs.get("kimi-coding");
    const modifyModels = provider?.oauth?.modifyModels;
    assert.ok(modifyModels);
    const models = modifyModels(
      provider.models?.map((model) => ({ ...model, provider: "kimi-coding" })) as never,
      {
        access: "oauth-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
        modelCatalogVersion: 1,
        modelCatalog: {
          "kimi-for-coding": {
            wireModelId: "kimi-for-coding",
            modelDisplay: "Kimi Standard",
            contextLength: 262144,
          },
          "kimi-for-coding-highspeed": {
            wireModelId: "kimi-for-coding-highspeed",
            modelDisplay: "Kimi High Speed",
            contextLength: 524288,
            supportsVideoIn: true,
          },
          k3: {
            wireModelId: "k3",
            modelDisplay: "k3",
            contextLength: 1048576,
            supportsThinkingType: "only",
            supportsImageIn: true,
            supportsVideoIn: true,
            supportEfforts: ["max"],
            defaultEffort: "max",
          },
        },
      } as never,
    );

    assert.equal(models[0]?.name, "Kimi Standard");
    assert.equal(models[1]?.name, "Kimi High Speed");
    assert.equal(models[1]?.contextWindow, 524288);
    assert.deepEqual(models[1]?.input, ["text", "image", "video"]);
    assert.equal(models[2]?.name, "Kimi K3");
    assert.equal(models[2]?.contextWindow, 1048576);
    assert.deepEqual(models[2]?.input, ["text", "image", "video"]);
    assert.deepEqual(
      (models[2] as (typeof models)[number] & { supportEfforts?: string[] }).supportEfforts,
      ["max"],
    );
  });

  it("registers every model advertised by a fresh catalog", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { pi, providerConfigs } = makePi();

    await withCwd(cwd, () => registerKimiCodeExtension(pi));

    const provider = providerConfigs.get("kimi-coding");
    const modifyModels = provider?.oauth?.modifyModels;
    assert.ok(modifyModels);
    const models = modifyModels(
      provider.models?.map((model) => ({
        ...model,
        api: provider.api,
        provider: PROVIDER_ID,
        baseUrl: provider.baseUrl,
      })) as never,
      {
        access: "oauth-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
        modelCatalogVersion: 1,
        modelCatalog: {
          "kimi-for-coding": { wireModelId: "kimi-for-coding", contextLength: 262144 },
          "kimi-experimental": {
            wireModelId: "kimi-experimental",
            modelDisplay: "Kimi Experimental",
            contextLength: 512000,
            supportsImageIn: true,
          },
        },
      } as never,
    );

    assert.deepEqual(
      models.map((model) => [model.id, model.name, model.contextWindow, model.cost.input]),
      [
        ["kimi-for-coding", "Kimi for Coding", 262144, 0.95],
        ["kimi-experimental", "Kimi Experimental", 512000, 0],
      ],
    );
    for (const model of models) {
      assert.equal(model.api, provider.api);
      assert.equal(model.provider, PROVIDER_ID);
      assert.equal(model.baseUrl, provider.baseUrl);
    }
  });

  it("regression: keeps discovered thinking metadata when credentials carry none", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { pi, providerConfigs } = makePi();

    await withCwd(cwd, () => registerKimiCodeExtension(pi));

    const provider = providerConfigs.get("kimi-coding");
    const modifyModels = provider?.oauth?.modifyModels;
    assert.ok(modifyModels);
    const registered = provider.models?.map((model) => ({
      ...model,
      api: provider.api,
      provider: PROVIDER_ID,
      baseUrl: provider.baseUrl,
    })) as never;
    type ExtrasModel = {
      id: string;
      supportEfforts?: string[];
      defaultEffort?: string;
      thinkingLevelMap?: Record<string, string | null>;
    };
    const enriched = modifyModels(registered, {
      access: "oauth-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      modelCatalogVersion: 1,
      modelCatalog: {
        "kimi-for-coding": {
          wireModelId: "kimi-for-coding",
          contextLength: 262144,
          supportsThinkingType: "both",
          supportEfforts: ["low", "high"],
          defaultEffort: "high",
        },
      },
    } as never) as ExtrasModel[];
    const standard = enriched.find((model) => model.id === "kimi-for-coding");
    assert.deepEqual(standard?.supportEfforts, ["low", "high"]);

    // A credential with no discovery extras (legacy format, or discovery
    // failed during login/refresh) must not strip metadata discovered
    // earlier; stripping would silently disable thinking levels.
    const kept = modifyModels(
      enriched as never,
      {
        access: "oauth-token-2",
        refresh: "refresh-token-2",
        expires: Date.now() + 60_000,
      } as never,
    ) as ExtrasModel[];
    const keptStandard = kept.find((model) => model.id === "kimi-for-coding");
    assert.deepEqual(keptStandard?.supportEfforts, ["low", "high"]);
    assert.equal(keptStandard?.defaultEffort, "high");
    assert.ok(keptStandard?.thinkingLevelMap);
  });

  it("regression: does not let a legacy cached catalog hide newly added models", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { pi, providerConfigs } = makePi();

    await withCwd(cwd, () => registerKimiCodeExtension(pi));

    const provider = providerConfigs.get("kimi-coding");
    const modifyModels = provider?.oauth?.modifyModels;
    assert.ok(modifyModels);
    const models = modifyModels(
      provider.models?.map((model) => ({ ...model, provider: "kimi-coding" })) as never,
      {
        access: "expired-oauth-token",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
        modelCatalog: {
          "kimi-for-coding": { wireModelId: "kimi-for-coding" },
          "kimi-for-coding-highspeed": { wireModelId: "kimi-for-coding-highspeed" },
        },
      } as never,
    );

    assert.deepEqual(
      models.map((model) => model.id),
      ["kimi-for-coding", "kimi-for-coding-highspeed", "k3"],
    );
  });

  it("regression: removes unavailable Kimi models without removing other providers", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { pi, providerConfigs } = makePi();

    await withCwd(cwd, () => registerKimiCodeExtension(pi));

    const provider = providerConfigs.get("kimi-coding");
    const modifyModels = provider?.oauth?.modifyModels;
    assert.ok(modifyModels);
    const foreignModel = { id: "gpt-5.4", provider: "openai-codex" };
    const models = modifyModels(
      [
        ...(provider.models ?? []).map((model) => ({ ...model, provider: "kimi-coding" })),
        foreignModel,
      ] as never,
      {
        access: "oauth-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
        modelCatalogVersion: 1,
        modelCatalog: {
          "kimi-for-coding": { wireModelId: "kimi-for-coding" },
        },
      } as never,
    );

    assert.deepEqual(
      models.map((model) => model.id),
      ["kimi-for-coding", "gpt-5.4"],
    );
    assert.equal(models[1], foreignModel);
  });

  it("registers only models exposed by a fresh authenticated catalog", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { pi, providerConfigs } = makePi();
    const auth = withTempAuthFile({
      type: "oauth",
      access: "oauth-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "kimi-for-coding" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    try {
      await withCwd(cwd, () => registerKimiCodeExtension(pi));
      assert.deepEqual(
        providerConfigs.get("kimi-coding")?.models?.map((model) => model.id),
        ["kimi-for-coding"],
      );
    } finally {
      globalThis.fetch = originalFetch;
      auth.cleanup();
    }
  });

  it("uses catalog availability and context regardless of usage membership", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { pi, providerConfigs } = makePi();
    const auth = withTempAuthFile({
      type: "oauth",
      access: "oauth-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "kimi-for-coding", context_length: 262144 },
              { id: "kimi-for-coding-highspeed", context_length: 262144 },
              { id: "k3", context_length: 1048576 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/usages")) {
        return new Response(JSON.stringify({ user: { membership: { level: "LEVEL_STANDARD" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    try {
      await withCwd(cwd, () => registerKimiCodeExtension(pi));
      const models = providerConfigs.get("kimi-coding")?.models ?? [];
      assert.deepEqual(
        models.map((model) => model.id),
        ["kimi-for-coding", "kimi-for-coding-highspeed", "k3"],
      );
      assert.equal(models[2]?.contextWindow, 1048576);
    } finally {
      globalThis.fetch = originalFetch;
      auth.cleanup();
    }
  });

  it("falls back to static models when catalog discovery cannot authenticate", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { pi, providerConfigs } = makePi();
    const auth = withTempAuthFile({
      type: "oauth",
      access: "stale-access",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      const authorization = String(headers?.Authorization ?? "");
      if (url.endsWith("/models")) {
        if (authorization === "Bearer stale-access")
          return new Response("expired", { status: 401 });
        return new Response(
          JSON.stringify({
            data: [
              { id: "kimi-for-coding", context_length: 262144 },
              { id: "kimi-for-coding-highspeed", context_length: 262144 },
              { id: "k3", context_length: 1048576 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/usages")) {
        if (authorization === "Bearer stale-access")
          return new Response("expired", { status: 401 });
        return new Response(
          JSON.stringify({ user: { membership: { level: "LEVEL_INTERMEDIATE" } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "fresh-refresh",
            expires_in: 900,
            scope: "kimi-code",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request: ${url}`);
    };

    try {
      await withCwd(cwd, () => registerKimiCodeExtension(pi));
      assert.deepEqual(
        providerConfigs.get("kimi-coding")?.models?.map((model) => [model.id, model.contextWindow]),
        [
          ["kimi-for-coding", 262144],
          ["kimi-for-coding-highspeed", 262144],
          ["k3", 262144],
        ],
      );
    } finally {
      globalThis.fetch = originalFetch;
      auth.cleanup();
    }
  });

  it("does not fetch usage while applying OAuth model metadata", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { pi, providerConfigs } = makePi();
    const auth = withTempAuthFile({
      type: "oauth",
      access: "startup-access",
      refresh: "startup-refresh",
      expires: Date.now() + 60_000,
    });
    const originalFetch = globalThis.fetch;
    let usageRequests = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "kimi-for-coding", context_length: 262144 },
              { id: "kimi-for-coding-highspeed", context_length: 262144 },
              { id: "k3", context_length: 1048576 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/usages")) {
        usageRequests++;
        if (usageRequests === 1) return new Response("unavailable", { status: 503 });
        return new Response(JSON.stringify({ user: { membership: { level: "LEVEL_STANDARD" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "refreshed-access",
            refresh_token: "refreshed-refresh",
            expires_in: 900,
            scope: "kimi-code",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request: ${url}`);
    };

    try {
      await withCwd(cwd, () => registerKimiCodeExtension(pi));
      const provider = providerConfigs.get("kimi-coding");
      const refreshToken = provider?.oauth?.refreshToken;
      const modifyModels = provider?.oauth?.modifyModels;
      assert.ok(refreshToken);
      assert.ok(modifyModels);

      const credentials = await refreshToken({
        access: "startup-access",
        refresh: "startup-refresh",
        expires: Date.now() + 60_000,
      });
      const models = modifyModels(
        provider.models?.map((model) => ({ ...model, provider: "kimi-coding" })) as never,
        credentials as never,
      );

      assert.equal(usageRequests, 0);
      assert.deepEqual(
        models.map((model) => [model.id, model.contextWindow]),
        [
          ["kimi-for-coding", 262144],
          ["kimi-for-coding-highspeed", 262144],
          ["k3", 1048576],
        ],
      );
    } finally {
      globalThis.fetch = originalFetch;
      auth.cleanup();
    }
  });

  it("keeps catalog limits when settings re-fetches usage", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { commands, pi, providerConfigs } = makePi();
    const originalFetch = globalThis.fetch;
    const originalKimiApiKey = process.env.KIMI_API_KEY;
    process.env.KIMI_API_KEY = "test-key";
    let usageRequests = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "kimi-for-coding", context_length: 262144 },
              { id: "kimi-for-coding-highspeed", context_length: 262144 },
              { id: "k3", context_length: 1048576 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/usages")) {
        usageRequests++;
        if (usageRequests === 3) return new Response("unavailable", { status: 503 });
        const level = usageRequests === 1 ? "LEVEL_STANDARD" : "LEVEL_INTERMEDIATE";
        return new Response(JSON.stringify({ user: { membership: { level } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    try {
      await withCwd(cwd, () => registerKimiCodeExtension(pi));
      assert.deepEqual(
        providerConfigs.get("kimi-coding")?.models?.map((model) => [model.id, model.contextWindow]),
        [
          ["kimi-for-coding", 262144],
          ["kimi-for-coding-highspeed", 262144],
          ["k3", 1048576],
        ],
      );

      const kimiCommand = commands.get("kimi-settings");
      assert.ok(kimiCommand);
      await runSettingsHandler(
        kimiCommand.handler,
        {
          cwd,
          mode: "tui",
          ui: { notify: () => {} },
          reload: async () => {},
        } as unknown as ExtensionCommandContext,
        (_list, done) => done(),
      );

      const allegrettoModels = [
        ["kimi-for-coding", 262144],
        ["kimi-for-coding-highspeed", 262144],
        ["k3", 1048576],
      ];
      assert.deepEqual(
        providerConfigs.get("kimi-coding")?.models?.map((model) => [model.id, model.contextWindow]),
        allegrettoModels,
      );

      await runSettingsHandler(
        kimiCommand.handler,
        {
          cwd,
          mode: "tui",
          ui: { notify: () => {} },
          reload: async () => {},
        } as unknown as ExtensionCommandContext,
        (_list, done) => done(),
      );
      assert.deepEqual(
        providerConfigs.get("kimi-coding")?.models?.map((model) => [model.id, model.contextWindow]),
        allegrettoModels,
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKimiApiKey === undefined) delete process.env.KIMI_API_KEY;
      else process.env.KIMI_API_KEY = originalKimiApiKey;
    }
  });

  it("refreshes registered model availability when settings re-fetches the catalog", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { commands, pi, providerConfigs } = makePi();
    const originalFetch = globalThis.fetch;
    const originalKimiApiKey = process.env.KIMI_API_KEY;
    process.env.KIMI_API_KEY = "test-key";
    let modelRequests = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        modelRequests++;
        const ids =
          modelRequests === 1
            ? ["kimi-for-coding", "kimi-for-coding-highspeed"]
            : ["kimi-for-coding"];
        return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/usages")) {
        return new Response(JSON.stringify({ usage: { limit: 100, remaining: 100 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    try {
      await withCwd(cwd, () => registerKimiCodeExtension(pi));
      const kimiCommand = commands.get("kimi-settings");
      assert.ok(kimiCommand);
      await runSettingsHandler(
        kimiCommand.handler,
        {
          cwd,
          mode: "tui",
          ui: { notify: () => {} },
          reload: async () => {},
        } as unknown as ExtensionCommandContext,
        (_list, done) => done(),
      );

      assert.equal(modelRequests, 2);
      assert.deepEqual(
        providerConfigs.get("kimi-coding")?.models?.map((model) => model.id),
        ["kimi-for-coding"],
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKimiApiKey === undefined) delete process.env.KIMI_API_KEY;
      else process.env.KIMI_API_KEY = originalKimiApiKey;
    }
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

  it("does not read project config before project trust is active", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const home = tempDir("kimi-extension-home");
    const configPath = getProjectKimiCodeConfigPath(cwd);
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        tools: {
          moonshot_search: { enabled: true },
        },
      }),
      "utf8",
    );
    const { emit, pi, tools } = makePi();

    await withCwd(cwd, async () => {
      process.env.HOME = home;
      await registerKimiCodeExtension(pi);
      await emit("session_start", { reason: "startup" }, { cwd, isProjectTrusted: () => false });
    });

    assert.deepEqual(
      tools.map((tool) => tool.name),
      [],
    );
  });

  it("does not read project config without saved project trust", async () => {
    const piExports = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
    if (!piExports.ProjectTrustStore) return;

    const cwd = tempDir("kimi-extension-cwd");
    const home = tempDir("kimi-extension-home");
    const agentDir = tempDir("kimi-extension-agent");
    const configPath = getProjectKimiCodeConfigPath(cwd);
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        tools: {
          moonshot_search: { enabled: true },
        },
      }),
      "utf8",
    );
    const { emit, pi, tools } = makePi();

    await withAgentDir(agentDir, () =>
      withCwd(cwd, async () => {
        process.env.HOME = home;
        await registerKimiCodeExtension(pi);
        await emit("session_start", { reason: "startup" }, { cwd, isProjectTrusted: () => true });
      }),
    );

    assert.deepEqual(
      tools.map((tool) => tool.name),
      [],
    );
  });

  it("falls back to trusted project config when Pi has no project trust API", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const home = tempDir("kimi-extension-home");
    const configPath = getProjectKimiCodeConfigPath(cwd);
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        tools: {
          moonshot_search: { enabled: true },
        },
      }),
      "utf8",
    );
    const { emit, pi, tools } = makePi();

    await withCwd(cwd, async () => {
      process.env.HOME = home;
      await registerKimiCodeExtension(pi);
      await emit("session_start", { reason: "startup" }, { cwd });
    });

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["moonshot_search"],
    );
  });

  it("registers only enabled Moonshot tools after project trust is active", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const home = tempDir("kimi-extension-home");
    const agentDir = tempDir("kimi-extension-agent");
    const configPath = getProjectKimiCodeConfigPath(cwd);
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
    const { emit, pi, tools } = makePi();

    writeProjectTrust(agentDir, cwd);
    await withAgentDir(agentDir, () =>
      withCwd(cwd, async () => {
        process.env.HOME = home;
        await registerKimiCodeExtension(pi);
        await emit("session_start", { reason: "startup" }, { cwd, isProjectTrusted: () => true });
      }),
    );

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
    assert.match(component.render(80).join("\n"), /https:\/\/example.com/);
  });

  it("requires TUI mode for /kimi-settings", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { commands, pi } = makePi();
    const notifications: Array<{ message: string; level?: string }> = [];

    await withCwd(cwd, () => registerKimiCodeExtension(pi));
    const kimiCommand = commands.get("kimi-settings");
    assert.ok(kimiCommand);

    await kimiCommand.handler("", {
      cwd,
      mode: "batch",
      ui: {
        notify: (message: string, level?: string) => {
          notifications.push({ message, level });
        },
      },
    } as unknown as ExtensionCommandContext);

    assert.deepEqual(notifications, [
      { message: "/kimi-settings requires TUI mode", level: "error" },
    ]);
  });

  it("shows effective tool sources in /kimi-settings", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const configPath = getProjectKimiCodeConfigPath(cwd);
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        tools: {
          moonshot_search: { enabled: true },
          kimi_datasource: { enabled: false },
        },
      }),
      "utf8",
    );
    const { commands, pi } = makePi();
    const originalFetch = globalThis.fetch;
    const originalKimiApiKey = process.env.KIMI_API_KEY;
    process.env.KIMI_API_KEY = "test-key";
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ usage: { limit: 100, remaining: 100 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    try {
      await withCwd(cwd, () => registerKimiCodeExtension(pi));
      const kimiCommand = commands.get("kimi-settings");
      assert.ok(kimiCommand);

      let items: TestSettingItem[] = [];
      let rendered = "";
      await runSettingsHandler(
        kimiCommand.handler,
        {
          cwd,
          mode: "tui",
          ui: { notify: () => {} },
          reload: async () => {},
        } as unknown as ExtensionCommandContext,
        (list, done) => {
          items = (list as unknown as { items: TestSettingItem[] }).items;
          rendered = list.render(80).join("\n");
          done();
        },
      );

      assert.match(
        rendered,
        /^Kimi settings \(provider v\d+\.\d+\.\d+\)\n\nKimi usage\n  Current week\n\s+0% used/m,
      );
      assert.deepEqual(
        items
          .filter(
            (i) =>
              i.id === "moonshot_search" || i.id === "moonshot_fetch" || i.id === "kimi_datasource",
          )
          .map((i) => [i.id, i.label]),
        [
          ["moonshot_search", "Search tool"],
          ["moonshot_fetch", "Fetch tool"],
          ["kimi_datasource", "Real-world data API"],
        ],
      );
      assert.equal(
        items.find((i) => i.id === "moonshot_search")?.currentValue,
        "enabled without preview",
      );
      assert.equal(items.find((i) => i.id === "kimi_datasource")?.currentValue, "disabled");
      assert.equal(items.find((i) => i.id === "scope")?.currentValue, "project");
      assert.equal(
        items.some((i) => i.id === "moonshot_search:enabled"),
        false,
      );

      const moonshotSearch = items.find((i) => i.id === "moonshot_search");
      assert.ok(moonshotSearch?.submenu);
      const submenu = moonshotSearch.submenu(moonshotSearch.currentValue, () => {});
      const submenuItems = (submenu as unknown as { items: TestSettingItem[] }).items;
      assert.deepEqual(
        submenuItems.map((i) => [i.id, i.label, i.currentValue]),
        [
          ["moonshot_search:enabled", "Enabled", "true"],
          ["moonshot_search:collapsed", "Show preview", "false"],
        ],
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKimiApiKey === undefined) {
        delete process.env.KIMI_API_KEY;
      } else {
        process.env.KIMI_API_KEY = originalKimiApiKey;
      }
    }
  });

  it("does not read project config in /kimi-settings when project is untrusted", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const home = tempDir("kimi-extension-home");
    const projectConfigPath = getProjectKimiCodeConfigPath(cwd);
    mkdirSync(join(projectConfigPath, ".."), { recursive: true });
    writeFileSync(
      projectConfigPath,
      JSON.stringify({ tools: { moonshot_search: { enabled: true } } }),
      "utf8",
    );
    const { commands, pi } = makePi();
    const originalFetch = globalThis.fetch;
    const originalKimiApiKey = process.env.KIMI_API_KEY;
    const originalHome = process.env.HOME;
    const originalCwd = process.cwd();
    process.env.KIMI_API_KEY = "test-key";
    process.env.HOME = home;
    process.chdir(cwd);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ usage: { limit: 100, remaining: 100 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    try {
      await registerKimiCodeExtension(pi);
      const kimiCommand = commands.get("kimi-settings");
      assert.ok(kimiCommand);

      let items: TestSettingItem[] = [];
      await runSettingsHandler(
        kimiCommand.handler,
        {
          cwd,
          mode: "tui",
          isProjectTrusted: () => false,
          ui: { notify: () => {} },
          reload: async () => {},
        } as unknown as ExtensionCommandContext,
        (list, done) => {
          items = (list as unknown as { items: TestSettingItem[] }).items;
          done();
        },
      );

      const scopeItem = items.find((i) => i.id === "scope");
      assert.deepEqual(scopeItem?.values, ["home"]);
      assert.equal(items.find((i) => i.id === "moonshot_search")?.currentValue, "disabled");
    } finally {
      globalThis.fetch = originalFetch;
      process.chdir(originalCwd);
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalKimiApiKey === undefined) {
        delete process.env.KIMI_API_KEY;
      } else {
        process.env.KIMI_API_KEY = originalKimiApiKey;
      }
    }
  });

  it("refreshes Kimi usage OAuth token once on 401", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const { commands, pi } = makePi();
    const notifications: string[] = [];
    const auth = withTempAuthFile({
      type: "oauth",
      access: "stale-access",
      refresh: "refresh-1",
      expires: Date.now() + 60_000,
    });
    const originalFetch = globalThis.fetch;
    const originalKimiApiKey = process.env.KIMI_API_KEY;
    delete process.env.KIMI_API_KEY;
    const usageTokens: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/coding/v1/usages")) {
        const headers = init?.headers as Record<string, string> | undefined;
        usageTokens.push(String(headers?.Authorization ?? ""));
        if (usageTokens.length === 1) return new Response("expired", { status: 401 });
        return new Response(
          JSON.stringify({
            usage: { limit: 100, remaining: 99 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/oauth/token")) {
        const bodyText = String(init?.body ?? "");
        const body = new URLSearchParams(bodyText);
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), "refresh-1");
        return new Response(
          JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "refresh-2",
            expires_in: 900,
            scope: "kimi-code",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    try {
      await withCwd(cwd, () => registerKimiCodeExtension(pi));
      const kimiCommand = commands.get("kimi-settings");
      assert.ok(kimiCommand);

      let rendered = "";
      await runSettingsHandler(
        kimiCommand.handler,
        {
          cwd,
          mode: "tui",
          ui: {
            notify: (message: string) => {
              notifications.push(message);
            },
          },
          reload: async () => {},
        } as unknown as ExtensionCommandContext,
        (list, done) => {
          rendered = list.render(80).join("\n");
          done();
        },
      );

      assert.match(rendered, /Current week\n  ▌\s+1% used/);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKimiApiKey === undefined) {
        delete process.env.KIMI_API_KEY;
      } else {
        process.env.KIMI_API_KEY = originalKimiApiKey;
      }
      auth.cleanup();
    }

    assert.deepEqual(usageTokens, ["Bearer stale-access", "Bearer fresh-access"]);
    assert.deepEqual(notifications, []);
  });

  it("writes protocol and upload threshold from /kimi-settings", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const configPath = getProjectKimiCodeConfigPath(cwd);
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, JSON.stringify(DEFAULT_KIMI_CODE_CONFIG), "utf8");
    const { commands, pi } = makePi();
    const notifications: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalKimiApiKey = process.env.KIMI_API_KEY;
    process.env.KIMI_API_KEY = "test-key";
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ usage: { limit: 100, remaining: 100 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    try {
      await withCwd(cwd, () => registerKimiCodeExtension(pi));
      const kimiCommand = commands.get("kimi-settings");
      assert.ok(kimiCommand);

      await runSettingsHandler(
        kimiCommand.handler,
        {
          cwd,
          mode: "tui",
          ui: {
            notify: (message: string) => {
              notifications.push(message);
            },
          },
          reload: async () => {},
        } as unknown as ExtensionCommandContext,
        (list, done) => {
          const onChange = (list as unknown as { onChange: (id: string, value: string) => void })
            .onChange;
          onChange("protocol", "anthropic");
          onChange("uploadThreshold", "2 MiB");
          done();
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKimiApiKey === undefined) {
        delete process.env.KIMI_API_KEY;
      } else {
        process.env.KIMI_API_KEY = originalKimiApiKey;
      }
    }

    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      ...DEFAULT_KIMI_CODE_CONFIG,
      uploads: { thresholdBytes: 2097152 },
      protocol: "anthropic",
    });
    assert.deepEqual(notifications, []);
  });

  it("preserves trusted project config when saving home scope from /kimi-settings", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const home = tempDir("kimi-extension-home");
    const configPath = getProjectKimiCodeConfigPath(cwd);
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ tools: { moonshot_search: { enabled: true } } }),
      "utf8",
    );
    const { commands, getActiveTools, pi } = makePi();
    const originalFetch = globalThis.fetch;
    const originalKimiApiKey = process.env.KIMI_API_KEY;
    const originalHome = process.env.HOME;
    process.env.KIMI_API_KEY = "test-key";
    process.env.HOME = home;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ usage: { limit: 100, remaining: 100 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    try {
      await withCwd(cwd, () => registerKimiCodeExtension(pi));
      const kimiCommand = commands.get("kimi-settings");
      assert.ok(kimiCommand);

      await runSettingsHandler(
        kimiCommand.handler,
        {
          cwd,
          mode: "tui",
          ui: { notify: () => {} },
          reload: async () => {},
        } as unknown as ExtensionCommandContext,
        (list, done) => {
          const onChange = (list as unknown as { onChange: (id: string, value: string) => void })
            .onChange;
          onChange("scope", "home");
          onChange("protocol", "anthropic");
          done();
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalKimiApiKey === undefined) {
        delete process.env.KIMI_API_KEY;
      } else {
        process.env.KIMI_API_KEY = originalKimiApiKey;
      }
    }

    assert.deepEqual(getActiveTools(), ["moonshot_search"]);
  });

  it("writes project config and updates active tools from /kimi-settings", async () => {
    const cwd = tempDir("kimi-extension-cwd");
    const configPath = getProjectKimiCodeConfigPath(cwd);
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, JSON.stringify(DEFAULT_KIMI_CODE_CONFIG), "utf8");
    const { commands, getActiveTools, pi, setActiveTools, tools } = makePi();
    setActiveTools(["shell", "moonshot_fetch"]);
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

      await runSettingsHandler(
        kimiCommand.handler,
        {
          cwd,
          mode: "tui",
          ui: {
            notify: (message: string) => {
              notifications.push(message);
            },
          },
          reload: async () => {},
        } as unknown as ExtensionCommandContext,
        (list, done) => {
          const onChange = (list as unknown as { onChange: (id: string, value: string) => void })
            .onChange;
          onChange("moonshot_search:enabled", "true");
          onChange("moonshot_fetch:collapsed", "true");
          done();
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKimiApiKey === undefined) {
        delete process.env.KIMI_API_KEY;
      } else {
        process.env.KIMI_API_KEY = originalKimiApiKey;
      }
    }

    assert.deepEqual(notifications, []);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      ...DEFAULT_KIMI_CODE_CONFIG,
      tools: Object.fromEntries(
        KIMI_TOOL_NAMES.map((name) => [
          name,
          name === "moonshot_search"
            ? { enabled: true, default_collapsed: true }
            : name === "moonshot_fetch"
              ? { enabled: false, default_collapsed: false }
              : { enabled: false, default_collapsed: true },
        ]),
      ),
    });
    assert.deepEqual(getActiveTools(), ["shell", "moonshot_search"]);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["moonshot_search"],
    );
  });
});
