# Programmatic Usage

Use `KimiCode()` to embed Kimi Code as a provider inside a custom Pi build. This is the recommended way to integrate when you are building your own Pi-based agent and want to ship Kimi Code support with pre-set defaults.

## Quick start

```typescript
import { main } from "@earendil-works/pi-coding-agent";
import { KimiCode } from "pi-provider-kimi-code";

main(process.argv.slice(2), {
  extensionFactories: [
    KimiCode({
      protocol: "anthropic",
      tools: {
        moonshot_search: { enabled: true, default_collapsed: false },
        moonshot_fetch: { enabled: true, default_collapsed: true },
      },
      uploads: { thresholdBytes: 2 * 1024 * 1024 },
    }),
  ],
});
```

That's it. The factory returns an `ExtensionFactory` — the same type Pi expects in its `extensionFactories` array. No file-based extension path needed.

## Zero-arg form

`KimiCode()` with no arguments behaves identically to the file-based extension (loads config from `~/.pi/`, project `.pi/`, and env vars):

```typescript
extensionFactories: [KimiCode()]
```

This is what the package's `export default` does internally.

## What `overrides` controls

The argument is a `KimiCodeConfigPatch` — a deep-partial overlay applied **after** all other config layers. Priority order (lowest to highest):

1. Built-in defaults
2. Home config (`~/.pi/providers/kimi-coding/config.json`)
3. Project config (`<cwd>/.pi/providers/kimi-coding/config.json`)
4. Environment variables (`KIMI_CODE_PROTOCOL`, `KIMI_CODE_UPLOAD_THRESHOLD_BYTES`, etc.)
5. **`overrides` parameter** (highest priority)

Users can still override your defaults through env vars only if you don't pass that key in `overrides`. If you set `protocol: "anthropic"` in overrides, it wins over `KIMI_CODE_PROTOCOL`.

### Patch shape

```typescript
KimiCode({
  // Wire protocol: "openai" (default) or "anthropic"
  protocol: "anthropic",

  // File upload threshold in bytes
  uploads: { thresholdBytes: 2 * 1024 * 1024 },

  // Per-tool enable and collapse defaults (all optional, omitted tools keep their config-file / default value)
  tools: {
    moonshot_search: { enabled: true, default_collapsed: false },
    moonshot_fetch: { enabled: true, default_collapsed: true },
    kimi_datasource: { enabled: false },
  },

  // Model parameters (rarely needed — server-side discovery handles most of this)
  model: {
    contextWindow: 262144,
    maxTokens: 32000,
    reasoning: true,
    // Note: K2.7 Code only accepts temperature=1 and top_p=0.95;
    // other values are silently stripped by the payload guard.
    generation: { maxCompletionTokens: 16384 },
  },
})
```

All fields are optional. Only the keys you provide are merged; the rest come from the normal config chain.

## Combining with other extensions

`extensionFactories` is an array. Mix `KimiCode()` with other inline or file-loaded extensions:

```typescript
import { KimiCode } from "pi-provider-kimi-code";
import { myCustomExtension } from "./my-extension";

main(process.argv.slice(2), {
  extensionFactories: [
    KimiCode({ protocol: "anthropic" }),
    myCustomExtension(),
  ],
});
```

File-based extensions (`pi -e /path/to/extension`) and inline factories coexist. Pi deduplicates by extension path, and inline factories get synthetic paths like `<inline:1>`, `<inline:2>`, so there is no collision risk.

## Runtime behavior

Everything that works with the file-based extension also works with `KimiCode()`:

- `/login kimi-coding` and `KIMI_API_KEY` authentication
- `/kimi-settings` interactive config editor (changes go to home/project JSON files, not overrides)
- Live model metadata discovery from `/v1/models`
- `kimi-code` credential reuse from `~/.kimi/credentials/kimi-code.json`
- File uploads via Kimi's Files API
- Reasoning level mapping

The only difference is that the `overrides` parameter sits at the top of the config stack, so your programmatic defaults take priority over file-based config.
