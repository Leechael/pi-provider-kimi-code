# Pi extension for Kimi Code
[![npm](https://img.shields.io/npm/v/pi-provider-kimi-code)](https://www.npmjs.com/package/pi-provider-kimi-code)
[![license](https://img.shields.io/npm/l/pi-provider-kimi-code)](./LICENSE)

**Reuse your [Kimi Code Plan](https://www.kimi.com/code/docs/en/) inside [pi-coding-agent](https://pi.dev/)** — no separate API credits, no second billing dashboard. Every request draws from your Kimi Code membership quota (the 5-hour token bucket) instead of billing per-token on the Moonshot Open Platform.

It's **"Claude Code for Kimi"** — log in with your Kimi account, with `KIMI_API_KEY` still supported as a fallback for CI. You get `kimi-for-coding` (the Kimi-k2.6 latest alias, backed by the same Kimi Code Plan that covers K2.6 and K2.5) with a 262K-token context window, automatic prompt caching, automatic large-image and video upload, and compatibility with both Anthropic-style and OpenAI-style clients.

## Who is this for?

- You already pay for a **[Kimi Code Plan](https://www.kimi.com/code/docs/en/)** and want to use it inside `pi-coding-agent` instead of the official `kimi-cli` — see [MoonshotAI/kimi-cli#757](https://github.com/MoonshotAI/kimi-cli/issues/757) for the canonical feature request this extension answers.
- You want **"Claude Code for Kimi"**: log in with your Kimi account instead of buying separate API credits. (`KIMI_API_KEY` is also supported as a fallback for CI.)
- You're in the [pi / pi-mono](https://github.com/badlogic/pi-mono) ecosystem and want **Kimi K2.6** (and the K2.5 coverage that comes with the Code Plan) as a pi provider.

Pay-per-token via `KIMI_API_KEY` also works if you just want to try Kimi in CI or without a subscription.

## Features

- **Browser login with your Kimi account** — reuse your Kimi Code Membership without buying separate API credits. Credentials are stored locally and refreshed automatically. `KIMI_API_KEY` is also accepted for pay-per-token or CI use.
- **262K-token context window** on all registered models.
- **Automatic prompt caching** — binds Kimi's prompt cache to your pi session so repeated calls hit the cache cheaply (observed TTL ~5-10 minutes). Honors pi's `PI_CACHE_RETENTION=none` if you want to disable caching entirely.
- **Automatic large-image and video upload** — images over 1 MB and all videos are uploaded to Kimi ahead of time, so you don't hit inline payload limits.
- **Works with both Anthropic- and OpenAI-compatible modes** — use whichever one your pi setup expects.
- **Stream cleaning** — Kimi occasionally leaks placeholder blocks into the stream during thinking phases; this extension catches and hides them so your pi UI stays clean.
- **Zero dependencies, zero build step** — the extension loads directly as TypeScript, nothing to compile.

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
# Download and extract
curl -L https://github.com/Leechael/pi-provider-kimi-code/releases/latest/download/pi-provider-kimi-code.tar.gz | tar -xz -C /tmp

# Install from the extracted directory
pi install /tmp/pi-provider-kimi-code
```

## Authentication

### Browser login (recommended)

Inside `pi`, run:

```
/login kimi-coding
```

A browser tab opens, you sign into your Kimi account, and credentials are stored at `~/.pi/agent/auth.json`. Tokens refresh automatically.

### API key

For CI or pay-per-token use, set `KIMI_API_KEY`:

```bash
KIMI_API_KEY=sk-... pi
```

## Models

| ID                | Name            | Reasoning | Input              | Context | Max Output |
| ----------------- | --------------- | --------- | ------------------ | ------- | ---------- |
| `kimi-for-coding` | Kimi for Coding | yes       | text, image, video | 262 144 | 32 000     |

`kimi-for-coding` is the latest alias on the Kimi Code Plan — today it points at Kimi-k2.6. The Plan itself still covers K2.5; the upstream routes older model IDs to the current alias, but this provider only publishes the canonical `kimi-for-coding` entry.

Select it inside `pi`:

```
/model kimi-coding/kimi-for-coding
```

## Environment variables

| Variable                           | Description                                            |
| ---------------------------------- | ------------------------------------------------------ |
| `KIMI_API_KEY`                     | Static API key (alternative to browser login)          |
| `KIMI_CODE_BASE_URL`               | Override the API base URL                              |
| `KIMI_CODE_OAUTH_HOST`             | Override the OAuth host                                |
| `KIMI_CODE_PROTOCOL`               | `anthropic` (default) or `openai`                      |
| `KIMI_CODE_UPLOAD_THRESHOLD_BYTES` | Image auto-upload threshold, default `1048576` (1 MB)  |
| `KIMI_CODE_DEBUG`                  | Set to `1` to print provider-side debug logs           |

Full list with defaults and the test-script variables: [docs/ENV.md](docs/ENV.md).

## FAQ

### How is this different from the official `kimi-cli`?

`kimi-cli` is Moonshot's own terminal agent. It's a full CLI — it replaces pi, you can't use it as a pi provider. This extension is the bridge: it lets you keep pi as your harness and point it at your Kimi Code Membership for inference, reusing the same login flow `kimi-cli` v1.3+ ships.

### Do I need a paid Kimi subscription?

For browser login, yes — whatever your Moonshot account is entitled to is what the provider can access. Without a plan you'll hit rate limits quickly. For pay-per-token usage, set `KIMI_API_KEY` instead.

### Where does my data go?

Requests go only to `api.kimi.com` (Moonshot's servers). Login credentials are stored locally at `~/.pi/agent/auth.json`, readable only by your user. Nothing is uploaded to any third party.

### Is this affiliated with Moonshot AI?

No. This is an independent extension. The login flow is derived from the public implementation in the open-source [`kimi-cli`](https://github.com/MoonshotAI/kimi-cli) repository.

### Which pi version does this work with?

Any recent [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

### Why are there two protocol modes?

Kimi's coding endpoint speaks both Anthropic and OpenAI dialects. Anthropic mode has better visibility into cache hits, so it's the default. Switch via `KIMI_CODE_PROTOCOL=openai` if something in your pi setup prefers the OpenAI path.

## Troubleshooting

### `pi` reports `fetch failed` even though `curl` works

pi runs on Node's `fetch` / undici stack, which handles `http_proxy` / `https_proxy` / `all_proxy` differently from `curl`. Verify those variables in the pi process's environment. The bundled smoke-test script `scripts/test_e2e.sh` prints the effective proxy-related environment for easier debugging.

### `/login kimi-coding` prints a device code but the browser never opens

The login flow always prints a verification URL — opening it is the terminal's job. If your terminal or OS blocks auto-open, copy the URL and paste it into a browser manually.

### "Access denied" or subscription errors after a successful login

Your Moonshot account needs an active Kimi Code subscription for the provider to do anything useful. If the same account works in `kimi-cli`, re-run `/login kimi-coding` to refresh credentials.

### Large images fail with a payload error

This extension uploads images over `KIMI_CODE_UPLOAD_THRESHOLD_BYTES` (default 1 MB) to Kimi's Files API and references them as `ms://`. Videos always upload. Set `KIMI_CODE_DEBUG=1` to see upload decisions in the provider logs.

### Prompt cache never seems to hit

The cache is keyed off your pi session, which changes between sessions. Long-lived sessions get cache hits within a few minutes; cold sessions won't. Also check `PI_CACHE_RETENTION` — if it's set to `none`, this extension intentionally skips cache-key injection. For deterministic measurement, run the cache-TTL probe with a fixed key — see [docs/TESTING.md](docs/TESTING.md).

### OpenAI-compatible tools complain about a `developer` role

In OpenAI mode this extension maps the `developer` role to `system` (Kimi's Coding endpoint does not recognize `developer`). If something in your toolchain expects `developer` to round-trip, use Anthropic mode instead.

## References

- Upstream harness: [badlogic/pi-mono](https://github.com/badlogic/pi-mono) · [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- Upstream login implementation and feature request: [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) · [kimi-cli#757](https://github.com/MoonshotAI/kimi-cli/issues/757)
- Environment variables: [docs/ENV.md](docs/ENV.md)
- Testing guide: [docs/TESTING.md](docs/TESTING.md)
- Architecture notes: [docs/architecture.md](docs/architecture.md)

## Credits

Based on the login implementation from [`kimi-cli`](https://github.com/MoonshotAI/kimi-cli) by Moonshot AI. Built as an extension for [`pi-coding-agent`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) by [@badlogic](https://github.com/badlogic).

## License

MIT
