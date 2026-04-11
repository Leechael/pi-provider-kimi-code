# Environment Variables

| Variable | Description |
|----------|-------------|
| `KIMI_API_KEY` | Static API key. Alternative to OAuth device-code login; used as `Authorization: Bearer <token>`. Read by pi core and by the extension's file-upload path. |
| `KIMI_CODE_BASE_URL` | Override the default API base URL. The default depends on the protocol (see `KIMI_CODE_PROTOCOL`). |
| `KIMI_CODE_OAUTH_HOST` | Override the OAuth host. |
| `KIMI_OAUTH_HOST` | Fallback OAuth host override for compatibility. |
| `KIMI_CODE_PROTOCOL` | Select the wire protocol. `openai` → `openai-completions` via `/coding/v1/chat/completions`. Any other value (including unset) → `anthropic-messages` via `/coding/v1/messages`. |
| `KIMI_CODE_UPLOAD_THRESHOLD_BYTES` | Minimum image size (in bytes) before uploading to Kimi's `/v1/files` endpoint as an `ms://` reference. Default: `1048576` (1 MB). Videos are always uploaded regardless of this threshold. |
| `KIMI_MODEL_TEMPERATURE` | Force temperature on outbound requests. |
| `KIMI_MODEL_TOP_P` | Force top-p on outbound requests. |
| `KIMI_MODEL_MAX_TOKENS` | Force max tokens on outbound requests. |
| `KIMI_CODE_DEBUG` | Set to `1` to print provider-side debug logs (request metadata, file upload logs). |

## pi-core variables honored by this extension

| Variable | Description |
|----------|-------------|
| `PI_CACHE_RETENTION` | Pi-core prompt-cache knob. When set to `none`, this extension skips `prompt_cache_key` injection on every request so Kimi's native session cache stays off. Any other value (unset / `short` / `long`) keeps caching on. `long` is also honored by pi-ai's Anthropic transport, which adds `cache_control: { ttl: "1h" }` markers — Kimi currently appears to ignore the extended TTL, so the effective cache window stays at ~5-10 minutes regardless. |
