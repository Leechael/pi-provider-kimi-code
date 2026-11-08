// Lazy, cached sync of the kimi-datasource catalog.
//
// The upstream kimi-datasource plugin moved out of the kimi-code repo into the
// server-side plugin marketplace (#4525). There is no "list sources" RPC on the
// /tools backend: the authoritative source list is the `enum` inside the
// plugin's `bin/kimi-datasource.mjs` tool schema. So the sync pipeline is:
//
//   GET {base}/coding/v1/plugins/marketplace   (no auth required)
//     -> entry "kimi-datasource": { version, source (zip URL), sha256sum }
//     -> zip -> bin/kimi-datasource.mjs -> parse enum + capability text
//
// The result is cached on disk for CATALOG_TTL_MS (24h). Callers fall back to
// stale cache, then to the bundled snapshot, so tool calls never fail just
// because the marketplace is unreachable.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

import { getKimiCodeHome } from "../constants.ts";
import { getKimiBaseV1 } from "./common.ts";

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
// After a failed refresh, suppress retries for an hour instead of a full day.
const CATALOG_RETRY_BACKOFF_MS = 60 * 60 * 1000;
const CATALOG_FETCH_TIMEOUT_MS = 15_000;
const MARKETPLACE_PLUGIN_ID = "kimi-datasource";
const BIN_ENTRY_SUFFIX = "bin/kimi-datasource.mjs";

// Bundled snapshot of marketplace kimi-datasource 3.5.1 (2026-11-03). Used when
// no cache exists and the marketplace cannot be reached.
export const BUNDLED_DATASOURCE_VERSION = "3.5.1";
export const BUNDLED_DATASOURCE_SOURCES: readonly string[] = [
  "stock_finance_data",
  "yahoo_finance",
  "world_bank_open_data",
  "tianyancha",
  "arxiv",
  "scholar",
  "yuandian_law",
  "wind",
  "imf",
  "gildata",
  "sec_edgar",
  "sp_data",
  "china_nda",
  "china_nbs",
  "china_standards",
  "who",
  "fao",
  "unsd",
  "ecb",
  "eurostat",
  "unicef",
  "oecd",
  "fred",
  "xhcj",
  "caixin",
  "chembl",
  "materials_project",
  "ncbi_blast",
  "oqmd",
  "pdb",
  "pubchem",
  "uniprot",
  "dongcai",
  "cls",
  "finance_research",
];

export const BUNDLED_DATASOURCE_CAPABILITIES =
  "stock_finance_data / yahoo_finance = general quotes and financials " +
  "(yahoo_finance FX history is limited to about 2 years); world_bank_open_data = historical macro; " +
  "imf = FX rates, CPI, GDP forecasts, balance of payments; tianyancha = CN company registry; " +
  "arxiv / scholar = papers; yuandian_law = CN laws and cases; " +
  "wind = A-share intraday minute series, funds, bonds (map PE/PB/ROE-style field names via wind_search_fields first); " +
  "gildata = natural-language stock/fund screening; " +
  "sec_edgar = US filings (10-K/10-Q, S-1, Form 4, 13F, 8-K); " +
  "sp_data = S&P fundamentals (consensus estimates, valuation ratios, transcripts); " +
  "china_nda = CN government open data catalogs; china_nbs = CN NBS macro indicators and time series; " +
  "china_standards = CN standards (GB national, HB industry, DB local, TT association); " +
  "who / fao / unsd / ecb / eurostat / unicef / oecd / fred = international organization open data " +
  "(global health, food & agriculture, UN statistics, ECB & EU statistics, child indicators, OECD datasets, US & global macro series); " +
  "xhcj = Xinhua Finance (CNFIC) news flashes, announcements, and policies; " +
  "caixin = Caixin database (600+ data APIs, discover via caixin_api_search first); " +
  "chembl = curated ChEMBL compounds, targets, assays, bioactivities, and mechanisms of action; " +
  "materials_project = Materials Project DFT properties and MP ID lookup (requires MP_API_KEY); " +
  "ncbi_blast = asynchronous nucleotide/protein sequence similarity searches; " +
  "oqmd = OQMD DFT material properties and OPTIMADE crystal structures; " +
  "pdb = RCSB PDB experimental 3D structures, polymer entities, and ligands; " +
  "pubchem = PubChem chemical identities, synonyms, computed properties, and 2D similarity; " +
  "uniprot = UniProt protein sequences, functions, and annotations; " +
  "dongcai = East Money Miaoxiang market intelligence; cls = Cailian Press financial news; " +
  "finance_research = sell-side research reports";

export interface DatasourceCatalog {
  readonly version: string;
  readonly sources: readonly string[];
  readonly capabilities: string;
  readonly fetchedAt: number;
  readonly origin: "network" | "cache" | "bundled";
}

interface CatalogCacheFile {
  readonly version?: unknown;
  readonly sources?: unknown;
  readonly capabilities?: unknown;
  readonly fetchedAt?: unknown;
}

export function catalogCachePath(): string {
  const explicit = process.env.KIMI_DATASOURCE_CATALOG_PATH?.trim();
  if (explicit) return explicit;
  return join(getKimiCodeHome(), "kimi-datasource-catalog.json");
}

function parseCacheFile(raw: string): DatasourceCatalog | undefined {
  let parsed: CatalogCacheFile;
  try {
    parsed = JSON.parse(raw) as CatalogCacheFile;
  } catch {
    return undefined;
  }
  if (typeof parsed.version !== "string" || !Array.isArray(parsed.sources)) return undefined;
  const sources = parsed.sources.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (sources.length === 0) return undefined;
  const fetchedAt = typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0;
  return {
    version: parsed.version,
    sources,
    capabilities:
      typeof parsed.capabilities === "string" && parsed.capabilities.length > 0
        ? parsed.capabilities
        : BUNDLED_DATASOURCE_CAPABILITIES,
    fetchedAt,
    origin: "cache",
  };
}

/** Synchronous cache read for tool-registration time (description embedding). */
export function readCatalogCacheSync(): DatasourceCatalog | undefined {
  try {
    const path = catalogCachePath();
    if (!existsSync(path)) return undefined;
    return parseCacheFile(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeCatalogCache(catalog: DatasourceCatalog): void {
  try {
    const path = catalogCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          version: catalog.version,
          sources: catalog.sources,
          capabilities: catalog.capabilities,
          fetchedAt: catalog.fetchedAt,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch {
    // Cache is best-effort; a read-only home dir must not break the tool.
  }
}

// ---------------------------------------------------------------------------
// Minimal zip reader (stored + deflate), enough to pull one text entry.
// ---------------------------------------------------------------------------

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("invalid zip: end of central directory not found");
}

export function extractZipEntry(buf: Buffer, entrySuffix: string): Buffer | undefined {
  const eocd = findEndOfCentralDirectory(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("invalid zip: bad central entry");
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;
    if (name !== entrySuffix && !name.endsWith(`/${entrySuffix}`)) continue;

    if (buf.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error("invalid zip: bad local header");
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    throw new Error(`unsupported zip compression method: ${method}`);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Parse the datasource bin script: source enum + capability description.
// ---------------------------------------------------------------------------

export function parseDatasourceBin(script: string): {
  sources: string[];
  capabilities?: string;
} {
  const enumMatch = /enum:\s*\[((?:\s*'[^']*',?\s*)+)\]/.exec(script);
  if (!enumMatch) throw new Error("datasource bin: enum block not found");
  const sources = [...enumMatch[1].matchAll(/'([^']+)'/g)]
    .map((m) => m[1])
    .filter((s) => s.length > 0);
  if (sources.length === 0) throw new Error("datasource bin: enum block is empty");

  let capabilities: string | undefined;
  const descMatch = /description:\s*((?:\s*'[^']*'\s*\+?\s*)+)/.exec(script.slice(enumMatch.index));
  if (descMatch) {
    const text = [...descMatch[1].matchAll(/'([^']*)'/g)].map((m) => m[1]).join("");
    if (text.length > 0) capabilities = text;
  }
  return { sources, capabilities };
}

// ---------------------------------------------------------------------------
// Marketplace fetch
// ---------------------------------------------------------------------------

interface MarketplaceEntry {
  readonly version?: unknown;
  readonly source?: unknown;
  readonly sha256sum?: unknown;
}

async function fetchMarketplaceEntry(
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ version: string; source: string; sha256sum?: string } | undefined> {
  const url = `${getKimiBaseV1()}/plugins/marketplace`;
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`marketplace fetch failed: HTTP ${response.status}`);
  const body = (await response.json()) as { plugins?: MarketplaceEntry[] };
  const entry = (body.plugins ?? []).find((p) => {
    const id = (p as Record<string, unknown>).id;
    return id === MARKETPLACE_PLUGIN_ID;
  });
  if (!entry || typeof entry.source !== "string" || entry.source.length === 0) return undefined;
  return {
    version: typeof entry.version === "string" ? entry.version : "unknown",
    source: entry.source,
    sha256sum: typeof entry.sha256sum === "string" ? entry.sha256sum : undefined,
  };
}

async function fetchCatalogFromNetwork(
  fetchImpl: typeof fetch,
  cached: DatasourceCatalog | undefined,
  now: number,
  signal?: AbortSignal,
): Promise<DatasourceCatalog | undefined> {
  const timeout = AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const entry = await fetchMarketplaceEntry(fetchImpl, combined);
  if (!entry) return undefined;

  // Same marketplace version as the cache: the catalog cannot have changed,
  // so just renew the TTL without downloading the archive again.
  if (cached && entry.version === cached.version) {
    const renewed: DatasourceCatalog = { ...cached, fetchedAt: now, origin: "cache" };
    writeCatalogCache(renewed);
    return renewed;
  }

  const zipResponse = await fetchImpl(entry.source, { signal: combined });
  if (!zipResponse.ok) throw new Error(`archive fetch failed: HTTP ${zipResponse.status}`);
  const zipBuf = Buffer.from(await zipResponse.arrayBuffer());
  if (entry.sha256sum) {
    const digest = createHash("sha256").update(zipBuf).digest("hex");
    if (digest !== entry.sha256sum.toLowerCase()) {
      throw new Error("archive sha256 mismatch");
    }
  }
  const bin = extractZipEntry(zipBuf, BIN_ENTRY_SUFFIX);
  if (!bin) throw new Error("archive is missing the datasource bin entry");
  const parsed = parseDatasourceBin(bin.toString("utf8"));
  const catalog: DatasourceCatalog = {
    version: entry.version,
    sources: parsed.sources,
    capabilities: parsed.capabilities ?? BUNDLED_DATASOURCE_CAPABILITIES,
    fetchedAt: now,
    origin: "network",
  };
  writeCatalogCache(catalog);
  return catalog;
}

// ---------------------------------------------------------------------------
// Public lazy accessor with 24h caching. Never throws.
// ---------------------------------------------------------------------------

let memoryCatalog: DatasourceCatalog | undefined;
let inFlight: Promise<DatasourceCatalog> | undefined;

export interface EnsureCatalogOptions {
  readonly fetchImpl?: typeof fetch;
  /** Skip the TTL check and hit the network (used to re-validate unknown names). */
  readonly forceRefresh?: boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

function bundledCatalog(): DatasourceCatalog {
  return {
    version: BUNDLED_DATASOURCE_VERSION,
    sources: BUNDLED_DATASOURCE_SOURCES,
    capabilities: BUNDLED_DATASOURCE_CAPABILITIES,
    fetchedAt: 0,
    origin: "bundled",
  };
}

/**
 * Synchronous best-known catalog for validating a call without blocking on
 * the network: memory, then disk (any age), then the bundled snapshot.
 */
export function peekDatasourceCatalog(): DatasourceCatalog {
  return memoryCatalog ?? readCatalogCacheSync() ?? bundledCatalog();
}

/** Fire-and-forget refresh when the best-known catalog is past its TTL. */
export function refreshDatasourceCatalogInBackground(fetchImpl?: typeof fetch): void {
  const now = Date.now();
  if (memoryCatalog && now - memoryCatalog.fetchedAt < CATALOG_TTL_MS) return;
  const disk = readCatalogCacheSync();
  if (disk && now - disk.fetchedAt < CATALOG_TTL_MS) {
    memoryCatalog = disk;
    return;
  }
  void refreshCatalog(fetchImpl ?? fetch, disk, now);
}

export async function ensureDatasourceCatalog(
  options: EnsureCatalogOptions = {},
): Promise<DatasourceCatalog> {
  const now = options.now?.() ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!options.forceRefresh) {
    if (memoryCatalog && now - memoryCatalog.fetchedAt < CATALOG_TTL_MS) return memoryCatalog;
    const disk = readCatalogCacheSync();
    if (disk && now - disk.fetchedAt < CATALOG_TTL_MS) {
      memoryCatalog = disk;
      return disk;
    }
    return refreshCatalog(fetchImpl, disk, now, options.signal);
  }

  // Forced re-validation: network only, keep the previous catalog on failure.
  const previous = memoryCatalog ?? readCatalogCacheSync();
  try {
    const fresh = await fetchCatalogFromNetwork(fetchImpl, previous, now, options.signal);
    if (fresh) {
      memoryCatalog = fresh;
      return fresh;
    }
  } catch {
    // fall through to whatever we had
  }
  return previous ?? bundledCatalog();
}

function refreshCatalog(
  fetchImpl: typeof fetch,
  disk: DatasourceCatalog | undefined,
  now: number,
  signal?: AbortSignal,
): Promise<DatasourceCatalog> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const fresh = await fetchCatalogFromNetwork(fetchImpl, disk, now, signal);
      if (fresh) {
        memoryCatalog = fresh;
        return fresh;
      }
    } catch {
      // fall through to stale/bundled
    } finally {
      inFlight = undefined;
    }
    const fallback = disk ?? bundledCatalog();
    // Mark the fallback with the attempt time (minus most of the TTL) so a
    // network outage does not trigger a fetch on every tool call, but a
    // transient failure still retries after the backoff window.
    memoryCatalog = { ...fallback, fetchedAt: now - (CATALOG_TTL_MS - CATALOG_RETRY_BACKOFF_MS) };
    return memoryCatalog;
  })();
  return inFlight;
}

/** Test hook: drop the in-memory catalog and in-flight refresh. */
export function resetDatasourceCatalogForTests(): void {
  memoryCatalog = undefined;
  inFlight = undefined;
}
