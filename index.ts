/**
 * Kimi Code Provider Extension
 *
 * Provides access to Kimi models via OAuth device code flow.
 * API endpoint: https://api.kimi.com/coding (Anthropic Messages compatible)
 *
 * Usage:
 *   pi -e ~/workshop/pi-provider-kimi-code
 *   # Then /login kimi-coding, or set KIMI_API_KEY=...
 *
 * Source layout:
 *   src/constants.ts  — module-level consts + env-driven configuration
 *   src/device.ts     — device id + kimi-cli-compatible request headers
 *   src/oauth.ts      — device flow, token refresh, kimi-cli reuse,
 *                       login/refresh handlers, stream-level auth refresh
 *   src/models.ts     — /v1/models discovery + extras-merging helpers
 *   src/payload.ts    — payload pipeline + file upload + transforms
 *   src/stream.ts     — empty-response filter + streamSimpleKimi orchestrator
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_KIMI_MODEL_INPUT,
  KIMI_API_TYPE,
  PROVIDER_ID,
  getBaseUrl,
} from "./src/constants.ts";
import { getCommonHeaders } from "./src/device.ts";
import {
  type KimiOAuthCredentials,
  applyKimiEnvOverridesToModel,
  applyKimiOAuthExtrasToModel,
} from "./src/models.ts";
import { loginKimiCode, refreshKimiCodeToken } from "./src/oauth.ts";
import { streamSimpleKimi } from "./src/stream.ts";

export default function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: getBaseUrl(),
    apiKey: "KIMI_API_KEY",
    api: KIMI_API_TYPE,
    streamSimple: streamSimpleKimi,

    headers: getCommonHeaders(),

    models: [
      applyKimiEnvOverridesToModel({
        id: "kimi-for-coding",
        name: "Kimi for Coding",
        reasoning: true,
        input: [...DEFAULT_KIMI_MODEL_INPUT] as unknown as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32000,
      } as Model<Api>),
    ],

    oauth: {
      name: "Kimi Code (OAuth)",
      login: loginKimiCode,
      refreshToken: refreshKimiCodeToken,
      getApiKey: (cred) => cred.access,
      // Reflect server-side model identity on the registered model after login
      // / refresh. We never rewrite the model id (pi-side `/model` selections
      // and persisted sessions reference it); only the human-facing name, the
      // context window, and an out-of-band `wireModelId` carried into the
      // request payload by streamSimpleKimi.
      modifyModels: (models, cred) => {
        const extras = cred as KimiOAuthCredentials;
        return models.map((model) => {
          if (model.id !== "kimi-for-coding") return model;
          return applyKimiEnvOverridesToModel(applyKimiOAuthExtrasToModel(model, extras));
        });
      },
    },
  });
}
