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
| `kimi-code`              | Kimi Code (powered by kimi-k2.5) | yes       | text, image | 262 144 | 32 768     |
| `kimi-k2.5`              | Kimi K2.5                        | yes       | text, image | 262 144 | 32 768     |
| `kimi-k2-thinking-turbo` | Kimi K2 Thinking Turbo           | yes       | text        | 262 144 | 32 768     |

Select a model inside pi:

```
/model kimi-coding/kimi-code
```

## Environment Overrides

- `KIMI_CODE_BASE_URL` — override the default API base URL (`https://api.kimi.com/coding`)
- `KIMI_CODE_OAUTH_HOST` — override the OAuth host
- `KIMI_OAUTH_HOST` — fallback OAuth host override for compatibility

## How It Works

- Registers provider `kimi-coding` with base URL `https://api.kimi.com/coding`
- Uses `api: "anthropic-messages"` — Kimi's API is wire-compatible with the Anthropic Messages format
- Adds a small `streamSimple` wrapper to suppress Kimi's leaked `(Empty response: ...)` placeholder blocks
- Sends the same `KimiCLI/1.28.0` + `X-Msh-*` headers as current `kimi-cli`
- Persists a stable device ID at `~/.pi/providers/kimi-coding/device_id`
- OAuth uses [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628) device authorization grant against `https://auth.kimi.com`
- Zero dependencies — types from `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` are provided by the pi runtime
- Zero build step — pi loads TypeScript directly via jiti

## Credits

This extension is based on the OAuth implementation from [kimi-cli](https://github.com/MoonshotAI/kimi-cli) by Moonshot AI.

## License

MIT
