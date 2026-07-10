# Pi extension for Kimi Code

[![npm](https://img.shields.io/npm/v/pi-provider-kimi-code)](https://www.npmjs.com/package/pi-provider-kimi-code)
[![license](https://img.shields.io/npm/l/pi-provider-kimi-code)](./LICENSE)

**Use Kimi Code in Pi, with the Kimi parts handled.**

Pi already has a basic `kimi-coding` provider. This extension is for the parts that start to matter once Kimi Code becomes part of your real Pi workflow: account login reuse, file uploads, tool schema compatibility, live model metadata, measured cache behavior, and API-tested parameter handling.

> **Kimi K2.7 supported.** The provider automatically discovers the current model from Kimi's `/v1/models` endpoint at login, refresh, and `/kimi-settings` time, so new rollouts (including K2.7) are picked up immediately without a package update.

## Why this exists

Pi is a small harness you adapt to your own workflow. Kimi Code is Moonshot's official coding agent. This package sits between them: Kimi Code as a Pi provider, plus the Kimi-specific details that the basic provider keeps simple.

Kimi's API surface goes beyond the LLM itself. It includes file uploads, web search, page fetch, and a growing set of datasource APIs. This extension wires those capabilities into Pi so you can use them alongside the community's existing extensions — MCP servers, custom themes, skills, and any other Pi add-on — without leaving the harness.

- **Use your Kimi account.** Log in with `/login kimi-coding`, or reuse an existing `kimi-code` session.
- **Send files the Kimi way.** Large inline images go through Kimi's Files API and become `ms://` references instead of huge base64 payloads.
- **Know what the cache is doing.** Kimi caches by content prefix. This repo measures that behavior instead of pretending `prompt_cache_key` controls it.
- **Keep Pi's tools working.** Moonshot's API rejects tool schemas over 15 KB — a limit that Pi's extension ecosystem regularly hits ([#16](https://github.com/Leechael/pi-provider-kimi-code/issues/16), [#21](https://github.com/Leechael/pi-provider-kimi-code/issues/21)). This extension automatically deduplicates schemas with `$ref`/`$defs` before sending, so subagents and other extensions don't break.
- **Tested against the live API.** Thinking config, parameter constraints, protocol compatibility, and streaming behavior are all verified against Kimi's Coding endpoint — not assumed from docs. When the API rejects something (wrong `temperature`, unsupported `tool_choice`), the provider strips it before you see a 400.
- **Turn on Kimi-native tools when you want them.** `moonshot_search`, `moonshot_fetch`, and `kimi_datasource` are opt-in, configurable per user or per project.
- **Embed in your own build.** `KimiCode()` factory lets you ship Kimi Code support inside a custom Pi agent with programmatic config overrides — no file-based extension path needed.

## What this package adds

- Kimi account login in Pi, plus `KIMI_API_KEY` for CI or pay-per-token use.
- `kimi-code` credential reuse from `~/.kimi/credentials/kimi-code.json`.
- Kimi Files API uploads for large inline images.
- Live model metadata from Kimi at login, refresh, and `/kimi-settings` time.
- OpenAI-compatible mode by default, Anthropic-compatible mode on request.
- Kimi K2.7 reasoning level mapping for Pi's reasoning controls.
- Tool schema dedup to stay under Moonshot's 15 KB per-tool-schema limit.
- K2.7 parameter guard: strips `temperature`, `top_p`, and `tool_choice` values that the API rejects.
- Stream cleanup for Kimi's thinking-only placeholder text.
- Optional `moonshot_search`, `moonshot_fetch`, and unified datasource `kimi_datasource` tools via `/kimi-settings`.
- Programmatic `KimiCode()` factory for embedding in custom Pi builds.
- No build step; Pi loads the TypeScript extension directly.

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

## Sign in

Inside Pi, run:

```text
/login kimi-coding
```

A browser tab opens, you sign into your Kimi account, and Pi stores the credential at `~/.pi/agent/auth.json`. Tokens refresh automatically.

If you already use `kimi-code`, this extension can reuse its credential file:

```text
~/.kimi/credentials/kimi-code.json
```

The file is read-only from this extension's side. Set `KIMI_SHARE_DIR` if your `kimi-code` share directory lives somewhere else.

For CI or pay-per-token use, set `KIMI_API_KEY` instead:

```bash
KIMI_API_KEY=sk-... pi
```

## Model

This provider publishes two Pi model IDs:

```text
kimi-coding/kimi-for-coding
kimi-coding/kimi-for-coding-highspeed
```

Select standard or highspeed mode inside Pi:

```text
/model kimi-coding/kimi-for-coding
/model kimi-coding/kimi-for-coding-highspeed
```

Kimi keeps Coding models behind aliases. Rather than hardcoding a stale model list, this extension asks Kimi for the current model info when you log in or refresh. If your account is on a newer rollout (e.g., Kimi K2.7) or internal test, Pi can pick up the latest model name and context size without waiting for a package release.

Fallback values:

- Context window: `256k` tokens
- Max output: `32k` tokens
- Input: text and image
- Reasoning: enabled

The provider maps Pi's reasoning levels to Kimi's top-level `thinking` parameter. It sends `thinking.effort` only when `/models` advertises supported effort values. The mapping refreshes automatically on credential refresh. Opening `/kimi-settings` also re-discovers the latest model metadata.

## Optional tools

Kimi Coding has server-side capabilities that this extension can expose as opt-in tools. All tools are off by default. Enable them individually through `/kimi-settings` or JSON config.

Inside Pi, run:

```text
/kimi-settings
```

That command shows the current server-side model name (e.g. "K2.7 Code High Speed"), your Kimi usage summary, and lets you edit the home or project config. Changes apply to the active session tool set.

Configurable settings include protocol mode, upload threshold, and per-tool enable/collapse.

Config files are JSON:

- Home: `~/.pi/pi-provider-kimi-code.json`
- Project override: `<cwd>/.pi/pi-provider-kimi-code.json`

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

- `KIMI_API_KEY` — static API key for CI or pay-per-token use.
- `KIMI_CODE_PROTOCOL` — `openai` by default; set to `anthropic` if your Pi setup needs Anthropic-compatible requests. Can also be set through `/kimi-settings` or JSON config.

Tools, protocol, and upload threshold are all configurable through `/kimi-settings` or JSON config files.

The full env list, including base URL overrides, `kimi-code` path overrides, upload tuning, debug logs, and model metadata overrides, lives in [docs/ENV.md](docs/ENV.md).

## Notes

### Kimi Code vs Pi

`kimi-code` is Moonshot's official terminal agent. Pi is the harness you adapt to your own workflow: extensions, skills, prompts, themes, custom commands, status bars, and UI pieces. This package lets you keep Kimi Code as the model path while staying inside Pi.

### Cache behavior

Kimi's cache is content-based. It fires automatically when your prompt prefix matches an earlier request. `prompt_cache_key`, Anthropic `cache_control` markers, and identifying headers like `X-Msh-Device-Id` are all ignored for cache decisions — cache is keyed purely by prompt content and is shared across machines, agent forks, and device-id rotations on the same Kimi account.

See [docs/caching.md](docs/caching.md) for the measured behavior: TTL, cross-protocol cache reuse, 256-token prefix alignment, device-id sharing, and the cases that invalidate cache.

### Protocol modes

Kimi's coding endpoint speaks both Anthropic and OpenAI dialects. This extension defaults to OpenAI-compatible mode.

`KIMI_CODE_PROTOCOL` supports:

- `openai` — default, uses `/coding/v1/chat/completions`
- `anthropic` — uses `/coding/v1/messages`

Use Anthropic mode if your Pi setup depends on Anthropic-style request or tool semantics.

### Why OpenAI-compatible mode is the default

The Anthropic-compatible protocol has an awkward tool-result shape: tool output is wrapped inside a `role: "user"` message. That is valid Anthropic format, but Kimi can sometimes read it like a real user message and continue from the wrong premise in multi-turn tool loops.

The OpenAI-compatible protocol uses a dedicated `role: "tool"` message, so the boundary is clearer. That is why this extension now defaults to `openai`. The Anthropic path stays available for setups that need it. See [issue #5](https://github.com/Leechael/pi-provider-kimi-code/issues/5) for details.

### Is this affiliated with Moonshot AI?

No. This is an independent extension. The login flow is derived from the public implementation in the open-source Kimi Code repository.

## Troubleshooting

### `pi` reports `fetch failed` even though `curl` works

Pi runs on Node's `fetch` / undici stack, which handles `http_proxy` / `https_proxy` / `all_proxy` differently from `curl`. Verify those variables in the Pi process's environment. The bundled smoke-test script `scripts/test_e2e.sh` prints the effective proxy-related environment for easier debugging.

### `/login kimi-coding` prints a device code but the browser never opens

The login flow always prints a verification URL. If your terminal or OS blocks auto-open, copy the URL and paste it into a browser manually.

### "Access denied" or subscription errors after a successful login

Your Moonshot account needs an active Kimi Code Plan for the provider to do anything useful. If the same account works in `kimi-code`, re-run `/login kimi-coding` to refresh credentials.

### Tools do not show up

Run `/kimi-settings` and check whether the tool is enabled in the home or project config. All tools also require `/login kimi-coding`; `KIMI_API_KEY` is not enough.

If you changed the JSON config by hand, reload it through `/kimi-settings` or start a new Pi session.

### Tools return subscription or whitelist errors

The tools call Moonshot's server-side services. Some accounts may not have access even with an active Kimi Code Plan. The error comes from the upstream service.

### Large images fail with a payload error

This extension uploads images over `KIMI_CODE_UPLOAD_THRESHOLD_BYTES` (default 1 MB) to Kimi's Files API and references them as `ms://`. Set `KIMI_CODE_DEBUG=1` to see upload decisions in the provider logs.

### Prompt cache never seems to hit

Kimi's cache is **content-based**: it fires automatically when your prompt prefix matches an earlier request, independent of any explicit cache key. If `cache_read_input_tokens` (Anthropic) or `cached_tokens` (OpenAI) stays at `0` across calls, something in the prompt is varying between turns. The usual suspects:

- On the Anthropic-compat endpoint, the `system` prompt or the `tools` array changed (e.g. an extension changed the tool set mid-session). Either fully invalidates the cache — see [docs/caching.md](docs/caching.md), Finding 11. OpenAI-compat endpoint not yet measured for this scenario.
- An `image_url` reference (`ms://<file_id>`) changed between turns. Same rule — see Finding 17.
- You're comparing across two cold `pi` invocations, not within a single session. Cache benefits accrue **within** a session; Pi's system/tools assembly drifts between sessions. See Finding 18.
- A timestamp, request ID, or randomized header is being interpolated into the prompt.
- The first ~256 tokens of the prompt differ between turns.

`PI_CACHE_RETENTION=none` skips `prompt_cache_key` injection but **does not** disable Kimi's caching (the cache is unconditional). For deterministic measurement, run a focused suite under `scripts/e2e/cache/`, starting with `scripts/e2e/cache/ttl.sh`. See [docs/caching.md](docs/caching.md) for full mechanics.

### OpenAI-compatible tools complain about a `developer` role

In OpenAI mode this extension maps the `developer` role to `system` (Kimi's Coding endpoint does not recognize `developer`). If something in your toolchain expects `developer` to round-trip, use Anthropic mode instead.

## References

- Pi: [earendil-works/pi](https://github.com/earendil-works/pi)
- Environment variables: [docs/ENV.md](docs/ENV.md)
- Programmatic usage: [docs/programmatic-usage.md](docs/programmatic-usage.md)
- Testing guide: [docs/TESTING.md](docs/TESTING.md)
- Cache behavior: [docs/caching.md](docs/caching.md)
- Architecture notes: [docs/architecture.md](docs/architecture.md)

## Credits

Based on the login implementation from Kimi Code by Moonshot AI. Built as a Pi extension by [@badlogic](https://github.com/badlogic).

## License

MIT
