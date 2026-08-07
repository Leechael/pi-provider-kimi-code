import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";

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

const DATASOURCE_DEFINITIONS = [
  {
    name: "stock_finance_data",
    description: "A/HK/US stocks, prices, financial reports, indicators, shareholders.",
  },
  {
    name: "yahoo_finance",
    description: "Global finance: quotes, analyst ratings, options, indexes, historical prices.",
  },
  {
    name: "world_bank_open_data",
    description: "World Bank macro data: GDP, inflation, population, country comparisons.",
  },
  {
    name: "tianyancha",
    description: "Chinese enterprise registry: shareholders, legal representative, risks, patents.",
  },
  { name: "arxiv", description: "arXiv preprints: paper search, abstracts, arXiv IDs." },
  {
    name: "scholar",
    description: "Google Scholar: academic papers, authors, citations, high-citation surveys.",
  },
  {
    name: "yuandian_law",
    description: "Chinese laws, regulations, judicial cases; labor contracts and legal clauses.",
  },
  {
    name: "wind",
    description:
      "A-share intraday minute series, funds, bonds; map PE/PB/ROE-style field names via wind_search_fields first.",
  },
  {
    name: "imf",
    description: "IMF macro data: FX rates, CPI, GDP forecasts, balance of payments.",
  },
  {
    name: "gildata",
    description: "Natural-language stock/fund screening.",
  },
  {
    name: "sec_edgar",
    description: "US SEC filings: 10-K/10-Q, S-1, Form 4, 13F, 8-K.",
  },
  {
    name: "sp_data",
    description: "S&P fundamentals: consensus estimates, valuation ratios, transcripts.",
  },
] as const;

const DATASOURCE_NAMES = DATASOURCE_DEFINITIONS.map((source) => source.name);

export const kimiDatasourceSchema = Type.Object({
  data_source_name: Type.Union(
    DATASOURCE_NAMES.map((name) => Type.Literal(name)),
    {
      description:
        "Source: stock_finance_data stocks/reports; yahoo_finance quotes/options; world_bank_open_data GDP/population; imf FX/CPI/GDP forecasts; tianyancha Chinese company registry/legal rep; arxiv preprints; scholar citations; yuandian_law Chinese laws/cases/contracts; wind A-share intraday minute series/funds/bonds (map field names via wind_search_fields first); gildata natural-language stock/fund screening; sec_edgar US filings (10-K/10-Q, S-1, Form 4, 13F, 8-K); sp_data S&P fundamentals (estimates, valuation, transcripts).",
    },
  ),
  api_name: Type.Optional(
    Type.String({
      description: "API name from the datasource docs. Omit to get docs first.",
    }),
  ),
  params: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
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

export function buildKimiDatasourceTool(options: BuildKimiToolOptions = {}) {
  const deps = buildKimiToolDeps(options);
  const defaultCollapsed = options.defaultCollapsed ?? true;

  return defineTool({
    name: "kimi_datasource",
    label: "Kimi Datasource",
    description:
      "Call Kimi datasource APIs. Covers stocks/finance, macro data, Chinese company registry, papers, and Chinese law/cases/contracts. First omit api_name to get docs, then call api_name with documented params.",
    promptSnippet: "Query Kimi datasource APIs; get docs first, then call documented api_name",
    parameters: kimiDatasourceSchema,

    async execute(toolCallId, params, signal) {
      const accessToken = deps.getAccessToken();
      if (!accessToken) {
        return errorResult<string>(
          "Missing Kimi Code OAuth credentials. Run /login kimi-coding first.",
        );
      }

      const timeout = buildTimeoutSignal(signal);
      try {
        const apiName = params.api_name?.trim();
        const body = apiName
          ? {
              method: "call_data_source_tool",
              params: {
                data_source_name: params.data_source_name,
                api_name: apiName,
                params: params.params ?? {},
              },
            }
          : {
              method: "get_data_source_desc",
              params: { name: params.data_source_name },
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
