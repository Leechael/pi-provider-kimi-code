import { AuthStorage, defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";

import { PROVIDER_ID } from "../constants.ts";
import { getCommonHeaders } from "../device.ts";
import { refreshKimiAuthToken } from "../oauth.ts";

const MOONSHOT_BASE_V1 = "https://api.kimi.com/coding/v1";
const MOONSHOT_TIMEOUT_MS = 180_000;

export const moonshotSearchSchema = Type.Object({
  query: Type.String({ description: "The query text to search for." }),
  limit: Type.Optional(
    Type.Number({
      description: "The number of results to return.",
      default: 5,
      minimum: 1,
      maximum: 20,
    }),
  ),
  include_content: Type.Optional(
    Type.Boolean({
      description: "Whether to include fetched page content in the search results.",
      default: false,
    }),
  ),
});

export const moonshotFetchSchema = Type.Object({
  url: Type.String({ description: "The URL to fetch content from." }),
});

export type MoonshotSearchParams = Static<typeof moonshotSearchSchema>;
export type MoonshotFetchParams = Static<typeof moonshotFetchSchema>;

export interface MoonshotSearchResult {
  url: string;
  title: string;
  snippet: string;
  content?: string;
}

export interface MoonshotFetchResult {
  url: string;
  content: string;
}

interface MoonshotToolDeps {
  fetch: typeof fetch;
  getAccessToken: () => string | null;
  refreshAccessToken: (currentToken: string) => Promise<string | null>;
}

export interface BuildMoonshotToolOptions {
  deps?: Partial<MoonshotToolDeps>;
  defaultCollapsed?: boolean;
}

interface MoonshotSearchResponse {
  search_results?: unknown;
}

function defaultGetAccessToken(): string | null {
  const credential = AuthStorage.create().get(PROVIDER_ID);
  if (!credential || credential.type !== "oauth") return null;
  return credential.access;
}

function buildDeps(options: BuildMoonshotToolOptions = {}): MoonshotToolDeps {
  return {
    fetch: options.deps?.fetch ?? fetch,
    getAccessToken: options.deps?.getAccessToken ?? defaultGetAccessToken,
    refreshAccessToken: options.deps?.refreshAccessToken ?? refreshKimiAuthToken,
  };
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(20, Math.trunc(value)));
}

function errorResult<T>(message: string): AgentToolResult<T> {
  return {
    content: [{ type: "text", text: message }],
    details: undefined as T,
  };
}

function buildTimeoutSignal(signal: AbortSignal | undefined): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MOONSHOT_TIMEOUT_MS);
  const abort = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    },
  };
}

function buildHeaders(accessToken: string, toolCallId: string): Record<string, string> {
  return {
    ...getCommonHeaders(),
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "X-Msh-Tool-Call-Id": toolCallId,
  };
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function mapSearchResults(value: unknown, includeContent: boolean): MoonshotSearchResult[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => {
      const result: MoonshotSearchResult = {
        url: stringField(item, "url"),
        title: stringField(item, "title"),
        snippet: stringField(item, "snippet"),
      };
      if (includeContent) {
        result.content = stringField(item, "content");
      }
      return result;
    });
}

function searchResultsText(results: MoonshotSearchResult[]): string {
  if (results.length === 0) return "[]";
  return JSON.stringify(results, null, 2);
}

function textComponent(text: string) {
  return {
    render: () => text.split("\n"),
    invalidate: () => {},
  };
}

function firstText(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

function shouldCollapse(defaultCollapsed: boolean, expanded: boolean | undefined): boolean {
  return defaultCollapsed && expanded !== true;
}

function renderSearchResult(
  result: AgentToolResult<MoonshotSearchResult[]>,
  expanded: boolean | undefined,
  defaultCollapsed: boolean,
) {
  if (!Array.isArray(result.details)) {
    return textComponent(firstText(result));
  }
  if (!shouldCollapse(defaultCollapsed, expanded)) {
    return textComponent(searchResultsText(result.details));
  }

  const count = result.details.length;
  const first = result.details[0];
  const suffix = first ? `; first: ${first.title || first.url}` : "";
  return textComponent(`moonshot_search returned ${count} result(s)${suffix}`);
}

function renderFetchResult(
  result: AgentToolResult<MoonshotFetchResult>,
  expanded: boolean | undefined,
  defaultCollapsed: boolean,
) {
  if (!result.details) {
    return textComponent(firstText(result));
  }
  if (!shouldCollapse(defaultCollapsed, expanded)) {
    return textComponent(result.details.content);
  }

  return textComponent(
    `moonshot_fetch fetched ${result.details.url} (${result.details.content.length} chars)`,
  );
}

async function readErrorBody(response: Response): Promise<string> {
  return response.text().catch(() => "");
}

async function fetchWithAuthRetry(
  deps: MoonshotToolDeps,
  accessToken: string,
  request: (token: string) => Promise<Response>,
): Promise<Response> {
  const response = await request(accessToken);
  if (response.status !== 401) return response;

  const refreshed = await deps.refreshAccessToken(accessToken);
  if (!refreshed || refreshed === accessToken) return response;
  return request(refreshed);
}

export function buildMoonshotSearchTool(options: BuildMoonshotToolOptions = {}) {
  const deps = buildDeps(options);
  const defaultCollapsed = options.defaultCollapsed ?? true;

  return defineTool({
    name: "moonshot_search",
    label: "Moonshot Search",
    description: "Search the web through Kimi Coding's server-side Moonshot search service.",
    promptSnippet: "Search the web with Kimi Coding's Moonshot search service",
    parameters: moonshotSearchSchema,

    async execute(toolCallId, params, signal) {
      const accessToken = deps.getAccessToken();
      if (!accessToken) {
        return errorResult<MoonshotSearchResult[]>(
          "Missing Kimi Code OAuth credentials. Run /login kimi-coding first.",
        );
      }

      const limit = clampLimit(params.limit);
      const includeContent = params.include_content === true;
      const timeout = buildTimeoutSignal(signal);
      try {
        const response = await fetchWithAuthRetry(deps, accessToken, (token) =>
          deps.fetch(`${MOONSHOT_BASE_V1}/search`, {
            method: "POST",
            headers: buildHeaders(token, toolCallId),
            body: JSON.stringify({
              text_query: params.query,
              limit,
              enable_page_crawling: includeContent,
              timeout_seconds: 30,
            }),
            signal: timeout.signal,
          }),
        );

        if (!response.ok) {
          const body = await readErrorBody(response);
          return errorResult<MoonshotSearchResult[]>(
            `Moonshot search failed: ${response.status}${body ? ` ${body}` : ""}`,
          );
        }

        const data = (await response.json()) as MoonshotSearchResponse;
        const results = mapSearchResults(data.search_results, includeContent);
        return {
          content: [{ type: "text", text: searchResultsText(results) }],
          details: results,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult<MoonshotSearchResult[]>(`Moonshot search failed: ${message}`);
      } finally {
        timeout.cleanup();
      }
    },

    renderResult(result, renderOptions) {
      return renderSearchResult(result, renderOptions.expanded, defaultCollapsed);
    },
  });
}

export function buildMoonshotFetchTool(options: BuildMoonshotToolOptions = {}) {
  const deps = buildDeps(options);
  const defaultCollapsed = options.defaultCollapsed ?? true;

  return defineTool({
    name: "moonshot_fetch",
    label: "Moonshot Fetch",
    description: "Fetch a web page through Kimi Coding's server-side Moonshot fetch service.",
    promptSnippet: "Fetch a web page with Kimi Coding's Moonshot fetch service",
    parameters: moonshotFetchSchema,

    async execute(toolCallId, params, signal) {
      const accessToken = deps.getAccessToken();
      if (!accessToken) {
        return errorResult<MoonshotFetchResult>(
          "Missing Kimi Code OAuth credentials. Run /login kimi-coding first.",
        );
      }

      const timeout = buildTimeoutSignal(signal);
      try {
        const response = await fetchWithAuthRetry(deps, accessToken, (token) =>
          deps.fetch(`${MOONSHOT_BASE_V1}/fetch`, {
            method: "POST",
            headers: {
              ...buildHeaders(token, toolCallId),
              Accept: "text/markdown",
            },
            body: JSON.stringify({ url: params.url }),
            signal: timeout.signal,
          }),
        );

        if (!response.ok) {
          const body = await readErrorBody(response);
          return errorResult<MoonshotFetchResult>(
            `Moonshot fetch failed: ${response.status}${body ? ` ${body}` : ""}`,
          );
        }

        const content = await response.text();
        return {
          content: [{ type: "text", text: content }],
          details: { url: params.url, content },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult<MoonshotFetchResult>(`Moonshot fetch failed: ${message}`);
      } finally {
        timeout.cleanup();
      }
    },

    renderResult(result, renderOptions) {
      return renderFetchResult(result, renderOptions.expanded, defaultCollapsed);
    },
  });
}
