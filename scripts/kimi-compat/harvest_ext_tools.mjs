// Headless tool-schema harvester.
//
// Loads one or more Pi extensions through a mock ExtensionAPI that records
// every `registerTool(...)` payload, then writes the captured tool schemas
// (in OpenAI `{type:"function",function:{...}}` shape) to a JSON file.
//
// The `parameters` field of a Pi tool definition is a TypeBox schema, which is
// itself a plain JSON Schema object at runtime — so recording it verbatim gives
// us the exact payload the provider would serialize into the `tools` array.
//
// Usage:
//   node scripts/kimi-compat/harvest_ext_tools.mjs <name>=<moduleSpecifier> [...] [--out file.json]
//
// Example:
//   node scripts/kimi-compat/harvest_ext_tools.mjs \
//     pi-subagents=pi-subagents/src/extension/index.ts \
//     --out ../ext-tool-schemas/pi-subagents.json

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
let outFile = null;
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") {
    outFile = args[++i];
    continue;
  }
  const eq = args[i].indexOf("=");
  if (eq === -1) {
    console.error(`Ignoring malformed target (expected name=specifier): ${args[i]}`);
    continue;
  }
  targets.push({ name: args[i].slice(0, eq), specifier: args[i].slice(eq + 1) });
}

if (targets.length === 0) {
  console.error(
    "Usage: node scripts/kimi-compat/harvest_ext_tools.mjs <name>=<specifier> [...] [--out file]",
  );
  process.exit(1);
}

// A permissive no-op stand-in for any ExtensionAPI sub-object the extension
// pokes at during registration (config stores, UI handles, loggers, ...).
function makeNoopProxy() {
  const fn = () => makeNoopProxy();
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === "then") return undefined; // not a thenable
      if (prop === Symbol.iterator) return undefined;
      return makeNoopProxy();
    },
    apply() {
      return makeNoopProxy();
    },
  });
}

function makeMockPi(captured) {
  const base = {
    registerTool(tool) {
      if (!tool || typeof tool !== "object") return;
      captured.push({
        name: typeof tool.name === "string" ? tool.name : "(unknown)",
        description: typeof tool.description === "string" ? tool.description : undefined,
        parameters: tool.parameters,
      });
    },
    on() {},
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerMessageRenderer() {},
    registerProvider() {},
    registerModel() {},
    registerEditor() {},
    registerAutocompleteProvider() {},
    sendMessage() {},
    log: makeNoopProxy(),
  };
  // Anything else the extension reaches for resolves to a no-op proxy.
  return new Proxy(base, {
    get(t, prop) {
      if (prop in t) return t[prop];
      return makeNoopProxy();
    },
  });
}

function resolveSpecifier(specifier) {
  try {
    const pkgPath = resolve("node_modules", specifier, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.pi?.extensions?.length) {
      return pkg.pi.extensions.map((e) => resolve("node_modules", specifier, e));
    }
  } catch {}
  return [specifier];
}

async function harvestOne(specifier) {
  const entries = resolveSpecifier(specifier);
  const captured = [];

  for (const entry of entries) {
    let mod;
    try {
      mod = /^[./]/.test(entry) ? await import(pathToFileURL(entry).href) : await import(entry);
    } catch {
      mod = await import(entry);
    }
    const register =
      typeof mod.default === "function"
        ? mod.default
        : typeof mod.default?.default === "function"
          ? mod.default.default
          : typeof mod.register === "function"
            ? mod.register
            : typeof mod.activate === "function"
              ? mod.activate
              : null;
    if (!register) continue;
    const pi = makeMockPi(captured);
    try {
      await register(pi);
    } catch {}
  }

  if (captured.length === 0 && entries.length > 0) {
    console.error(`    (no tools registered by any of ${entries.length} entry point(s))`);
  }
  return captured;
}

const allTools = [];
const summary = [];
for (const { name, specifier } of targets) {
  try {
    const tools = await harvestOne(specifier);
    for (const t of tools) {
      const params = t.parameters ?? { type: "object", properties: {} };
      allTools.push({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: params,
        },
        _source: name,
      });
    }
    summary.push({ name, count: tools.length, ok: true });
    console.error(`✓ ${name}: ${tools.length} tool(s)`);
    for (const t of tools) {
      const bytes = Buffer.byteLength(JSON.stringify(t.parameters ?? {}));
      console.error(`    ${t.name}: ${bytes} bytes`);
    }
  } catch (err) {
    summary.push({ name, count: 0, ok: false, error: String(err?.message ?? err) });
    console.error(`✗ ${name}: ${err?.message ?? err}`);
  }
}

if (outFile) {
  const abs = resolve(outFile);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(allTools, null, 2));
  console.error(`\nWrote ${allTools.length} tool(s) to ${abs}`);
}
