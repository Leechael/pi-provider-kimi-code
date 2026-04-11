# Architecture: pi-provider-kimi-code

A pi custom provider extension that integrates [Kimi Code](https://kimi.com) models
into the pi coding agent via OAuth device-code flow. Supports both Kimi's Anthropic
Messages and OpenAI Chat Completions wire-compatible endpoints.

## Overview

This extension registers a provider named `kimi-coding` that exposes Kimi's coding
models. It supports two authentication modes:

1. **OAuth device-code flow** — interactive browser-based login (`/login kimi-coding`)
2. **Static API key** — set the `KIMI_API_KEY` environment variable

The Kimi Code API is wire-compatible with both the Anthropic Messages and OpenAI Chat
Completions formats. The extension picks which wire protocol to use via the
`KIMI_CODE_PROTOCOL` environment variable (default: `anthropic-messages`). A
`streamSimpleKimi()` wrapper sits on top of pi's built-in streaming to:

- upload inline base64 images (and videos, OpenAI protocol only) to Kimi's `/v1/files` endpoint as `ms://` references
- inject Kimi's proprietary `prompt_cache_key` alongside Anthropic `cache_control`
- apply env-level hyperparameter overrides (`temperature`, `top_p`, `max_tokens`)
- map pi's `reasoning` level to Kimi's `reasoning_effort` + `extra_body.thinking`
- suppress Kimi's `(Empty response: ...)` placeholder text blocks from the response stream

## File Structure

```
pi-provider-kimi-code/
├── .gitignore          # Excludes node_modules/, docs/, etc. from npm
├── package.json        # Extension manifest (pi.extensions field)
├── index.ts            # OAuth + provider registration + stream wrapper
├── docs/
│   ├── architecture.md # This document
│   ├── ENV.md          # Environment variable reference
│   └── TESTING.md      # E2E test runbook
└── scripts/
    ├── test_e2e.sh     # End-to-end test runner
    └── next-version.sh # Release version bump helper
```

The package is intentionally a single-file extension. pi loads `index.ts` directly
via jiti (TypeScript-in-JS runtime), so no build step is required. The virtual modules
`@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` are provided by the pi
runtime; no npm dependencies are needed.

## Provider Registration

The default export is a function that receives `ExtensionAPI` and calls
`pi.registerProvider()`:

```
Provider ID:    kimi-coding
Base URL:       https://api.kimi.com/coding       (anthropic-messages, default)
                https://api.kimi.com/coding/v1    (openai-completions)
API type:       anthropic-messages | openai-completions  (via KIMI_CODE_PROTOCOL)
Env var key:    KIMI_API_KEY
```

The base URL can also be overridden with `KIMI_CODE_BASE_URL`. See
[ENV.md](./ENV.md) for the full list of supported environment variables.

### Common Headers

Every OAuth request and model API request includes Kimi CLI-style headers:

| Header               | Value                               |
| -------------------- | ----------------------------------- |
| `User-Agent`         | `KimiCLI/1.30.0`                    |
| `X-Msh-Platform`     | `kimi_cli`                          |
| `X-Msh-Version`      | `1.30.0`                            |
| `X-Msh-Device-Name`  | Hostname                            |
| `X-Msh-Device-Model` | OS + kernel release + architecture  |
| `X-Msh-Os-Version`   | `os.release()`                      |
| `X-Msh-Device-Id`    | Stable random hex persisted on disk |

Header values are ASCII-sanitized and trimmed before sending, matching the upstream
fix for Linux / non-ASCII hostnames.

### Models

| ID                       | Name                             | Reasoning | Input       | Context | Max Output |
| ------------------------ | -------------------------------- | --------- | ----------- | ------- | ---------- |
| `kimi-code`              | Kimi Code (powered by kimi-k2.5) | yes       | text, image | 262 144 | 32 000     |
| `kimi-k2.5`              | Kimi K2.5                        | yes       | text, image | 262 144 | 32 000     |
| `kimi-k2-thinking-turbo` | Kimi K2 Thinking Turbo           | yes       | text        | 262 144 | 32 000     |

All costs are set to zero (free tier / OAuth-authenticated usage).

## OAuth Device-Code Flow

The login flow follows [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)
(OAuth 2.0 Device Authorization Grant).

### Endpoints

| Purpose              | URL                                                    |
| -------------------- | ------------------------------------------------------ |
| Device authorization | `https://auth.kimi.com/api/oauth/device_authorization` |
| Token exchange       | `https://auth.kimi.com/api/oauth/token`                |

The OAuth host can be overridden with `KIMI_CODE_OAUTH_HOST` or `KIMI_OAUTH_HOST`.

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
2. pi opens the verification URL in the user's browser and displays the user code.
3. `requestDeviceToken()` polls the token endpoint at the server-specified interval
   (default 5 s) until the user completes authorization or the device code expires.
4. On `expired_token`, the outer loop in `loginKimiCode()` automatically restarts the
   entire flow with a fresh device code.
5. On success, credentials (`access_token`, `refresh_token`, `expires`) are persisted
   by pi's credential store.

### Token Refresh

`refreshKimiCodeToken()` sends a `grant_type=refresh_token` request. If the refresh
token itself has expired (401/403), pi will prompt the user to re-login.

## Device Identity

The extension keeps a stable device identifier in:

```text
~/.pi/providers/kimi-coding/device_id
```

This mirrors `kimi-cli` behavior more closely than the earlier per-process random ID,
while keeping storage isolated to pi.

## Credential Mapping

The `oauth.getApiKey` callback extracts the `access` field from stored credentials and
uses it as the `Authorization: Bearer <token>` value for API requests.

```typescript
getApiKey: (cred) => cred.access;
```

## Internals

The sections above describe the public contract. This one is for contributors:
how `index.ts` is layered internally, and where to thread new features so the
tests still cover them.

### Module layout

`index.ts` is organized into layered sections. Each section is marked with a
`// ===` banner comment and has a clearly bounded responsibility.

```
index.ts
├── Constants                       # CLIENT_ID, endpoints, version, paths
├── Device identification           # X-Msh-* header construction, stable device_id
├── OAuth Implementation            # device_authorization / token / refresh fetches
├── OAuth login / refresh wrappers  # loginKimiCode + refreshKimiCodeToken
├── Payload / stream helpers        # types + pure utilities
├── File upload                     # uploadKimiFile (I/O edge)
├── Payload file transformers       # transformOpenAI / transformAnthropic
├── Payload mutation pipeline       # applyKimiPayloadMutations
├── Event stream filter             # filterEmptyResponseStream
├── Stream wrapper                  # streamSimpleKimi (orchestrator)
└── Extension Entry Point           # pi.registerProvider
```

### Purity boundary

Every function belongs to one of four layers. Higher layers can depend on lower
ones; lower layers never reach upward.

```
Layer 1 — Pure                             (no side effects, deterministic)
    isRecord, mapThinkingLevel, parseInlineUploadThreshold, deriveFilesBaseUrl,
    parseDataUrl, getUploadFilename, asciiHeaderValue

Layer 2 — Pure given dependencies           (mutates input, calls injected Uploader)
    transformOpenAIPayloadFiles(payload, upload)
    transformAnthropicPayloadFiles(payload, upload)
    applyKimiPayloadMutations(payload, ctx)

Layer 3 — Pure stream transformation        (async generator, no external closure dependencies)
    filterEmptyResponseStream(upstream)

Layer 4 — I/O edges                         (process.env, fs, network, execSync)
    getOAuthHost / getBaseUrl, readEnvOverrides,
    readPersistedDeviceId / persistDeviceId / ensurePrivateFile,
    getMacOSVersion / getDeviceModel / getStableDeviceId, getCommonHeaders,
    uploadKimiFile,
    requestDeviceAuthorization / requestDeviceToken / refreshAccessToken,
    loginKimiCode / refreshKimiCodeToken,
    streamSimpleKimi  (orchestrator — reads env + options, wires layers 2/3)
```

The key rule: **Layers 1–3 must never touch `process.env`, `fs`, or `fetch`
directly.** Environment values are read at the orchestrator boundary
(`streamSimpleKimi`) and passed down as plain data in `KimiPayloadContext`, so
the middle layers are unit-testable without mocking modules.

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
            │                                   │
            ▼                                   ▼
   applyKimiPayloadMutations(payload, ctx)  filterEmptyResponseStream(upstream)
     1. developer → system role map              │
     2. transform*PayloadFiles(payload, upload)  │  buffer text_start/text_delta,
        (OpenAI or Anthropic)                    │  drop block on "(Empty response:" marker,
           └─> upload(mimeType, data)            │  replace done.message.content with filtered copy
     3. prompt_cache_key injection               │
     4. env overrides                            ▼
     5. reasoning_effort mapping         filtered.push(event)
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

| Function | Contract | Fixture strategy |
|---|---|---|
| `isRecord(value)` | Type guard for plain objects | Boolean assertions over `null`, `[]`, `{}`, primitives |
| `mapThinkingLevel(level)` | `ThinkingLevel` → `{effort, enabled}` | Table test, all 7 levels + `undefined` |
| `parseInlineUploadThreshold(raw)` | `string \| undefined` → bytes | Valid int, empty, `undefined`, negative, non-numeric |
| `deriveFilesBaseUrl(baseUrl)` | Ensure the base URL ends with `/v1` (the `/files` suffix is appended by `uploadKimiFile`) | `/coding` vs `/coding/v1` vs trailing slash |
| `parseDataUrl(url)` | Data URL regex → `{mimeType, data} \| null` | Valid, missing `;base64,`, non-data URL |
| `getUploadFilename(mimeType)` | MIME → filename | Known MIMEs, generic `video/*`, unknown |

#### Layer 2 — pure given injected dependencies

| Function | Contract | Fixture strategy |
|---|---|---|
| `transformOpenAIPayloadFiles(payload, upload)` | Replace inline base64 `image_url` / `video_url` fields with `ms://` refs | Build payload fixture, pass fake `upload = async () => "ms://fake"`, assert mutated payload. Cover: plain data URL, already `ms://`, mime that fails `parseDataUrl`, cache dedup for repeated URLs |
| `transformAnthropicPayloadFiles(payload, upload)` | Replace base64 `image` blocks (including inside `tool_result`) with `{source: {type: "url", url}}` | Fixture with nested `tool_result.content`, assert recursive replacement + `cache_control` preservation |
| `applyKimiPayloadMutations(payload, ctx)` | Apply all 5 steps in order | Table test per step: (a) developer→system, (b) upload dispatch by `ctx.api`, (c) cache_key precedence (existing > ctx.cacheKey > nothing), (d) env overrides only when set, (e) reasoning_effort only when `ctx.reasoning` is set |

#### Layer 3 — pure stream transformation

| Function | Contract | Fixture strategy |
|---|---|---|
| `filterEmptyResponseStream(upstream)` | Async generator that drops `(Empty response: ...)` text blocks and the related events | Build synthetic `AssistantMessageEvent[]`, wrap as `async function*`, collect output. Cover: legitimate text passes through, empty-response block fully suppressed, mixed stream (one real + one empty), final `done` cleans `message.content` |

#### Layer 4 — integration

The I/O functions are tested end-to-end via `scripts/test_e2e.sh` (see
[TESTING.md](./TESTING.md)). There is no unit-level test for `fetch` wrappers or
OAuth polling loops; they are exercised by hitting the real upstream.

### Extension points

These are the knobs the extension reads; a contributor adding a new feature should
thread it through the same boundary — read at the edge in `streamSimpleKimi` or
`uploadKimiFile`, carry the value into pure layers via explicit parameters.

| Env var | Read site | Layer |
|---|---|---|
| `KIMI_API_KEY` | `streamSimpleKimi` (also pi core) | Orchestrator |
| `KIMI_CODE_PROTOCOL` | `PROTOCOL` constant | Module load |
| `KIMI_CODE_BASE_URL` | `getBaseUrl` + `uploadKimiFile` | I/O edge |
| `KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST` | `getOAuthHost` | I/O edge |
| `KIMI_CODE_UPLOAD_THRESHOLD_BYTES` | `uploadKimiFile` (via `parseInlineUploadThreshold`) | I/O edge |
| `KIMI_CODE_DEBUG` | `uploadKimiFile` | I/O edge |
| `KIMI_MODEL_TEMPERATURE` / `KIMI_MODEL_TOP_P` / `KIMI_MODEL_MAX_TOKENS` | `readEnvOverrides` → `streamSimpleKimi` | Orchestrator |

OAuth behavior is extended via the `oauth` field in `pi.registerProvider`.
Payload mutation is extended by adding a new step to `applyKimiPayloadMutations`
and (if the step needs new inputs) a new field on `KimiPayloadContext`.

## Design Decisions

### Why support both Anthropic and OpenAI wire protocols?

Kimi Code's backend speaks both formats. Different pi users and downstream tools
prefer different protocols — some want strict Anthropic compatibility for
`cache_control` + thinking blocks, others need OpenAI's `reasoning_effort` and
`extra_body` semantics. Selecting via `KIMI_CODE_PROTOCOL` at module load lets a
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

pi loads extensions via jiti, which transpiles TypeScript on-the-fly. A
zero-build setup reduces friction for both development and distribution.

### Why no dependencies?

`@mariozechner/pi-ai` (for types and SDK streaming) and
`@mariozechner/pi-coding-agent` (for `ExtensionAPI` type) are virtual modules
injected by the pi runtime. The only Node.js APIs used are built-ins. There is
nothing to install.

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

# Inside pi:
#   /model kimi-coding/kimi-code
#   /login kimi-coding

# Or use a static API key:
KIMI_API_KEY=sk-... pi -e ~/workshop/pi-provider-kimi-code
```
