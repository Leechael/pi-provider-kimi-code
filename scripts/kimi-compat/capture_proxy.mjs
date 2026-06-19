import { createWriteStream, mkdirSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";

const port = Number.parseInt(process.env.CAPTURE_PORT ?? "8787", 10);
const targetOrigin = new URL(process.env.CAPTURE_TARGET_ORIGIN ?? "https://api.kimi.com");
const captureDir = process.env.CAPTURE_DIR ?? join(process.cwd(), "captures");

mkdirSync(captureDir, { recursive: true });

let sequence = 0;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function tryParseJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  const out = createWriteStream(path, { flags: "w", encoding: "utf8" });
  out.end(`${JSON.stringify(value, null, 2)}\n`);
}

function responseHeaders(headers) {
  const out = { ...headers };
  delete out.connection;
  delete out["transfer-encoding"];
  return out;
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
    return;
  }

  const id = `${String(++sequence).padStart(4, "0")}-${timestamp()}`;
  const body = await collect(req);
  const targetUrl = new URL(req.url ?? "/", targetOrigin);
  const requestJson = {
    id,
    targetUrl: targetUrl.toString(),
    method: req.method,
    url: req.url,
    httpVersion: req.httpVersion,
    rawHeaders: req.rawHeaders,
    headers: req.headers,
    bodyUtf8: body.toString("utf8"),
    bodyBase64: body.toString("base64"),
    bodyJson: tryParseJson(body),
  };

  writeJson(join(captureDir, `${id}-request.json`), requestJson);
  console.log(`[capture] ${id} ${req.method} ${req.url} -> ${targetUrl}`);

  const headers = { ...req.headers, host: targetUrl.host };
  delete headers.connection;
  headers["content-length"] = String(body.length);

  const upstream = https.request(
    {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || 443,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: req.method,
      headers,
    },
    async (upstreamRes) => {
      const responseBody = await collect(upstreamRes);
      const responseJson = {
        id,
        statusCode: upstreamRes.statusCode,
        statusMessage: upstreamRes.statusMessage,
        rawHeaders: upstreamRes.rawHeaders,
        headers: upstreamRes.headers,
        bodyUtf8: responseBody.toString("utf8"),
        bodyBase64: responseBody.toString("base64"),
        bodyJson: tryParseJson(responseBody),
      };
      writeJson(join(captureDir, `${id}-response.json`), responseJson);
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders(upstreamRes.headers));
      res.end(responseBody);
    },
  );

  upstream.on("error", (error) => {
    writeJson(join(captureDir, `${id}-proxy-error.json`), {
      id,
      message: error.message,
      stack: error.stack,
    });
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  });

  upstream.end(body);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[capture] listening on http://127.0.0.1:${port}`);
  console.log(`[capture] forwarding to ${targetOrigin}`);
  console.log(`[capture] writing files to ${captureDir}`);
});
