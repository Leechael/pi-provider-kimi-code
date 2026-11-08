import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import {
  BUNDLED_DATASOURCE_SOURCES,
  CATALOG_TTL_MS,
  ensureDatasourceCatalog,
  extractZipEntry,
  parseDatasourceBin,
  readCatalogCacheSync,
  resetDatasourceCatalogForTests,
} from "../src/tools/datasource-catalog.ts";
import { buildKimiDatasourceTool } from "../src/tools/datasource.ts";

const BIN_FIXTURE = `
const TOOLS = [
  {
    name: 'get_data_source_desc',
    inputSchema: {
      properties: {
        name: {
          type: 'string',
          enum: [
            'arxiv',
            'wind',
            'finance_research',
          ],
          description:
            'Data source name. Capabilities: arxiv = papers; ' +
            'wind = A-share intraday; ' +
            'finance_research = sell-side research reports.',
        },
      },
    },
  },
];
`;

// --- minimal zip builder (stored or deflate), mirroring what the reader needs
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("datasource catalog", () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kimi-ds-catalog-"));
    savedPath = process.env.KIMI_DATASOURCE_CATALOG_PATH;
    process.env.KIMI_DATASOURCE_CATALOG_PATH = join(dir, "catalog.json");
    process.env.KIMI_CODE_BASE_URL = "https://proxy.example/kimi/v1";
    resetDatasourceCatalogForTests();
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.KIMI_DATASOURCE_CATALOG_PATH;
    else process.env.KIMI_DATASOURCE_CATALOG_PATH = savedPath;
    delete process.env.KIMI_CODE_BASE_URL;
    resetDatasourceCatalogForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses the source enum and capability text from the bin script", () => {
    const parsed = parseDatasourceBin(BIN_FIXTURE);
    assert.deepEqual(parsed.sources, ["arxiv", "wind", "finance_research"]);
    assert.match(parsed.capabilities ?? "", /arxiv = papers/);
    assert.match(parsed.capabilities ?? "", /sell-side research reports/);
  });

  it("extracts entries from stored and deflated zips", () => {
    const stored = buildZip([{ name: "bin/kimi-datasource.mjs", data: Buffer.from(BIN_FIXTURE) }]);
    assert.equal(extractZipEntry(stored, "bin/kimi-datasource.mjs")?.toString(), BIN_FIXTURE);

    const deflated = buildZip([
      { name: "plugin/bin/kimi-datasource.mjs", data: Buffer.from(BIN_FIXTURE), deflate: true },
    ]);
    assert.equal(extractZipEntry(deflated, "bin/kimi-datasource.mjs")?.toString(), BIN_FIXTURE);
  });

  it("syncs from the marketplace and caches for 24h", async () => {
    const zip = buildZip([{ name: "bin/kimi-datasource.mjs", data: Buffer.from(BIN_FIXTURE) }]);
    const digest = sha256(zip);
    const requested: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/plugins/marketplace")) {
        return new Response(
          JSON.stringify({
            plugins: [
              {
                id: "kimi-datasource",
                version: "9.9.9",
                source: "https://cdn.example/ds.zip",
                sha256sum: digest,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "https://cdn.example/ds.zip") {
        return new Response(new Uint8Array(zip), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const catalog = await ensureDatasourceCatalog({ fetchImpl: mockFetch });
    assert.deepEqual(catalog.sources, ["arxiv", "wind", "finance_research"]);
    assert.equal(catalog.version, "9.9.9");
    assert.equal(catalog.origin, "network");

    // Second call within the TTL must not touch the network.
    requested.length = 0;
    const again = await ensureDatasourceCatalog({ fetchImpl: mockFetch });
    assert.equal(requested.length, 0);
    assert.deepEqual(again.sources, catalog.sources);

    // After the TTL, a refresh with an unchanged version renews the cache
    // without downloading the archive again.
    resetDatasourceCatalogForTests();
    const later = Date.now() + CATALOG_TTL_MS + 1_000;
    const renewed = await ensureDatasourceCatalog({ fetchImpl: mockFetch, now: () => later });
    assert.equal(renewed.version, "9.9.9");
    assert.equal(renewed.fetchedAt, later);
    assert.deepEqual(requested, ["https://proxy.example/kimi/v1/plugins/marketplace"]);
  });

  it("falls back to stale cache, then to the bundled snapshot", async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error("network down");
    };

    // No cache, no network -> bundled snapshot.
    const bundled = await ensureDatasourceCatalog({ fetchImpl: failingFetch });
    assert.equal(bundled.origin, "bundled");
    assert.deepEqual([...bundled.sources], [...BUNDLED_DATASOURCE_SOURCES]);

    // Stale cache + no network -> stale cache wins over bundled.
    const stale = {
      version: "0.0.1",
      sources: ["stale_source"],
      capabilities: "stale",
      fetchedAt: 1,
    };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "catalog.json"), JSON.stringify(stale));
    resetDatasourceCatalogForTests();
    const cached = await ensureDatasourceCatalog({ fetchImpl: failingFetch });
    assert.equal(cached.version, "0.0.1");
    assert.deepEqual(cached.sources, ["stale_source"]);
  });

  it("rejects archives with a bad sha256 and keeps the previous catalog", async () => {
    const zip = buildZip([{ name: "bin/kimi-datasource.mjs", data: Buffer.from(BIN_FIXTURE) }]);
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/plugins/marketplace")) {
        return new Response(
          JSON.stringify({
            plugins: [
              {
                id: "kimi-datasource",
                version: "1.0.0",
                source: "https://cdn.example/ds.zip",
                sha256sum: "0".repeat(64),
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(new Uint8Array(zip), { status: 200 });
    };
    const catalog = await ensureDatasourceCatalog({ fetchImpl: mockFetch });
    assert.equal(catalog.origin, "bundled");
    assert.equal(readCatalogCacheSync(), undefined);
  });

  it("tool rejects unknown sources with the catalog list, and re-validates after refresh", async () => {
    // NB: names in the bundled snapshot validate without any network, so the
    // reject/accept cycle below uses a source the bundled snapshot lacks.
    let sources = ["arxiv"];
    const zip = () =>
      buildZip([
        {
          name: "bin/kimi-datasource.mjs",
          data: Buffer.from(
            BIN_FIXTURE.replace(
              "'arxiv',\n            'wind',\n            'finance_research',",
              sources.map((s) => `'${s}',`).join("\n"),
            ),
          ),
        },
      ]);
    let version = "1.0.0";
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/plugins/marketplace")) {
        const z = zip();
        return new Response(
          JSON.stringify({
            plugins: [
              {
                id: "kimi-datasource",
                version,
                source: "https://cdn.example/ds.zip",
                sha256sum: sha256(z),
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "https://cdn.example/ds.zip")
        return new Response(new Uint8Array(zip()), { status: 200 });
      // Actual datasource call.
      return new Response(
        JSON.stringify({ is_success: true, result: { assistant: [{ text: "ok" }] } }),
        {
          status: 200,
        },
      );
    };

    const tool = buildKimiDatasourceTool({
      deps: { fetch: mockFetch, getAccessToken: () => "oauth-token" },
    });
    const execute = tool.execute as unknown as (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>;

    const rejected = await execute("t1", { data_source_name: "brand_new_source" });
    const rejectedText = rejected.content[0].text ?? "";
    assert.match(rejectedText, /Unknown data source "brand_new_source"/);
    assert.match(rejectedText, /arxiv/);

    // Server adds the source; the unknown-name path force-refreshes (version
    // bump -> archive download) and accepts it.
    sources = ["arxiv", "brand_new_source"];
    version = "1.1.0";
    const accepted = await execute("t2", { data_source_name: "brand_new_source" });
    assert.match(accepted.content[0].text ?? "", /ok/);
  });
});
