import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildMoonshotSearchTool } from "../src/tools/moonshot.ts";

function renderText(component: { render: (width: number) => string[] }): string {
  return component.render(80).join("\n");
}

describe("moonshot_search", () => {
  it("posts the expected URL, headers, and body, then maps search results", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          search_results: [
            {
              title: "Example",
              url: "https://example.com",
              snippet: "Example summary",
              content: "Full page",
              ignored: "ignored",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const tool = buildMoonshotSearchTool({
      deps: { fetch: mockFetch, getAccessToken: () => "oauth-token" },
    });

    const result = await tool.execute(
      "tool-call-1",
      { query: "kimi code", limit: 99, include_content: true },
      undefined,
      undefined,
      undefined as never,
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.kimi.com/coding/v1/search");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(
      (calls[0].init.headers as Record<string, string>).Authorization,
      "Bearer oauth-token",
    );
    assert.equal(
      (calls[0].init.headers as Record<string, string>)["X-Msh-Tool-Call-Id"],
      "tool-call-1",
    );
    assert.deepEqual(JSON.parse(calls[0].init.body as string), {
      text_query: "kimi code",
      limit: 20,
      enable_page_crawling: true,
      timeout_seconds: 30,
    });
    assert.deepEqual(result.details, [
      {
        title: "Example",
        url: "https://example.com",
        snippet: "Example summary",
        content: "Full page",
      },
    ]);
  });

  it("refreshes OAuth credentials once on 401 and retries the search", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (calls.length === 1) return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({ search_results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const refreshes: string[] = [];
    const tool = buildMoonshotSearchTool({
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
      { query: "kimi code" },
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
    assert.deepEqual(result.details, []);
  });

  it("returns an error result when OAuth credentials are missing", async () => {
    const tool = buildMoonshotSearchTool({
      deps: {
        fetch: (() => {
          throw new Error("fetch should not be called");
        }) as typeof fetch,
        getAccessToken: () => null,
      },
    });

    const result = await tool.execute(
      "tool-call-1",
      { query: "kimi code" },
      undefined,
      undefined,
      undefined as never,
    );

    assert.match(
      result.content[0].type === "text" ? result.content[0].text : "",
      /\/login kimi-coding/,
    );
  });

  it("renders collapsed search results by default", () => {
    const tool = buildMoonshotSearchTool();
    const component = tool.renderResult!(
      {
        content: [{ type: "text", text: "full json" }],
        details: [{ title: "Example", url: "https://example.com", snippet: "Summary" }],
      },
      { expanded: false, isPartial: false },
      undefined as never,
      undefined as never,
    );

    assert.equal(renderText(component), "moonshot_search returned 1 result(s); first: Example");
  });

  it("can render search results expanded by default when configured", () => {
    const tool = buildMoonshotSearchTool({ defaultCollapsed: false });
    const component = tool.renderResult!(
      {
        content: [{ type: "text", text: "full json" }],
        details: [{ title: "Example", url: "https://example.com", snippet: "Summary" }],
      },
      { expanded: false, isPartial: false },
      undefined as never,
      undefined as never,
    );

    assert.match(renderText(component), /"url": "https:\/\/example.com"/);
  });
});
