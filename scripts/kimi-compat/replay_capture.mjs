import { existsSync, readdirSync, readFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";

const captureDir = process.env.CAPTURE_DIR ?? join(process.cwd(), "captures");
const apiKey = process.env.KIMI_API_KEY ?? process.argv[2];
const baseUrl = process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1";

if (!apiKey) {
  console.error("Usage: KIMI_API_KEY=sk-... node scripts/replay-capture.mjs");
  console.error("   or: node scripts/replay-capture.mjs sk-...");
  process.exit(1);
}

const files = readdirSync(captureDir)
  .filter((f) => f.endsWith("-request.json"))
  .sort();

if (files.length === 0) {
  console.error("No captures found in", captureDir);
  process.exit(1);
}

const target = process.argv[3] ?? files[files.length - 1];
const capturePath = join(captureDir, target);
if (!existsSync(capturePath)) {
  console.error("Capture not found:", capturePath);
  process.exit(1);
}

const capture = JSON.parse(readFileSync(capturePath, "utf8"));
const body = capture.bodyJson ?? JSON.parse(capture.bodyUtf8);

if (body.stream) {
  body.stream = false;
}

const url = new URL(capture.url ?? "/chat/completions", baseUrl.replace(/\/v1\/?$/, ""));

const payload = JSON.stringify(body);

console.log(`Replaying ${target}`);
console.log(`  URL: ${url}`);
console.log(`  Body size: ${Buffer.byteLength(payload)} bytes`);
console.log(`  Tools: ${(body.tools ?? []).length}`);
for (const t of body.tools ?? []) {
  const name = t?.function?.name ?? t?.name ?? "?";
  console.log(`    - ${name}: ${Buffer.byteLength(JSON.stringify(t))} bytes`);
}
console.log();

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
      "Content-Length": String(Buffer.byteLength(payload)),
      "User-Agent": "KimiCLI/1.44.0",
      "X-Msh-Platform": "kimi_cli",
      "X-Msh-Version": "1.44.0",
    },
  },
  (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("error", (err) => {
      console.error("Response error:", err.message);
      process.exit(1);
    });
    res.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      console.log(`Status: ${res.statusCode} ${res.statusMessage}`);
      console.log(`Headers: ${JSON.stringify(res.headers, null, 2)}`);
      console.log();
      try {
        const json = JSON.parse(raw);
        console.log("Response body:");
        console.log(JSON.stringify(json, null, 2));
      } catch {
        console.log("Response body (raw):");
        console.log(raw);
      }
    });
  },
);

req.on("error", (err) => {
  console.error("Request error:", err.message);
  process.exit(1);
});

req.end(payload);
