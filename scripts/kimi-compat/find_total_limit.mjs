import http from "node:http";
import https from "node:https";

const apiKey = process.env.KIMI_API_KEY ?? process.argv[2];
const baseUrl = process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1";

if (!apiKey) {
  console.error("Usage: KIMI_API_KEY=sk-... node scripts/kimi-compat/find_total_limit.mjs");
  process.exit(1);
}

const url = new URL("chat/completions", baseUrl.replace(/\/?$/, "/"));

function buildSchema(size) {
  const props = {};
  let idx = 0;
  let currentSize = 0;
  while (currentSize < size) {
    const key = `p${idx++}`;
    const prop = { type: "string" };
    const added = JSON.stringify({ [key]: prop }).length - 2;
    if (currentSize + added > size) break;
    props[key] = prop;
    currentSize += added;
  }
  const remaining = size - JSON.stringify({ type: "object", properties: props }).length;
  if (remaining > 10) {
    props["pad"] = { type: "string", description: "x".repeat(remaining) };
  }
  return { type: "object", properties: props };
}

function buildTool(name, schemaSize) {
  return {
    type: "function",
    function: {
      name,
      description: "test",
      parameters: buildSchema(schemaSize),
    },
  };
}

function sendRequest(payload) {
  const body = JSON.stringify(payload);
  const client = url.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const req = client.request(
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
          resolve({ status: res.statusCode, body: raw });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

console.log(`Target: ${url}`);

// Test 1: multiple tools each under 15KB, but total over 15KB
console.log();
console.log("=== Test 1: 3 tools x 10KB each (total ~30KB, each under limit) ===");
{
  const payload = {
    model: "kimi-for-coding",
    messages: [{ role: "user", content: "Say hi." }],
    max_completion_tokens: 8,
    stream: false,
    tools: [buildTool("tool_a", 10000), buildTool("tool_b", 10000), buildTool("tool_c", 10000)],
  };
  const totalSchema = payload.tools.reduce(
    (sum, t) => sum + Buffer.byteLength(JSON.stringify(t.function.parameters)),
    0,
  );
  const res = await sendRequest(payload);
  console.log(
    `  total schema: ${totalSchema} bytes -> ${res.status} ${res.status < 400 ? "OK" : "REJECT"}`,
  );
  if (res.status >= 400) {
    try {
      console.log(`  error: ${JSON.parse(res.body).error.message}`);
    } catch {}
  }
}

// Test 2: 5 tools x 14KB each (total ~70KB, each just under per-tool limit)
console.log();
console.log("=== Test 2: 5 tools x 14KB each (total ~70KB, each under limit) ===");
{
  const payload = {
    model: "kimi-for-coding",
    messages: [{ role: "user", content: "Say hi." }],
    max_completion_tokens: 8,
    stream: false,
    tools: [
      buildTool("tool_a", 14000),
      buildTool("tool_b", 14000),
      buildTool("tool_c", 14000),
      buildTool("tool_d", 14000),
      buildTool("tool_e", 14000),
    ],
  };
  const totalSchema = payload.tools.reduce(
    (sum, t) => sum + Buffer.byteLength(JSON.stringify(t.function.parameters)),
    0,
  );
  const res = await sendRequest(payload);
  console.log(
    `  total schema: ${totalSchema} bytes -> ${res.status} ${res.status < 400 ? "OK" : "REJECT"}`,
  );
  if (res.status >= 400) {
    try {
      console.log(`  error: ${JSON.parse(res.body).error.message}`);
    } catch {}
  }
}

// Test 3: 10 tools x 14KB each (total ~140KB)
console.log();
console.log("=== Test 3: 10 tools x 14KB each (total ~140KB) ===");
{
  const tools = [];
  for (let i = 0; i < 10; i++) {
    tools.push(buildTool(`tool_${String.fromCharCode(97 + i)}`, 14000));
  }
  const payload = {
    model: "kimi-for-coding",
    messages: [{ role: "user", content: "Say hi." }],
    max_completion_tokens: 8,
    stream: false,
    tools,
  };
  const totalSchema = payload.tools.reduce(
    (sum, t) => sum + Buffer.byteLength(JSON.stringify(t.function.parameters)),
    0,
  );
  const res = await sendRequest(payload);
  console.log(
    `  total schema: ${totalSchema} bytes -> ${res.status} ${res.status < 400 ? "OK" : "REJECT"}`,
  );
  if (res.status >= 400) {
    try {
      console.log(`  error: ${JSON.parse(res.body).error.message}`);
    } catch {}
  }
}

// Test 4: 1 tool at 15.5KB (over per-tool limit, confirm it's per-tool)
console.log();
console.log("=== Test 4: 1 tool x 15.5KB (over per-tool limit) ===");
{
  const payload = {
    model: "kimi-for-coding",
    messages: [{ role: "user", content: "Say hi." }],
    max_completion_tokens: 8,
    stream: false,
    tools: [buildTool("tool_big", 15500)],
  };
  const schemaSize = Buffer.byteLength(JSON.stringify(payload.tools[0].function.parameters));
  const res = await sendRequest(payload);
  console.log(
    `  schema: ${schemaSize} bytes -> ${res.status} ${res.status < 400 ? "OK" : "REJECT"}`,
  );
  if (res.status >= 400) {
    try {
      console.log(`  error: ${JSON.parse(res.body).error.message}`);
    } catch {}
  }
}
