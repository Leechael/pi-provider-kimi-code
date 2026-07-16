import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import { PROVIDER_ID, getBaseUrl } from "../constants.ts";
import { getKimiProviderHeaders } from "../device.ts";
import {
  KIMI_LOGIN_REQUIRED_MESSAGE,
  readStoredOAuthCredential,
  refreshKimiAuthToken,
} from "../oauth.ts";

export const KIMI_TOOL_TIMEOUT_MS = 180_000;

export interface KimiToolDeps {
  fetch: typeof fetch;
  getAccessToken: () => string | null;
  refreshAccessToken: (currentToken: string) => Promise<string | null>;
}

export interface BuildKimiToolOptions {
  deps?: Partial<KimiToolDeps>;
  defaultCollapsed?: boolean;
}

function defaultGetAccessToken(): string | null {
  return readStoredOAuthCredential(PROVIDER_ID)?.access ?? null;
}

export function buildKimiToolDeps(options: BuildKimiToolOptions = {}): KimiToolDeps {
  return {
    fetch: options.deps?.fetch ?? fetch,
    getAccessToken: options.deps?.getAccessToken ?? defaultGetAccessToken,
    refreshAccessToken: options.deps?.refreshAccessToken ?? refreshKimiAuthToken,
  };
}

export function buildTimeoutSignal(signal: AbortSignal | undefined): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KIMI_TOOL_TIMEOUT_MS);
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

export function getKimiBaseV1(): string {
  const base = getBaseUrl().replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export function getKimiDatasourceUrl(): string {
  const explicit = process.env.KIMI_DATASOURCE_API_URL?.trim();
  if (explicit) return explicit;
  return `${getKimiBaseV1()}/tools`;
}

export function buildHeaders(accessToken: string, toolCallId: string): Record<string, string> {
  return {
    ...getKimiProviderHeaders(),
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "X-Msh-Tool-Call-Id": toolCallId,
  };
}

export function errorResult<T>(message: string): AgentToolResult<T> {
  return {
    content: [{ type: "text", text: message }],
    details: undefined as T,
  };
}

export async function readErrorBody(response: Response): Promise<string> {
  return response.text().catch(() => "");
}

export async function fetchWithAuthRetry(
  deps: KimiToolDeps,
  accessToken: string,
  request: (token: string) => Promise<Response>,
): Promise<Response> {
  const response = await request(accessToken);
  if (response.status !== 401) return response;

  const refreshed = await deps.refreshAccessToken(accessToken);
  if (!refreshed || refreshed === accessToken) {
    throw new Error(KIMI_LOGIN_REQUIRED_MESSAGE);
  }
  return request(refreshed);
}

export function textComponent(text: string) {
  return {
    render: (width: number) => text.split("\n").map((line) => truncateToWidth(line, width, "…")),
    invalidate: () => {},
  };
}

export function firstText(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

export function shouldCollapse(defaultCollapsed: boolean, expanded: boolean | undefined): boolean {
  return defaultCollapsed && expanded !== true;
}
