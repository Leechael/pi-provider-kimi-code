# Architecture: pi-provider-kimi-code

A pi custom provider extension that integrates [Kimi Code](https://kimi.com) models
into the Pi coding agent via OAuth device-code flow. Supports both Kimi's Anthropic
Messages and OpenAI Chat Completions wire-compatible endpoints.

## Overview

This extension registers a provider named `kimi-coding` that exposes Kimi's coding
models. It supports two authentication modes:

1. **OAuth device-code flow** — interactive browser-based login (`/login kimi-coding`)
2. **Static API key** — set the `KIMI_API_KEY` environment variable

The Kimi Code API is wire-compatible with Anthropic Messages, OpenAI Chat
Completions, and OpenAI Responses. The extension picks which wire protocol to use via the
`KIMI_CODE_PROTOCOL` environment variable. Supported values are `openai` (default),
`anthropic`, and `responses`. Managed endpoints (API base and OAuth host) are selected
per region — `mainland-cn` (`api.kimi.com` / `auth.kimi.com`, default) or `global`
(`api.kimi.ai` / `auth.kimi.ai`) — via `KIMI_CODE_REGION`, the `region` config key, or
`/kimi-settings`. A `streamSimpleKimi()` wrapper (in `src/stream.ts`) sits on top of Pi's
built-in streaming to:

- upload large inline base64 images to Kimi's `/v1/files` endpoint as `ms://` references
- enforce a per-request inline media budget (~20 MB of base64 on the wire), dropping oversized media items and leaving a placeholder so the model knows content was removed
- inject Kimi's proprietary `prompt_cache_key` alongside Anthropic `cache_control`
- apply env-level hyperparameter overrides (`max_completion_tokens`; `temperature` and `top_p` are sent only when explicitly configured — matching the official `kimi-code` client — and are otherwise omitted; on the OpenAI wires the completion cap is omitted entirely unless configured)
- map Pi's `reasoning` level to top-level `thinking`, including only server-advertised effort values
- strip empty text parts that pi-ai's Responses serializer replays from text-less assistant turns (issue #78)
- suppress Kimi's `(Empty response: ...)` placeholder text blocks from the response stream

## File Structure

```
pi-provider-kimi-code/
├── .gitignore          # Excludes node_modules/, docs/, etc. from npm
├── package.json        # Extension manifest (pi.extensions field)
├── index.ts            # Extension entry point: provider registration, OAuth wiring,
│                       #   /kimi-settings command, tool registration, kimi-code sync
├── src/
│   ├── constants.ts    # CLIENT_ID, region profiles, endpoint derivation, protocol
│   ├── config.ts       # Config schema + load/merge (defaults < home < project < env < overrides)
│   ├── oauth.ts        # Device-code flow, token refresh, region-validity probe
│   ├── device.ts       # X-Msh-* device identity headers, stable device_id
│   ├── models.ts       # Model catalog discovery, thinking-level map, model building
│   ├── payload.ts      # Payload mutation pipeline + Kimi Files API upload
│   ├── stream.ts       # filterEmptyResponseStream + streamSimpleKimi orchestrator
│   ├── usage.ts        # /usages + /me parsing, quota bar rendering
│   ├── settings-ui.ts  # /kimi-settings rows and editing
│   ├── schema-dedup.ts # $ref/$defs tool-schema dedup (Moonshot 15 KB per-tool limit)
│   ├── project-trust.ts# Project-config trust prompt
│   └── tools/          # moonshot_search, moonshot_fetch, kimi_datasource
├── docs/
│   ├── architecture.md # This document
│   ├── ENV.md          # Environment variable reference
│   └── TESTING.md      # E2E test runbook
└── scripts/
    ├── e2e/            # End-to-end test scripts (smoke, provider-payload, ...)
    ├── test_e2e.sh     # End-to-end test runner
    └── next-version.sh # Release version bump helper
```

Pi loads `index.ts` directly via jiti (TypeScript-in-JS runtime), so no build
step is required. The virtual modules `@earendil-works/pi-ai` and
`@earendil-works/pi-coding-agent` are provided by the Pi runtime; no npm
dependencies are needed. The split into `src/` modules keeps the pure payload
/ stream layers free of I/O so they stay unit-testable; `index.ts` only wires
the modules together.

## Provider Registration

The default export is a function that receives `ExtensionAPI` and calls
`pi.registerProvider()`:

```
Provider ID:    kimi-coding
Base URL:       <region apiBase>/coding/v1    (openai-completions / openai-responses, default)
                <region apiBase>/coding       (anthropic-messages)
API type:       openai-completions | anthropic-messages | openai-responses  (via KIMI_CODE_PROTOCOL=openai|anthropic|responses)
Env var key:    KIMI_API_KEY
Region:         mainland-cn (default) | global   (via KIMI_CODE_REGION, config.json, or /kimi-settings)
```

`<region apiBase>` is `https://api.kimi.com` for `mainland-cn` and
`https://api.kimi.ai` for `global`. The base URL can also be overridden with
`KIMI_CODE_BASE_URL`, which wins over the region profile. See
[ENV.md](./ENV.md) for the full list of supported environment variables.

### Common Headers

Every OAuth request and model API request includes Kimi Code-style headers:

| Header               | Value                               |
| -------------------- | ----------------------------------- |
| `User-Agent`         | `kimi-code-cli/0.28.0`              |
| `X-Msh-Platform`     | `kimi_code_cli`                     |
| `X-Msh-Version`      | `0.28.0`                            |
| `X-Msh-Device-Name`  | Hostname                            |
| `X-Msh-Device-Model` | OS + kernel release + architecture  |
| `X-Msh-Os-Version`   | `os.release()`                      |
| `X-Msh-Device-Id`    | Stable random hex persisted on disk |

Header values are ASCII-sanitized and trimmed before sending, matching the upstream
fix for Linux / non-ASCII hostnames.

### Models

The official catalog determines the models this provider publishes. These default IDs are used when catalog discovery is unavailable:

| ID                          | Default Name             | Default Context | Max Output |
| --------------------------- | ------------------------ | --------------- | ---------- |
| `kimi-for-coding`           | Kimi K2.8 Code           | 256K            | 32K        |
| `kimi-for-coding-highspeed` | Kimi K2.8 Code HighSpeed | 256K            | 32K        |
| `k3`                        | Kimi K3                  | 256K            | 32K        |

The `kimi-for-coding` ID is stable across engine upgrades — K2.8 Preview (2026-09-11)
replaced K2.7 behind the same ID, so no client config change is needed when Moonshot
rolls out a new generation. The official catalog at
`https://api.kimi.com/coding/v1/models` is authoritative for model availability and
context windows (K2.8 advertises up to 1M tokens); the table above shows the
conservative fallback metadata used only when discovery is unavailable. It also
refreshes model reasoning and input modalities.

## OAuth Device-Code Flow

The login flow follows [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)
(OAuth 2.0 Device Authorization Grant).

### Endpoints

| Purpose              | mainland-cn                                            | global                                                |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| Device authorization | `https://auth.kimi.com/api/oauth/device_authorization` | `https://auth.kimi.ai/api/oauth/device_authorization` |
| Token exchange       | `https://auth.kimi.com/api/oauth/token`                | `https://auth.kimi.ai/api/oauth/token`                |

The OAuth host follows the selected region (and `/login kimi-coding` follows it
end to end). It can be overridden with `KIMI_CODE_OAUTH_HOST` or
`KIMI_OAUTH_HOST`. When the region is switched at runtime (e.g. from
`/kimi-settings`), the extension bridges the non-default region into Pi core's
built-in Kimi OAuth by setting `KIMI_CODE_OAUTH_HOST` in-process, so a login
through Pi's own `kimi-coding` provider still hits the right side.

### Sequence

```
  User            pi CLI            auth.kimi.com
   │                │                     │
   │  /login        │                     │
   │───────────────>│                     │
   │                │  POST /device_auth  │
   │                │────────────────────>│
   │                │  {device_code,      │
   │                │   user_code, url}   │
   │                │<────────────────────│
   │  Open browser  │                     │
   │<───────────────│                     │
   │  Authorize     │                     │
   │───────────────────────────────────-->│
   │                │  POST /token (poll) │
   │                │────────────────────>│
   │                │  {access_token,     │
   │                │   refresh_token}    │
   │                │<────────────────────│
   │  Logged in     │                     │
   │<───────────────│                     │
```

1. `requestDeviceAuthorization()` POSTs to the device authorization endpoint with
   `client_id`. It returns a `user_code`, `device_code`, and
   `verification_uri_complete`.
2. Pi opens the verification URL in the user's browser and displays the user code.
3. `requestDeviceToken()` polls the token endpoint at the server-specified interval
   (default 5 s) until the user completes authorization or the device code expires.
4. On `expired_token`, the outer loop in `loginKimiCode()` automatically restarts the
   entire flow with a fresh device code.
5. On success, credentials (`access_token`, `refresh_token`, `expires`) are persisted
   by Pi's credential store.

### Token Refresh

`refreshKimiCodeToken()` sends a `grant_type=refresh_token` request. If the refresh
token itself has expired (401/403), Pi will prompt the user to re-login.

## Device Identity

The extension keeps a stable device identifier in:

```text
~/.pi/providers/kimi-coding/device_id
```

This mirrors `kimi-code` behavior more closely than the earlier per-process random ID,
while keeping storage isolated to Pi.

## Credential Mapping

The `oauth.getApiKey` callback extracts the `access` field from stored credentials and
uses it as the `Authorization: Bearer <token>` value for API requests.

```typescript
getApiKey: (cred) => cred.access;
```

## Internals

The sections above describe the public contract. This one is for contributors:
how the extension is layered internally, and where to thread new features so
the tests still cover them.

### Module layout

Responsibilities are split across `src/` modules; `index.ts` is only the entry
point that wires them into `pi.registerProvider()`.

```
index.ts                # pi.registerProvider, OAuth wiring, /kimi-settings command,
                        #   tool registration, kimi-code credential sync
src/constants.ts        # CLIENT_ID, region profiles + endpoint derivation, protocol
src/config.ts           # config schema, load/merge chain, env overrides
src/oauth.ts            # device_authorization / token / refresh fetches, login wrappers,
                        #   region-validity probe, credential read/mapping
src/device.ts           # X-Msh-* header construction, stable device_id
src/models.ts           # catalog discovery, thinking-level map, model building
src/payload.ts          # uploadKimiFile + transform*/applyKimiPayloadMutations pipeline
src/stream.ts           # filterEmptyResponseStream + streamSimpleKimi orchestrator
src/usage.ts            # /usages + /me parsing (incl. quota-model payload, goods_version)
src/settings-ui.ts      # /kimi-settings rows and editing
src/schema-dedup.ts     # $ref/$defs dedup for Moonshot's 15 KB per-tool limit
src/project-trust.ts    # project-config trust prompt
src/tools/              # moonshot_search / moonshot_fetch / kimi_datasource
```

### Purity boundary

Every function belongs to one of four layers. Higher layers can depend on lower
ones; lower layers never reach upward.

```
Layer 1 — Pure                             (no side effects, deterministic)
    isRecord, resolveReasoningForLevel, parseInlineUploadThreshold,
    deriveFilesBaseUrl, parseDataUrl, getUploadFilename, asciiHeaderValue

Layer 2 — Pure given dependencies           (mutates input, calls injected Uploader)
    transformOpenAIPayloadFiles(payload, upload)
    transformAnthropicPayloadFiles(payload, upload)
    applyKimiPayloadMutations(payload, ctx)
    (also: applyInlineMediaBudget, stripEmptyResponsesTextParts, optimizeToolSchemas)

Layer 3 — Pure stream transformation        (async generator, no external closure dependencies)
    filterEmptyResponseStream(upstream)

Layer 4 — I/O edges                         (process.env, fs, network, execSync)
    currentKimiRegion / getBaseUrl / getOAuthHost, loadKimiCodeConfig,
    device id persistence, getCommonHeaders,
    uploadKimiFile,
    requestDeviceAuthorization / requestDeviceToken / refreshAccessToken,
    loginKimiCode / refreshKimiCodeToken,
    streamSimpleKimi  (orchestrator — reads config + options, wires layers 2/3)
```

The key rule: **Layers 1–3 must never touch `process.env`, `fs`, or `fetch`
directly.** Environment and config values are read at the orchestrator boundary
(`streamSimpleKimi`, or module scope for region/protocol selection) and passed
down as plain data in `KimiPayloadContext`, so the middle layers are
unit-testable without mocking modules.

### Data flow: streamSimpleKimi

```
                                    streamSimpleKimi(model, context, options)
                                                │
            ┌───────────────────────────────────┤  read boundary:
            │                                   │    apiKey, cacheKey, envOverrides,
            │                                   │    upload = apiKey
            │                                   │      ? (mime, data) => uploadKimiFile(apiKey, mime, data)
            │                                   │      : undefined
            │                                   │
            ▼                                   ▼
   patchedOptions.onPayload                upstream = streamSimpleOpenAICompletions(...)
            │                                       or streamSimpleAnthropic(...)
            │                                       or streamSimpleOpenAIResponses(...)
            │                                   │
            ▼                                   ▼
   applyKimiPayloadMutations(payload, ctx)  filterEmptyResponseStream(upstream)
     1. developer → system role map              │
     1b. Responses: strip empty text parts      │  buffer text_start/text_delta,
        replayed from text-less turns (#78)     │  drop block on "(Empty response:" marker,
     2. transform*PayloadFiles(payload, upload)  │  replace done.message.content with filtered copy
        (OpenAI or Anthropic)                    │
           └─> upload(mimeType, data)            │
     2b. applyInlineMediaBudget                 │
     2c. normalize tool calls + dedup schemas    │
     3. prompt_cache_key injection               │
     4. stream_options / extra_body              │
     5. env + config caps, thinking map          │
                                                ▼
                                        filtered.push(event)
            │
            ▼
   originalOnPayload chain
            │
            ▼
   nextPayload → SDK
```

`streamSimpleKimi` wraps `options.onPayload` with its own callback. The order
inside that callback is:

1. Apply Kimi mutations (`applyKimiPayloadMutations`) on the payload produced by
   the SDK.
2. Delegate to the caller's original `onPayload` (if any) so user hooks see the
   already-mutated payload — not an intermediate form.

This ordering matters: if user hooks ran first, any subsequent upload /
cache_key / env-override step could silently overwrite their changes.

### Empty-response suppression state machine

`filterEmptyResponseStream` is a stateful async generator with three variables:

- `bufferingIndex: number | null` — the `contentIndex` of the text block
  currently being buffered, or `null` when no block is active.
- `textBuffer: AssistantMessageEvent[]` — events seen since `text_start` for the
  active block.
- `suppressedIndices: Set<number>` — content indices that were identified as
  `(Empty response: ...)` blocks and should be dropped from the stream
  end-to-end.

Transitions:

```
text_start(i)                          → bufferingIndex := i; textBuffer := [event]
text_delta(i == buffering)             → textBuffer.push(event)
text_end(i == buffering)
  ├─ starts with "(Empty response:":    suppressedIndices.add(i); discard buffer
  └─ otherwise:                         flush buffer + yield end event
event with contentIndex ∈ suppressed   → drop
done(suppressed.size > 0)              → replace message.content with a filtered
                                         copy (drop suppressed text blocks)
```

`message.content` is a shared reference into session state, so mutating it
mid-stream would shift the `contentIndex` of later blocks and corrupt events
still in flight. The generator keeps an internal `suppressedIndices` Set instead,
and only reassigns `message.content` on the terminal `done` event — `.filter()`
returns a new array, so the original session-state array stays untouched.

### Testable units

Every unit below can be tested without touching the network, the filesystem, or
`process.env`.

#### Layer 1 — pure inputs/outputs

| Function                          | Contract                                                                                  | Fixture strategy                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `isRecord(value)`                 | Type guard for plain objects                                                              | Boolean assertions over `null`, `[]`, `{}`, primitives |
| `resolveReasoningForLevel(...)`   | Thinking level + catalog → `{effort, enabled}`                                            | Table test, all levels + catalog with/without efforts  |
| `parseInlineUploadThreshold(raw)` | `string \| undefined` → bytes                                                             | Valid int, empty, `undefined`, negative, non-numeric   |
| `deriveFilesBaseUrl(baseUrl)`     | Ensure the base URL ends with `/v1` (the `/files` suffix is appended by `uploadKimiFile`) | `/coding` vs `/coding/v1` vs trailing slash            |
| `parseDataUrl(url)`               | Data URL regex → `{mimeType, data} \| null`                                               | Valid, missing `;base64,`, non-data URL                |
| `getUploadFilename(mimeType)`     | MIME → filename                                                                           | Known image MIMEs and unknown                          |

#### Layer 2 — pure given injected dependencies

| Function                                          | Contract                                                                                           | Fixture strategy                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transformOpenAIPayloadFiles(payload, upload)`    | Replace inline base64 `image_url` fields with `ms://` refs                                         | Build payload fixture, pass fake `upload = async () => "ms://fake"`, assert mutated payload. Cover: plain data URL, already `ms://`, mime that fails `parseDataUrl`, cache dedup for repeated URLs                                                                                                        |
| `transformAnthropicPayloadFiles(payload, upload)` | Replace base64 `image` blocks (including inside `tool_result`) with `{source: {type: "url", url}}` | Fixture with nested `tool_result.content`, assert recursive replacement + `cache_control` preservation                                                                                                                                                                                                    |
| `applyKimiPayloadMutations(payload, ctx)`         | Apply all payload steps in order                                                                   | Table test per step: (a) developer→system, (a2) Responses empty-text stripping, (b) upload dispatch by `ctx.api`, (b2) inline media budget, (c) cache_key precedence (existing > ctx.cacheKey > nothing), (d) env/config overrides only when set, (e) thinking effort only when the catalog advertises it |

#### Layer 3 — pure stream transformation

| Function                              | Contract                                                                              | Fixture strategy                                                                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filterEmptyResponseStream(upstream)` | Async generator that drops `(Empty response: ...)` text blocks and the related events | Build synthetic `AssistantMessageEvent[]`, wrap as `async function*`, collect output. Cover: legitimate text passes through, empty-response block fully suppressed, mixed stream (one real + one empty), final `done` cleans `message.content` |

#### Layer 4 — integration

The I/O functions are tested end-to-end via `scripts/test_e2e.sh` (see
[TESTING.md](./TESTING.md)). No unit-level tests cover `fetch` wrappers or
OAuth polling loops; the E2E test script exercises them by hitting the real upstream.

### Extension points

These are the knobs the extension reads; a contributor adding a new feature should
thread it through the same boundary — read at the edge in `streamSimpleKimi` or
`uploadKimiFile`, carry the value into pure layers via explicit parameters.

| Env var                                                                            | Read site                                           | Layer        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------- | ------------ |
| `KIMI_API_KEY`                                                                     | `streamSimpleKimi` (also Pi core)                   | Orchestrator |
| `KIMI_CODE_PROTOCOL`                                                               | `PROTOCOL` constant                                 | Module load  |
| `KIMI_CODE_REGION`                                                                 | region capture in `src/constants.ts`                | Module load  |
| `KIMI_CODE_BASE_URL`                                                               | `getBaseUrl` + `uploadKimiFile`                     | I/O edge     |
| `KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST`                                         | `getOAuthHost`                                      | I/O edge     |
| `KIMI_CODE_UPLOAD_THRESHOLD_BYTES`                                                 | `uploadKimiFile` (via `parseInlineUploadThreshold`) | I/O edge     |
| `KIMI_CODE_DEBUG`                                                                  | `uploadKimiFile`                                    | I/O edge     |
| `KIMI_MODEL_TEMPERATURE` / `KIMI_MODEL_TOP_P` / `KIMI_MODEL_MAX_COMPLETION_TOKENS` | `loadKimiCodeConfig` env layer → `streamSimpleKimi` | Orchestrator |
| `KIMI_MODEL_THINKING_KEEP`                                                         | `loadKimiCodeConfig` env layer → `streamSimpleKimi` | Orchestrator |

OAuth behavior is extended via the `oauth` field in `pi.registerProvider`.
Payload mutation is extended by adding a new step to `applyKimiPayloadMutations`
and (if the step needs new inputs) a new field on `KimiPayloadContext`.
New config keys are threaded through `src/config.ts` (schema, sources, patch
type) and surfaced in `src/settings-ui.ts` if they belong in `/kimi-settings`.

## Design Decisions

### Why support both Anthropic and OpenAI wire protocols?

Kimi Code's backend speaks both formats. Different Pi users and downstream tools
prefer different protocols — some want strict Anthropic compatibility for
`cache_control` + thinking blocks, while others need the OpenAI-compatible transport.
Selecting via `KIMI_CODE_PROTOCOL` at module load lets a
single extension cover both audiences without duplication, and the protocol-
specific payload transform lives in its own function
(`transformOpenAIPayloadFiles` / `transformAnthropicPayloadFiles`) behind a
shared `Uploader` interface.

### Why keep a custom `streamSimple` wrapper?

Three reasons:

1. **File upload** — Kimi's `/v1/files` endpoint is not standard Anthropic or
   OpenAI; inline base64 blocks above the upload threshold must be replaced with
   `ms://` references before the SDK sends them.
2. **`prompt_cache_key` injection** — Kimi's Anthropic compatibility endpoint
   requires this proprietary field alongside `cache_control` to actually hit the
   cache.
3. **Empty-response suppression** — Kimi sometimes returns a text block that
   wraps thinking-only output as `(Empty response: ...)`. The wrapper drops
   those blocks so they do not leak internal state to the user.

### Why no build step?

Pi loads extensions via jiti, which transpiles TypeScript on-the-fly. A
zero-build setup reduces friction for both development and distribution.

### Why no dependencies?

`@earendil-works/pi-ai` (for types and SDK streaming) and
`@earendil-works/pi-coding-agent` (for `ExtensionAPI` type) are virtual modules
injected by the Pi runtime. The only Node.js APIs used are built-ins. You don't need to install anything.

### Why a standalone package instead of a core patch?

Keeping provider integrations as extensions avoids coupling third-party OAuth
flows to the core `packages/ai` library. Extensions can be versioned, installed,
and uninstalled independently via `pi install` / `pi uninstall`.

## Usage

```bash
# Load temporarily
pi -e ~/workshop/pi-provider-kimi-code

# Install persistently
pi install ~/workshop/pi-provider-kimi-code

# After npm publish
pi install npm:pi-provider-kimi-code

# Inside Pi:
#   /model kimi-coding/kimi-for-coding
#   /login kimi-coding

# Or use a static API key:
KIMI_API_KEY=sk-... pi -e ~/workshop/pi-provider-kimi-code
```
