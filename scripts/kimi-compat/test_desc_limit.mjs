import { existsSync, readFileSync, readdirSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";

const apiKey = process.env.KIMI_API_KEY ?? process.argv[2];
const baseUrl = process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1";

if (!apiKey) {
  console.error("Usage: KIMI_API_KEY=sk-... node scripts/kimi-compat/test_desc_limit.mjs");
  process.exit(1);
}

const url = new URL("chat/completions", baseUrl.replace(/\/?$/, "/"));

const captureDir = join(import.meta.dirname, "..", "captures");

function latestCaptureFile(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith("-request.json"))
    .sort();
  return files.at(-1) ?? null;
}

const captureFile = process.env.CAPTURE_FILE ?? process.argv[3] ?? latestCaptureFile(captureDir);
if (!captureFile) {
  console.error("No capture file specified and no captures found in", captureDir);
  process.exit(1);
}
const capturePath = captureFile.includes("/") ? captureFile : join(captureDir, captureFile);
const capture = JSON.parse(readFileSync(capturePath, "utf8"));
const body = JSON.parse(capture.bodyUtf8);
const originalDesc = body.tools[4].function.description;

function send(label, tool) {
  const payload = {
    model: "kimi-for-coding",
    messages: [{ role: "user", content: "Say hi." }],
    max_completion_tokens: 8,
    stream: false,
    tools: [tool],
  };
  const reqBody = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
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
          "Content-Length": String(Buffer.byteLength(reqBody)),
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
          console.log(
            `  [${label}] ${res.statusCode} ${res.statusCode < 400 ? "OK" : "REJECT"}${detail}`,
          );
          resolve(res.statusCode < 400);
        });
      },
    );
    req.on("error", reject);
    req.end(reqBody);
  });
}

// Test 1: original description + empty schema
console.log(`Original description: ${Buffer.byteLength(originalDesc)} bytes`);
console.log("\n=== Test 1: original description + empty parameters ===");
await send("desc-only", {
  type: "function",
  function: {
    name: "subagent",
    description: originalDesc,
    parameters: { type: "object", properties: {} },
  },
});

// Test 2: no description + original schema (to confirm size limit is on parameters only)
console.log("\n=== Test 2: no description + original schema ===");
await send("schema-only", {
  type: "function",
  function: {
    name: "subagent",
    description: "test",
    parameters: body.tools[4].function.parameters,
  },
});

// Test 3: description is counted in the size limit?
// Big description + schema near limit
console.log("\n=== Test 3: 10KB description + 13KB schema ===");
const bigDesc = "x".repeat(10000);
const props13k = {};
for (let i = 0; i < 250; i++) {
  props13k[`f${i}`] = { type: "string", description: "padding ".repeat(3) };
}
const schema13k = { type: "object", properties: props13k };
const schema13kSize = Buffer.byteLength(JSON.stringify(schema13k));
console.log(`  schema size: ${schema13kSize} bytes`);
await send("big-desc-13k-schema", {
  type: "function",
  function: { name: "test_tool", description: bigDesc, parameters: schema13k },
});

// Test 4: 10KB description + 14.5KB schema (near limit)
console.log("\n=== Test 4: 10KB description + ~14.5KB schema ===");
const props14k = {};
for (let i = 0; i < 300; i++) {
  props14k[`f${i}`] = { type: "string", description: "padding ".repeat(3) };
}
const schema14k = { type: "object", properties: props14k };
const schema14kSize = Buffer.byteLength(JSON.stringify(schema14k));
console.log(`  schema size: ${schema14kSize} bytes`);
await send("big-desc-14k-schema", {
  type: "function",
  function: { name: "test_tool", description: bigDesc, parameters: schema14k },
});

// Test 5: massive description alone (50KB)
console.log("\n=== Test 5: 50KB description + empty schema ===");
await send("50k-desc", {
  type: "function",
  function: {
    name: "test_tool",
    description: "x".repeat(50000),
    parameters: { type: "object", properties: {} },
  },
});
