# Testing

## Quick Test

```bash
KIMI_API_KEY=sk-... ./scripts/test_e2e.sh
```

## What It Tests

The test script covers the following checks:

1. Smoke test in Anthropic mode
2. Smoke test in OpenAI mode
3. High-thinking extraction (thinking + answer + usage)
4. Prompt-cache TTL probe
5. Large file upload via `ms://` reference
6. Direct `prompt_cache_key` verification

## Test Script Environment Variables

| Variable                   | Default                                     | Description                             |
| -------------------------- | ------------------------------------------- | --------------------------------------- |
| `KIMI_API_KEY`             | (required)                                  | API key                                 |
| `KIMI_CODE_DEBUG`          | `1`                                         | Provider debug logs                     |
| `KIMI_E2E_VERBOSE`         | `1`                                         | Command and environment diagnostics     |
| `KIMI_E2E_MODEL`           | `kimi-coding/kimi-for-coding`               | Model for smoke tests                   |
| `KIMI_E2E_CACHE_INTERVALS` | `60,300`                                    | Absolute seconds from warmup per probe  |
| `KIMI_E2E_CACHE_KEY`       | `pi-provider-kimi-code-e2e-<pid>-<unix_ts>` | Override cache key for TTL probe        |
| `KIMI_E2E_CACHE_REPEAT`    | `2000`                                      | Long-text repeat count for cache warmup |
| `KIMI_E2E_SKIP_CACHE`      | `0`                                         | Set `1` to skip cache TTL phase         |
| `KIMI_E2E_ONLY_CACHE`      | `0`                                         | Set `1` to run only cache TTL test      |

## Issue #19 Reproduction Script

```bash
KIMI_API_KEY=sk-... ./scripts/repro_issue19.sh
```

Tests payload variants against both OpenAI (`/chat/completions`) and Anthropic (`/messages`) endpoints on the Kimi Code API. Verifies that the server actually respects thinking configuration by checking response content, not just HTTP status.

### Test Groups

| Group | What it tests |
|-------|---------------|
| A | Baselines — no thinking/reasoning fields |
| B | `reasoning_effort: null` (v0.6.0 bug) |
| C | `thinking` nested in `extra_body` (v0.6.0 behavior) |
| D | `thinking` at top level (fixed behavior) |
| E | Streaming + old payload combos |
| F | Streaming + fixed payload combos + `stream_options` |
| G | `prompt_cache_key` |

### Results (2026-06-18, Kimi Code API)

**Non-streaming:**

| Test | Endpoint | Payload | thinking in response? | Verdict |
|------|----------|---------|----------------------|---------|
| A1 | OpenAI | no thinking fields | yes | default is thinking-on |
| A2 | Anthropic | no thinking fields | no | default is thinking-off |
| C1 | OpenAI | `extra_body.thinking: enabled` | yes | but thinking is on by default anyway |
| C2 | OpenAI | `extra_body.thinking: disabled` | **yes** | **server ignored disable** |
| C3 | Anthropic | `extra_body.thinking: enabled` | **no** | **server ignored enable** |
| C4 | Anthropic | `extra_body.thinking: disabled` | no | but thinking is off by default anyway |
| D1 | OpenAI | top-level `thinking: enabled` | yes | works |
| D2 | OpenAI | top-level `thinking: disabled` | no | works |
| D3 | Anthropic | top-level `thinking: enabled` | yes | works |
| D4 | Anthropic | top-level `thinking: disabled` | no | works |

**Conclusion:** `extra_body` nesting is silently ignored by the server. Only top-level `thinking` is respected. The fix (spreading `extra_body` to top level) is necessary for thinking config to take effect.

**Streaming:** F2/F4 (thinking enabled, streaming) did not return thinking content in the response. This may be a token limit issue (`max_completion_tokens=128`) or a difference in how streaming surfaces reasoning content. Non-streaming results are definitive.

## Proxy / Networking

If `curl` can reach Kimi but `pi` reports `fetch failed`, check your `http_proxy` / `https_proxy` / `all_proxy` environment. `pi` uses Node's `fetch` / undici stack, which may behave differently from `curl`.
