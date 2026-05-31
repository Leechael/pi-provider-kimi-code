# Kimi Coding endpoint cache behavior

Empirical findings from [`scripts/test_e2e.sh`](../scripts/test_e2e.sh) —
tests 4 and 4a–4s (4h and 4r are opt-in long-running probes, executed
once for the data below). Numbers below come from real runs against
`https://api.kimi.com/coding/v1/messages` and `/coding/v1/chat/completions`
using `kimi-for-coding`.

## TL;DR

- Cache identity is the **content prefix hash**. No marker is required, and
  none can disable it.
- `prompt_cache_key` and Anthropic `cache_control` markers are **fully
  ignored** for cache decisions.
- On `/coding/v1/messages` (Anthropic-compat), the `system` field, the
  `tools` array, and any `image_url` reference (e.g. `ms://<file_id>`) are
  all part of the cached prefix. Changing any of them invalidates the
  messages cache entirely. `system` / `tools` invalidation on the
  OpenAI-compat endpoint is not yet directly measured; image_url
  invalidation IS measured on the OpenAI endpoint.
- Cache is **shared between `/messages` (Anthropic) and `/chat/completions`
  (OpenAI)** — switching `KIMI_CODE_PROTOCOL` does NOT invalidate.
- The **`X-Msh-Device-Id` header is not part of cache identity** (Test 4s).
  Different device ids on the same account share cache; the no-header
  bucket and explicit device ids land in the same slot. Rotating
  `~/.pi/providers/kimi-coding/device_id` or running parallel agents on
  separate machines does not force a cold prefix.
- Prefix matching aligns to **256-token chunks** (confirmed at prompt sizes
  from 800 to 32 000 tokens). The tail past the last chunk boundary
  re-processes each turn.
- An exact-content re-send reads the **entire** prompt from cache (not just
  the chunk-aligned portion).
- TTL falls in **[300s, 1800s)** — at least 5 minutes, less than 30
  minutes (probes at 1800s/3600s/7200s all MISS; probes at 60s/300s all
  HIT).
- `cache_creation_input_tokens` is always `0` — Kimi does not surface cache
  writes.
- **Generation parameters** (`temperature`, `top_p`, `max_tokens`,
  `reasoning_effort`) do **not** participate in cache identity. Changing
  them between turns is free.
- The `/coding/v1/chat/completions` (OpenAI-compat) endpoint matches
  Anthropic's caching behaviour for both exact re-sends and prefix
  extensions.
- Concurrent identical writes converge to a single consistent cache entry —
  no observed race.
- Cache benefits accrue **within** a single pi session (multi-turn growth,
  branch reuse). Two cold `pi` invocations with the "same" user prompt do
  not share cache — pi's full payload (system + tools) drifts between
  sessions.

## Method

All payloads target `https://api.kimi.com/coding/v1/messages`
(Anthropic-compat) or `/coding/v1/chat/completions` (OpenAI-compat) with
`model: "kimi-for-coding"`. Cache state is read from the response `usage`
block: `cache_read_input_tokens` (Anthropic field) mirrors `cached_tokens`
(OpenAI field). Variant requests use UUID-salted content so they cannot
accidentally share cache through identical prefixes.

| Test | Function                              | Topic                                        |
| ---- | ------------------------------------- | -------------------------------------------- |
| 4    | `cache_ttl_check`                     | TTL short-interval baseline (60s/300s)       |
| 4a   | `cache_mechanism_isolation_check`     | which marker drives cache                    |
| 4b   | `dual_breakpoint_check`               | dual marker vs single                        |
| 4c   | `cache_key_semantics_check`           | does `prompt_cache_key` segregate / collide? |
| 4d   | `cache_chain_check`                   | multi-turn chain, persistence, branch        |
| 4e   | `cross_protocol_cache_check`          | /messages ↔ /chat/completions                |
| 4f   | `system_tools_cache_check`            | system/tools in cached prefix                |
| 4g   | `large_delta_check`                   | multi-chunk delta cross-boundary             |
| 4h   | `ttl_upper_check`                     | TTL upper bound (opt-in, long)               |
| 4i   | `block_size_sweep_check`              | 256-token alignment across sizes             |
| 4j   | `tools_change_cache_check`            | tools-only change impact                     |
| 4k   | `small_boundary_cache_check`          | sub-256 token chunk behaviour                |
| 4l   | `openai_cache_boundary_check`         | OpenAI endpoint cache mechanics              |
| 4m   | `retention_none_provider_cache_check` | `PI_CACHE_RETENTION=none` via pi binary      |
| 4n   | `usage_field_extraction_check`        | unit test of usage extractor (no network)    |
| 4o   | `non_prompt_params_cache_check`       | does temperature/top_p/etc invalidate?       |
| 4p   | `multimodal_cache_check`              | image_url in cache identity                  |
| 4q   | `concurrent_cache_check`              | parallel identical-prefix writes             |
| 4r   | `very_large_cache_check`              | ~100K context (opt-in)                       |
| 4s   | `device_id_cache_check`               | `X-Msh-Device-Id` header in cache identity   |

## Findings

### 1. Markers are decorative (Test 4a)

Four payload variants — distinct salted content, identical caching outcome:

| Variant | `cache_control` | `prompt_cache_key` | probe `cache_read_input_tokens` |
| ------- | --------------- | ------------------ | ------------------------------- |
| A       | set             | unset              | 24048                           |
| B       | unset           | set                | 24042                           |
| C       | set             | set                | 24040                           |
| D       | unset           | unset              | 24040                           |

Even **D (no markers)** hits. The cache writes implicitly on first send; the
second send reads it back unconditionally.

### 2. `prompt_cache_key` participates in nothing (Test 4c)

- **Collision (V1)** — warm payload X, then payload Y with the **same** key.
  Re-probing X still HITs (24042). Y also HITs (24043). Y did not evict X.
- **Segregation (V2)** — warm with key K1, probe **identical content** with
  key K2. HIT (24038).

The key is fully ignored. Two agents using the same `prompt_cache_key` with
different content cannot collide. Two agents using different keys but sharing
prefix content share cache hits.

### 3. Cache identity is content-hash (Test 4d Phase 3)

The branch test constructs a 5-turn payload that diverges from the main
chain at turn 4 (turns 1–3 identical, turns 4–5 differ):

```
branch prompt_tokens  = 11341
branch cache_read     = 11264   (~ shared turn-3 prefix, chunk-floor)
main turn 3 prompt    = 11294
```

The branch reuses the shared prefix up to the chunk boundary (see Finding 4).
Real-world implication: tool-call retries, re-routing, and any "same
conversation, different ending" pattern is effectively free.

### 4. Prefix matching aligns to 256-token chunks (Tests 4d, 4i)

Linear chain growth — ~10K-token base + ~50-token delta per turn:

```
turn   prompt    cache_read    new_input
1      11250          0           11250      (cold)
2      11272      11008             264
3      11294      11264              30
4      11316      11264              52      cache_read does NOT grow
5      11338      11264              74      still 11264
```

`11008 = 43 × 256`, `11264 = 44 × 256`. The cache reads up to the largest
256-aligned offset that fits within the previous prefix; the partial tail
past that offset re-processes each turn.

The block-size sweep (Test 4i) confirms the same alignment across prompt
sizes from 800 to 32 000 tokens:

| warm prompt | probe `cache_read` | aligned to | delta |
| ----------- | ------------------ | ---------- | ----- |
| 834         | 768                | 3 × 256    | 0     |
| 1638        | 1536               | 6 × 256    | 0     |
| 4035        | 3840               | 15 × 256   | 0     |
| 12035       | 12032              | 47 × 256   | 0     |
| 32039       | 32000              | 125 × 256  | 0     |

Cost ceiling: at most ~256 tokens of re-processing per turn — ~2.3% on an
11K context, decreasing with larger contexts.

### 5. Exact-content re-sends read everything (Test 4d Phase 2)

Re-probing the turn-1 and turn-3 payloads after the chain completed:

```
reprobe turn 1: prompt = 11250, cache_read = 11250   (100%)
reprobe turn 3: prompt = 11294, cache_read = 11294   (100%)
```

When the request hash matches a previously-sent payload exactly, the full
prompt reads from cache — regardless of the 256-token alignment that governs
prefix matching. Two distinct cache layers appear to coexist: a
chunk-aligned prefix index, and an exact-hash entry.

### 6. Old prefixes persist (Test 4d Phase 2)

After the 5-turn chain wrote 5 distinct prefix caches, re-sending the turn-1
payload still HITs. Newer caches do not evict older ones, at least within
the ~10-second test window.

### 7. TTL is between 300 and 1800 seconds (Tests 4, 4h)

Test 4 — same 26036-token payload sent at `t=0`, probed at `t=60s` and
`t=300s`: both reads full 26036 tokens from cache.

Test 4h — same ~26K payload, warmed then probed at longer intervals:

| Probe interval  | `prompt_tokens` | `cache_read` |
| --------------- | --------------- | ------------ |
| 1800s (30 min)  | 26047           | 0 (MISS)     |
| 3600s (1 hour)  | 26046           | 0 (MISS)     |
| 7200s (2 hours) | 26047           | 0 (MISS)     |

TTL falls in the bracket **[300s, 1800s)** — at least 5 minutes, less
than 30 minutes. Consistent with the ~5–10 minute window the upstream
extension docs hint at.

### 8. Cache writes are not surfaced (all tests)

`cache_creation_input_tokens` is `0` in **every** response across all test
functions (~80 requests total). Either Kimi does not bill cache writes on
the Coding Plan, or the field is hidden by policy. Operationally: cache
writes have no visible per-token cost.

### 9. Dual cache-breakpoint marking offers nothing (Test 4b)

The optimisation proposed in
[badlogic/pi-mono#1737](https://github.com/badlogic/pi-mono/pull/1737) and
shipped as [`pi-better-messages-cache`](https://github.com/mcowger/pi-better-messages-cache)
adds a second `cache_control` marker on the last assistant `tool_use` block.
Multi-turn tool-use probe:

```
single marker (last user only):       cache_read = 24064
dual marker (last tool_use + user):   cache_read = 24064
```

Zero difference. Consistent with Finding 1.

### 10. Cache is shared across protocols (Test 4e)

Warm via one endpoint, probe via the other with the same text content:

| Direction                         | warm prompt | probe `cache_read` | aligned to |
| --------------------------------- | ----------- | ------------------ | ---------- |
| `/messages` → `/chat/completions` | 24041       | 23808              | 93 × 256   |
| `/chat/completions` → `/messages` | 24040       | 23808              | 93 × 256   |

Both directions cache-read at the same chunk-aligned offset that a
within-protocol warm→probe would produce. The cache layer sits below the
protocol layer; switching `KIMI_CODE_PROTOCOL` mid-session does NOT
invalidate cache.

### 11. The `system` field and `tools` array participate in the cached prefix (Tests 4f, 4j)

> Scope: both tests target the **Anthropic-compat endpoint**
> (`/coding/v1/messages`). The OpenAI-compat endpoint serializes `tools`
> differently (top-level `tools` array with a function-calling schema) and
> has not been probed for the same behaviour — it may or may not invalidate
> in the same way.

Test 4f — vary one of system/tools, keep messages identical:

| Scenario         | Warm config | Probe config         | probe `cache_read` |
| ---------------- | ----------- | -------------------- | ------------------ |
| F0 baseline      | `system=A`  | `system=A`           | 24050 (full HIT)   |
| F1 system swap   | `system=A`  | `system=B`           | **0**              |
| F2 add tools     | `system=A`  | `system=A` + `tools` | **0**              |
| F3 remove system | `system=A`  | (no system)          | **0**              |

Test 4j — tools-only change:

| Scenario    | Warm           | Probe           | probe `cache_read` |
| ----------- | -------------- | --------------- | ------------------ |
| J0 baseline | `tools=[Read]` | `tools=[Read]`  | 22081 (full HIT)   |
| J1 swap     | `tools=[Read]` | `tools=[Write]` | **0**              |
| J2 add      | no tools       | `tools=[Read]`  | **0**              |

**Any change to `system` or `tools` fully invalidates the messages cache.**
They appear to be serialized **before** `messages` in the prefix hash, so
modifying either resets the hash from byte 0.

This is the most operationally significant finding: harnesses that toggle
the tool list mid-session (MCP plugin load/unload, dynamic tool registration,
agent steering that injects helper tools, etc.) lose cache for every
subsequent turn until the next stable prefix is re-warmed.

### 12. Multi-chunk deltas cache normally (Test 4g)

A turn whose new content crosses multiple 256-token boundaries still caches
correctly for the next turn. Sending P1 → P2 (+ ~16K delta) → P3 (+50 tail):

```
P1: prompt =   847, cache_read =     0       (cold)
P2: prompt = 17394, cache_read =   768       (chunk-floor of P1)
P3: prompt = 17416, cache_read = 17152       (chunk-floor of P2)
```

`17152 = 67 × 256`. P2's full ~17K prompt was cached past the P1 chunk
boundary; P3 reads back to chunk-floor of P2 normally. Large deltas — e.g.
big tool_result dumps — do not break chunk-alignment semantics.

### 13. Sub-256-token prompts: exact hit yes, prefix extension no (Test 4k)

For prompts below the first 256-token chunk, the **exact-content** cache
still HITs fully — but the **prefix-extension** path reads 0 (no
sub-chunk cache for partial prefixes). Crossing the first chunk boundary
unlocks the normal chunk-floor read behaviour.

| warm prompt | exact re-send `cache_read` | extended `cache_read` | floor(warm / 256) × 256 |
| ----------- | -------------------------- | --------------------- | ----------------------- |
| 43          | 43                         | 0                     | 0                       |
| 59          | 59                         | 0                     | 0                       |
| 85          | 85                         | 0                     | 0                       |
| 122         | 122                        | 0                     | 0                       |
| 201         | 201                        | 0                     | 0                       |
| 361         | 361                        | 256                   | 256                     |

Practical impact: very short conversations (system + first user < 256
tokens) get no incremental cache reads until the conversation grows past
the first chunk. Not a meaningful loss in real workloads.

### 14. The OpenAI-compat endpoint caches the same way (Test 4l)

Repeating the exact-resend and prefix-extension checks against
`/coding/v1/chat/completions`:

```
warm prompt:                 24041, cache_read = 0
exact re-send probe:         24041, cache_read = 24041 (100%)
prefix-extension probe:      24059, cache_read = 23808 (= 93 × 256)
```

Identical to Anthropic-endpoint behaviour. Combined with Finding 10 (cache
shared across protocols), this closes the OpenAI-endpoint open question:
both endpoints use the same underlying cache, with the same chunk-alignment
rules.

### 15. Generation parameters do not participate in cache identity (Test 4o)

Same prompt, probe with each of four generation knobs changed between warm
and probe (OpenAI endpoint):

| Knob changed       | cache_read / prompt | ratio |
| ------------------ | ------------------- | ----- |
| `temperature`      | 24041 / 24041       | 100%  |
| `top_p`            | 24041 / 24041       | 100%  |
| `max_tokens`       | 24042 / 24042       | 100%  |
| `reasoning_effort` | 24045 / 24045       | 100%  |

The cache key is **prompt-content only** — sampling and reasoning controls
are orthogonal. Mid-session tuning (e.g. flipping thinking on/off,
adjusting temperature) costs nothing.

### 16. Concurrent same-prefix writes converge (Test 4q)

Five identical requests fired in parallel against a single 20K-token
prefix, then two probes:

```
5 / 5 warm requests succeeded
exact probe:               20043, cache_read = 20043 (full)
prefix-extension probe:    20061, cache_read = 19968 (= 78 × 256)
```

No race-condition artifacts (no partial hits, no inconsistent reads). The
cache layer is safe for multi-agent or multi-tab use of the same plan.

### 17. Image content participates in cache identity (Test 4p)

Two distinct PNGs uploaded via `/files`, referenced as `ms://` URLs, sent
with identical text on the OpenAI-compat endpoint:

| Probe                              | prompt | cache_read | ratio |
| ---------------------------------- | ------ | ---------- | ----- |
| warm (image A + text)              | 63     | 6          | 9.5%  |
| exact resend (image A + same text) | 63     | 63         | 100%  |
| different image B + same text      | 63     | 6          | 9.5%  |

Changing only the image (same text, same `messages.content` shape) drops
cache to the baseline ~6-token framing read. Image references (here, the
literal `ms://<file_id>` URL) are hashed as part of the prefix. Same as
`system` and `tools` (Finding 11): any change at byte position 0+ in the
serialized prefix invalidates downstream.

> Note: the test changes the `ms://` URL string itself between A and B
> (different `file_id`). Whether Kimi additionally dereferences and hashes
> image _bytes_ (so two uploads of the same image would share cache) is
> not measured here.

### 18. pi-binary cross-session invocations do not share cache (Test 4m)

Two separate `pi` binary invocations with `PI_CACHE_RETENTION=none` and the
same generated user-message text:

```
warm:  exit=0, cache_read=0 (field=cacheRead at message.usage, event=message_start)
probe: exit=0, cache_read=0
```

Despite identical user text, neither call hit cache. The most likely cause
is that pi's full outbound payload (system prompt + tools array, both of
which Finding 11 shows participate in the prefix) drifts between
invocations — pi assembles them fresh each session and may include
session-scoped content.

Operational implication: prompt-cache benefits accrue **within** a single
pi session (multi-turn growth, branch reuse), not across cold pi
invocations. Don't expect "running the same task twice from a fresh `pi`
prompt" to be free.

`PI_CACHE_RETENTION=none` itself is observed to be inert here (consistent
with Finding 2): it removes the no-op `prompt_cache_key` injection, but
the actual cache decision is content-hash based and unaffected.

### 19. `X-Msh-Device-Id` header does not participate in cache identity (Test 4s)

Four scenarios, identical ~24K-token payload, varying only the
`X-Msh-Device-Id` request header. The provider sends this header on every
call (`src/device.ts`) using a persisted random 32-char hex id; every
prior 4\* test omitted it, so this fills the header-dimension gap.

| Scenario            | warm header | probe header | probe `cache_read_input_tokens` |
| ------------------- | ----------- | ------------ | ------------------------------- |
| V0 baseline         | device-A    | device-A     | 24044                           |
| V1 different device | device-A    | device-B     | 24043                           |
| V2 omitted → set    | (omitted)   | device-A     | 24052                           |
| V3 set → omitted    | device-A    | (omitted)    | 24052                           |

All four probes read the full prompt back from cache (ratios vs V0:
V1=100.0%, V2=100.0%, V3=100.0%). The device id header is ignored
entirely: distinct device ids on the same account share cache, and the
no-header bucket lands in the same slot as explicit ids.

Combined with the body-level findings (1–3, key/marker decorative) and
the protocol finding (10, /messages ↔ /chat/completions share), cache
identity on the Coding endpoint appears to be **strictly the serialized
prompt content** — no header, no protocol, no marker, no key participates.

Operational implication: two agents on different machines using the same
Kimi account share each other's cache for free. Multi-machine fleets and
forked sessions get the full benefit of any prior warm-up. The device id
is therefore safe to rotate; it presumably drives usage attribution /
rate-limiting server-side, not cache slotting.

## Implications for this extension

- **`prompt_cache_key` injection** (`applyKimiPayloadMutations` step 3 in
  `index.ts`): functionally a no-op, but kept for parity with upstream
  [`kimi-cli`](https://github.com/MoonshotAI/kimi-cli/blob/main/packages/kosong/src/kosong/chat_provider/kimi.py#L95),
  which sets the same field.
- **`PI_CACHE_RETENTION=none`** currently skips the key injection above.
  Empirically this has **no effect** on actual cache behaviour — Kimi will
  still cache. The knob is misleading and should either be documented as
  such or removed.
- **System prompt and tool list stability matter (Anthropic endpoint).** On
  `/coding/v1/messages`, any change to `system` or the `tools` array fully
  invalidates the messages cache (Finding 11). For agents that toggle MCP
  servers, dynamically load tools, or inject steering helpers mid-session,
  every such change costs a full cold prefix on the next turn. Consider
  stabilising the tools list for a session, or accept the cost. Behaviour
  on the OpenAI-compat endpoint has not been measured for the same
  scenario.
- **Image references are part of the prefix (Finding 17).** A different
  `ms://<file_id>` or image_url value invalidates the cache just like a
  changed system or tools field. If you re-upload the same image with a
  different file_id, you get a different prefix hash even though the bytes
  may be identical.
- **Caching is intra-session, not cross-session (Finding 18).** Within one
  `pi` session you get the full benefit of prefix growth, branch reuse,
  and exact re-send. Two cold `pi` invocations of "the same task" will not
  share cache, because pi's full payload (system + tools) drifts between
  sessions.
- **`KIMI_CODE_PROTOCOL` switching is free for cache** (Finding 10). Users
  can swap between Anthropic and OpenAI dialects mid-session without losing
  the cache they've built up.
- **Anthropic-style `cache_control` markers** generated by pi-ai's built-in
  `streamSimpleAnthropic` transport: the cache hits regardless of where (or
  whether) they're placed.
- **Device id rotation is free (Finding 19).** Multi-machine setups, agent
  forks, and a regenerated `~/.pi/providers/kimi-coding/device_id` all
  share the same prompt cache on the same Kimi account. The header drives
  attribution / rate-limiting server-side, not cache identity.

## Open questions

- **TTL exact value.** Finding 7 brackets TTL to [300s, 1800s). Narrowing
  this further (e.g. probing 600s / 900s / 1200s / 1500s) is left as a
  future probe — operationally the [5min, 30min) bracket is enough to
  inform harness design.
- **System / tools invalidation on the OpenAI-compat endpoint.** Tests 4f
  and 4j only cover `/coding/v1/messages`. The OpenAI dialect serializes
  `tools` differently (function-calling schema) and may or may not behave
  the same — though Finding 14 shows the basic cache mechanics are aligned.
- **Cross-account isolation.** Whether cache is shared across API keys /
  Moonshot accounts has privacy implications and has not been probed.
- **Cache behaviour at ~100K tokens.** Test 4r is opt-in (set
  `KIMI_E2E_SKIP_VERY_LARGE_CACHE=0`). The 32K sweep in Finding 4 holds for
  every size tested, but extreme sizes haven't been confirmed.
