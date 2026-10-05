import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import { buildKimiDatasourceTool } from "../src/tools/datasource.ts";

function renderText(component: { render: (width: number) => string[] }): string {
  return component.render(80).join("\n");
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0].type === "text" ? (result.content[0].text ?? "") : "";
}

describe("kimi_datasource datasource", () => {
  it("calls get_data_source_desc when api_name is omitted", async () => {
    // Pin an explicit base URL so the expectation is independent of the
    // ambient region/default while still asserting the real derivation.
    const originalBase = process.env.KIMI_CODE_BASE_URL;
    process.env.KIMI_CODE_BASE_URL = "https://proxy.example/kimi/v1";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          is_success: true,
          result: {
            assistant: [{ text: "Available APIs: search, detail" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const tool = buildKimiDatasourceTool({
        deps: { fetch: mockFetch, getAccessToken: () => "oauth-token" },
      });

      const result = await tool.execute(
        "tool-call-1",
        { data_source_name: "arxiv" },
        undefined,
        undefined,
        undefined as never,
      );

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://proxy.example/kimi/v1/tools");
      assert.deepEqual(JSON.parse(calls[0].init.body as string), {
        method: "get_data_source_desc",
        params: { name: "arxiv" },
      });
      const text = resultText(result);
      assert.ok(text.startsWith("Available APIs: search, detail"));
      assert.match(text, /\[kimi-datasource\] tool-call-id: tool-call-1/);
    } finally {
      if (originalBase === undefined) delete process.env.KIMI_CODE_BASE_URL;
      else process.env.KIMI_CODE_BASE_URL = originalBase;
    }
  });

  it("calls call_data_source_tool when api_name is provided", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          is_success: true,
          result: {
            user: [{ text: "Paper found: Attention Is All You Need" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const tool = buildKimiDatasourceTool({
      deps: { fetch: mockFetch, getAccessToken: () => "oauth-token" },
    });

    const result = await tool.execute(
      "tool-call-1",
      { data_source_name: "arxiv", api_name: "search", params: { query: "transformer" } },
      undefined,
      undefined,
      undefined as never,
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].init.body as string), {
      method: "call_data_source_tool",
      params: {
        data_source_name: "arxiv",
        api_name: "search",
        params: { query: "transformer" },
      },
    });
    const text = resultText(result);
    assert.ok(text.startsWith("Paper found: Attention Is All You Need"));
    assert.match(text, /\[kimi-datasource\] tool-call-id: tool-call-1/);
  });

  it("returns an error when OAuth credentials are missing", async () => {
    const tool = buildKimiDatasourceTool({
      deps: {
        fetch: (() => {
          throw new Error("should not call");
        }) as typeof fetch,
        getAccessToken: () => null,
      },
    });

    const result = await tool.execute(
      "tool-call-1",
      { data_source_name: "arxiv", api_name: "search" },
      undefined,
      undefined,
      undefined as never,
    );

    assert.match(
      result.content[0].type === "text" ? result.content[0].text : "",
      /\/login kimi-coding/,
    );
  });

  it("returns an error for non-2xx response", async () => {
    const mockFetch: typeof fetch = async () => new Response("server error", { status: 500 });

    const tool = buildKimiDatasourceTool({
      deps: { fetch: mockFetch, getAccessToken: () => "oauth-token" },
    });

    const result = await tool.execute(
      "tool-call-1",
      { data_source_name: "arxiv" },
      undefined,
      undefined,
      undefined as never,
    );

    const text = resultText(result);
    assert.match(text, /500/);
    assert.match(text, /\[kimi-datasource\] tool-call-id: tool-call-1/);
  });

  it("returns an error when is_success is false", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ is_success: false, error: "invalid api" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const tool = buildKimiDatasourceTool({
      deps: { fetch: mockFetch, getAccessToken: () => "oauth-token" },
    });

    const result = await tool.execute(
      "tool-call-1",
      { data_source_name: "arxiv" },
      undefined,
      undefined,
      undefined as never,
    );

    const text = resultText(result);
    assert.match(text, /invalid api/);
    assert.match(text, /\[kimi-datasource\] tool-call-id: tool-call-1/);
  });

  it("refreshes OAuth credentials once on 401 and retries", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (calls.length === 1) return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({ is_success: true, result: { assistant: ["ok"] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const refreshes: string[] = [];

    const tool = buildKimiDatasourceTool({
      deps: {
        fetch: mockFetch,
        getAccessToken: () => "stale-token",
        refreshAccessToken: async (token) => {
          refreshes.push(token);
          return "fresh-token";
        },
      },
    });

    const result = await tool.execute(
      "tool-call-1",
      { data_source_name: "arxiv" },
      undefined,
      undefined,
      undefined as never,
    );

    assert.equal(calls.length, 2);
    assert.deepEqual(refreshes, ["stale-token"]);
    assert.equal(
      (calls[0].init.headers as Record<string, string>).Authorization,
      "Bearer stale-token",
    );
    assert.equal(
      (calls[1].init.headers as Record<string, string>).Authorization,
      "Bearer fresh-token",
    );
    const text = resultText(result);
    assert.ok(text.startsWith("ok"));
    assert.match(text, /\[kimi-datasource\] tool-call-id: tool-call-1/);
  });

  it("regression: prompts for login when token refresh cannot recover from 401", async () => {
    const tool = buildKimiDatasourceTool({
      deps: {
        fetch: async () => new Response("expired", { status: 401 }),
        getAccessToken: () => "revoked-token",
        refreshAccessToken: async () => null,
      },
    });

    const result = await tool.execute(
      "tool-call-1",
      { data_source_name: "arxiv" },
      undefined,
      undefined,
      undefined as never,
    );

    assert.equal(
      resultText(result),
      "kimi_datasource failed: Kimi Code authorization is no longer valid. Sign in again with /login kimi-coding.",
    );
  });

  it("uses KIMI_DATASOURCE_API_URL when provided", async () => {
    const original = process.env.KIMI_DATASOURCE_API_URL;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ is_success: true, result: { assistant: ["ok"] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      process.env.KIMI_DATASOURCE_API_URL = "https://proxy.example.com/tools";
      const tool = buildKimiDatasourceTool({
        deps: { fetch: mockFetch, getAccessToken: () => "oauth-token" },
      });

      await tool.execute(
        "tool-call-1",
        { data_source_name: "arxiv" },
        undefined,
        undefined,
        undefined as never,
      );
    } finally {
      if (original === undefined) delete process.env.KIMI_DATASOURCE_API_URL;
      else process.env.KIMI_DATASOURCE_API_URL = original;
    }

    assert.equal(calls[0].url, "https://proxy.example.com/tools");
  });

  it("renders datasource result collapsed by default", () => {
    const tool = buildKimiDatasourceTool({ defaultCollapsed: true });
    const component = tool.renderResult!(
      { content: [{ type: "text", text: "x".repeat(300) }], details: "x".repeat(300) },
      { expanded: false, isPartial: false },
      undefined as never,
      undefined as never,
    );

    assert.match(renderText(component), /kimi_datasource:/);
    assert.doesNotMatch(renderText(component), /x{250}/);
  });

  it("truncates long world_bank datasource docs preview to the render width", () => {
    const tool = buildKimiDatasourceTool({ defaultCollapsed: true });
    const component = tool.renderResult!(
      {
        content: [{ type: "text", text: `"# world_bank_open_data\\n${"x".repeat(300)}` }],
        details: "",
      },
      { expanded: false, isPartial: false },
      undefined as never,
      undefined as never,
    );

    const lines = component.render(40);
    assert.ok(lines.every((line) => visibleWidth(line) <= 40));
  });

  it("includes request-id in trace when header is present", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({ is_success: true, result: { assistant: [{ text: "data" }] } }),
        { status: 200, headers: { "Content-Type": "application/json", "x-request-id": "req-abc" } },
      );

    const tool = buildKimiDatasourceTool({
      deps: { fetch: mockFetch, getAccessToken: () => "oauth-token" },
    });

    const result = await tool.execute(
      "tc-42",
      { data_source_name: "arxiv" },
      undefined,
      undefined,
      undefined as never,
    );

    const text = resultText(result);
    assert.match(text, /request-id: req-abc/);
    assert.match(text, /tool-call-id: tc-42/);
  });

  it("notes returned files that cannot be written", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          is_success: true,
          result: { assistant: [{ text: "data" }] },
          files: [
            { name: "/tmp/output.csv", content: "a,b\n1,2\n" },
            { name: "/tmp/output_extra.csv", content: "x" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const tool = buildKimiDatasourceTool({
      deps: { fetch: mockFetch, getAccessToken: () => "oauth-token" },
    });

    const result = await tool.execute(
      "tool-call-1",
      { data_source_name: "world_bank_open_data", api_name: "query", params: { country: "CN" } },
      undefined,
      undefined,
      undefined as never,
    );

    const text = resultText(result);
    assert.match(text, /2 file\(s\)/);
    assert.match(text, /\/tmp\/output\.csv/);
  });

  it("renders datasource result expanded when configured", () => {
    const tool = buildKimiDatasourceTool({ defaultCollapsed: false });
    const component = tool.renderResult!(
      {
        content: [{ type: "text", text: "full datasource output" }],
        details: "full datasource output",
      },
      { expanded: false, isPartial: false },
      undefined as never,
      undefined as never,
    );

    assert.equal(renderText(component), "full datasource output");
  });
});
