import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { optimizeToolSchemas, resetToolSchemaCache } from "../src/schema-dedup.ts";

function jsonSize(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v));
}

function loadCapturedTools(): unknown[] {
  const fixturePath = join(import.meta.dirname, "..", "fixtures", "oversized-tools.json");
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

describe("optimizeToolSchemas", () => {
  it("reduces oversized subagent schema below 15 KB", () => {
    resetToolSchemaCache();
    const tools = loadCapturedTools();
    const subagent = tools[4] as Record<string, unknown>;
    const fn = subagent.function as Record<string, unknown>;
    const originalSize = jsonSize(fn.parameters);
    assert.ok(originalSize > 15_000, `original should be oversized: ${originalSize}`);

    const optimized = optimizeToolSchemas(tools);
    const optFn = (optimized[4] as Record<string, unknown>).function as Record<string, unknown>;
    const optimizedSize = jsonSize(optFn.parameters);
    assert.ok(optimizedSize < 15_000, `optimized should be under 15KB: ${optimizedSize}`);
  });

  it("does not modify tools under the threshold", () => {
    resetToolSchemaCache();
    const tools = loadCapturedTools();
    const optimized = optimizeToolSchemas(tools);

    for (let i = 0; i < 4; i++) {
      const orig = (tools[i] as Record<string, unknown>).function as Record<string, unknown>;
      const opt = (optimized[i] as Record<string, unknown>).function as Record<string, unknown>;
      assert.deepStrictEqual(opt.parameters, orig.parameters, `tool ${i} should be unchanged`);
    }
  });

  it("produces valid JSON Schema with $defs and $ref", () => {
    resetToolSchemaCache();
    const tools = loadCapturedTools();
    const optimized = optimizeToolSchemas(tools);
    const optFn = (optimized[4] as Record<string, unknown>).function as Record<string, unknown>;
    const params = optFn.parameters as Record<string, unknown>;

    assert.ok(params.$defs, "should have $defs");
    const defs = params.$defs as Record<string, unknown>;
    assert.ok(Object.keys(defs).length > 0, "should have at least one $def entry");

    const serialized = JSON.stringify(params);
    assert.ok(serialized.includes('"$ref"'), "should contain $ref references");
    for (const key of Object.keys(defs)) {
      assert.ok(serialized.includes(`"#/$defs/${key}"`), `$ref should reference $defs/${key}`);
    }
  });

  it("is deterministic — same input produces identical output", () => {
    resetToolSchemaCache();
    const tools = loadCapturedTools();
    const result1 = optimizeToolSchemas(tools);

    resetToolSchemaCache();
    const result2 = optimizeToolSchemas(loadCapturedTools());

    assert.deepStrictEqual(result1, result2);
  });

  it("caches result based on tool fingerprint", () => {
    resetToolSchemaCache();
    const tools = loadCapturedTools();
    const result1 = optimizeToolSchemas(tools);
    const result2 = optimizeToolSchemas(tools);
    assert.strictEqual(result1, result2, "should return same reference on cache hit");
  });

  it("invalidates cache when tool names change", () => {
    resetToolSchemaCache();
    const tools = loadCapturedTools();
    const result1 = optimizeToolSchemas(tools);
    const result2 = optimizeToolSchemas(tools.slice(0, 4));
    assert.notStrictEqual(result1, result2, "different tool set should bust cache");
  });

  it("invalidates cache when schema content changes for same tool names", () => {
    resetToolSchemaCache();
    const toolsV1 = [
      {
        type: "function",
        function: {
          name: "my_tool",
          description: "test",
          parameters: { type: "object", properties: { first: { type: "string" } } },
        },
      },
    ];
    const toolsV2 = [
      {
        type: "function",
        function: {
          name: "my_tool",
          description: "test",
          parameters: { type: "object", properties: { second: { type: "integer" } } },
        },
      },
    ];
    const result1 = optimizeToolSchemas(toolsV1);
    const result2 = optimizeToolSchemas(toolsV2);
    const params1 = ((result1[0] as Record<string, unknown>).function as Record<string, unknown>)
      .parameters as Record<string, unknown>;
    const params2 = ((result2[0] as Record<string, unknown>).function as Record<string, unknown>)
      .parameters as Record<string, unknown>;
    assert.notDeepStrictEqual(params1, params2, "different schemas should not return stale cache");
    assert.ok(
      (params2.properties as Record<string, unknown>).second,
      "should have second property from v2",
    );
  });

  it("invalidates cache when schema content differs but serialized length is identical", () => {
    resetToolSchemaCache();
    const toolsV1 = [
      {
        type: "function",
        function: {
          name: "t",
          description: "test",
          parameters: { type: "object", properties: { alpha: { type: "string" } } },
        },
      },
    ];
    const toolsV2 = [
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
      JSON.stringify(toolsV1[0].function.parameters).length,
      JSON.stringify(toolsV2[0].function.parameters).length,
      "precondition: both schemas must have identical serialized length",
    );
    const result1 = optimizeToolSchemas(toolsV1);
    const result2 = optimizeToolSchemas(toolsV2);
    assert.notStrictEqual(result1, result2, "same length but different content must bust cache");
    const props = ((result2[0] as Record<string, unknown>).function as Record<string, unknown>)
      .parameters as Record<string, unknown>;
    assert.ok(
      (props.properties as Record<string, unknown>).bravo,
      "should have bravo from v2, not alpha from v1",
    );
  });

  it("invalidates cache when description changes but schema stays the same", () => {
    resetToolSchemaCache();
    const params = { type: "object", properties: { x: { type: "string" } } };
    const toolsV1 = [
      { type: "function", function: { name: "t", description: "FIRST", parameters: params } },
    ];
    const toolsV2 = [
      { type: "function", function: { name: "t", description: "SECOND", parameters: params } },
    ];
    const result1 = optimizeToolSchemas(toolsV1);
    const result2 = optimizeToolSchemas(toolsV2);
    assert.notStrictEqual(result1, result2, "description change must bust cache");
    const desc = ((result2[0] as Record<string, unknown>).function as Record<string, unknown>)
      .description;
    assert.strictEqual(desc, "SECOND", "should reflect updated description");
  });

  it("handles tools without function.parameters gracefully", () => {
    resetToolSchemaCache();
    const tools = [{ type: "function", function: { name: "bare", description: "no params" } }];
    const result = optimizeToolSchemas(tools);
    assert.deepStrictEqual(result, tools);
  });

  it("does not throw on non-serializable array entries (undefined, function, symbol)", () => {
    resetToolSchemaCache();
    const tools: unknown[] = [
      undefined,
      () => {},
      Symbol("test"),
      {
        type: "function",
        function: {
          name: "real",
          description: "test",
          parameters: { type: "object", properties: { a: { type: "string" } } },
        },
      },
    ];
    assert.doesNotThrow(() => optimizeToolSchemas(tools));
  });

  it("does not throw on entries that JSON.stringify cannot serialize", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const throwingToJSON = {
      toJSON() {
        throw new Error("boom");
      },
    };
    const cases: Array<{ name: string; value: unknown }> = [
      { name: "top-level BigInt", value: 1n },
      { name: "nested BigInt", value: { value: 1n } },
      { name: "cyclic object", value: cyclic },
      { name: "throwing toJSON", value: throwingToJSON },
    ];
    const failures: string[] = [];

    for (const { name, value } of cases) {
      resetToolSchemaCache();
      try {
        optimizeToolSchemas([value] as unknown[]);
      } catch (err) {
        failures.push(`${name}: ${(err as Error).message}`);
      }
    }

    assert.deepStrictEqual(failures, [], "all unstringifiable entries should be tolerated");
  });

  it("distinguishes different non-serializable types in cache fingerprint", () => {
    resetToolSchemaCache();
    const result1 = optimizeToolSchemas([undefined] as unknown[]);
    const result2 = optimizeToolSchemas([() => {}] as unknown[]);
    const result3 = optimizeToolSchemas([Symbol("x")] as unknown[]);
    assert.notStrictEqual(result1, result2, "undefined vs function must not collide");
    assert.notStrictEqual(result2, result3, "function vs symbol must not collide");
    assert.notStrictEqual(result1, result3, "undefined vs symbol must not collide");
  });

  it("distinguishes different function entries in cache fingerprint", () => {
    resetToolSchemaCache();
    const first = () => "first";
    const second = () => "second";
    const result1 = optimizeToolSchemas([first] as unknown[]);
    const result2 = optimizeToolSchemas([second] as unknown[]);
    assert.notStrictEqual(result1, result2, "different functions must not collide");
    assert.strictEqual(result2[0], second, "should return the second input function");
  });

  it("distinguishes different symbol entries in cache fingerprint", () => {
    resetToolSchemaCache();
    const first = Symbol("first");
    const second = Symbol("second");
    const result1 = optimizeToolSchemas([first] as unknown[]);
    const result2 = optimizeToolSchemas([second] as unknown[]);
    assert.notStrictEqual(result1, result2, "different symbols must not collide");
    assert.strictEqual(result2[0], second, "should return the second input symbol");
  });

  it("distinguishes different symbols with the same description in cache fingerprint", () => {
    resetToolSchemaCache();
    const first = Symbol("same");
    const second = Symbol("same");
    const result1 = optimizeToolSchemas([first] as unknown[]);
    const result2 = optimizeToolSchemas([second] as unknown[]);
    assert.notStrictEqual(
      result1,
      result2,
      "different symbols with same description must not collide",
    );
    assert.strictEqual(result2[0], second, "should return the second input symbol");
  });

  it("distinguishes object entries with non-serializable properties in cache fingerprint", () => {
    resetToolSchemaCache();
    const first = { marker: () => "first" };
    const second = { marker: () => "second" };
    const result1 = optimizeToolSchemas([first] as unknown[]);
    const result2 = optimizeToolSchemas([second] as unknown[]);
    assert.notStrictEqual(
      result1,
      result2,
      "objects with omitted function properties must not collide",
    );
    assert.strictEqual(result2[0], second, "should return the second input object");
  });

  it("distinguishes JSON.stringify collision cases in cache fingerprint", () => {
    const cases: Array<{ name: string; first: unknown; second: unknown }> = [
      {
        name: "object property undefined vs missing",
        first: { marker: undefined },
        second: {},
      },
      {
        name: "array undefined vs null",
        first: [undefined],
        second: [null],
      },
      {
        name: "array function vs null",
        first: [() => "first"],
        second: [null],
      },
      {
        name: "array symbol vs null",
        first: [Symbol("first")],
        second: [null],
      },
      {
        name: "top-level NaN vs null",
        first: Number.NaN,
        second: null,
      },
      {
        name: "top-level Infinity vs null",
        first: Number.POSITIVE_INFINITY,
        second: null,
      },
      {
        name: "regular expressions",
        first: /first/,
        second: /second/,
      },
      {
        name: "errors",
        first: new Error("first"),
        second: new Error("second"),
      },
      {
        name: "promises",
        first: Promise.resolve("first"),
        second: Promise.resolve("second"),
      },
      {
        name: "different empty maps",
        first: new Map([["first", 1]]),
        second: new Map([["second", 2]]),
      },
      {
        name: "different empty sets",
        first: new Set(["first"]),
        second: new Set(["second"]),
      },
      {
        name: "array buffers",
        first: new Uint8Array([1]).buffer,
        second: new Uint8Array([2]).buffer,
      },
      {
        name: "data views",
        first: new DataView(new Uint8Array([1]).buffer),
        second: new DataView(new Uint8Array([2]).buffer),
      },
      {
        name: "weak maps",
        first: new WeakMap([[{}, "first"]]),
        second: new WeakMap([[{}, "second"]]),
      },
      {
        name: "weak sets",
        first: new WeakSet([{}]),
        second: new WeakSet([{}]),
      },
      {
        name: "objects with identical toJSON output",
        first: { toJSON: () => "same" },
        second: { toJSON: () => "same" },
      },
    ];

    const failures: string[] = [];

    for (const { name, first, second } of cases) {
      resetToolSchemaCache();
      const result1 = optimizeToolSchemas([first] as unknown[]);
      const result2 = optimizeToolSchemas([second] as unknown[]);
      if (result1 === result2 || result2[0] !== second) {
        failures.push(name);
      }
    }

    assert.deepStrictEqual(failures, [], "JSON.stringify collision cases must not collide");
  });

  it("returns original array when no tools exceed threshold", () => {
    resetToolSchemaCache();
    const smallTools = [
      {
        type: "function",
        function: {
          name: "small",
          description: "test",
          parameters: { type: "object", properties: { a: { type: "string" } } },
        },
      },
    ];
    const result = optimizeToolSchemas(smallTools);
    assert.strictEqual(result, smallTools, "should return same reference when nothing to optimize");
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
      $defs: {
        existing: { type: "string", description: "pre-existing def" },
      },
      properties: {} as Record<string, unknown>,
    };
    for (let i = 0; i < 200; i++) {
      schema.properties[`p${i}`] = JSON.parse(JSON.stringify(repeated));
    }

    const tools = [
      {
        type: "function",
        function: { name: "test", description: "test", parameters: schema },
      },
    ];

    const result = optimizeToolSchemas(tools);
    const params = ((result[0] as Record<string, unknown>).function as Record<string, unknown>)
      .parameters as Record<string, unknown>;
    const defs = params.$defs as Record<string, unknown>;

    assert.ok(defs.existing, "pre-existing $defs entry should be preserved");
    assert.ok(Object.keys(defs).length > 1, "should have added new $defs entries");
  });

  it("deduplicates correctly when property names contain dots", () => {
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
    const originalSize = Buffer.byteLength(JSON.stringify(schema));

    const tools = [
      {
        type: "function",
        function: { name: "dotted", description: "test", parameters: schema },
      },
    ];
    const result = optimizeToolSchemas(tools);
    const params = ((result[0] as Record<string, unknown>).function as Record<string, unknown>)
      .parameters as Record<string, unknown>;
    const optimizedSize = Buffer.byteLength(JSON.stringify(params));

    assert.ok(optimizedSize < originalSize, `should shrink: ${optimizedSize} < ${originalSize}`);
    const defs = params.$defs as Record<string, unknown> | undefined;
    assert.ok(defs && Object.keys(defs).length > 0, "should have $defs from dedup");

    const serialized = JSON.stringify(params);
    assert.ok(serialized.includes('"$ref"'), "should contain $ref references");
  });

  it("never increases schema size — small fragments with marginal savings", () => {
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

    const originalSize = Buffer.byteLength(JSON.stringify(schema));
    assert.ok(
      originalSize > 14_000 && originalSize < 15_100,
      `precondition: near limit, got ${originalSize}`,
    );

    const tools = [
      {
        type: "function",
        function: { name: "edge", description: "test", parameters: schema },
      },
    ];
    const result = optimizeToolSchemas(tools);
    const optimizedParams = (
      (result[0] as Record<string, unknown>).function as Record<string, unknown>
    ).parameters as Record<string, unknown>;
    const optimizedSize = Buffer.byteLength(JSON.stringify(optimizedParams));
    assert.ok(
      optimizedSize <= originalSize,
      `must not increase: ${optimizedSize} > ${originalSize}`,
    );
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
    const originalSize = Buffer.byteLength(JSON.stringify(schema));

    const tools = [
      {
        type: "function",
        function: { name: "boundary", description: "test", parameters: schema },
      },
    ];
    const result = optimizeToolSchemas(tools);
    const optimizedParams = (
      (result[0] as Record<string, unknown>).function as Record<string, unknown>
    ).parameters as Record<string, unknown>;
    const optimizedSize = Buffer.byteLength(JSON.stringify(optimizedParams));
    assert.ok(
      optimizedSize <= originalSize,
      `must not grow past original (${originalSize}): got ${optimizedSize}`,
    );
  });
});
