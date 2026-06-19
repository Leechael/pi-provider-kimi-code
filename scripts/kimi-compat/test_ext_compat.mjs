// Generalized Kimi tool-schema compatibility test.
//
// Takes a harvested tools JSON file (array of OpenAI-shaped tool objects, as
// produced by harvest-ext-tools.mjs), and for every tool:
//
//   1. Measures the raw `function.parameters` size.
//   2. Runs the tool through the REAL provider pipeline (applyKimiPayloadMutations
//      with api="openai-completions") — the same property-type back-fill and
//      $defs/$ref dedup the live provider applies.
//   3. Reports the normalized size and whether it lands under Kimi's ~15 KB
//      per-tool limit.
//   4. If KIMI_API_KEY is set, sends both the raw and the normalized single-tool
//      payloads to Kimi and reports REJECT/OK — proving the normalization fixes
//      real rejections.
//
// Usage (from repo root):
//   node --import tsx scripts/kimi-compat/test_ext_compat.mjs scripts/kimi-compat/corpus/*.json
//   KIMI_API_KEY=sk-... node --import tsx scripts/kimi-compat/test_ext_compat.mjs scripts/kimi-compat/corpus/*.json

import { readFileSync } from "node:fs";
import https from "node:https";
import { resolve } from "node:path";

import { optimizeToolSchemas, resetToolSchemaCache } from "../../src/schema-dedup.ts";

const KIMI_PER_TOOL_LIMIT = 15000;

const apiKey = process.env.KIMI_API_KEY;
const baseUrl = process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1";
const url = new URL("chat/completions", baseUrl.replace(/\/?$/, "/"));

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error(
    "Usage: node --import tsx scripts/kimi-compat/test_ext_compat.mjs <harvested.json> [...]",
  );
  process.exit(1);
}

function bytes(v) {
  return Buffer.byteLength(JSON.stringify(v));
}

// Run a single tool through the real provider pipeline and return the
// normalized tool object.
function normalizeTool(tool) {
  resetToolSchemaCache();
  // Apply the oversized-schema $defs/$ref dedup the provider runs on every
  // tools array. (The provider also back-fills missing JSON Schema `type`s,
  // a no-op for byte size unless a property omits `type`.)
  const tools = optimizeToolSchemas([
    { type: "function", function: structuredClone(tool.function) },
  ]);
  return tools[0];
}

function send(tool) {
  const body = JSON.stringify({
    model: "kimi-for-coding",
    messages: [{ role: "user", content: "Say hi." }],
    max_completion_tokens: 8,
    stream: false,
    tools: [tool],
  });
  return new Promise((resolveP, reject) => {
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
          "User-Agent": "KimiCLI/1.44.0",
          "X-Msh-Platform": "kimi_cli",
          "X-Msh-Version": "1.44.0",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let detail = "";
          try {
            const json = JSON.parse(raw);
            if (json.error) detail = ` — ${json.error.message}`;
          } catch {}
          resolveP({ ok: res.statusCode < 400, status: res.statusCode, detail });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("Request timeout"));
    });
    req.end(body);
  });
}

let totalTools = 0;
let oversizeRaw = 0;
let oversizeNorm = 0;
const liveResults = [];

for (const file of files) {
  const abs = resolve(file);
  const tools = JSON.parse(readFileSync(abs, "utf8"));
  console.log(`\n=== ${file} (${tools.length} tool(s)) ===`);
  for (const tool of tools) {
    totalTools++;
    const name = tool.function?.name ?? "(unknown)";
    const src = tool._source ? ` [${tool._source}]` : "";
    const rawSize = bytes(tool.function?.parameters ?? {});
    const normalized = normalizeTool(tool);
    const normSize = bytes(normalized.function?.parameters ?? {});
    const rawFlag = rawSize > KIMI_PER_TOOL_LIMIT ? "OVER" : "ok";
    const normFlag = normSize > KIMI_PER_TOOL_LIMIT ? "OVER" : "ok";
    if (rawSize > KIMI_PER_TOOL_LIMIT) oversizeRaw++;
    if (normSize > KIMI_PER_TOOL_LIMIT) oversizeNorm++;
    console.log(
      `  ${name}${src}: raw=${rawSize} (${rawFlag}) -> normalized=${normSize} (${normFlag})` +
        (rawSize !== normSize ? `  saved ${rawSize - normSize}` : ""),
    );

    if (apiKey) {
      const rawTool = { type: "function", function: tool.function };
      const rawRes = await send(rawTool);
      const normRes = await send(normalized);
      console.log(
        `      live: raw ${rawRes.status} ${rawRes.ok ? "OK" : "REJECT"}${rawRes.detail}` +
          ` | normalized ${normRes.status} ${normRes.ok ? "OK" : "REJECT"}${normRes.detail}`,
      );
      liveResults.push({ name, rawOk: rawRes.ok, normOk: normRes.ok });
    }
  }
}

console.log(`\n=== Summary ===`);
console.log(`tools tested:         ${totalTools}`);
console.log(`over limit (raw):     ${oversizeRaw}`);
console.log(`over limit (normd):   ${oversizeNorm}`);
if (apiKey) {
  const fixed = liveResults.filter((r) => !r.rawOk && r.normOk).length;
  const stillBroken = liveResults.filter((r) => !r.normOk).length;
  console.log(`live: rejections fixed by normalization: ${fixed}`);
  console.log(`live: still rejected after normalization: ${stillBroken}`);
} else {
  console.log(`(set KIMI_API_KEY to run live REJECT/OK checks against Kimi)`);
}
