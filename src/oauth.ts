// OAuth subsystem: device flow, refresh-with-retry, Kimi credential
// reuse, the login / refresh handlers wired into pi's OAuth interface, and
// the stream-level auth refresh used by the streaming handler.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

import { lock as acquireFileLock } from "proper-lockfile";

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import * as piAgent from "@earendil-works/pi-coding-agent";

// Structural mirrors of pi's stored credential shapes. The exported names
// moved between pi versions (pi-coding-agent <=0.79 vs pi-ai >=0.80.8), so
// these are defined locally to type-check against either surface.
type StoredCredential = { type: string } & Record<string, unknown>;

export interface StoredOAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

// pi renamed its auth storage surface in 0.80.8: the exported AuthStorage
// class (sync get/set under a file lock) was replaced by readStoredCredential
// for one-off reads, with no exported write path. Detect whichever the host
// pi provides so the extension keeps loading on both sides of the rename.
const piAgentRuntime = piAgent as unknown as {
  getAgentDir(): string;
  readStoredCredential?(providerId: string): StoredCredential | undefined;
  AuthStorage?: {
    create(): {
      get(provider: string): StoredCredential | undefined;
      set(provider: string, credential: StoredCredential): void;
    };
  };
};

export function readStoredOAuthCredential(providerId: string): StoredOAuthCredential | null {
  const credential = piAgentRuntime.readStoredCredential
    ? piAgentRuntime.readStoredCredential(providerId)
    : piAgentRuntime.AuthStorage?.create().get(providerId);
  return credential?.type === "oauth" ? (credential as StoredOAuthCredential) : null;
}

// Mutual exclusion with pi's own credential writes: use the same library
// (proper-lockfile) on the same file pi's FileAuthStorageBackend locks, with
// the same options. The shared implementation keeps the lock mtime fresh
// while held, recovers stale locks from crashed processes, and retries for
// ~40s so a live holder running a slow network refresh inside the lock is
// waited out.
async function acquireSharedFileLock(
  path: string,
  signal: AbortSignal | undefined,
  options: { maxRetries: number; stale: number; minTimeout: number; maxTimeout: number },
): Promise<() => Promise<void>> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await acquireFileLock(path, {
        realpath: false,
        stale: options.stale,
        // Retry via the outer abortable sleep below. proper-lockfile's own
        // retry loop is not signal-aware and would otherwise ignore an abort
        // for the full configured retry window.
        retries: 0,
      });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
      if (code !== "ELOCKED" || attempt >= options.maxRetries) throw error;
      const baseDelay = Math.min(options.minTimeout * 2 ** attempt, options.maxTimeout);
      await sleep(baseDelay * (1 + Math.random()), signal);
    }
  }
}

async function acquireAuthFileLock(
  authPath: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  return acquireSharedFileLock(authPath, signal, {
    maxRetries: 10,
    stale: 30_000,
    minTimeout: 100,
    maxTimeout: 10_000,
  });
}

async function acquireKimiCodeRefreshLock(signal?: AbortSignal): Promise<() => Promise<void>> {
  if (process.platform === "win32" || process.env.KIMI_DISABLE_OAUTH_LOCK === "1") {
    return async () => {};
  }
  const target = join(
    process.env.KIMI_CODE_HOME || join(os.homedir(), ".kimi-code"),
    "oauth",
    "kimi-code",
  );
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, "", { encoding: "utf-8", flag: "a" });
  return acquireSharedFileLock(target, signal, {
    maxRetries: 120,
    stale: 5_000,
    minTimeout: 500,
    maxTimeout: 1_000,
  });
}

interface LockedOAuthCredential {
  credential: StoredOAuthCredential | null;
  store(credential: StoredOAuthCredential): void;
  release(): Promise<void>;
}

async function lockStoredOAuthCredential(
  providerId: string,
  signal?: AbortSignal,
): Promise<LockedOAuthCredential> {
  // Hold the same lock Pi uses across the complete read-refresh-write
  // transaction. Kimi rotates refresh tokens, so locking only the write lets
  // concurrent Pi processes exchange the same token twice.
  const authPath = join(piAgentRuntime.getAgentDir(), "auth.json");
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  if (!existsSync(authPath)) {
    writeFileSync(authPath, "{}", { encoding: "utf-8", mode: 0o600 });
    chmodSync(authPath, 0o600);
  }
  const release = await acquireAuthFileLock(authPath, signal);
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable auth.json — treat it as an empty store.
  }
  const stored = data[providerId] as StoredCredential | undefined;
  return {
    credential: stored?.type === "oauth" ? (stored as unknown as StoredOAuthCredential) : null,
    store(credential) {
      data[providerId] = credential;
      writeFileSync(authPath, JSON.stringify(data, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      chmodSync(authPath, 0o600);
    },
    release,
  };
}

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
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

export const KIMI_LOGIN_REQUIRED_MESSAGE =
  "Kimi Code authorization is no longer valid. Sign in again with /login kimi-coding.";

export class KimiLoginRequiredError extends Error {
  constructor() {
    super(KIMI_LOGIN_REQUIRED_MESSAGE);
    this.name = "KimiLoginRequiredError";
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function refreshAccessToken(
  refreshToken: string,
  options: RefreshAccessTokenOptions = {},
): Promise<TokenResponse> {
  const maxRetries = options.maxRetries ?? 3;
  const wait = options.sleep ?? ((ms: number) => sleep(ms, options.signal));
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      options.signal?.throwIfAborted();
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
        signal: options.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let errorCode = "";
        try {
          const body = JSON.parse(text) as { error?: unknown };
          if (typeof body.error === "string") errorCode = body.error;
        } catch {
          // Non-JSON OAuth errors are classified by status below.
        }
        if (response.status === 401 || response.status === 403 || errorCode === "invalid_grant") {
          throw new KimiLoginRequiredError();
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
      if (options.signal?.aborted) throw options.signal.reason;
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof KimiLoginRequiredError) throw error;
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

function writeKimiCodeCredentials(access: string, refresh: string, expiresMs: number): void {
  const path = getKimiCodeCredentialPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const data: KimiCliCredentialsFile = {
    access_token: access,
    refresh_token: refresh,
    expires_at: Math.floor(expiresMs / 1000),
    scope: "",
    token_type: "Bearer",
    expires_in: Math.max(0, Math.floor((expiresMs - Date.now()) / 1000)),
  };
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(path, 0o600);
}

interface LockedKimiCodeCredentials {
  credential: KimiCliCredentialsFile | null;
  store(access: string, refresh: string, expiresMs: number): void;
  release(): Promise<void>;
}

async function lockKimiCodeCredentials(signal?: AbortSignal): Promise<LockedKimiCodeCredentials> {
  const release = await acquireKimiCodeRefreshLock(signal);
  const credential = readKimiCliCredentials();
  return {
    credential,
    store: writeKimiCodeCredentials,
    release,
  };
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
  const kimiLocked = await lockKimiCodeCredentials();
  try {
    const initialKimiCred = kimiLocked.credential;
    const initialKimiExpiresMs = (initialKimiCred?.expires_at ?? 0) * 1000;
    const peerHasNewerValidAccess =
      initialKimiCred?.access_token !== undefined &&
      initialKimiCred.access_token !== credentials.access &&
      Date.now() < initialKimiExpiresMs;
    const activeRefreshToken = peerHasNewerValidAccess
      ? initialKimiCred.refresh_token!
      : credentials.refresh;
    const activeAccessToken = peerHasNewerValidAccess
      ? initialKimiCred.access_token!
      : credentials.access;
    if (peerHasNewerValidAccess && initialKimiCred.refresh_token !== credentials.refresh) {
      const extras = await discoverKimiModelMetadata(activeAccessToken);
      return {
        access: activeAccessToken,
        refresh: activeRefreshToken,
        expires: initialKimiExpiresMs,
        ...extras,
      };
    }
    let token: Awaited<ReturnType<typeof refreshAccessToken>>;
    try {
      token = await refreshAccessToken(activeRefreshToken);
    } catch (error) {
      // Lock-disabled platforms (Windows / KIMI_DISABLE_OAUTH_LOCK=1) use
      // storage re-read as the only coordinator. A peer may have rotated the
      // shared sidecar while this process was exchanging the old refresh
      // token; recover from that newer valid credential instead of surfacing
      // the stale-token invalid_grant as a login failure.
      await sleep(100);
      const peerCredential = readKimiCliCredentials();
      const peerAccess = peerCredential?.access_token;
      const peerRefresh = peerCredential?.refresh_token;
      const peerExpiresMs = (peerCredential?.expires_at ?? 0) * 1000;
      if (
        peerAccess !== undefined &&
        peerRefresh !== undefined &&
        peerAccess !== credentials.access &&
        Date.now() < peerExpiresMs
      ) {
        const extras = await discoverKimiModelMetadata(peerAccess);
        return {
          access: peerAccess,
          refresh: peerRefresh,
          expires: peerExpiresMs,
          ...extras,
        };
      }
      throw error;
    }
    const expiresMs = Date.now() + token.expires_in * 1000;
    const kimiCredentialAfterRefresh = readKimiCliCredentials();
    const peerAccess = kimiCredentialAfterRefresh?.access_token;
    const peerRefresh = kimiCredentialAfterRefresh?.refresh_token;
    const peerExpiresMs = (kimiCredentialAfterRefresh?.expires_at ?? 0) * 1000;
    const accessToken =
      peerAccess !== undefined && peerAccess !== activeAccessToken && Date.now() < peerExpiresMs
        ? peerAccess
        : token.access_token;
    const refreshToken = accessToken === peerAccess ? peerRefresh! : token.refresh_token;
    const effectiveExpiresMs = accessToken === peerAccess ? peerExpiresMs : expiresMs;
    if (accessToken !== peerAccess) {
      kimiLocked.store(accessToken, refreshToken, effectiveExpiresMs);
    }
    const extras = await discoverKimiModelMetadata(accessToken);
    return {
      access: accessToken,
      refresh: refreshToken,
      expires: effectiveExpiresMs,
      ...extras,
    };
  } finally {
    await kimiLocked.release().catch(() => {});
  }
}

// =============================================================================
// Stream-level auth refresh: recover from server-side token invalidation
//
// pi-coding-agent only refreshes an OAuth token when the locally cached
// `expires` is in the past. If the server rotates/revokes the access token
// before that (common with short-lived session tokens), every request keeps
// returning 401. The streaming handler invokes refreshKimiAuthToken on the
// first auth error to force a refresh and persist the new credentials, and
// retry once.
// =============================================================================

export function getKimiApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}

export function isKimiAuthErrorMessage(message: unknown): boolean {
  const text = String(message ?? "").toLowerCase();
  const isMembershipPermissionError =
    text.includes("current subscription does not have access to k3") ||
    text.includes("current plan supports only kimi-k3 up to 256k context") ||
    text.includes("current subscription does not have access to kimi-for-coding-highspeed");
  if (isMembershipPermissionError) return false;
  return (
    /\b401\b/.test(text) ||
    text.includes("unauthorized") ||
    text.includes("incorrect api key") ||
    text.includes("invalid api key") ||
    // Kimi's production 401 body: "The API Key appears to be invalid or may
    // have expired..." with type "invalid_authentication_error". Neither
    // contains the substrings above, so without these the digit fallback is
    // the only match and vanishes when a transport strips the status prefix.
    text.includes("api key appears to be invalid") ||
    text.includes("invalid_authentication_error")
  );
}

export async function refreshKimiAuthToken(
  currentKey: string,
  options: { signal?: AbortSignal } = {},
): Promise<string | null> {
  let locked: LockedOAuthCredential | undefined;
  let kimiLocked: LockedKimiCodeCredentials | undefined;
  try {
    locked = await lockStoredOAuthCredential(PROVIDER_ID, options.signal);
    const piOAuth = locked.credential;

    if (piOAuth) {
      if (piOAuth.access !== currentKey && Date.now() < piOAuth.expires) {
        return piOAuth.access;
      }

      let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>;
      kimiLocked = await lockKimiCodeCredentials(options.signal);
      try {
        refreshed = await refreshAccessToken(piOAuth.refresh, { signal: options.signal });
      } catch (error) {
        const kimiCred = readKimiCliCredentials();
        if (!kimiCred?.refresh_token || kimiCred.refresh_token === piOAuth.refresh) throw error;
        const kimiExpiresMs = (kimiCred.expires_at ?? 0) * 1000;
        if (kimiCred.access_token !== currentKey && Date.now() < kimiExpiresMs) {
          const recovered: StoredOAuthCredential = {
            ...piOAuth,
            type: "oauth",
            access: kimiCred.access_token!,
            refresh: kimiCred.refresh_token,
            expires: kimiExpiresMs,
          };
          locked.store(recovered);
          return recovered.access;
        }
        refreshed = await refreshAccessToken(kimiCred.refresh_token, { signal: options.signal });
      }

      const newExpiresMs = Date.now() + refreshed.expires_in * 1000;
      const kimiCredentialAfterRefresh = readKimiCliCredentials();
      const peerAccess = kimiCredentialAfterRefresh?.access_token;
      const peerExpiresMs = (kimiCredentialAfterRefresh?.expires_at ?? 0) * 1000;
      const peerIsNewerValid =
        peerAccess !== undefined && peerAccess !== currentKey && Date.now() < peerExpiresMs;
      if (peerIsNewerValid) {
        const peerCred: StoredOAuthCredential = {
          ...piOAuth,
          type: "oauth",
          access: peerAccess,
          refresh: kimiCredentialAfterRefresh!.refresh_token!,
          expires: peerExpiresMs,
        };
        locked.store(peerCred);
        return peerCred.access;
      }
      kimiLocked.store(refreshed.access_token, refreshed.refresh_token, newExpiresMs);
      const newCred: StoredOAuthCredential = {
        ...piOAuth,
        type: "oauth",
        access: refreshed.access_token,
        refresh: refreshed.refresh_token,
        expires: newExpiresMs,
      };
      locked.store(newCred);
      return newCred.access;
    }

    kimiLocked = await lockKimiCodeCredentials(options.signal);
    const kimiCred = kimiLocked.credential;
    if (!kimiCred) {
      return null;
    }

    const kimiExpiresMs = (kimiCred.expires_at ?? 0) * 1000;
    if (kimiCred.access_token !== currentKey && Date.now() < kimiExpiresMs) {
      return kimiCred.access_token!;
    }

    const refreshed = await refreshAccessToken(kimiCred.refresh_token!, {
      signal: options.signal,
    });
    const newExpiresMs = Date.now() + refreshed.expires_in * 1000;
    const kimiCredentialAfterRefresh = readKimiCliCredentials();
    const peerAccess = kimiCredentialAfterRefresh?.access_token;
    const peerExpiresMs = (kimiCredentialAfterRefresh?.expires_at ?? 0) * 1000;
    if (peerAccess !== undefined && peerAccess !== currentKey && Date.now() < peerExpiresMs) {
      return peerAccess;
    }
    kimiLocked.store(refreshed.access_token, refreshed.refresh_token, newExpiresMs);
    return refreshed.access_token;
  } catch (err) {
    if (options.signal?.aborted) return null;
    if (err instanceof KimiLoginRequiredError) {
      console.error(`[kimi-coding] ${KIMI_LOGIN_REQUIRED_MESSAGE}`);
    } else {
      console.error("[kimi-coding] auth refresh failed:", err);
    }
    return null;
  } finally {
    if (kimiLocked) {
      await kimiLocked.release().catch(() => {});
    }
    if (locked) {
      await locked.release().catch(() => {});
    }
  }
}
