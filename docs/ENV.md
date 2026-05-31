# Environment Variables

## Authentication

| Variable         | Description                                                                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KIMI_API_KEY`   | Static API key. Alternative to OAuth device-code login; used as `Authorization: Bearer <token>`. Read by pi core and by the extension's file-upload path.                                                                          |
| `KIMI_SHARE_DIR` | Override the `kimi-cli` share directory used to look up an existing OAuth credential at `<dir>/credentials/kimi-code.json`. Default: `~/.kimi`. Mirrors upstream `kimi-cli`. Read-only — this extension never writes to that file. |

## Endpoint / protocol

| Variable               | Description                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KIMI_CODE_BASE_URL`   | Override the default API base URL. The default depends on the protocol (see `KIMI_CODE_PROTOCOL`).                                                                                                                                                                       |
| `KIMI_BASE_URL`        | Alias for `KIMI_CODE_BASE_URL`. Accepted for compatibility with upstream `kimi-cli`, which uses this name. `KIMI_CODE_BASE_URL` wins if both are set.                                                                                                                    |
| `KIMI_CODE_OAUTH_HOST` | Override the OAuth host.                                                                                                                                                                                                                                                 |
| `KIMI_OAUTH_HOST`      | Fallback OAuth host override for compatibility.                                                                                                                                                                                                                          |
| `KIMI_CODE_PROTOCOL`   | Select the wire protocol. Supported values: `openai` (default) or `anthropic`. `openai` → `openai-completions` via `/coding/v1/chat/completions`; `anthropic` → `anthropic-messages` via `/coding/v1/messages`. Any value other than `anthropic` is treated as `openai`. |

## Uploads

| Variable                           | Description                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KIMI_CODE_UPLOAD_THRESHOLD_BYTES` | Minimum image size (in bytes) before uploading to Kimi's `/v1/files` endpoint as an `ms://` reference instead of inlining base64. Default: `1048576` (1 MB). |

## Model identity overrides

These mirror the same-name environment variables in upstream `kimi-cli`. When set they apply _after_ server-side discovery, so a user-provided override always wins over `/v1/models` metadata.

| Variable                      | Description                                                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KIMI_MODEL_NAME`             | Override the wire model id sent to the server and the human-readable model name shown in pi. Useful for pointing the extension at a non-default model variant exposed by the same Coding endpoint.                                                           |
| `KIMI_MODEL_MAX_CONTEXT_SIZE` | Override the model's advertised context window (in tokens). Useful when a server-side rollout exceeds what `/v1/models` reports. Non-positive / non-numeric values are ignored.                                                                              |
| `KIMI_MODEL_CAPABILITIES`     | Comma-separated capability flags. Recognized tokens: `thinking`, `always_thinking`, `image_in`. Either `thinking` or `always_thinking` enables reasoning; `image_in` enables image input. Tokens not in this list are ignored. Example: `thinking,image_in`. |

## Generation overrides

| Variable                           | Description                                                                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KIMI_MODEL_TEMPERATURE`           | Force temperature on outbound requests.                                                                                                                                                                                             |
| `KIMI_MODEL_TOP_P`                 | Force top-p on outbound requests.                                                                                                                                                                                                   |
| `KIMI_MODEL_MAX_COMPLETION_TOKENS` | Force max completion tokens on outbound requests.                                                                                                                                                                                   |
| `KIMI_MODEL_THINKING_KEEP`         | When thinking is enabled, forwarded verbatim as `extra_body.thinking.keep`. Moonshot-specific switch for preserving thinking content across turns (e.g. `"all"`). Has no effect when reasoning is off. Mirrors upstream `kimi-cli`. |

## Diagnostics

| Variable          | Description                                                                        |
| ----------------- | ---------------------------------------------------------------------------------- |
| `KIMI_CODE_DEBUG` | Set to `1` to print provider-side debug logs (request metadata, file upload logs). |

## pi-core variables honored by this extension

| Variable             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_CACHE_RETENTION` | Pi-core prompt-cache knob. When set to `none`, this extension skips `prompt_cache_key` injection on every request so Kimi's native session cache stays off. Any other value (unset / `short` / `long`) keeps caching on. `long` is also honored by pi-ai's Anthropic transport, which adds `cache_control: { ttl: "1h" }` markers — Kimi currently appears to ignore the extended TTL, so the effective cache window stays at ~5-10 minutes regardless. |
