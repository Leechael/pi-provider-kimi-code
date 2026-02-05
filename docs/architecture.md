# Architecture: pi-provider-kimi-code

A pi custom provider extension that integrates [Kimi Code](https://kimi.com) models into
the pi coding agent via OAuth device-code flow and the Anthropic Messages API.

## Overview

This extension registers a provider named `kimi-coding` that exposes Kimi's coding
models. It supports two authentication modes:

1. **OAuth device-code flow** — interactive browser-based login (`/login kimi-coding`)
2. **Static API key** — set the `KIMI_API_KEY` environment variable

The Kimi Code API is wire-compatible with the Anthropic Messages format, so the
extension declares `api: "anthropic-messages"` and relies entirely on pi's built-in
Anthropic streaming implementation. No custom `streamSimple` is needed.

## File Structure

```
pi-provider-kimi-code/
├── .gitignore          # Excludes node_modules/, docs/, etc. from npm
├── package.json        # Extension manifest (pi.extensions field)
├── index.ts            # Sole source file: OAuth + registerProvider
└── docs/
    └── architecture.md # This document
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
Base URL:       https://api.kimi.com/coding
API type:       anthropic-messages
Env var key:    KIMI_API_KEY
```

### Static Headers

Every API request includes:

| Header           | Value                            |
|------------------|----------------------------------|
| `User-Agent`     | `kimi-cli/1.0.0 (external, cli)` |
| `X-Msh-Platform` | `kimi_cli`                       |

These are declared in the `headers` field of the provider config and are applied
automatically by pi's HTTP layer.

### Models

| ID                  | Name              | Reasoning | Input          | Context  | Max Output |
|---------------------|-------------------|-----------|----------------|----------|------------|
| `kimi-k2-thinking`  | Kimi K2 Thinking  | yes       | text           | 262 144  | 32 768     |
| `k2p5`              | Kimi K2.5         | yes       | text, image    | 262 144  | 32 768     |

All costs are set to zero (free tier / OAuth-authenticated usage).

## OAuth Device-Code Flow

The login flow follows [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)
(OAuth 2.0 Device Authorization Grant).

### Endpoints

| Purpose              | URL                                              |
|----------------------|--------------------------------------------------|
| Device authorization | `https://auth.kimi.com/api/oauth/device_authorization` |
| Token exchange       | `https://auth.kimi.com/api/oauth/token`          |

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

1. `requestDeviceAuthorization()` — POSTs to the device authorization endpoint with
   `client_id`. Returns a `user_code`, `device_code`, and `verification_uri_complete`.
2. pi opens the verification URL in the user's browser and displays the user code.
3. `requestDeviceToken()` — Polls the token endpoint at the server-specified interval
   (default 5 s) until the user completes authorization or the device code expires.
4. On `expired_token`, the outer loop in `loginKimiCode()` automatically restarts the
   entire flow with a fresh device code.
5. On success, credentials (`access_token`, `refresh_token`, `expires`) are persisted
   by pi's credential store.

### Token Refresh

`refreshKimiCodeToken()` sends a `grant_type=refresh_token` request. If the refresh
token itself has expired (401/403), pi will prompt the user to re-login.

### OAuth Request Headers

OAuth endpoint requests include additional device-identification headers beyond the
static API headers:

| Header               | Value                                |
|----------------------|--------------------------------------|
| `X-Msh-Device-Model` | e.g. `macOS arm64`, `Windows x64`   |
| `X-Msh-Device-Id`    | Stable random hex (generated once per process) |

These are produced by `getCommonHeaders()` and are only used for OAuth requests, not
for model API calls.

## Credential Mapping

The `oauth.getApiKey` callback extracts the `access` field from stored credentials and
uses it as the `Authorization: Bearer <token>` value for API requests.

```typescript
getApiKey: (cred) => cred.access
```

## Design Decisions

### Why `anthropic-messages` instead of `openai-completions`?

The Kimi Code API at `https://api.kimi.com/coding` implements the Anthropic Messages
wire format. Using the built-in Anthropic streaming path avoids any custom stream
parsing.

### Why no build step?

pi loads extensions via jiti, which transpiles TypeScript on-the-fly. A zero-build
setup reduces friction for both development and distribution.

### Why no dependencies?

`@mariozechner/pi-ai` (for `OAuthCredentials`, `OAuthLoginCallbacks` types) and
`@mariozechner/pi-coding-agent` (for `ExtensionAPI` type) are virtual modules injected
by the pi runtime. The only Node.js API used is `crypto.randomBytes`, which is a
built-in. There is nothing to install.

### Why a standalone package instead of a core patch?

Keeping provider integrations as extensions avoids coupling third-party OAuth flows
to the core `packages/ai` library. Extensions can be versioned, installed, and
uninstalled independently via `pi install` / `pi uninstall`.

## Usage

```bash
# Load temporarily
pi -e ~/workshop/pi-provider-kimi-code

# Install persistently
pi install ~/workshop/pi-provider-kimi-code

# After npm publish
pi install npm:pi-provider-kimi-code

# Inside pi:
#   /model             — should list kimi-coding/kimi-k2-thinking, kimi-coding/k2p5
#   /login kimi-coding — triggers device-code OAuth flow

# Or use a static API key:
KIMI_API_KEY=sk-... pi -e ~/workshop/pi-provider-kimi-code
```
