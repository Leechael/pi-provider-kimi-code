/**
 * Kimi Code Provider Extension
 *
 * Provides access to Kimi models via OAuth device code flow.
 * API endpoint: https://api.kimi.com/coding (Anthropic Messages compatible)
 *
 * Usage:
 *   pi -e ~/workshop/pi-provider-kimi-code
 *   # Then /login kimi-coding, or set KIMI_API_KEY=...
 */

import { randomBytes } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const OAUTH_HOST = "https://auth.kimi.com";
const KIMI_CLI_USER_AGENT = "kimi-cli/1.0.0 (external, cli)";
const KIMI_PLATFORM = "kimi_cli";

// =============================================================================
// Device identification
// =============================================================================

function createDeviceId(): string {
	return randomBytes(16).toString("hex");
}

function getDeviceModel(): string {
	const platform = process.platform;
	const arch = process.arch;
	if (platform === "darwin") {
		return `macOS ${arch}`;
	}
	if (platform === "win32") {
		return `Windows ${arch}`;
	}
	return `${platform} ${arch}`;
}

const DEVICE_MODEL = getDeviceModel();
let DEVICE_ID: string | null = null;

function getStableDeviceId(): string {
	if (!DEVICE_ID) {
		DEVICE_ID = createDeviceId();
	}
	return DEVICE_ID;
}

function getCommonHeaders(): Record<string, string> {
	return {
		"User-Agent": KIMI_CLI_USER_AGENT,
		"X-Msh-Platform": KIMI_PLATFORM,
		"X-Msh-Device-Model": DEVICE_MODEL,
		"X-Msh-Device-Id": getStableDeviceId(),
	};
}

// =============================================================================
// OAuth Implementation
// =============================================================================

interface DeviceAuthorization {
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

async function requestDeviceAuthorization(): Promise<DeviceAuthorization> {
	const response = await fetch(`${OAUTH_HOST}/api/oauth/device_authorization`, {
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

	if (!data.user_code || !data.device_code || !data.verification_uri_complete) {
		throw new Error("Invalid device authorization response");
	}

	return {
		user_code: data.user_code,
		device_code: data.device_code,
		verification_uri: data.verification_uri || "",
		verification_uri_complete: data.verification_uri_complete,
		expires_in: data.expires_in || 1800,
		interval: data.interval || 5,
	};
}

async function requestDeviceToken(auth: DeviceAuthorization): Promise<TokenResponse | null> {
	const response = await fetch(`${OAUTH_HOST}/api/oauth/token`, {
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
			return null; // Still waiting for user
		}
		if (data.error === "expired_token") {
			throw new Error("expired_token");
		}
		throw new Error(`Token request failed: ${data.error_description || data.error || "unknown"}`);
	}

	const text = await response.text().catch(() => "");
	throw new Error(`Token request failed: ${response.status} ${text}`);
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
	const response = await fetch(`${OAUTH_HOST}/api/oauth/token`, {
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
		throw new Error(`Token refresh failed: ${response.status} ${text}`);
	}

	const data = (await response.json()) as TokenResponse;
	if (!data.access_token || !data.refresh_token) {
		throw new Error("Token refresh response missing required fields");
	}

	return data;
}

// =============================================================================
// OAuth login / refresh for extension registration
// =============================================================================

async function loginKimiCode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	// Keep trying until we get a token (handles expired device codes)
	while (true) {
		const auth = await requestDeviceAuthorization();

		callbacks.onAuth({
			url: auth.verification_uri_complete,
			instructions: `Please visit the URL to authorize. Your code: ${auth.user_code}`,
		});

		const interval = Math.max(auth.interval, 1) * 1000;
		const expiresAt = Date.now() + auth.expires_in * 1000;

		let token: TokenResponse | null = null;
		let printedWaiting = false;

		while (Date.now() < expiresAt) {
			try {
				token = await requestDeviceToken(auth);
				if (token) break;
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
			return {
				access: token.access_token,
				refresh: token.refresh_token,
				expires: Date.now() + token.expires_in * 1000,
			};
		}

		// If we get here without a token, the device code expired - loop will retry
	}
}

async function refreshKimiCodeToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const token = await refreshAccessToken(credentials.refresh);
	return {
		access: token.access_token,
		refresh: token.refresh_token,
		expires: Date.now() + token.expires_in * 1000,
	};
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider("kimi-coding", {
		baseUrl: "https://api.kimi.com/coding",
		apiKey: "KIMI_API_KEY",
		api: "anthropic-messages",

		headers: {
			"User-Agent": KIMI_CLI_USER_AGENT,
			"X-Msh-Platform": KIMI_PLATFORM,
		},

		models: [
			{
				id: "kimi-k2-thinking",
				name: "Kimi K2 Thinking",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 32768,
			},
			{
				id: "k2p5",
				name: "Kimi K2.5",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 32768,
			},
		],

		oauth: {
			name: "Kimi Code (OAuth)",
			login: loginKimiCode,
			refreshToken: refreshKimiCodeToken,
			getApiKey: (cred) => cred.access,
		},
	});
}
