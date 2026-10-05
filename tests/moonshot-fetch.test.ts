import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import { buildMoonshotFetchTool } from "../src/tools/moonshot.ts";
import { getKimiBaseV1 } from "../src/tools/common.ts";

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
    assert.equal(calls[0].url, `${getKimiBaseV1()}/fetch`);
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

  it("uses KIMI_CODE_BASE_URL when provided", async () => {
    const original = process.env.KIMI_CODE_BASE_URL;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response("Fetched content", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      });
    };

    try {
      process.env.KIMI_CODE_BASE_URL = "https://proxy.example.com/kimi/v1";
      const tool = buildMoonshotFetchTool({
        deps: { fetch: mockFetch, getAccessToken: () => "oauth-token" },
      });

      await tool.execute(
        "tool-call-2",
        { url: "https://example.com/page" },
        undefined,
        undefined,
        undefined as never,
      );
    } finally {
      if (original === undefined) delete process.env.KIMI_CODE_BASE_URL;
      else process.env.KIMI_CODE_BASE_URL = original;
    }

    assert.equal(calls[0].url, "https://proxy.example.com/kimi/v1/fetch");
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

  it("regression: prompts for login when token refresh cannot recover from 401", async () => {
    const tool = buildMoonshotFetchTool({
      deps: {
        fetch: async () => new Response("expired", { status: 401 }),
        getAccessToken: () => "revoked-token",
        refreshAccessToken: async () => null,
      },
    });

    const result = await tool.execute(
      "tool-call-2",
      { url: "https://example.com/page" },
      undefined,
      undefined,
      undefined as never,
    );

    assert.equal(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      "Moonshot fetch failed: Kimi Code authorization is no longer valid. Sign in again with /login kimi-coding.",
    );
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

  it("truncates long 403 error output to the render width", () => {
    const tool = buildMoonshotFetchTool();
    const component = tool.renderResult!(
      {
        content: [
          {
            type: "text",
            text: 'Moonshot fetch failed: 403 {"error":{"type":"security_risk","message":"We consider the current URL poses a security risk and are unable to provide fetch service at this time."}}',
          },
        ],
        details: undefined,
      },
      { expanded: false, isPartial: false },
      undefined as never,
      undefined as never,
    );

    const lines = component.render(80);
    assert.ok(lines.every((line) => visibleWidth(line) <= 80));
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
