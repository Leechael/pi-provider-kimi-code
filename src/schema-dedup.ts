// Tool schema deduplication: extract repeated sub-schemas into $defs/$ref
// to stay under Moonshot's ~15 KB per-tool function.parameters limit.

import { createHash } from "node:crypto";

import type { JsonRecord } from "./payload.ts";

const TOOL_SCHEMA_SIZE_THRESHOLD = 14_000;
const MIN_FRAGMENT_SIZE = 50;
const MAX_DEDUP_PASSES = 5;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is JsonRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jsonSize(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v));
}

type PathSegment = string | number;
type FragmentMap = Map<string, PathSegment[][]>;

function collectFragments(
  node: unknown,
  path: PathSegment[],
  map: FragmentMap,
  minSize: number,
): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectFragments(item, [...path, i], map, minSize));
    return;
  }
  const serialized = JSON.stringify(node);
  if (serialized.length >= minSize) {
    let paths = map.get(serialized);
    if (!paths) {
      paths = [];
      map.set(serialized, paths);
    }
    paths.push(path);
  }
  for (const [key, value] of Object.entries(node as JsonRecord)) {
    collectFragments(value, [...path, key], map, minSize);
  }
}

function setAtPath(root: JsonRecord, path: PathSegment[], value: unknown): void {
  let current: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isRecord(current) && !Array.isArray(current)) return;
    current = (current as Record<string, unknown>)[path[i]];
  }
  if (isRecord(current) || Array.isArray(current)) {
    (current as Record<string, unknown>)[path[path.length - 1]] = value;
  }
}

function isDescendant(child: PathSegment[], ancestor: PathSegment[]): boolean {
  if (child.length <= ancestor.length) return false;
  for (let i = 0; i < ancestor.length; i++) {
    if (child[i] !== ancestor[i]) return false;
  }
  return true;
}

function nextDefKey(existing: Set<string>, index: number): string {
  let key = `d${index}`;
  while (existing.has(key)) key = `d${++index}`;
  return key;
}

// ---------------------------------------------------------------------------
// Core dedup
// ---------------------------------------------------------------------------

function deduplicateSchema(schema: JsonRecord): JsonRecord {
  const result: JsonRecord = JSON.parse(JSON.stringify(schema));
  const defs: JsonRecord = isRecord(result.$defs) ? (result.$defs as JsonRecord) : {};
  const existingKeys = new Set(Object.keys(defs));
  let defIndex = 0;
  const replaced: PathSegment[][] = [];

  for (let pass = 0; pass < MAX_DEDUP_PASSES; pass++) {
    const fragments: FragmentMap = new Map();
    collectFragments(result, [], fragments, MIN_FRAGMENT_SIZE);

    const candidates = [...fragments.entries()]
      .filter(([, paths]) => paths.length >= 2)
      .sort((a, b) => b[0].length - a[0].length);

    let progress = false;
    for (const [serialized, paths] of candidates) {
      const active = paths.filter((p) => !replaced.some((r) => isDescendant(p, r)));
      if (active.length < 2) continue;

      const size = Buffer.byteLength(serialized);
      const savings = (active.length - 1) * size - 40;
      if (savings <= 0) continue;

      const key = nextDefKey(existingKeys, defIndex++);
      existingKeys.add(key);
      defs[key] = JSON.parse(serialized);

      for (const p of active) {
        setAtPath(result, p, { $ref: `#/$defs/${key}` });
        replaced.push(p);
      }
      progress = true;
    }
    if (!progress) break;
  }

  if (Object.keys(defs).length > 0) {
    result.$defs = defs;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API with caching
// ---------------------------------------------------------------------------

let cachedFingerprint: string | null = null;
let cachedTools: unknown[] | null = null;

function toolsFingerprint(tools: unknown[]): string {
  const hash = createHash("sha256");
  for (const t of tools) {
    const serialized = JSON.stringify(t);
    if (serialized !== undefined) {
      hash.update(serialized);
    } else {
      hash.update(`<${typeof t}>`);
    }
    hash.update("|");
  }
  return hash.digest("hex");
}

export function optimizeToolSchemas(tools: unknown[]): unknown[] {
  const fp = toolsFingerprint(tools);
  if (fp === cachedFingerprint && cachedTools) return cachedTools;

  let changed = false;
  const result = tools.map((tool) => {
    if (!isRecord(tool) || !isRecord(tool.function)) return tool;
    const fn = tool.function as JsonRecord;
    const params = fn.parameters;
    if (!isRecord(params)) return tool;

    const size = jsonSize(params);
    if (size <= TOOL_SCHEMA_SIZE_THRESHOLD) return tool;

    const optimized = deduplicateSchema(params);
    changed = true;
    return { ...tool, function: { ...fn, parameters: optimized } };
  });

  cachedFingerprint = fp;
  cachedTools = changed ? result : tools;
  return cachedTools;
}

export function resetToolSchemaCache(): void {
  cachedFingerprint = null;
  cachedTools = null;
}
