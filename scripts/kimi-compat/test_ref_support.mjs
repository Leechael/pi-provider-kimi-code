import https from "node:https";

const apiKey = process.env.KIMI_API_KEY ?? process.argv[2];
const baseUrl = process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1";

if (!apiKey) {
  console.error("Usage: KIMI_API_KEY=sk-... node scripts/kimi-compat/test_ref_support.mjs");
  process.exit(1);
}

const url = new URL("chat/completions", baseUrl.replace(/\/?$/, "/"));

function send(label, payload) {
  const body = JSON.stringify(payload);
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
          const ok = res.statusCode < 400;
          console.log(`  [${label}] ${res.statusCode} ${ok ? "OK" : "REJECT"}${detail}`);
          resolve(ok);
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const BASE = {
  model: "kimi-for-coding",
  messages: [{ role: "user", content: "Say hi." }],
  max_completion_tokens: 8,
  stream: false,
};

// Test 1: $ref with $defs
console.log("=== Test 1: $ref + $defs ===");
await send("ref-defs", {
  ...BASE,
  tools: [
    {
      type: "function",
      function: {
        name: "ref_test",
        description: "test",
        parameters: {
          type: "object",
          $defs: {
            item: {
              type: "object",
              properties: {
                name: { type: "string" },
                value: { type: "integer" },
              },
            },
          },
          properties: {
            a: { $ref: "#/$defs/item" },
            b: { $ref: "#/$defs/item" },
            c: { $ref: "#/$defs/item" },
          },
        },
      },
    },
  ],
});

// Test 2: $ref with definitions (older JSON Schema style)
console.log("\n=== Test 2: $ref + definitions ===");
await send("ref-definitions", {
  ...BASE,
  tools: [
    {
      type: "function",
      function: {
        name: "ref_test2",
        description: "test",
        parameters: {
          type: "object",
          definitions: {
            item: {
              type: "object",
              properties: {
                name: { type: "string" },
                value: { type: "integer" },
              },
            },
          },
          properties: {
            a: { $ref: "#/definitions/item" },
            b: { $ref: "#/definitions/item" },
          },
        },
      },
    },
  ],
});

// Test 3: inline (no $ref, as control)
console.log("\n=== Test 3: inline (control) ===");
const inlineItem = {
  type: "object",
  properties: {
    name: { type: "string" },
    value: { type: "integer" },
  },
};
await send("inline", {
  ...BASE,
  tools: [
    {
      type: "function",
      function: {
        name: "inline_test",
        description: "test",
        parameters: {
          type: "object",
          properties: {
            a: inlineItem,
            b: inlineItem,
            c: inlineItem,
          },
        },
      },
    },
  ],
});
