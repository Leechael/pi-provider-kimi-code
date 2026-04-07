# Architecture: pi-provider-kimi-code

A pi custom provider extension that integrates [Kimi Code](https://kimi.com) models into
the pi coding agent via OAuth device-code flow and the Anthropic Messages API.

## Overview

This extension registers a provider named `kimi-coding` that exposes Kimi's coding
models. It supports two authentication modes:

1. **OAuth device-code flow** — interactive browser-based login (`/login kimi-coding`)
2. **Static API key** — set the `KIMI_API_KEY` environment variable

The Kimi Code API is wire-compatible with the Anthropic Messages format, so the
extension declares `api: "anthropic-messages"` and uses pi's built-in Anthropic
streaming implementation. A thin `streamSimpleKimi()` wrapper filters out Kimi's
`(Empty response: ...)` placeholder text blocks before they reach the user.

## File Structure

```
pi-provider-kimi-code/
├── .gitignore          # Excludes node_modules/, docs/, etc. from npm
├── package.json        # Extension manifest (pi.extensions field)
├── index.ts            # OAuth + provider registration + stream filtering
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

The base URL can also be overridden with `KIMI_CODE_BASE_URL`.

### Common Headers

Every OAuth request and model API request includes Kimi CLI-style headers:

| Header               | Value                               |
| -------------------- | ----------------------------------- |
| `User-Agent`         | `KimiCLI/1.28.0`                    |
| `X-Msh-Platform`     | `kimi_cli`                          |
| `X-Msh-Version`      | `1.28.0`                            |
| `X-Msh-Device-Name`  | Hostname                            |
| `X-Msh-Device-Model` | OS + kernel release + architecture  |
| `X-Msh-Os-Version`   | `os.release()`                      |
| `X-Msh-Device-Id`    | Stable random hex persisted on disk |

Header values are ASCII-sanitized and trimmed before sending, matching the upstream
fix for Linux / non-ASCII hostnames.

### Models

| ID                       | Name                             | Reasoning | Input       | Context | Max Output |
| ------------------------ | -------------------------------- | --------- | ----------- | ------- | ---------- |
| `kimi-code`              | Kimi Code (powered by kimi-k2.5) | yes       | text, image | 262 144 | 32 768     |
| `kimi-k2.5`              | Kimi K2.5                        | yes       | text, image | 262 144 | 32 768     |
| `kimi-k2-thinking-turbo` | Kimi K2 Thinking Turbo           | yes       | text        | 262 144 | 32 768     |

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

## Design Decisions

### Why `anthropic-messages` instead of `openai-completions`?

The Kimi Code API at `https://api.kimi.com/coding` implements the Anthropic Messages
wire format. Using the built-in Anthropic streaming path avoids any custom protocol
implementation.

### Why keep a custom `streamSimple` wrapper?

Kimi sometimes returns a text block that wraps thinking-only output as
`(Empty response: ...)`. The wrapper suppresses those blocks without changing pi's core
Anthropic implementation.

### Why no build step?

pi loads extensions via jiti, which transpiles TypeScript on-the-fly. A zero-build
setup reduces friction for both development and distribution.

### Why no dependencies?

`@mariozechner/pi-ai` (for `OAuthCredentials`, `OAuthLoginCallbacks` types) and
`@mariozechner/pi-coding-agent` (for `ExtensionAPI` type) are virtual modules injected
by the pi runtime. The only Node.js APIs used are built-ins. There is nothing to
install.

### Why a standalone package instead of a core patch?

Keeping provider integrations as extensions avoids coupling third-party OAuth flows to
the core `packages/ai` library. Extensions can be versioned, installed, and
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
#   /model kimi-coding/kimi-code
#   /login kimi-coding

# Or use a static API key:
KIMI_API_KEY=sk-... pi -e ~/workshop/pi-provider-kimi-code
```
