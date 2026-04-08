# pi-provider-kimi-code

[![npm](https://img.shields.io/npm/v/pi-provider-kimi-code)](https://www.npmjs.com/package/pi-provider-kimi-code)

A [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) custom provider extension that adds [Kimi Code](https://kimi.com) models with OAuth device-code login.

## Install

```bash
pi install npm:pi-provider-kimi-code
```

Or load without installing:

```bash
pi -e /path/to/pi-provider-kimi-code
```

## Authentication

### OAuth (recommended)

Inside pi, run:

```
/login kimi-coding
```

This starts the device-code flow — a browser window opens, you authorize, and credentials are stored automatically.

### API Key

Set the `KIMI_API_KEY` environment variable:

```bash
KIMI_API_KEY=sk-... pi
```

## Models

| ID                       | Name                             | Reasoning | Input       | Context | Max Output |
| ------------------------ | -------------------------------- | --------- | ----------- | ------- | ---------- |
| `kimi-code`              | Kimi Code (powered by kimi-k2.5) | yes       | text, image | 262 144 | 32 000     |
| `kimi-k2.5`              | Kimi K2.5                        | yes       | text, image | 262 144 | 32 000     |
| `kimi-k2-thinking-turbo` | Kimi K2 Thinking Turbo           | yes       | text        | 262 144 | 32 000     |

Select a model inside pi:

```
/model kimi-coding/kimi-code
```

## Environment Overrides

- `KIMI_CODE_BASE_URL` — override the default API base URL (default depends on protocol; see below)
- `KIMI_CODE_OAUTH_HOST` — override the OAuth host
- `KIMI_OAUTH_HOST` — fallback OAuth host override for compatibility
- `KIMI_CODE_PROTOCOL` — choose protocol mode:
  - unset / `anthropic` → `anthropic-messages` via `/coding/v1/messages`
  - `openai` → `openai-completions` via `/coding/v1/chat/completions`
- `KIMI_MODEL_TEMPERATURE` — force temperature on outbound requests
- `KIMI_MODEL_TOP_P` — force top-p on outbound requests
- `KIMI_MODEL_MAX_TOKENS` — force max tokens on outbound requests
- `KIMI_CODE_DEBUG=1` — print provider-side debug logs (request metadata, file upload logs)

## Prompt Caching

Kimi Code API supports prompt caching via a "dual-lock" mechanism that combines Anthropic's `cache_control` blocks with a proprietary `prompt_cache_key` at the payload root. This provider automatically bridges the gap:

1. **Automatic Context Caching**: The underlying `@mariozechner/pi-ai` framework injects standard `cache_control: { type: "ephemeral" }` markers into your prompt.
2. **Session Persistence**: This extension automatically extracts your current pi `sessionId` and injects it as the `prompt_cache_key`.
3. **TTL (Time-To-Live)**: In manual probes, cache hits were observed up to ~600s (10 min) after warmup and expired by ~900s. Note that `KIMI_E2E_CACHE_INTERVALS` are cumulative sleep durations between probes, not absolute offsets from warmup. Use `KIMI_E2E_ONLY_CACHE=1` with custom intervals to measure TTL in your environment.
4. **Manual Override**: You can override the cache key explicitly with `payload.prompt_cache_key` or `options.prompt_cache_key`; otherwise the provider falls back to pi's stable `sessionId`.

Note: cache usage is easiest to verify on the Anthropic-compatible endpoint because it returns explicit `cache_read_input_tokens` / `cache_creation_input_tokens` fields.

## OpenAI Compatibility Mode

Set `KIMI_CODE_PROTOCOL=openai` to switch the provider to Kimi Coding's OpenAI-compatible chat completions endpoint. Internally this extension uses `openai-completions` (not `openai-responses`) and applies Kimi-specific compatibility overrides:

- maps `developer` role to `system` (Kimi does not support the OpenAI `developer` role)
- disables `store`
- uses `max_tokens`
- still sends Kimi CLI style `X-Msh-*` agent headers required by the Coding endpoint

## End-to-End Test Script

This repo includes a tracked smoke-test script:

```bash
KIMI_API_KEY=sk-... ./test_e2e.sh
```

By default it explicitly targets `--model kimi-coding/kimi-code`, disables extension discovery with `-ne`, and turns on provider debug logging.

What it does:

1. Runs a `pi -ne -e <extension-dir>` smoke test in Anthropic mode.
2. Runs the same smoke test in OpenAI mode.
3. Runs a high-thinking smoke test (saves full JSONL, extracts thinking + answer + usage).
4. Runs a prompt-cache TTL probe and prints a conclusion on observed cache lifetime.
5. Uploads a watermarked image to `/files`, then asks the model to read back the watermark via `ms://` reference.
6. Sends a `prompt_cache_key` request directly to verify cache key injection.

Useful environment variables for the test script:

| Variable                   | Default                 | Description                             |
| -------------------------- | ----------------------- | --------------------------------------- |
| `KIMI_API_KEY`             | (required)              | API key (or pass as positional arg)     |
| `KIMI_CODE_DEBUG`          | `1`                     | Provider debug logs                     |
| `KIMI_E2E_VERBOSE`         | `1`                     | Command and environment diagnostics     |
| `KIMI_E2E_MODEL`           | `kimi-coding/kimi-code` | Model for `pi` smoke tests              |
| `KIMI_E2E_CACHE_INTERVALS` | `60,300`                | Cache probe sleeps in seconds           |
| `KIMI_E2E_CACHE_KEY`       | auto                    | Override cache key for TTL probe        |
| `KIMI_E2E_CACHE_REPEAT`    | `2000`                  | Long-text repeat count for cache warmup |
| `KIMI_E2E_SKIP_CACHE`      | `0`                     | Set `1` to skip the cache TTL phase     |
| `KIMI_E2E_ONLY_CACHE`      | `0`                     | Set `1` to run only the cache TTL test  |

### Proxy / networking note

If `curl` can reach Kimi but `pi` reports `fetch failed`, check your `http_proxy` / `https_proxy` / `all_proxy` environment. `pi` runs on Node's `fetch` / undici stack, which may behave differently from `curl`; the test script prints the effective proxy-related environment for easier debugging.

## How It Works

- Registers provider `kimi-coding` with base URL `https://api.kimi.com/coding`
- Supports two protocol modes:
  - `anthropic-messages` (default)
  - `openai-completions` when `KIMI_CODE_PROTOCOL=openai`
- Adds a small `streamSimple` wrapper to suppress Kimi's leaked `(Empty response: ...)` placeholder blocks
- Injects `prompt_cache_key` automatically so Kimi's cache works with pi sessions
- Maps pi thinking levels to Kimi-native `reasoning_effort` + `extra_body.thinking`
- Pre-uploads large image / video attachments to Kimi Files API (returns `ms://` references)
- Maps `developer` role to `system` for OpenAI protocol compatibility
- Sends the same `KimiCLI/1.30.0` + `X-Msh-*` headers as current `kimi-cli`
- Persists a stable device ID at `~/.pi/providers/kimi-coding/device_id`
- OAuth uses [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628) device authorization grant against `https://auth.kimi.com`
- Zero dependencies — types from `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` are provided by the pi runtime
- Zero build step — pi loads TypeScript directly via jiti

## Credits

This extension is based on the OAuth implementation from [kimi-cli](https://github.com/MoonshotAI/kimi-cli) by Moonshot AI.

## License

MIT
