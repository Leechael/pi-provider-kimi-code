import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const captureDir = process.env.CAPTURE_DIR ?? join(process.cwd(), "captures");
const showSecrets = process.env.SHOW_SECRETS === "1";
const requestedFile = process.argv[2];

function latestRequestFile() {
  if (!existsSync(captureDir)) return null;
  const files = readdirSync(captureDir)
    .filter((file) => file.endsWith("-request.json"))
    .sort();
  return files.at(-1) ?? null;
}

function redactHeaderValue(name, value) {
  if (showSecrets) return value;
  const lower = name.toLowerCase();
  if (
    lower === "authorization" ||
    lower === "x-api-key" ||
    lower === "api-key" ||
    lower === "cookie"
  ) {
    return "<redacted>";
  }
  return value;
}

const file = requestedFile ? basename(requestedFile) : latestRequestFile();
if (!file) {
  console.error("No request captures found.");
  process.exit(1);
}

const capture = JSON.parse(readFileSync(join(captureDir, file), "utf8"));
const method = capture.method ?? "POST";
const url = capture.url ?? "/";
const httpVersion = capture.httpVersion ?? "1.1";

console.log(`${method} ${url} HTTP/${httpVersion}`);

const rawHeaders = Array.isArray(capture.rawHeaders) ? capture.rawHeaders : [];
for (let index = 0; index < rawHeaders.length; index += 2) {
  const name = rawHeaders[index];
  const value = rawHeaders[index + 1];
  if (typeof name !== "string" || typeof value !== "string") continue;
  console.log(`${name}: ${redactHeaderValue(name, value)}`);
}

console.log("");
process.stdout.write(capture.bodyUtf8 ?? "");
if (!String(capture.bodyUtf8 ?? "").endsWith("\n")) process.stdout.write("\n");
