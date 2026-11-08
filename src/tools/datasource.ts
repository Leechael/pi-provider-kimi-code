import { defineTool } from "@earendil-works/pi-coding-agent";
import { map, obj, opt, str, unknown, type Static } from "@earendil-works/pi-schema";

import {
  ensureDatasourceCatalog,
  peekDatasourceCatalog,
  readCatalogCacheSync,
  refreshDatasourceCatalogInBackground,
} from "./datasource-catalog.ts";

import {
  type BuildKimiToolOptions,
  buildHeaders,
  getKimiDatasourceUrl,
  buildKimiToolDeps,
  buildTimeoutSignal,
  errorResult,
  fetchWithAuthRetry,
  firstText,
  readErrorBody,
  shouldCollapse,
  textComponent,
} from "./common.ts";

// Source names are validated at call time against the synced catalog
// (datasource-catalog.ts) instead of a static enum, so sources added
// server-side never get rejected by a stale client schema.
export const kimiDatasourceSchema = obj({
  data_source_name: str({
    description:
      "Data source name. The set of available sources is synced from the official kimi-datasource plugin and cached for 24h; if a call fails with an unknown-source error, pick one of the names listed in that error.",
  }),
  api_name: opt(
    str({
      description: "API name from the datasource docs. Omit to get docs first.",
    }),
  ),
  params: opt(
    map(unknown(), {
      description: "Parameters matching the selected datasource API docs.",
    }),
  ),
});

export type KimiDatasourceParams = Static<typeof kimiDatasourceSchema>;

interface DatasourceToolResponse {
  is_success?: boolean;
  error?: unknown;
  result?: {
    assistant?: unknown;
    user?: unknown;
  };
}

function extractTextFromResult(result: unknown): string {
  if (!Array.isArray(result)) return "";
  const texts: string[] = [];
  for (const item of result) {
    if (typeof item === "string") {
      texts.push(item);
    } else if (typeof item === "object" && item !== null) {
      const record = item as Record<string, unknown>;
      if (typeof record.text === "string") {
        texts.push(record.text);
      }
    }
  }
  return texts.join("\n");
}

function extractResponseText(data: DatasourceToolResponse): string {
  if (data.result?.assistant) {
    const text = extractTextFromResult(data.result.assistant);
    if (text) return text;
  }
  if (data.result?.user) {
    const text = extractTextFromResult(data.result.user);
    if (text) return text;
  }
  return JSON.stringify(data, null, 2);
}

function extractResponseFiles(data: DatasourceToolResponse): string[] {
  const raw = data as Record<string, unknown>;
  if (!Array.isArray(raw.files)) return [];
  const names: string[] = [];
  for (const file of raw.files) {
    if (
      typeof file === "object" &&
      file !== null &&
      typeof (file as Record<string, unknown>).name === "string"
    ) {
      names.push((file as Record<string, unknown>).name as string);
    }
  }
  return names;
}

const REQUEST_ID_HEADERS = [
  "x-request-id",
  "x-trace-id",
  "x-msh-request-id",
  "x-msh-trace-id",
  "request-id",
];

function extractRequestId(headers: Headers): string | undefined {
  for (const key of REQUEST_ID_HEADERS) {
    const value = headers.get(key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function buildTraceLine(toolCallId: string, requestId: string | undefined): string {
  const parts: string[] = [];
  if (requestId) parts.push(`request-id: ${requestId}`);
  parts.push(`tool-call-id: ${toolCallId}`);
  return `\n\n[kimi-datasource] ${parts.join(" · ")}`;
}

function buildDescription(): string {
  const base =
    "Call Kimi datasource APIs: finance/quotes, macro & government data, papers, Chinese law, chemistry/bio/materials, and more. First omit api_name to get docs, then call api_name with documented params.";
  // Registration-time snapshot: embed the cached catalog so the model sees the
  // current source list without any network I/O. Refreshed lazily on use.
  const cached = readCatalogCacheSync();
  if (!cached) return base;
  return `${base} Known sources (kimi-datasource v${cached.version}): ${cached.capabilities}`;
}

export function buildKimiDatasourceTool(options: BuildKimiToolOptions = {}) {
  const deps = buildKimiToolDeps(options);
  const defaultCollapsed = options.defaultCollapsed ?? true;

  return defineTool({
    name: "kimi_datasource",
    label: "Kimi Datasource",
    description: buildDescription(),
    promptSnippet: "Query Kimi datasource APIs; get docs first, then call documented api_name",
    parameters: kimiDatasourceSchema,

    async execute(toolCallId, params: KimiDatasourceParams, signal) {
      const accessToken = deps.getAccessToken();
      if (!accessToken) {
        return errorResult<string>(
          "Missing Kimi Code OAuth credentials. Run /login kimi-coding first.",
        );
      }

      const timeout = buildTimeoutSignal(signal);
      try {
        const sourceName = params.data_source_name.trim();

        // Lazy catalog sync: validate against the best-known catalog without
        // blocking, and refresh in the background when it is stale. Unknown
        // names get one forced refresh before we reject them, so newly added
        // server-side sources work even when the local cache is old.
        let catalog = peekDatasourceCatalog();
        if (!catalog.sources.includes(sourceName)) {
          catalog = await ensureDatasourceCatalog({
            fetchImpl: deps.fetch,
            forceRefresh: true,
          });
          if (!catalog.sources.includes(sourceName)) {
            return errorResult<string>(
              `Unknown data source "${sourceName}". Available sources (kimi-datasource v${catalog.version}): ${catalog.sources.join(", ")}`,
            );
          }
        } else {
          refreshDatasourceCatalogInBackground(deps.fetch);
        }

        const apiName = params.api_name?.trim();
        const body = apiName
          ? {
              method: "call_data_source_tool",
              params: {
                data_source_name: sourceName,
                api_name: apiName,
                params: params.params ?? {},
              },
            }
          : {
              method: "get_data_source_desc",
              params: { name: sourceName },
            };

        const response = await fetchWithAuthRetry(deps, accessToken, (token) =>
          deps.fetch(getKimiDatasourceUrl(), {
            method: "POST",
            headers: buildHeaders(token, toolCallId),
            body: JSON.stringify(body),
            signal: timeout.signal,
          }),
        );

        const requestId = extractRequestId(response.headers);
        const trace = buildTraceLine(toolCallId, requestId);

        if (!response.ok) {
          const bodyText = await readErrorBody(response);
          return errorResult<string>(
            `kimi_datasource failed: ${response.status}${bodyText ? ` ${bodyText}` : ""}${trace}`,
          );
        }

        const data = (await response.json()) as DatasourceToolResponse;
        if (data.is_success === false) {
          const errorText =
            typeof data.error === "string"
              ? data.error
              : JSON.stringify(data.error ?? data, null, 2);
          return errorResult<string>(`kimi_datasource error: ${errorText}${trace}`);
        }

        let text = extractResponseText(data);
        const files = extractResponseFiles(data);
        if (files.length > 0) {
          text += `\n\nNote: the backend returned ${files.length} file(s) that cannot be written in this context: ${files.join(", ")}`;
        }
        text += trace;

        return {
          content: [{ type: "text", text }],
          details: text,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult<string>(`kimi_datasource failed: ${message}`);
      } finally {
        timeout.cleanup();
      }
    },

    renderResult(result, renderOptions) {
      const text = firstText(result);
      if (!shouldCollapse(defaultCollapsed, renderOptions.expanded)) {
        return textComponent(text);
      }
      const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      return textComponent(`kimi_datasource: ${text.length} chars\n${preview}`);
    },
  });
}
