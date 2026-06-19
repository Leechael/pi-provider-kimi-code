import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { optimizeToolSchemas, resetToolSchemaCache } from "../src/schema-dedup.ts";

const KIMI_PER_TOOL_LIMIT = 15_000;

interface CorpusTool {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
  _source?: string;
}

function jsonSize(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v));
}

function loadCorpus(): CorpusTool[] {
  const path = join(
    import.meta.dirname,
    "..",
    "scripts",
    "kimi-compat",
    "corpus",
    "all-tools.json",
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

function findTool(corpus: CorpusTool[], name: string): CorpusTool {
  const tool = corpus.find((t) => t.function.name === name);
  assert.ok(tool, `expected tool "${name}" in corpus`);
  return tool;
}

function normalizeTool(tool: CorpusTool): CorpusTool {
  resetToolSchemaCache();
  const result = optimizeToolSchemas([structuredClone(tool)]);
  return result[0] as CorpusTool;
}

// ---------------------------------------------------------------------------
// Dedup algorithm
// ---------------------------------------------------------------------------

describe("deduplicateSchema", () => {
  const corpus = loadCorpus();

  it("reduces oversized subagent schema below 15 KB", () => {
    const subagent = findTool(corpus, "subagent");
    assert.ok(jsonSize(subagent.function.parameters) > KIMI_PER_TOOL_LIMIT);

    const normalized = normalizeTool(subagent);
    assert.ok(jsonSize(normalized.function.parameters) < KIMI_PER_TOOL_LIMIT);
  });

  it("does not modify tools already under the threshold", () => {
    const small = corpus.filter((t) => jsonSize(t.function.parameters) <= KIMI_PER_TOOL_LIMIT);
    assert.ok(small.length > 0);

    resetToolSchemaCache();
    const result = optimizeToolSchemas(small.map((t) => structuredClone(t)));
    for (let i = 0; i < small.length; i++) {
      assert.deepStrictEqual(
        (result[i] as CorpusTool).function.parameters,
        small[i].function.parameters,
        `${small[i].function.name} should be unchanged`,
      );
    }
  });

  it("produces valid $defs/$ref structure", () => {
    const normalized = normalizeTool(findTool(corpus, "subagent"));
    const params = normalized.function.parameters as Record<string, unknown>;

    assert.ok(params.$defs, "should have $defs");
    const defs = params.$defs as Record<string, unknown>;
    assert.ok(Object.keys(defs).length > 0);

    const serialized = JSON.stringify(params);
    assert.ok(serialized.includes('"$ref"'));
    for (const key of Object.keys(defs)) {
      assert.ok(serialized.includes(`"#/$defs/${key}"`));
    }
  });

  it("is deterministic", () => {
    resetToolSchemaCache();
    const result1 = optimizeToolSchemas(corpus.map((t) => structuredClone(t)));
    resetToolSchemaCache();
    const result2 = optimizeToolSchemas(corpus.map((t) => structuredClone(t)));
    assert.deepStrictEqual(result1, result2);
  });

  it("normalizes every corpus tool under 15 KB", () => {
    const offenders: string[] = [];
    for (const tool of corpus) {
      const normalized = normalizeTool(tool);
      const size = jsonSize(normalized.function.parameters);
      if (size > KIMI_PER_TOOL_LIMIT) {
        offenders.push(`${tool.function.name} [${tool._source ?? "?"}]: ${size} bytes`);
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("normalizes full corpus in one batch", () => {
    resetToolSchemaCache();
    const result = optimizeToolSchemas(corpus.map((t) => structuredClone(t)));
    const offenders: string[] = [];
    for (let i = 0; i < result.length; i++) {
      const tool = result[i] as CorpusTool;
      const size = jsonSize(tool.function.parameters);
      if (size > KIMI_PER_TOOL_LIMIT) {
        offenders.push(`${tool.function.name}: ${size} bytes`);
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("merges with existing $defs without collision", () => {
    resetToolSchemaCache();
    const repeated = {
      type: "object",
      properties: {
        name: { type: "string" },
        value: { type: "integer" },
        extra: { type: "string", description: "x".repeat(200) },
      },
    };
    const schema = {
      type: "object",
      $defs: { existing: { type: "string", description: "pre-existing def" } },
      properties: {} as Record<string, unknown>,
    };
    for (let i = 0; i < 200; i++) {
      schema.properties[`p${i}`] = JSON.parse(JSON.stringify(repeated));
    }

    const tools = [
      { type: "function", function: { name: "test", description: "test", parameters: schema } },
    ];
    const result = optimizeToolSchemas(tools);
    const params = ((result[0] as Record<string, unknown>).function as Record<string, unknown>)
      .parameters as Record<string, unknown>;
    const defs = params.$defs as Record<string, unknown>;

    assert.ok(defs.existing, "pre-existing $defs entry should be preserved");
    assert.ok(Object.keys(defs).length > 1);
  });

  it("handles property names containing dots", () => {
    resetToolSchemaCache();
    const repeated = {
      type: "object",
      properties: {
        name: { type: "string" },
        value: { type: "integer" },
        extra: { type: "string", description: "x".repeat(200) },
      },
    };
    const schema: Record<string, unknown> = {
      type: "object",
      properties: {} as Record<string, unknown>,
    };
    const props = schema.properties as Record<string, unknown>;
    for (let i = 0; i < 80; i++) {
      props[`field.${i}`] = JSON.parse(JSON.stringify(repeated));
    }
    const originalSize = jsonSize(schema);

    const tools = [
      { type: "function", function: { name: "dotted", description: "test", parameters: schema } },
    ];
    const result = optimizeToolSchemas(tools);
    const params = ((result[0] as Record<string, unknown>).function as Record<string, unknown>)
      .parameters as Record<string, unknown>;

    assert.ok(jsonSize(params) < originalSize);
    assert.ok((params.$defs as Record<string, unknown> | undefined) !== undefined);
  });

  it("never increases schema size", () => {
    resetToolSchemaCache();
    const repeated = { type: "string", description: "x".repeat(30) };
    const schema: Record<string, unknown> = {
      type: "object",
      properties: {} as Record<string, unknown>,
    };
    const props = schema.properties as Record<string, unknown>;
    for (let i = 0; i < 2; i++) {
      props[`f${i}`] = JSON.parse(JSON.stringify(repeated));
    }
    const pad = "y".repeat(14_000 - Buffer.byteLength(JSON.stringify(schema)));
    props.pad = { type: "string", description: pad };
    const originalSize = jsonSize(schema);

    const tools = [
      { type: "function", function: { name: "edge", description: "test", parameters: schema } },
    ];
    const result = optimizeToolSchemas(tools);
    const optimizedSize = jsonSize(
      ((result[0] as Record<string, unknown>).function as Record<string, unknown>).parameters,
    );
    assert.ok(optimizedSize <= originalSize, `${optimizedSize} > ${originalSize}`);
  });

  it("never pushes a schema from under 15KB to over 15KB", () => {
    resetToolSchemaCache();
    const repeated = { type: "string", description: "x".repeat(25) };
    const schema: Record<string, unknown> = {
      type: "object",
      properties: {} as Record<string, unknown>,
    };
    const props = schema.properties as Record<string, unknown>;
    for (let i = 0; i < 2; i++) {
      props[`f${i}`] = JSON.parse(JSON.stringify(repeated));
    }
    const targetSize = 14_995;
    const currentSize = Buffer.byteLength(JSON.stringify(schema));
    if (currentSize < targetSize) {
      props.pad = { type: "string", description: "z".repeat(targetSize - currentSize) };
    }
    const originalSize = jsonSize(schema);

    const tools = [
      {
        type: "function",
        function: { name: "boundary", description: "test", parameters: schema },
      },
    ];
    const result = optimizeToolSchemas(tools);
    const optimizedSize = jsonSize(
      ((result[0] as Record<string, unknown>).function as Record<string, unknown>).parameters,
    );
    assert.ok(optimizedSize <= originalSize, `${optimizedSize} > ${originalSize}`);
  });

  it("handles tools without function.parameters gracefully", () => {
    resetToolSchemaCache();
    const tools = [{ type: "function", function: { name: "bare", description: "no params" } }];
    const result = optimizeToolSchemas(tools);
    assert.deepStrictEqual(result, tools);
  });
});

// ---------------------------------------------------------------------------
// Cache fingerprint
// ---------------------------------------------------------------------------

describe("toolsFingerprint", () => {
  it("caches on identical input", () => {
    resetToolSchemaCache();
    const tools = loadCorpus();
    const result1 = optimizeToolSchemas(tools);
    const result2 = optimizeToolSchemas(tools);
    assert.strictEqual(result1, result2);
  });

  it("invalidates when tool set changes", () => {
    resetToolSchemaCache();
    const tools = loadCorpus();
    const result1 = optimizeToolSchemas(tools);
    const result2 = optimizeToolSchemas(tools.slice(0, 4));
    assert.notStrictEqual(result1, result2);
  });

  it("invalidates when schema content changes", () => {
    resetToolSchemaCache();
    const v1 = [
      {
        type: "function",
        function: {
          name: "t",
          description: "test",
          parameters: { type: "object", properties: { first: { type: "string" } } },
        },
      },
    ];
    const v2 = [
      {
        type: "function",
        function: {
          name: "t",
          description: "test",
          parameters: { type: "object", properties: { second: { type: "integer" } } },
        },
      },
    ];
    optimizeToolSchemas(v1);
    const result2 = optimizeToolSchemas(v2);
    const params = ((result2[0] as Record<string, unknown>).function as Record<string, unknown>)
      .parameters as Record<string, unknown>;
    assert.ok((params.properties as Record<string, unknown>).second);
  });

  it("invalidates when serialized length is identical but content differs", () => {
    resetToolSchemaCache();
    const v1 = [
      {
        type: "function",
        function: {
          name: "t",
          description: "test",
          parameters: { type: "object", properties: { alpha: { type: "string" } } },
        },
      },
    ];
    const v2 = [
      {
        type: "function",
        function: {
          name: "t",
          description: "test",
          parameters: { type: "object", properties: { bravo: { type: "string" } } },
        },
      },
    ];
    assert.strictEqual(
      JSON.stringify(v1[0].function.parameters).length,
      JSON.stringify(v2[0].function.parameters).length,
      "precondition: identical serialized length",
    );
    const result1 = optimizeToolSchemas(v1);
    const result2 = optimizeToolSchemas(v2);
    assert.notStrictEqual(result1, result2);
  });

  it("invalidates when description changes", () => {
    resetToolSchemaCache();
    const params = { type: "object", properties: { x: { type: "string" } } };
    const result1 = optimizeToolSchemas([
      { type: "function", function: { name: "t", description: "FIRST", parameters: params } },
    ]);
    const result2 = optimizeToolSchemas([
      { type: "function", function: { name: "t", description: "SECOND", parameters: params } },
    ]);
    assert.notStrictEqual(result1, result2);
  });

  it("returns original array when nothing to optimize", () => {
    resetToolSchemaCache();
    const tools = [
      {
        type: "function",
        function: {
          name: "small",
          description: "test",
          parameters: { type: "object", properties: { a: { type: "string" } } },
        },
      },
    ];
    assert.strictEqual(optimizeToolSchemas(tools), tools);
  });

  it("tolerates non-serializable array entries", () => {
    resetToolSchemaCache();
    const tools: unknown[] = [undefined, () => {}, Symbol("test")];
    assert.doesNotThrow(() => optimizeToolSchemas(tools));
  });

  it("tolerates unstringifiable entries", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cases: unknown[] = [
      1n,
      { value: 1n },
      cyclic,
      {
        toJSON() {
          throw new Error("boom");
        },
      },
    ];
    const failures: string[] = [];
    for (const value of cases) {
      resetToolSchemaCache();
      try {
        optimizeToolSchemas([value] as unknown[]);
      } catch (err) {
        failures.push((err as Error).message);
      }
    }
    assert.deepStrictEqual(failures, []);
  });

  it("distinguishes non-serializable types", () => {
    resetToolSchemaCache();
    const r1 = optimizeToolSchemas([undefined] as unknown[]);
    const r2 = optimizeToolSchemas([() => {}] as unknown[]);
    const r3 = optimizeToolSchemas([Symbol("x")] as unknown[]);
    assert.notStrictEqual(r1, r2);
    assert.notStrictEqual(r2, r3);
    assert.notStrictEqual(r1, r3);
  });

  it("distinguishes different functions", () => {
    resetToolSchemaCache();
    const a = () => "a";
    const b = () => "b";
    const r1 = optimizeToolSchemas([a] as unknown[]);
    const r2 = optimizeToolSchemas([b] as unknown[]);
    assert.notStrictEqual(r1, r2);
    assert.strictEqual(r2[0], b);
  });

  it("distinguishes different symbols (same description)", () => {
    resetToolSchemaCache();
    const a = Symbol("same");
    const b = Symbol("same");
    const r1 = optimizeToolSchemas([a] as unknown[]);
    const r2 = optimizeToolSchemas([b] as unknown[]);
    assert.notStrictEqual(r1, r2);
    assert.strictEqual(r2[0], b);
  });

  it("distinguishes objects with non-serializable properties", () => {
    resetToolSchemaCache();
    const a = { marker: () => "a" };
    const b = { marker: () => "b" };
    const r1 = optimizeToolSchemas([a] as unknown[]);
    const r2 = optimizeToolSchemas([b] as unknown[]);
    assert.notStrictEqual(r1, r2);
    assert.strictEqual(r2[0], b);
  });

  it("distinguishes JSON.stringify collision cases", () => {
    const cases: Array<{ name: string; first: unknown; second: unknown }> = [
      { name: "undefined prop vs missing", first: { marker: undefined }, second: {} },
      { name: "array undefined vs null", first: [undefined], second: [null] },
      { name: "array function vs null", first: [() => "a"], second: [null] },
      { name: "array symbol vs null", first: [Symbol("a")], second: [null] },
      { name: "NaN vs null", first: Number.NaN, second: null },
      { name: "Infinity vs null", first: Number.POSITIVE_INFINITY, second: null },
      { name: "RegExp identity", first: /first/, second: /second/ },
      { name: "Error identity", first: new Error("a"), second: new Error("b") },
      {
        name: "Promise identity",
        first: Promise.resolve("a"),
        second: Promise.resolve("b"),
      },
      {
        name: "Map identity",
        first: new Map([["a", 1]]),
        second: new Map([["b", 2]]),
      },
      { name: "Set identity", first: new Set(["a"]), second: new Set(["b"]) },
      {
        name: "ArrayBuffer identity",
        first: new Uint8Array([1]).buffer,
        second: new Uint8Array([2]).buffer,
      },
      {
        name: "DataView identity",
        first: new DataView(new Uint8Array([1]).buffer),
        second: new DataView(new Uint8Array([2]).buffer),
      },
      {
        name: "WeakMap identity",
        first: new WeakMap([[{}, "a"]]),
        second: new WeakMap([[{}, "b"]]),
      },
      { name: "WeakSet identity", first: new WeakSet([{}]), second: new WeakSet([{}]) },
      {
        name: "toJSON identity",
        first: { toJSON: () => "same" },
        second: { toJSON: () => "same" },
      },
    ];

    const failures: string[] = [];
    for (const { name, first, second } of cases) {
      resetToolSchemaCache();
      const r1 = optimizeToolSchemas([first] as unknown[]);
      const r2 = optimizeToolSchemas([second] as unknown[]);
      if (r1 === r2 || r2[0] !== second) failures.push(name);
    }
    assert.deepStrictEqual(failures, []);
  });
});
