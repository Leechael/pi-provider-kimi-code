# Testing

## Quick Test

```bash
KIMI_API_KEY=sk-... ./scripts/test_e2e.sh
```

## What It Tests

1. Smoke test in Anthropic mode
2. Smoke test in OpenAI mode
3. High-thinking extraction (thinking + answer + usage)
4. Prompt-cache TTL probe
5. Large file upload via `ms://` reference
6. Direct `prompt_cache_key` verification

## Test Script Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KIMI_API_KEY` | (required) | API key |
| `KIMI_CODE_DEBUG` | `1` | Provider debug logs |
| `KIMI_E2E_VERBOSE` | `1` | Command and environment diagnostics |
| `KIMI_E2E_MODEL` | `kimi-coding/kimi-for-coding` | Model for smoke tests |
| `KIMI_E2E_CACHE_INTERVALS` | `60,300` | Absolute seconds from warmup per probe |
| `KIMI_E2E_CACHE_KEY` | `pi-provider-kimi-code-e2e-<pid>-<unix_ts>` | Override cache key for TTL probe |
| `KIMI_E2E_CACHE_REPEAT` | `2000` | Long-text repeat count for cache warmup |
| `KIMI_E2E_SKIP_CACHE` | `0` | Set `1` to skip cache TTL phase |
| `KIMI_E2E_ONLY_CACHE` | `0` | Set `1` to run only cache TTL test |

## Proxy / Networking

If `curl` can reach Kimi but `pi` reports `fetch failed`, check your `http_proxy` / `https_proxy` / `all_proxy` environment. `pi` uses Node's `fetch` / undici stack, which may behave differently from `curl`.
