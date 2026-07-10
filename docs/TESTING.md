# Testing

## Local Checks

```bash
npm test
npm run check
npm run lint
```

## Live E2E Suites

All live suites require `KIMI_API_KEY`. `scripts/test_e2e.sh` is the run-all entry point; it invokes the focused suites below in order.

```bash
KIMI_API_KEY=sk-... ./scripts/test_e2e.sh
```

The cache suites issue many requests and some have long waits. Run an individual suite while investigating one behavior.

| Suite                                     | Purpose                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `scripts/e2e/model-contract.sh`           | Reads `/v1/models` and reports model id, protocol, thinking capability, `think_efforts`, context, and input modalities.       |
| `scripts/e2e/api-schema-inspect.sh`       | Writes normalized response-schema snapshots for `/models`, `/chat/completions`, and `/messages`; optionally diffs a baseline. |
| `scripts/e2e/smoke.sh`                    | Runs Pi through both wire protocols and the configured thinking-level matrix.                                                 |
| `scripts/e2e/thinking-effort-contract.sh` | Uses `/v1/models` to select a server-declared effort, then verifies `thinking.effort` is accepted on selected protocols.      |
| `scripts/e2e/provider-payload.sh`         | Captures Pi's wire payload and asserts model identity, `thinking.type`, nested effort, and removal of `reasoning_effort`.     |
| `scripts/e2e/file-upload.sh`              | Uploads a large image and verifies an `ms://` reference with the OpenAI endpoint.                                             |
| `scripts/e2e/cache/*.sh`                  | Focused cache probes, grouped by TTL, mechanisms, identity, prefix behavior, parameters, and multimodal/concurrency behavior. |

`./scripts/list_models.sh` remains as a compatibility entry point for `scripts/e2e/model-contract.sh`. `./scripts/test_payload_thinking.sh` remains as a compatibility entry point for `scripts/e2e/thinking-effort-contract.sh`.

## Live E2E Variables

| Variable                          | Default                          | Description                                                                                                      |
| --------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `KIMI_API_KEY`                    | required                         | API key used for direct API probes and Pi.                                                                       |
| `KIMI_CODE_BASE_URL`              | `https://api.kimi.com/coding/v1` | Coding API base URL.                                                                                             |
| `KIMI_E2E_MODEL`                  | `kimi-coding/kimi-for-coding`    | Pi model alias for provider smoke tests.                                                                         |
| `KIMI_E2E_WIRE_MODEL`             | `kimi-for-coding`                | Wire model id used by direct API contract suites.                                                                |
| `KIMI_E2E_EFFORT`                 | model default                    | A server-declared effort to test. The contract suite rejects values not listed in `think_efforts.valid_efforts`. |
| `KIMI_E2E_EFFORT_PROTOCOLS`       | `openai,anthropic`               | Comma-separated direct protocols for the effort contract suite.                                                  |
| `KIMI_E2E_EXPECT_THINKING_EFFORT` | `none`                           | Expected nested effort in provider payload captures; `none` requires the field to be absent.                     |
| `KIMI_E2E_SCHEMA_ENDPOINTS`       | `models,openai,anthropic`        | Comma-separated endpoints queried by the schema inspection suite.                                                |
| `KIMI_E2E_SCHEMA_OUTPUT`          | temporary file                   | Destination for the normalized API schema snapshot.                                                              |
| `KIMI_E2E_SCHEMA_BASELINE`        | unset                            | Existing snapshot to diff against; a difference makes the suite fail.                                            |
| `KIMI_E2E_THINKING_LEVELS`        | `off low medium high`            | Pi thinking levels exercised by the smoke suite.                                                                 |
| `KIMI_E2E_VERBOSE`                | `1`                              | Print suite setup and Pi version.                                                                                |
| `KIMI_E2E_CACHE_REPEAT`           | `2000`                           | Long-text repeat count used by cache suites.                                                                     |
| `KIMI_E2E_SKIP_TTL_UPPER`         | `1`                              | Set to `0` to run the 30-minute TTL upper-bound probe.                                                           |
| `KIMI_E2E_SKIP_VERY_LARGE_CACHE`  | `1`                              | Set to `0` to run the very-large-context cache probe.                                                            |
| `KIMI_E2E_KEEP_CAPTURES`          | `0`                              | Set to `1` to retain provider-payload captures under `/tmp`.                                                     |

## Provider Payload Capture

`provider-payload.sh` starts a loopback capture proxy, forwards the request to Kimi, and removes captures by default. It persists redacted `Authorization` and `x-api-key` headers. To inspect a retained capture:

```bash
KIMI_API_KEY=sk-... KIMI_E2E_KEEP_CAPTURES=1 ./scripts/e2e/provider-payload.sh
CAPTURE_DIR=/tmp/kimi-provider-payload-... node scripts/kimi-compat/inspect_captures.mjs
CAPTURE_DIR=/tmp/kimi-provider-payload-... node scripts/kimi-compat/dump_raw_request.mjs
```

For manual proxy use, `KIMI_CODE_BASE_URL` must retain the `/coding/v1` prefix:

```bash
CAPTURE_PORT=8787 CAPTURE_TARGET_ORIGIN=https://api.kimi.com CAPTURE_DIR=/tmp/kimi-captures \
  node scripts/kimi-compat/capture_proxy.mjs

KIMI_CODE_BASE_URL=http://127.0.0.1:8787/coding/v1 \
  pi -ne -e . --model kimi-coding/kimi-for-coding -p "Say hi." --mode print
```

## Proxy / Networking

If `curl` can reach Kimi but Pi reports `fetch failed`, check `http_proxy`, `https_proxy`, and `all_proxy`. Pi uses Node's `fetch` / undici stack, which can differ from `curl`.
