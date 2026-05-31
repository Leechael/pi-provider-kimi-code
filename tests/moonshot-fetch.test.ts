import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildMoonshotFetchTool } from "../src/tools/moonshot.ts";

function renderText(component: { render: (width: number) => string[] }): string {
  return component.render(80).join("\n");
}

describe("moonshot_fetch", () => {
  it("posts the expected URL, headers, and body, then maps content", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response("# Example\n\nFetched page", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      });
    };
    const tool = buildMoonshotFetchTool({
      deps: { fetch: mockFetch, getAccessToken: () => "oauth-token" },
    });

    const result = await tool.execute(
      "tool-call-2",
      { url: "https://example.com/page" },
      undefined,
      undefined,
      undefined as never,
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.kimi.com/coding/v1/fetch");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(
      (calls[0].init.headers as Record<string, string>).Authorization,
      "Bearer oauth-token",
    );
    assert.equal((calls[0].init.headers as Record<string, string>).Accept, "text/markdown");
    assert.equal(
      (calls[0].init.headers as Record<string, string>)["X-Msh-Tool-Call-Id"],
      "tool-call-2",
    );
    assert.deepEqual(JSON.parse(calls[0].init.body as string), {
      url: "https://example.com/page",
    });
    assert.deepEqual(result.details, {
      url: "https://example.com/page",
      content: "# Example\n\nFetched page",
    });
  });

  it("refreshes OAuth credentials once on 401 and retries the fetch", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (calls.length === 1) return new Response("unauthorized", { status: 401 });
      return new Response("Fetched content", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      });
    };
    const refreshes: string[] = [];
    const tool = buildMoonshotFetchTool({
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
      "tool-call-2",
      { url: "https://example.com/page" },
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
    assert.deepEqual(result.details, {
      url: "https://example.com/page",
      content: "Fetched content",
    });
  });

  it("returns an error result when OAuth credentials are missing", async () => {
    const tool = buildMoonshotFetchTool({
      deps: {
        fetch: (() => {
          throw new Error("fetch should not be called");
        }) as typeof fetch,
        getAccessToken: () => null,
      },
    });

    const result = await tool.execute(
      "tool-call-2",
      { url: "https://example.com/page" },
      undefined,
      undefined,
      undefined as never,
    );

    assert.match(
      result.content[0].type === "text" ? result.content[0].text : "",
      /\/login kimi-coding/,
    );
  });

  it("returns an error result without retrying local fetch on non-2xx responses", async () => {
    let callCount = 0;
    const tool = buildMoonshotFetchTool({
      deps: {
        fetch: (async () => {
          callCount += 1;
          return new Response("forbidden", { status: 403 });
        }) as typeof fetch,
        getAccessToken: () => "oauth-token",
      },
    });

    const result = await tool.execute(
      "tool-call-2",
      { url: "https://example.com/page" },
      undefined,
      undefined,
      undefined as never,
    );

    assert.equal(callCount, 1);
    assert.match(result.content[0].type === "text" ? result.content[0].text : "", /403 forbidden/);
  });

  it("renders collapsed fetch content by default", () => {
    const tool = buildMoonshotFetchTool();
    const component = tool.renderResult!(
      {
        content: [{ type: "text", text: "Fetched content" }],
        details: { url: "https://example.com/page", content: "Fetched content" },
      },
      { expanded: false, isPartial: false },
      undefined as never,
      undefined as never,
    );

    assert.equal(
      renderText(component),
      "moonshot_fetch fetched https://example.com/page (15 chars)",
    );
  });

  it("can render fetch content expanded by default when configured", () => {
    const tool = buildMoonshotFetchTool({ defaultCollapsed: false });
    const component = tool.renderResult!(
      {
        content: [{ type: "text", text: "Fetched content" }],
        details: { url: "https://example.com/page", content: "Fetched content" },
      },
      { expanded: false, isPartial: false },
      undefined as never,
      undefined as never,
    );

    assert.equal(renderText(component), "Fetched content");
  });
});
