import https from "node:https";

const apiKey = process.env.KIMI_API_KEY ?? process.argv[2];
const baseUrl = process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1";

if (!apiKey) {
  console.error("Usage: KIMI_API_KEY=sk-... node scripts/kimi-compat/find_size_limit.mjs");
  process.exit(1);
}

const url = new URL("chat/completions", baseUrl.replace(/\/?$/, "/"));

function buildPayload(schemaSize) {
  const props = {};
  let currentSize = 0;
  let idx = 0;
  while (currentSize < schemaSize) {
    const key = `p${idx++}`;
    const prop = { type: "string" };
    const added = JSON.stringify({ [key]: prop }).length - 2;
    if (currentSize + added > schemaSize) break;
    props[key] = prop;
    currentSize += added;
  }

  const remaining = schemaSize - JSON.stringify({ type: "object", properties: props }).length;
  if (remaining > 10) {
    props[`pad`] = { type: "string", description: "x".repeat(remaining) };
  }

  const schema = { type: "object", properties: props };
  return {
    model: "kimi-for-coding",
    messages: [{ role: "user", content: "Say hi." }],
    max_completion_tokens: 8,
    stream: false,
    tools: [
      {
        type: "function",
        function: {
          name: "size_test",
          description: "test",
          parameters: schema,
        },
      },
    ],
  };
}

function sendRequest(payload) {
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
          resolve({ status: res.statusCode, body: raw });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function probe(size) {
  const payload = buildPayload(size);
  const schemaActual = Buffer.byteLength(JSON.stringify(payload.tools[0].function.parameters));
  const res = await sendRequest(payload);
  const ok = res.status >= 200 && res.status < 300;
  const label = ok ? "OK" : "REJECT";
  console.log(`  schema=${schemaActual} bytes -> ${res.status} ${label}`);
  return ok;
}

console.log(`Target: ${url}`);
console.log();

// Coarse scan first
console.log("=== Coarse scan (1KB steps) ===");
let lo = 1000;
let hi = 30000;

const coarseStep = 1000;
let lastOk = null;
let firstFail = hi;

for (let size = lo; size <= hi; size += coarseStep) {
  const ok = await probe(size);
  if (ok) {
    lastOk = size;
  } else {
    firstFail = size;
    break;
  }
}

if (lastOk === null) {
  console.error("Coarse scan found no successful size. Check credentials / server status.");
  process.exit(1);
}

console.log();
console.log(`Coarse: last OK ~${lastOk}, first FAIL ~${firstFail}`);
console.log();

// Fine binary search
console.log("=== Binary search (byte-level) ===");
lo = lastOk;
hi = firstFail;

while (hi - lo > 100) {
  const mid = Math.floor((lo + hi) / 2);
  const ok = await probe(mid);
  if (ok) {
    lo = mid;
  } else {
    hi = mid;
  }
}

// Final sweep
console.log();
console.log("=== Final sweep ===");
for (let size = lo; size <= hi; size += 10) {
  await probe(size);
}

console.log();
console.log(`Limit is between ${lo} and ${hi} bytes (schema size).`);
