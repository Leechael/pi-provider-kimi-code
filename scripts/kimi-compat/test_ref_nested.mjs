import https from "node:https";

const apiKey = process.env.KIMI_API_KEY ?? process.argv[2];
const baseUrl = process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1";

if (!apiKey) {
  console.error("Usage: KIMI_API_KEY=sk-... node scripts/kimi-compat/test_ref_nested.mjs");
  process.exit(1);
}

const url = new URL("chat/completions", baseUrl.replace(/\/?$/, "/"));

function send(label, schema) {
  const payload = {
    model: "kimi-for-coding",
    messages: [{ role: "user", content: "Say hi." }],
    max_completion_tokens: 8,
    stream: false,
    tools: [
      {
        type: "function",
        function: { name: "test_tool", description: "test", parameters: schema },
      },
    ],
  };
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

// Test 1: $defs referencing another $defs
console.log("=== Test 1: $defs references another $defs ===");
await send("nested-ref", {
  type: "object",
  $defs: {
    address: {
      type: "object",
      properties: {
        street: { type: "string" },
        city: { type: "string" },
      },
    },
    person: {
      type: "object",
      properties: {
        name: { type: "string" },
        home: { $ref: "#/$defs/address" },
        work: { $ref: "#/$defs/address" },
      },
    },
  },
  properties: {
    sender: { $ref: "#/$defs/person" },
    receiver: { $ref: "#/$defs/person" },
  },
});

// Test 2: 3 levels deep — $defs -> $defs -> $defs
console.log("\n=== Test 2: 3 levels deep ($defs -> $defs -> $defs) ===");
await send("3-level-ref", {
  type: "object",
  $defs: {
    tag: {
      type: "object",
      properties: { key: { type: "string" }, value: { type: "string" } },
    },
    metadata: {
      type: "object",
      properties: {
        tags: { type: "array", items: { $ref: "#/$defs/tag" } },
        created: { type: "string" },
      },
    },
    resource: {
      type: "object",
      properties: {
        name: { type: "string" },
        meta: { $ref: "#/$defs/metadata" },
      },
    },
  },
  properties: {
    primary: { $ref: "#/$defs/resource" },
    secondary: { $ref: "#/$defs/resource" },
  },
});

// Test 3: recursive $ref (self-referencing)
console.log("\n=== Test 3: recursive $ref (self-referencing tree) ===");
await send("recursive-ref", {
  type: "object",
  $defs: {
    node: {
      type: "object",
      properties: {
        value: { type: "string" },
        children: {
          type: "array",
          items: { $ref: "#/$defs/node" },
        },
      },
    },
  },
  properties: {
    root: { $ref: "#/$defs/node" },
  },
});

// Test 4: $ref in anyOf/allOf
console.log("\n=== Test 4: $ref inside anyOf ===");
await send("ref-in-anyof", {
  type: "object",
  $defs: {
    stringVal: { type: "object", properties: { s: { type: "string" } } },
    intVal: { type: "object", properties: { n: { type: "integer" } } },
  },
  properties: {
    data: {
      anyOf: [{ $ref: "#/$defs/stringVal" }, { $ref: "#/$defs/intVal" }],
    },
  },
});

// Test 5: $ref in array items
console.log("\n=== Test 5: $ref in array items ===");
await send("ref-in-array", {
  type: "object",
  $defs: {
    entry: {
      type: "object",
      properties: {
        id: { type: "string" },
        score: { type: "number" },
      },
    },
  },
  properties: {
    entries: { type: "array", items: { $ref: "#/$defs/entry" } },
  },
});
