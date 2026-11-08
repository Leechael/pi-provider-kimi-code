import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
  type BuildKimiToolOptions,
  buildHeaders,
  getKimiBaseV1,
  buildKimiToolDeps,
  buildTimeoutSignal,
  errorResult,
  fetchWithAuthRetry,
  firstText,
  readErrorBody,
  shouldCollapse,
  textComponent,
} from "./common.ts";

export const moonshotSearchSchema = Type.Object({
  query: Type.String({ description: "The query text to search for." }),
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
  date?: string;
  siteName?: string;
}

export interface MoonshotFetchResult {
  url: string;
  content: string;
}

interface MoonshotSearchResponse {
  search_results?: unknown;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function mapSearchResults(value: unknown): MoonshotSearchResult[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => {
      const result: MoonshotSearchResult = {
        url: stringField(item, "url"),
        title: stringField(item, "title"),
        snippet: stringField(item, "snippet"),
      };
      const date = stringField(item, "date");
      if (date) result.date = date;
      const siteName = stringField(item, "site_name");
      if (siteName) result.siteName = siteName;
      return result;
    });
}

function searchResultsText(results: MoonshotSearchResult[]): string {
  if (results.length === 0) return "[]";
  return JSON.stringify(results, null, 2);
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

export function buildMoonshotSearchTool(options: BuildKimiToolOptions = {}) {
  const deps = buildKimiToolDeps(options);
  const defaultCollapsed = options.defaultCollapsed ?? true;

  return defineTool({
    name: "moonshot_search",
    label: "Moonshot Search",
    description:
      "Search the web through Kimi Coding. Results are summaries; use moonshot_fetch to read relevant pages.",
    promptSnippet:
      "Search the web with Kimi Coding, then fetch the few relevant result URLs before answering",
    parameters: moonshotSearchSchema,

    async execute(toolCallId, params, signal) {
      const accessToken = deps.getAccessToken();
      if (!accessToken) {
        return errorResult<MoonshotSearchResult[]>(
          "Missing Kimi Code OAuth credentials. Run /login kimi-coding first.",
        );
      }

      const timeout = buildTimeoutSignal(signal);
      try {
        const response = await fetchWithAuthRetry(deps, accessToken, (token) =>
          deps.fetch(`${getKimiBaseV1()}/search`, {
            method: "POST",
            headers: buildHeaders(token, toolCallId),
            body: JSON.stringify({ text_query: params.query }),
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
        const results = mapSearchResults(data.search_results);
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

export function buildMoonshotFetchTool(options: BuildKimiToolOptions = {}) {
  const deps = buildKimiToolDeps(options);
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
          deps.fetch(`${getKimiBaseV1()}/fetch`, {
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
