# Pi extension for Kimi Code

[![npm](https://img.shields.io/npm/v/pi-provider-kimi-code)](https://www.npmjs.com/package/pi-provider-kimi-code)
[![license](https://img.shields.io/npm/l/pi-provider-kimi-code)](./LICENSE)

**Use Kimi Code in Pi, with the Kimi parts handled.**

Pi already has a basic `kimi-coding` provider. This extension is for the parts that start to matter once Kimi Code becomes part of your real Pi workflow: account login reuse, file uploads, measured cache behavior, live model metadata, and optional Moonshot search/fetch tools.

## Why this exists

Pi is a small harness you adapt to your own workflow. Kimi CLI is Moonshot's official Kimi Code path. This package sits between them: Kimi Code as a Pi provider, plus the Kimi-specific details that the basic provider keeps simple.

- **Use your Kimi account.** Log in with `/login kimi-coding`, or reuse an existing `kimi-cli` session.
- **Send files the Kimi way.** Large inline images go through Kimi's Files API and become `ms://` references instead of huge base64 payloads.
- **Know what the cache is doing.** Kimi caches by content prefix. This repo measures that behavior instead of pretending `prompt_cache_key` controls it.
- **Use the safer protocol by default.** OpenAI-compatible mode is the default because tool results are less ambiguous there. Anthropic-compatible mode is still available.
- **Turn on Kimi-native tools when you want them.** `moonshot_search` and `moonshot_fetch` are opt-in, configurable per user or per project.

## What this package adds

- Kimi account login in Pi, plus `KIMI_API_KEY` for CI or pay-per-token use.
- `kimi-cli` credential reuse from `~/.kimi/credentials/kimi-code.json`.
- Kimi Files API uploads for large inline images.
- Live model metadata from Kimi at login / refresh time.
- OpenAI-compatible mode by default, Anthropic-compatible mode on request.
- Kimi K2.6 reasoning level mapping for Pi's reasoning controls.
- Stream cleanup for Kimi's thinking-only placeholder text.
- Optional `moonshot_search` and `moonshot_fetch` tools via `/kimi-settings`.
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

## Sign in

Inside Pi, run:

```text
/login kimi-coding
```

A browser tab opens, you sign into your Kimi account, and Pi stores the credential at `~/.pi/agent/auth.json`. Tokens refresh automatically.

If you already use `kimi-cli`, this extension can reuse its credential file:

```text
~/.kimi/credentials/kimi-code.json
```

The file is read-only from this extension's side. Set `KIMI_SHARE_DIR` if your `kimi-cli` share directory lives somewhere else.

For CI or pay-per-token use, set `KIMI_API_KEY` instead:

```bash
KIMI_API_KEY=sk-... pi
```

## Model

This provider publishes one Pi model ID:

```text
kimi-coding/kimi-for-coding
```

Select it inside Pi:

```text
/model kimi-coding/kimi-for-coding
```

Model capabilities (context window, reasoning support, image/video input) are discovered
live from Kimi's `/v1/models` endpoint at provider registration and on OAuth login.
The JSON config provides user-adjustable knobs the server does not report:
`maxTokens`, `reasoningMap`, `thinkingKeep`, and `generation` defaults.

```json
{
  "model": {
    "contextWindow": 262144,
    "maxTokens": 32000,
    "input": ["text", "image"],
    "reasoning": true,
    "reasoningMap": {
      "none":  { "effort": null,     "enabled": false },
      "off":   { "effort": null,     "enabled": false },
      "low":   { "effort": "low",    "enabled": true  },
      "medium":{ "effort": "medium", "enabled": true  },
      "high":  { "effort": "high",   "enabled": true  },
      "xhigh": { "effort": "high",   "enabled": true  }
    },
    "thinkingKeep": "all",
    "generation": {
      "temperature": null,
      "topP": null,
      "maxCompletionTokens": null
    }
  },
  "tools": {
    "moonshot_search": { "enabled": false, "default_collapsed": true },
    "moonshot_fetch":  { "enabled": false, "default_collapsed": true }
  },
  "uploads": { "thresholdBytes": 1048576 },
  "protocol": "openai"
}
```

Edit `~/.pi/pi-provider-kimi-code.json` (home) or `<cwd>/.pi/pi-provider-kimi-code.json`
(project). Project overrides home via deep merge. Restart pi after editing the model
block.

## Optional Moonshot tools

Kimi Coding has server-side search and fetch tools. This extension can expose them to Pi as:

- `moonshot_search`
- `moonshot_fetch`

They are off by default. Turn them on when you want Kimi's own search/fetch path in the agent loop.

Inside Pi, run:

```text
/kimi-settings
```

That command shows your current Kimi usage summary and lets you edit the home or project config. Changes apply to the active session tool set.

Config files are JSON:

- Home: `~/.pi/pi-provider-kimi-code.json`
- Project override: `<cwd>/.pi/pi-provider-kimi-code.json`

Project config overrides home config with a deep merge. Missing files or missing keys mean both tools stay off.

```json
{
  "tools": {
    "moonshot_search": { "enabled": true, "default_collapsed": true },
    "moonshot_fetch": { "enabled": true, "default_collapsed": true }
  }
}
```

Both tools require `/login kimi-coding` OAuth credentials. `KIMI_API_KEY` is not used for these tools. Your account also needs access to Moonshot's server-side search/fetch services; if not, the upstream service can return subscription or whitelist errors.

`default_collapsed` controls only the TUI preview. The full tool result still goes to the model; set it to `false` if you want previews expanded by default.

If you already use another search or fetch tool, pick one path for a session. Overlapping tools can make the model choose the wrong one.

## Configuration

All model knobs (context window, max tokens, reasoning map, thinking keep, generation
defaults) live in the JSON config file, not environment variables. The `KIMI_MODEL_*`
env vars from earlier versions are ignored.

Two env vars cover the common cases:

- `KIMI_API_KEY` — static API key for CI or pay-per-token use.
- `KIMI_CODE_PROTOCOL` — `openai` by default; set to `anthropic` if your Pi setup needs Anthropic-compatible requests.

Moonshot search/fetch tools are configured through `/kimi-settings` or JSON config files, not env vars.

The full env list, including base URL overrides, `kimi-cli` path overrides, upload tuning,
debug logs, and model metadata overrides, lives in [docs/ENV.md](docs/ENV.md).

## Notes

### Kimi CLI vs Pi

`kimi-cli` is Moonshot's official terminal agent. Pi is the harness you adapt to your own workflow: extensions, skills, prompts, themes, custom commands, status bars, and UI pieces. This package lets you keep Kimi Code as the model path while staying inside Pi.

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

No. This is an independent extension. The login flow is derived from the public implementation in the open-source [`kimi-cli`](https://github.com/MoonshotAI/kimi-cli) repository.

## Troubleshooting

### `pi` reports `fetch failed` even though `curl` works

Pi runs on Node's `fetch` / undici stack, which handles `http_proxy` / `https_proxy` / `all_proxy` differently from `curl`. Verify those variables in the Pi process's environment. The bundled smoke-test script `scripts/test_e2e.sh` prints the effective proxy-related environment for easier debugging.

### `/login kimi-coding` prints a device code but the browser never opens

The login flow always prints a verification URL. If your terminal or OS blocks auto-open, copy the URL and paste it into a browser manually.

### "Access denied" or subscription errors after a successful login

Your Moonshot account needs an active Kimi Code subscription for the provider to do anything useful. If the same account works in `kimi-cli`, re-run `/login kimi-coding` to refresh credentials.

### Moonshot tools do not show up

Run `/kimi-settings` and check whether `moonshot_search` / `moonshot_fetch` are enabled in the home or project config. These tools also require `/login kimi-coding`; `KIMI_API_KEY` is not enough.

If you changed the JSON config by hand, reload it through `/kimi-settings` or start a new Pi session.

### Moonshot tools return subscription or whitelist errors

The tools call Moonshot's server-side search/fetch services. Some accounts may not have access even with an active Kimi Code Plan. The error comes from the upstream service.

### Large images fail with a payload error

This extension uploads images over `KIMI_CODE_UPLOAD_THRESHOLD_BYTES` (default 1 MB) to Kimi's Files API and references them as `ms://`. Set `KIMI_CODE_DEBUG=1` to see upload decisions in the provider logs.

### Prompt cache never seems to hit

Kimi's cache is **content-based**: it fires automatically when your prompt prefix matches an earlier request, independent of any explicit cache key. If `cache_read_input_tokens` (Anthropic) or `cached_tokens` (OpenAI) stays at `0` across calls, something in the prompt is varying between turns. The usual suspects:

- On the Anthropic-compat endpoint, the `system` prompt or the `tools` array changed (e.g. an extension changed the tool set mid-session). Either fully invalidates the cache — see [docs/caching.md](docs/caching.md), Finding 11. OpenAI-compat endpoint not yet measured for this scenario.
- An `image_url` reference (`ms://<file_id>`) changed between turns. Same rule — see Finding 17.
- You're comparing across two cold `pi` invocations, not within a single session. Cache benefits accrue **within** a session; Pi's system/tools assembly drifts between sessions. See Finding 18.
- A timestamp, request ID, or randomized header is being interpolated into the prompt.
- The first ~256 tokens of the prompt differ between turns.

`PI_CACHE_RETENTION=none` skips `prompt_cache_key` injection but **does not** disable Kimi's caching (the cache is unconditional). For deterministic measurement, run `scripts/test_e2e.sh` with `KIMI_E2E_ONLY_CACHE=1`. See [docs/caching.md](docs/caching.md) for full mechanics.

### OpenAI-compatible tools complain about a `developer` role

In OpenAI mode this extension maps the `developer` role to `system` (Kimi's Coding endpoint does not recognize `developer`). If something in your toolchain expects `developer` to round-trip, use Anthropic mode instead.

## References

- Pi: [earendil-works/pi](https://github.com/earendil-works/pi)
- Upstream login implementation and feature request: [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) · [kimi-cli#757](https://github.com/MoonshotAI/kimi-cli/issues/757)
- Environment variables: [docs/ENV.md](docs/ENV.md)
- Testing guide: [docs/TESTING.md](docs/TESTING.md)
- Cache behavior: [docs/caching.md](docs/caching.md)
- Architecture notes: [docs/architecture.md](docs/architecture.md)

## Credits

Based on the login implementation from [`kimi-cli`](https://github.com/MoonshotAI/kimi-cli) by Moonshot AI. Built as a Pi extension by [@badlogic](https://github.com/badlogic).

## License

MIT
