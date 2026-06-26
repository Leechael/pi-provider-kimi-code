// OAuth subsystem: device flow, refresh-with-retry, Kimi credential
// reuse, the login / refresh handlers wired into pi's OAuth interface, and
// the stream-level auth refresh used by the streaming handler.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { OAuthCredential } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent";

import { CLIENT_ID, PROVIDER_ID, RETRYABLE_REFRESH_STATUSES, getOAuthHost } from "./constants.ts";
import { getCommonHeaders } from "./device.ts";
import { type KimiOAuthCredentials, discoverKimiModelMetadata } from "./models.ts";

// =============================================================================
// Device flow + token endpoint
// =============================================================================

export interface DeviceAuthorization {
  user_code: string;
  device_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export async function requestDeviceAuthorization(): Promise<DeviceAuthorization> {
  const response = await fetch(`${getOAuthHost()}/api/oauth/device_authorization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...getCommonHeaders(),
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Device authorization failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    user_code?: string;
    device_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };

  const verificationUrl = data.verification_uri_complete || data.verification_uri;
  if (!data.user_code || !data.device_code || !verificationUrl) {
    throw new Error("Invalid device authorization response");
  }

  return {
    user_code: data.user_code,
    device_code: data.device_code,
    verification_uri: data.verification_uri || verificationUrl,
    verification_uri_complete: verificationUrl,
    expires_in: data.expires_in || 1800,
    interval: data.interval || 5,
  };
}

export async function requestDeviceToken(
  auth: DeviceAuthorization,
): Promise<TokenResponse | "slow_down" | null> {
  const response = await fetch(`${getOAuthHost()}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...getCommonHeaders(),
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      device_code: auth.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

  if (response.status === 200) {
    const data = (await response.json()) as TokenResponse;
    if (data.access_token && data.refresh_token) {
      return data;
    }
    throw new Error("Token response missing required fields");
  }

  if (response.status === 400) {
    const data = (await response.json()) as { error?: string; error_description?: string };
    if (data.error === "authorization_pending") {
      return null;
    }
    if (data.error === "slow_down") {
      return "slow_down";
    }
    if (data.error === "expired_token") {
      throw new Error("expired_token");
    }
    throw new Error(`Token request failed: ${data.error_description || data.error || "unknown"}`);
  }

  const text = await response.text().catch(() => "");
  throw new Error(`Token request failed: ${response.status} ${text}`);
}

interface RefreshAccessTokenOptions {
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function refreshAccessToken(
  refreshToken: string,
  options: RefreshAccessTokenOptions = {},
): Promise<TokenResponse> {
  const maxRetries = options.maxRetries ?? 3;
  const wait = options.sleep ?? sleep;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(`${getOAuthHost()}/api/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...getCommonHeaders(),
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Token refresh unauthorized: ${text}`);
        }
        if (RETRYABLE_REFRESH_STATUSES.has(response.status)) {
          throw new Error(`Token refresh retryable: ${response.status} ${text}`);
        }
        throw new Error(`Token refresh failed: ${response.status} ${text}`);
      }

      const data = (await response.json()) as TokenResponse;
      if (!data.access_token || !data.refresh_token) {
        throw new Error("Token refresh response missing required fields");
      }

      return data;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Token refresh unauthorized:")) throw error;
      if (message.startsWith("Token refresh failed:")) throw error;
      if (attempt < maxRetries - 1) {
        await wait(2 ** attempt * 1000);
        continue;
      }
    }
  }

  throw new Error("Token refresh failed after retries.", { cause: lastError });
}

// =============================================================================
// Reuse existing Kimi credentials
//
// Users who already ran the upstream Kimi Code CLI and signed in have a valid
// OAuth token under `$KIMI_CODE_HOME/credentials/kimi-code.json` (defaults to
// `~/.kimi-code/...`). We also keep read-only support for legacy kimi-cli
// credentials under `$KIMI_SHARE_DIR/credentials/kimi-code.json` (defaults to
// `~/.kimi/...`). Loading either lets users skip the device-flow dance.
// =============================================================================

interface KimiCliCredentialsFile {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // Unix seconds (upstream convention)
  scope?: string;
  token_type?: string;
  expires_in?: number;
}

function getKimiCodeCredentialPath(): string {
  const kimiCodeHome = process.env.KIMI_CODE_HOME || join(os.homedir(), ".kimi-code");
  return join(kimiCodeHome, "credentials", "kimi-code.json");
}

function getKimiCredentialPaths(): string[] {
  const shareDir = process.env.KIMI_SHARE_DIR || join(os.homedir(), ".kimi");
  return [getKimiCodeCredentialPath(), join(shareDir, "credentials", "kimi-code.json")];
}

function readKimiCliCredentials(): KimiCliCredentialsFile | null {
  for (const path of getKimiCredentialPaths()) {
    try {
      if (!existsSync(path)) continue;
      const data = JSON.parse(readFileSync(path, "utf-8")) as KimiCliCredentialsFile;
      if (!data.access_token || !data.refresh_token) continue;
      return data;
    } catch {
      continue;
    }
  }
  return null;
}

function kimiCodeCredentialExists(): boolean {
  return existsSync(getKimiCodeCredentialPath());
}

function writeKimiCodeCredentials(access: string, refresh: string, expiresMs: number): void {
  const path = getKimiCodeCredentialPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const data: KimiCliCredentialsFile = {
    access_token: access,
    refresh_token: refresh,
    expires_at: Math.floor(expiresMs / 1000),
    scope: "",
    token_type: "Bearer",
    expires_in: Math.max(0, Math.floor((expiresMs - Date.now()) / 1000)),
  };
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function getFileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

async function tryReuseKimiCliCredentials(
  callbacks: OAuthLoginCallbacks,
): Promise<KimiOAuthCredentials | null> {
  const data = readKimiCliCredentials();
  if (!data) return null;

  const expiresAtMs = typeof data.expires_at === "number" ? data.expires_at * 1000 : 0;
  // 60s safety buffer so we don't hand pi a token that flips to expired
  // between this returning and the first API call.
  const stillFresh = expiresAtMs > Date.now() + 60_000;

  callbacks.onProgress?.("Found existing Kimi credentials, reusing them.");

  if (stillFresh) {
    const extras = await discoverKimiModelMetadata(data.access_token!);
    return {
      access: data.access_token!,
      refresh: data.refresh_token!,
      expires: expiresAtMs,
      ...extras,
    };
  }

  callbacks.onProgress?.("Kimi access token expired, refreshing.");
  try {
    const token = await refreshAccessToken(data.refresh_token!);
    const expiresMs = Date.now() + token.expires_in * 1000;
    writeKimiCodeCredentials(token.access_token, token.refresh_token, expiresMs);
    const extras = await discoverKimiModelMetadata(token.access_token);
    return {
      access: token.access_token,
      refresh: token.refresh_token,
      expires: expiresMs,
      ...extras,
    };
  } catch {
    callbacks.onProgress?.("Refresh of Kimi token failed, falling back to device flow.");
    return null;
  }
}

// =============================================================================
// OAuth login / refresh for extension registration
// =============================================================================

export async function loginKimiCode(callbacks: OAuthLoginCallbacks): Promise<KimiOAuthCredentials> {
  const reused = await tryReuseKimiCliCredentials(callbacks);
  if (reused) return reused;

  // Keep trying until we get a token (handles expired device codes)
  while (true) {
    const auth = await requestDeviceAuthorization();

    callbacks.onAuth({
      url: auth.verification_uri_complete,
      instructions: `Please visit the URL to authorize. Your code: ${auth.user_code}`,
    });

    let interval = Math.max(auth.interval, 1) * 1000;
    const expiresAt = Date.now() + auth.expires_in * 1000;

    let token: TokenResponse | null = null;
    let printedWaiting = false;

    while (Date.now() < expiresAt) {
      try {
        const result = await requestDeviceToken(auth);
        if (result === "slow_down") {
          interval += 5000;
        } else {
          token = result;
          if (token) break;
        }
      } catch (error) {
        if (error instanceof Error && error.message === "expired_token") {
          // Device code expired, restart the flow
          if (callbacks.onProgress) {
            callbacks.onProgress("Device code expired, restarting...");
          }
          break;
        }
        throw error;
      }

      if (!printedWaiting) {
        if (callbacks.onProgress) {
          callbacks.onProgress("Waiting for authorization...");
        }
        printedWaiting = true;
      }

      // Check for abort
      if (callbacks.signal?.aborted) {
        throw new Error("Authorization aborted");
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    if (token) {
      const expiresMs = Date.now() + token.expires_in * 1000;
      writeKimiCodeCredentials(token.access_token, token.refresh_token, expiresMs);
      const extras = await discoverKimiModelMetadata(token.access_token);
      return {
        access: token.access_token,
        refresh: token.refresh_token,
        expires: expiresMs,
        ...extras,
      };
    }

    // If we get here without a token, the device code expired - loop will retry
  }
}

export async function refreshKimiCodeToken(
  credentials: OAuthCredentials,
): Promise<KimiOAuthCredentials> {
  const token = await refreshAccessToken(credentials.refresh);
  const expiresMs = Date.now() + token.expires_in * 1000;
  writeKimiCodeCredentials(token.access_token, token.refresh_token, expiresMs);
  const extras = await discoverKimiModelMetadata(token.access_token);
  return {
    access: token.access_token,
    refresh: token.refresh_token,
    expires: expiresMs,
    ...extras,
  };
}

// =============================================================================
// Stream-level auth refresh: recover from server-side token invalidation
//
// pi-coding-agent only refreshes an OAuth token when the locally cached
// `expires` is in the past. If the server rotates/revokes the access token
// before that (common with short-lived session tokens), every request keeps
// returning 401. The streaming handler invokes refreshKimiAuthToken on the
// first auth error to force a refresh through AuthStorage (which persists the
// new credentials under a file lock), and retry once.
// =============================================================================

export function isKimiAuthErrorMessage(message: unknown): boolean {
  const text = String(message ?? "").toLowerCase();
  return (
    /\b401\b/.test(text) ||
    text.includes("unauthorized") ||
    text.includes("incorrect api key") ||
    text.includes("invalid api key")
  );
}

export async function refreshKimiAuthToken(currentKey: string): Promise<string | null> {
  try {
    const kimiCred = readKimiCliCredentials();
    const hasKimiCode = kimiCodeCredentialExists();

    const storage = AuthStorage.create();
    const piCred = storage.get(PROVIDER_ID);
    const piOAuth = piCred?.type === "oauth" ? piCred : null;

    // Merge: when both sources exist, pick the newer one and sync to kimi-code
    if (hasKimiCode && kimiCred && piOAuth) {
      const kimiExpiresMs = (kimiCred.expires_at ?? 0) * 1000;
      const piMtime = getFileMtimeMs(
        join(
          process.env.PI_CODING_AGENT_DIR || join(os.homedir(), ".pi", "agent"),
          "auth.json",
        ),
      );
      const kimiMtime = getFileMtimeMs(getKimiCodeCredentialPath());

      if (piMtime > kimiMtime && piOAuth.access !== kimiCred.access_token) {
        writeKimiCodeCredentials(piOAuth.access, piOAuth.refresh, piOAuth.expires);
        kimiCred.access_token = piOAuth.access;
        kimiCred.refresh_token = piOAuth.refresh;
        kimiCred.expires_at = Math.floor(piOAuth.expires / 1000);
        console.error("[kimi-coding] auth merge: synced newer pi credentials to kimi-code");
      } else if (kimiMtime > piMtime && kimiCred.access_token !== piOAuth.access) {
        const merged: OAuthCredential = {
          ...piOAuth,
          type: "oauth",
          access: kimiCred.access_token!,
          refresh: kimiCred.refresh_token!,
          expires: kimiExpiresMs,
        };
        storage.set(PROVIDER_ID, merged);
        console.error("[kimi-coding] auth merge: synced newer kimi-code credentials to pi");
      }
    }

    // Prefer kimi-code credentials when available
    if (hasKimiCode && kimiCred) {
      const expiresMs = (kimiCred.expires_at ?? 0) * 1000;

      if (kimiCred.access_token !== currentKey && Date.now() < expiresMs) {
        console.error("[kimi-coding] auth refresh: reusing newer kimi-code token");
        return kimiCred.access_token!;
      }

      console.error("[kimi-coding] auth refresh: requesting new access token via kimi-code");
      const refreshed = await refreshAccessToken(kimiCred.refresh_token!);
      const newExpiresMs = Date.now() + refreshed.expires_in * 1000;
      writeKimiCodeCredentials(refreshed.access_token, refreshed.refresh_token, newExpiresMs);

      if (piOAuth) {
        storage.set(PROVIDER_ID, {
          ...piOAuth,
          type: "oauth",
          access: refreshed.access_token,
          refresh: refreshed.refresh_token,
          expires: newExpiresMs,
        });
      }

      console.error("[kimi-coding] auth refresh: new token persisted to kimi-code");
      return refreshed.access_token;
    }

    // Fall back to pi AuthStorage
    if (!piOAuth) {
      console.error(
        `[kimi-coding] auth refresh skipped: no OAuth credentials for ${PROVIDER_ID} on disk`,
      );
      return null;
    }

    if (piOAuth.access !== currentKey && Date.now() < piOAuth.expires) {
      console.error("[kimi-coding] auth refresh: reusing newer on-disk token");
      return piOAuth.access;
    }

    console.error("[kimi-coding] auth refresh: requesting new access token");
    const refreshed = await refreshAccessToken(piOAuth.refresh);
    const newExpiresMs = Date.now() + refreshed.expires_in * 1000;
    const newCred: OAuthCredential = {
      ...piOAuth,
      type: "oauth",
      access: refreshed.access_token,
      refresh: refreshed.refresh_token,
      expires: newExpiresMs,
    };
    storage.set(PROVIDER_ID, newCred);
    console.error("[kimi-coding] auth refresh: new token persisted");
    return newCred.access;
  } catch (err) {
    console.error("[kimi-coding] auth refresh failed:", err);
    return null;
  }
}
