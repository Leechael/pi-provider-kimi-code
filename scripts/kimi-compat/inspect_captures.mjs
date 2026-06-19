import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const captureDir = process.env.CAPTURE_DIR ?? join(process.cwd(), "captures");
if (!existsSync(captureDir)) {
  console.log("No request captures found.");
  process.exit(0);
}

const files = readdirSync(captureDir)
  .filter((file) => file.endsWith("-request.json"))
  .sort();

if (files.length === 0) {
  console.log("No request captures found.");
  process.exit(0);
}

for (const file of files) {
  let capture;
  try {
    capture = JSON.parse(readFileSync(join(captureDir, file), "utf8"));
  } catch (err) {
    console.error(`  skipping ${file}: ${err.message}`);
    continue;
  }
  const body = capture.bodyJson;
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const rows = [];

  for (const tool of tools) {
    const name =
      typeof tool?.function?.name === "string"
        ? tool.function.name
        : typeof tool?.name === "string"
          ? tool.name
          : "(unknown)";
    const schema = tool?.function?.parameters ?? tool?.input_schema;
    rows.push({
      name,
      schemaBytes: schema ? Buffer.byteLength(JSON.stringify(schema)) : 0,
      toolBytes: Buffer.byteLength(JSON.stringify(tool)),
    });
  }

  console.log(`${file} ${capture.method} ${capture.url}`);
  if (rows.length === 0) {
    console.log("  tools: none");
    continue;
  }
  for (const row of rows) {
    console.log(`  ${row.name}: schemaBytes=${row.schemaBytes} toolBytes=${row.toolBytes}`);
  }
}
