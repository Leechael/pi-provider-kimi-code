import { readFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";

const apiKey = process.env.KIMI_API_KEY ?? process.argv[2];
const baseUrl = process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1";

if (!apiKey) {
  console.error("Usage: KIMI_API_KEY=sk-... node scripts/kimi-compat/test_ref_dedup.mjs");
  process.exit(1);
}

const url = new URL("chat/completions", baseUrl.replace(/\/?$/, "/"));

const captureDir = join(import.meta.dirname, "..", "captures");
const files = readFileSync(join(captureDir, "0001-2026-06-04T23-22-09-516Z-request.json"), "utf8");
const capture = JSON.parse(files);
const body = JSON.parse(capture.bodyUtf8);
const originalTool = body.tools[4];
const originalSchema = originalTool.function.parameters;

console.log(`Original schema size: ${Buffer.byteLength(JSON.stringify(originalSchema))} bytes`);
console.log();

// Find duplicate sub-schemas by serializing and comparing
function findDuplicates(obj, path = "", map = new Map(), minSize = 50) {
  if (obj === null || typeof obj !== "object") return map;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => findDuplicates(item, `${path}[${i}]`, map, minSize));
    return map;
  }

  const serialized = JSON.stringify(obj);
  if (serialized.length >= minSize) {
    if (!map.has(serialized)) {
      map.set(serialized, []);
    }
    map.get(serialized).push(path);
  }

  for (const [key, value] of Object.entries(obj)) {
    findDuplicates(value, path ? `${path}.${key}` : key, map, minSize);
  }
  return map;
}

const dupes = findDuplicates(originalSchema, "", new Map(), 50);
console.log("=== Duplicate sub-schemas (>=50 bytes, >=2 occurrences) ===");
for (const [serialized, paths] of dupes) {
  if (paths.length < 2) continue;
  console.log(`  ${Buffer.byteLength(serialized)} bytes x ${paths.length} occurrences:`);
  for (const p of paths) {
    console.log(`    ${p}`);
  }
  console.log();
}

// Deduplicate: extract repeated sub-schemas into $defs, multi-pass
function dedup(schema, minSize = 50) {
  const result = JSON.parse(JSON.stringify(schema));
  const defs = result.$defs || {};
  let defIndex = 0;
  const replaced = new Set();

  // Multiple passes: after replacing large blocks, smaller duplicates may emerge
  for (let pass = 0; pass < 5; pass++) {
    const candidates = findDuplicates(result, "", new Map(), minSize);
    const sorted = [...candidates.entries()]
      .filter(([, paths]) => paths.length >= 2)
      .sort((a, b) => Buffer.byteLength(b[0]) - Buffer.byteLength(a[0]));

    let madeProgress = false;
    for (const [serialized, paths] of sorted) {
      const activePaths = paths.filter(
        (p) => ![...replaced].some((r) => p.startsWith(r + ".") || p.startsWith(r + "[")),
      );
      if (activePaths.length < 2) continue;

      // Only worth extracting if net savings > 0
      // Savings = (count - 1) * size - ($defs overhead ~40 bytes per entry)
      const size = Buffer.byteLength(serialized);
      const savings = (activePaths.length - 1) * size - 40;
      if (savings <= 0) continue;

      const defName = `d${defIndex++}`;
      defs[defName] = JSON.parse(serialized);

      for (const path of activePaths) {
        setAtPath(result, path, { $ref: `#/$defs/${defName}` });
        replaced.add(path);
      }
      madeProgress = true;
    }
    if (!madeProgress) break;
  }

  if (Object.keys(defs).length > 0) {
    result.$defs = defs;
  }
  return result;
}

function setAtPath(obj, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (current[key] === undefined) return;
    current = current[key];
  }
  current[parts[parts.length - 1]] = value;
}

const dedupedSchema = dedup(originalSchema);
const dedupedSize = Buffer.byteLength(JSON.stringify(dedupedSchema));
const originalSize = Buffer.byteLength(JSON.stringify(originalSchema));

console.log(`=== Dedup result ===`);
console.log(`Original:  ${originalSize} bytes`);
console.log(`Deduped:   ${dedupedSize} bytes`);
console.log(
  `Saved:     ${originalSize - dedupedSize} bytes (${((1 - dedupedSize / originalSize) * 100).toFixed(1)}%)`,
);
console.log(`Under 15KB limit: ${dedupedSize < 15000 ? "YES" : "NO"}`);
console.log(`$defs count: ${Object.keys(dedupedSchema.$defs || {}).length}`);
console.log();

// Send to Kimi
function send(label, tools) {
  const payload = {
    model: "kimi-for-coding",
    messages: [{ role: "user", content: "Say hi." }],
    max_completion_tokens: 8,
    stream: false,
    tools,
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

console.log("=== Test: original (expect REJECT) ===");
await send("original", [
  { type: "function", function: { ...originalTool.function, parameters: originalSchema } },
]);

console.log("\n=== Test: deduped with $ref (expect OK) ===");
await send("deduped", [
  { type: "function", function: { ...originalTool.function, parameters: dedupedSchema } },
]);

console.log("\n=== Test: all 5 tools with deduped subagent ===");
const allTools = body.tools.map((t, i) => {
  if (i === 4) {
    return { type: "function", function: { ...t.function, parameters: dedupedSchema } };
  }
  return t;
});
await send("all-tools-deduped", allTools);
