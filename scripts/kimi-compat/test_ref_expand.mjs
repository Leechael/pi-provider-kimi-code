import https from "node:https";

const apiKey = process.env.KIMI_API_KEY ?? process.argv[2];
const baseUrl = process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1";

if (!apiKey) {
  console.error("Usage: KIMI_API_KEY=sk-... node scripts/kimi-compat/test_ref_expand.mjs");
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
    req.setTimeout(30000, () => {
      req.destroy(new Error("Request timeout"));
    });
    req.end(body);
  });
}

// Build a big block ~5KB
const bigBlock = {
  type: "object",
  properties: {},
};
for (let i = 0; i < 100; i++) {
  bigBlock.properties[`field_${i}`] = {
    type: "string",
    description: `Description for field ${i} with some padding text`,
  };
}
const blockSize = Buffer.byteLength(JSON.stringify(bigBlock));
console.log(`Block size: ${blockSize} bytes`);

// Test A: $ref schema, wire size ~6KB, expanded size ~25KB (5 refs to 5KB block)
const refSchema = {
  type: "object",
  $defs: { big: bigBlock },
  properties: {
    a: { $ref: "#/$defs/big" },
    b: { $ref: "#/$defs/big" },
    c: { $ref: "#/$defs/big" },
    d: { $ref: "#/$defs/big" },
    e: { $ref: "#/$defs/big" },
  },
};
const wireSize = Buffer.byteLength(JSON.stringify(refSchema));
const expandedSize = blockSize * 5 + 200;
console.log(`\nRef schema wire size: ${wireSize} bytes`);
console.log(`Expanded size (approx): ${expandedSize} bytes`);
console.log(`Wire under 15KB: ${wireSize < 15000}`);
console.log(`Expanded under 15KB: ${expandedSize < 15000}`);

console.log("\n=== Test A: wire < 15KB, expanded > 15KB ===");
await send("ref-expand", refSchema);

// Test B: same content inlined (should be > 15KB, expect REJECT)
const inlineSchema = {
  type: "object",
  properties: {
    a: JSON.parse(JSON.stringify(bigBlock)),
    b: JSON.parse(JSON.stringify(bigBlock)),
    c: JSON.parse(JSON.stringify(bigBlock)),
    d: JSON.parse(JSON.stringify(bigBlock)),
    e: JSON.parse(JSON.stringify(bigBlock)),
  },
};
const inlineSize = Buffer.byteLength(JSON.stringify(inlineSchema));
console.log(`\nInline schema size: ${inlineSize} bytes`);

console.log("\n=== Test B: same content inlined (expect REJECT) ===");
await send("inline-expand", inlineSchema);
