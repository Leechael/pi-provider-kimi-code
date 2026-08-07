# Pi extension for Kimi Code

[![npm](https://img.shields.io/npm/v/pi-provider-kimi-code)](https://www.npmjs.com/package/pi-provider-kimi-code)
[![license](https://img.shields.io/npm/l/pi-provider-kimi-code)](./LICENSE)

> **Kimi Code extension for Pi — use K3, K2.7 Code, and HighSpeed models with your Kimi Code Plan.** This extension brings the full Kimi Code surface into Pi: shared OAuth login state with the official `kimi-code` CLI, Kimi Files API uploads, and Kimi-native tools such as `moonshot_search`, `moonshot_fetch`, and `kimi_datasource`. (Pi v0.82.0+ ships a built-in `kimi-coding` provider for the LLM layer; this extension covers everything around it.)

## Why this exists

Use the built-in provider if you only want to chat with Kimi models. Install this extension when you also want the full Kimi Code surface inside Pi:

- **Share a session with the official `kimi-code` CLI.** Reuse an existing `kimi-code` login, or sync Pi's OAuth login back to `kimi-code` so both CLIs stay authenticated.
- **Send files the Kimi way.** Large inline images go through Kimi's Files API and become `ms://` references instead of huge base64 payloads.
- **Use Kimi-native tools.** `moonshot_search`, `moonshot_fetch`, and `kimi_datasource` are opt-in tools that call Moonshot's server-side services.
- **Keep Pi's tools working.** Moonshot's API rejects tool schemas over 15 KB — a limit that Pi's extension ecosystem regularly hits ([#16](https://github.com/Leechael/pi-provider-kimi-code/issues/16), [#21](https://github.com/Leechael/pi-provider-kimi-code/issues/21)). This extension automatically deduplicates schemas with `$ref`/`$defs` before sending, so subagents and other extensions don't break.
- **Embed in your own build.** The `KimiCode()` factory lets you ship Kimi Code support inside a custom Pi agent with programmatic config overrides — no file-based extension path needed.

## What this package adds

- **Credential reuse with `kimi-code`.** Reads `~/.kimi-code/credentials/kimi-code.json` and syncs refreshed OAuth tokens back to it.
- **Kimi account login in Pi.** `/login kimi-coding` stores credentials in `~/.pi/agent/auth.json`; tokens refresh automatically.
- **`KIMI_API_KEY` fallback.** For CI or key-based access.
- **Kimi Files API uploads.** Uploads large inline images and references them as `ms://` instead of inline base64.
- **Optional Kimi-native tools.** `moonshot_search`, `moonshot_fetch`, and `kimi_datasource` via `/kimi-settings`.
- **Tool schema dedup.** Collapses repeated `$ref`/`$defs` structures to stay under Moonshot's 15 KB per-tool limit.
- **Legacy provider registration.** Keeps existing model sessions loading; new users should use Pi's built-in provider.
- **Programmatic `KimiCode()` factory.** Embed Kimi Code in a custom Pi build with config overrides.
- **No build step.** Pi loads the TypeScript extension directly.

## Install

From npm:

```bash
pi install npm:pi-provider-kimi-code
```

Or load a local checkout without installing:

```bash
pi -e /path/to/pi-provider-kimi-code
```

### Install from GitHub Release tarball

If you prefer not to use npm, download the tarball from the [latest release](https://github.com/Leechael/pi-provider-kimi-code/releases/latest), extract it, and install from the local path:

```bash
curl -L https://github.com/Leechael/pi-provider-kimi-code/releases/latest/download/pi-provider-kimi-code.tar.gz | tar -xz -C /tmp
pi install /tmp/pi-provider-kimi-code
```

### Programmatic usage

Use `KimiCode()` to embed Kimi Code as a provider inside a custom Pi build:

```typescript
import { main } from "@earendil-works/pi-coding-agent";
import { KimiCode } from "pi-provider-kimi-code";

main(process.argv.slice(2), {
  extensionFactories: [KimiCode({ protocol: "anthropic" })],
});
```

`KimiCode()` with no arguments behaves identically to the file-based extension. Pass a `KimiCodeConfigPatch` to override defaults (protocol, upload threshold, tools, model parameters). See [docs/programmatic-usage.md](docs/programmatic-usage.md) for the full API.

## Authentication

Pi's built-in `kimi-coding` provider already supports OAuth login via `/login`. This extension handles the credential layer around that login:

- **Syncs refreshed tokens back to `kimi-code`.** Pi stores credentials at `~/.pi/agent/auth.json`; this extension keeps the official CLI's credential file (`~/.kimi-code/credentials/kimi-code.json`) up to date so both stay authenticated.
- **Reuses existing `kimi-code` sessions.** If you already use the official CLI, the extension reads its session directly. Set `KIMI_CODE_HOME` if its home directory lives somewhere else.
- **Supports the legacy `~/.kimi` path.** Read-only. Set `KIMI_SHARE_DIR` to override it.
- **`KIMI_API_KEY` fallback.** For CI or key-based access:

```bash
KIMI_API_KEY=sk-... pi
```

## Models (legacy provider registration)

> **New users:** Use Pi's built-in `kimi-coding` provider for model discovery, reasoning controls, and OAuth login. This extension keeps its own model registration only for backward compatibility with existing sessions.

When this extension does register models, the official catalog determines what it publishes. The following IDs are the fallback set when catalog discovery is unavailable:

| Pi model ID                             | Default name               | Source           |
| --------------------------------------- | -------------------------- | ---------------- |
| `kimi-coding/kimi-for-coding`           | Kimi for Coding            | Official catalog |
| `kimi-coding/kimi-for-coding-highspeed` | Kimi for Coding High Speed | Official catalog |
| `kimi-coding/k3`                        | Kimi K3                    | Official catalog |

Kimi's official catalog at `https://api.kimi.com/coding/v1/models` is authoritative for model availability and context windows. When discovery is unavailable, the extension uses the fallback models and defaults below.

Fallback values:

- Context window: `256k` tokens
- Max output: `32k` tokens
- Input: text and image
- Reasoning: enabled

The provider maps Pi's reasoning levels to Kimi's top-level `thinking` parameter. It sends `thinking.effort` only when the official catalog advertises the mapped value. The mapping refreshes automatically on credential refresh. Opening `/kimi-settings` also re-discovers the latest model metadata.

Switching models or thinking effort invalidates Kimi's existing context cache. Start a new session when switching to avoid re-prefilling a long conversation and consuming extra quota.

## Optional tools

Kimi Code has server-side capabilities that this extension exposes as opt-in tools. All tools are off by default. Enable them individually through `/kimi-settings` or JSON config.

Inside Pi, run:

```text
/kimi-settings
```

That command shows the current server-side model name (e.g. "K2.7 Code High Speed"), your Kimi quota and Extra Usage balance, and lets you edit the home or project config. Changes apply to the active session tool set.

Configurable settings include protocol mode, upload threshold, and per-tool enable/collapse.

Config files are JSON:

- Home: `~/.pi/providers/kimi-coding/config.json`
- Project override: `<cwd>/.pi/providers/kimi-coding/config.json`

Project config overrides home config with a deep merge. Missing files or missing keys mean all tools stay off.

### Available tools

| Tool              | Description                                    |
| ----------------- | ---------------------------------------------- |
| `moonshot_search` | Web search through Kimi's Moonshot service     |
| `moonshot_fetch`  | Web page fetch through Kimi's Moonshot service |
| `kimi_datasource` | Unified Kimi datasource tool                   |

### Example config

```json
{
  "protocol": "openai",
  "uploads": { "thresholdBytes": 1048576 },
  "tools": {
    "moonshot_search": { "enabled": true, "default_collapsed": true },
    "moonshot_fetch": { "enabled": true, "default_collapsed": true },
    "kimi_datasource": { "enabled": true, "default_collapsed": true }
  }
}
```

### Datasource tool

`kimi_datasource` calls Kimi's `/tools` endpoint. It accepts `data_source_name` plus optional `api_name` and `params`:

- Without `api_name`: returns the datasource description (available APIs).
- With `api_name` and `params`: calls the specified API.

Supported datasource names:

| Datasource             | Description                           |
| ---------------------- | ------------------------------------- |
| `stock_finance_data`   | Chinese stock and financial data      |
| `yahoo_finance`        | Yahoo Finance market data             |
| `world_bank_open_data` | World Bank open statistics            |
| `tianyancha`           | Chinese enterprise and corporate data |
| `arxiv`                | Academic paper search and metadata    |
| `scholar`              | Academic literature search            |
| `yuandian_law`         | Chinese legal database and case law   |

### Common notes

All tools require `/login kimi-coding` OAuth credentials. `KIMI_API_KEY` is not used for these tools. Your account also needs access to Moonshot's server-side services; if not, the upstream service can return subscription or whitelist errors.

`default_collapsed` controls only the TUI preview. The full tool result still goes to the model; set it to `false` if you want previews expanded by default.

If you already use another search or fetch tool, pick one path for a session. Overlapping tools can make the model choose the wrong one.

## Common knobs

Most users do not need environment variables. Two are worth knowing:

- `KIMI_API_KEY` — static API key for CI or key-based access.
- `KIMI_CODE_PROTOCOL` — `openai` by default; set to `anthropic` for Anthropic-compatible requests.

Tools, protocol, and upload threshold are all configurable through `/kimi-settings` or JSON config files.

The full env list, including base URL overrides, `kimi-code` path overrides, upload tuning, debug logs, and model metadata overrides, lives in [docs/ENV.md](docs/ENV.md).

## Notes

### Kimi Code vs Pi

`kimi-code` is Moonshot's official terminal agent. Pi is the harness you adapt to your own workflow. Pi's built-in `kimi-coding` provider handles the LLM; this extension adds the rest of the Kimi Code surface to Pi.

### Cache behavior

Kimi's cache is content-based and keyed purely by prompt prefix. `prompt_cache_key`, Anthropic `cache_control` markers, and device-id headers are ignored. Cache benefits accrue within a session, not across cold starts. See [docs/caching.md](docs/caching.md) for measured behavior.

### Protocol modes

Kimi's coding endpoint speaks both Anthropic and OpenAI dialects. This extension defaults to OpenAI-compatible mode (`/coding/v1/chat/completions`) because it uses a dedicated `role: "tool"` message, which keeps tool results separate from user messages in multi-turn loops. Anthropic mode (`/coding/v1/messages`) is available if your setup depends on Anthropic-style semantics. See [issue #5](https://github.com/Leechael/pi-provider-kimi-code/issues/5) for details.

### Is this affiliated with Moonshot AI?

No. This is an independent extension. The login flow is derived from the public implementation in the open-source Kimi Code repository.

## Troubleshooting

### `pi` reports `fetch failed` even though `curl` works

Pi uses Node's `fetch` / undici stack, which handles `http_proxy` / `https_proxy` / `all_proxy` differently from `curl`. Check the proxy variables in the Pi process's environment. `scripts/test_e2e.sh` prints the effective proxy settings for debugging.

### `/login kimi-coding` prints a device code but the browser never opens

The login flow always prints a verification URL. Copy it into a browser manually if your terminal or OS blocks auto-open.

### "Access denied" or subscription errors after a successful login

Your Moonshot account needs an active Kimi Code Plan. If the same account works in `kimi-code`, re-run `/login kimi-coding` to refresh credentials.

### Tools do not show up or return errors

Run `/kimi-settings` and check whether the tool is enabled in the home or project config. All tools require OAuth login; `KIMI_API_KEY` is not enough. Subscription or whitelist errors come from the upstream Moonshot service.

### Large images fail with a payload error

This extension uploads images over `KIMI_CODE_UPLOAD_THRESHOLD_BYTES` (default 1 MB) to Kimi's Files API and references them as `ms://`. Set `KIMI_CODE_DEBUG=1` to see upload decisions in the provider logs.

### Prompt cache never seems to hit

Cache benefits accrue within a single session. If `cache_read_input_tokens` (Anthropic) or `cached_tokens` (OpenAI) stays at `0`, something in the prompt is varying between turns — a changed system prompt, tool set, `ms://` reference, or timestamp. See [docs/caching.md](docs/caching.md) for the full list of invalidation causes and measurement scripts.

### OpenAI-compatible tools complain about a `developer` role

In OpenAI mode this extension maps `developer` to `system` because Kimi's Coding endpoint does not recognize `developer`. Use Anthropic mode if your toolchain expects `developer` to round-trip.

## References

- Pi: [earendil-works/pi](https://github.com/earendil-works/pi)
- Environment variables: [docs/ENV.md](docs/ENV.md)
- Programmatic usage: [docs/programmatic-usage.md](docs/programmatic-usage.md)
- Testing guide: [docs/TESTING.md](docs/TESTING.md)
- Cache behavior: [docs/caching.md](docs/caching.md)
- Architecture notes: [docs/architecture.md](docs/architecture.md)

## License

MIT
