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

| ID                 | Name             | Reasoning | Input       | Context  | Max Output |
|--------------------|------------------|-----------|-------------|----------|------------|
| `kimi-k2-thinking` | Kimi K2 Thinking | yes       | text        | 262 144  | 32 768     |
| `k2p5`             | Kimi K2.5        | yes       | text, image | 262 144  | 32 768     |

Select a model inside pi:

```
/model kimi-coding/kimi-k2-thinking
```

## How It Works

- Registers provider `kimi-coding` with base URL `https://api.kimi.com/coding`
- Uses `api: "anthropic-messages"` — Kimi's API is wire-compatible with the Anthropic Messages format, so no custom streaming logic is needed
- OAuth uses [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628) device authorization grant against `https://auth.kimi.com`
- Zero dependencies — types from `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` are provided by the pi runtime
- Zero build step — pi loads TypeScript directly via jiti

## Credits

This extension is based on the OAuth implementation from [kimi-cli](https://github.com/MoonshotAI/kimi-cli) by Moonshot AI.

## License

MIT
