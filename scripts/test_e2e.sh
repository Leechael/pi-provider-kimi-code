#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
EXT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PI_BIN="$(command -v pi)"
API_KEY="${KIMI_API_KEY:-${1:-}}"

if [ -z "$API_KEY" ]; then
  echo "Usage: KIMI_API_KEY=sk-... $0"
  echo "   or: $0 sk-..."
  exit 1
fi

export KIMI_API_KEY="$API_KEY"
export KIMI_CODE_DEBUG="${KIMI_CODE_DEBUG:-1}"
export KIMI_E2E_VERBOSE="${KIMI_E2E_VERBOSE:-1}"
export KIMI_E2E_MODEL="${KIMI_E2E_MODEL:-kimi-coding/kimi-for-coding}"
export KIMI_E2E_CACHE_INTERVALS="${KIMI_E2E_CACHE_INTERVALS:-60,300}"
export KIMI_E2E_CACHE_KEY="${KIMI_E2E_CACHE_KEY:-pi-provider-kimi-code-e2e-$$-$(date +%s)}"
export KIMI_E2E_CACHE_REPEAT="${KIMI_E2E_CACHE_REPEAT:-2000}"
export KIMI_E2E_SKIP_CACHE="${KIMI_E2E_SKIP_CACHE:-0}"
export KIMI_E2E_SKIP_CACHE_MATRIX="${KIMI_E2E_SKIP_CACHE_MATRIX:-0}"
export KIMI_E2E_SKIP_DUAL_BREAKPOINT="${KIMI_E2E_SKIP_DUAL_BREAKPOINT:-0}"
export KIMI_E2E_SKIP_CACHE_KEY_SEMANTICS="${KIMI_E2E_SKIP_CACHE_KEY_SEMANTICS:-0}"
export KIMI_E2E_SKIP_CACHE_CHAIN="${KIMI_E2E_SKIP_CACHE_CHAIN:-0}"
export KIMI_E2E_SKIP_CROSS_PROTOCOL="${KIMI_E2E_SKIP_CROSS_PROTOCOL:-0}"
export KIMI_E2E_SKIP_SYSTEM_TOOLS_CACHE="${KIMI_E2E_SKIP_SYSTEM_TOOLS_CACHE:-0}"
export KIMI_E2E_SKIP_LARGE_DELTA="${KIMI_E2E_SKIP_LARGE_DELTA:-0}"
export KIMI_E2E_SKIP_TTL_UPPER="${KIMI_E2E_SKIP_TTL_UPPER:-1}"
export KIMI_E2E_TTL_UPPER_INTERVALS="${KIMI_E2E_TTL_UPPER_INTERVALS:-1800}"
export KIMI_E2E_SKIP_BLOCK_SIZE_SWEEP="${KIMI_E2E_SKIP_BLOCK_SIZE_SWEEP:-0}"
export KIMI_E2E_SKIP_TOOLS_CHANGE="${KIMI_E2E_SKIP_TOOLS_CHANGE:-0}"
export KIMI_E2E_SKIP_SMALL_BOUNDARY="${KIMI_E2E_SKIP_SMALL_BOUNDARY:-0}"
export KIMI_E2E_SKIP_OPENAI_CACHE_BOUNDARY="${KIMI_E2E_SKIP_OPENAI_CACHE_BOUNDARY:-0}"
export KIMI_E2E_SKIP_RETENTION_NONE_PROVIDER="${KIMI_E2E_SKIP_RETENTION_NONE_PROVIDER:-0}"
export KIMI_E2E_SKIP_USAGE_FIELDS="${KIMI_E2E_SKIP_USAGE_FIELDS:-0}"
export KIMI_E2E_SKIP_NON_PROMPT_PARAMS="${KIMI_E2E_SKIP_NON_PROMPT_PARAMS:-0}"
export KIMI_E2E_SKIP_MULTIMODAL_CACHE="${KIMI_E2E_SKIP_MULTIMODAL_CACHE:-0}"
export KIMI_E2E_SKIP_CONCURRENT_CACHE="${KIMI_E2E_SKIP_CONCURRENT_CACHE:-0}"
export KIMI_E2E_SKIP_VERY_LARGE_CACHE="${KIMI_E2E_SKIP_VERY_LARGE_CACHE:-1}"
export KIMI_E2E_VERY_LARGE_REPEAT="${KIMI_E2E_VERY_LARGE_REPEAT:-12000}"

KIMI_HEADERS=(
  -H "User-Agent: KimiCLI/1.44.0"
  -H "X-Msh-Platform: kimi_cli"
  -H "X-Msh-Version: 1.44.0"
)
BASE_URL="${KIMI_CODE_BASE_URL:-https://api.kimi.com/coding/v1}"
BASE_URL="${BASE_URL%/}"

log() {
  printf '%s\n' "$*"
}

if [ "$KIMI_E2E_VERBOSE" = "1" ]; then
  log "Using extension: $EXT_DIR"
  log "Using pi binary: $PI_BIN"
  "$PI_BIN" --version
  log "Relevant env:"
  env | grep -E '^(KIMI|HTTP|HTTPS|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|PI_)' | sort || true
  log "Model under test: $KIMI_E2E_MODEL"
fi

run_pi_test() {
  local title="$1"
  local protocol="$2"
  local prompt="$3"
  shift 3

  log "=== $title ==="
  if [ "$KIMI_E2E_VERBOSE" = "1" ]; then
    log "+ KIMI_CODE_PROTOCOL=$protocol $PI_BIN -ne -e $EXT_DIR --model $KIMI_E2E_MODEL -p $prompt $*"
  fi
  KIMI_CODE_PROTOCOL="$protocol" "$PI_BIN" -ne -e "$EXT_DIR" --model "$KIMI_E2E_MODEL" -p "$prompt" "$@"
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4: Prompt Cache TTL
# ---------------------------------------------------------------------------
cache_ttl_check() {
  if [ "$KIMI_E2E_SKIP_CACHE" = "1" ]; then
    log "=== Test 4: Prompt Cache TTL (skipped) ==="
    return 0
  fi

  log "=== Test 4: Prompt Cache TTL (Anthropic endpoint) ==="
  if [ "$KIMI_E2E_VERBOSE" = "1" ]; then
    log "+ cache_key=$KIMI_E2E_CACHE_KEY intervals=$KIMI_E2E_CACHE_INTERVALS repeat=$KIMI_E2E_CACHE_REPEAT"
  fi

  python3 - <<'PY'
import json
import os
import sys
import time
import urllib.request
import urllib.error

api_key = os.environ["KIMI_API_KEY"]
cache_key = os.environ["KIMI_E2E_CACHE_KEY"]
intervals = [int(x) for x in os.environ["KIMI_E2E_CACHE_INTERVALS"].split(",") if x.strip()]
repeat = int(os.environ["KIMI_E2E_CACHE_REPEAT"])
verbose = os.environ.get("KIMI_E2E_VERBOSE", "1") == "1"

long_text = (
    f"cache-key:{cache_key}\n" +
    ("This is meaningless filler text for testing Kimi Prompt Cache TTL. " * repeat) +
    "\n\nReply with only: ok"
)
payload = {
    "model": "kimi-for-coding",
    "max_tokens": 100,
    "prompt_cache_key": cache_key,
    "messages": [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": long_text,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
        }
    ],
}
headers = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

def make_payload(round_key):
    text = long_text.replace(f"cache-key:{cache_key}", f"cache-key:{round_key}")
    return {
        "model": "kimi-for-coding",
        "max_tokens": 100,
        "prompt_cache_key": round_key,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": text, "cache_control": {"type": "ephemeral"}},
        ]}],
    }

def send(label, body_payload):
    body = json.dumps(body_payload).encode("utf-8")
    req = urllib.request.Request(
        (os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/") + "/messages"),
        data=body, headers=headers, method="POST",
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8")
            elapsed = time.time() - start
            data = json.loads(raw)
            usage = data.get("usage", {})
            cache_read = max(
                int(usage.get("cache_read_input_tokens", 0) or 0),
                int(usage.get("cached_tokens", 0) or 0),
            )
            cache_create = int(usage.get("cache_creation_input_tokens", 0) or 0)
            input_tokens = int(usage.get("input_tokens", 0) or 0)
            print(f"[{time.strftime('%X')}] {label}: status=200 elapsed={elapsed:.2f}s input={input_tokens} cache_read={cache_read} cache_create={cache_create}", flush=True)
            if verbose:
                print(f"usage={json.dumps(usage, ensure_ascii=False)}", flush=True)
            return cache_read
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print(f"[{time.strftime('%X')}] {label}: status={e.code} body={err_body}", flush=True)
        return -1
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: request failed: {e}", flush=True)
        return -1

import concurrent.futures, copy

def run_probe(target):
    """Independent round: warmup -> sleep -> single probe. Returns (target, hit)."""
    round_key = f"{cache_key}-{target}s"
    p = make_payload(round_key)
    print(f"--- Round {target}s: warmup (key={round_key}) ---", flush=True)
    send(f"warmup_{target}s", p)
    print(f"[round {target}s] sleeping {target}s...", flush=True)
    time.sleep(target)
    cache_read = send(f"probe_at_{target}s", p)
    hit = cache_read > 0
    print(f"[round {target}s] result: {'HIT' if hit else 'MISS'}\n", flush=True)
    return (target, hit)

# Run all intervals concurrently
with concurrent.futures.ThreadPoolExecutor(max_workers=len(intervals)) as pool:
    futures = {pool.submit(run_probe, t): t for t in intervals}
    probe_results = []
    for f in concurrent.futures.as_completed(futures):
        probe_results.append(f.result())

probe_results.sort()

# --- Conclusion ---
print()
hits = [t for t, hit in probe_results if hit]
misses = [t for t, hit in probe_results if not hit]
summary = " | ".join(f"{t}s={'HIT' if hit else 'MISS'}" for t, hit in probe_results)
print(f"Summary: {summary}")
if hits and misses:
    last_hit = max(hits)
    first_miss = min(misses)
    if first_miss > last_hit:
        print(f"Conclusion: TTL is between {last_hit}s and {first_miss}s.")
    else:
        print(f"Conclusion: mixed results (hits: {hits}, misses: {misses}). Cache behavior may be non-deterministic.")
elif hits:
    print(f"Conclusion: TTL >= {max(hits)}s (all probes hit).")
elif misses:
    print(f"Conclusion: TTL < {min(misses)}s (all probes missed).")
else:
    print("Conclusion: no probes ran.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4a: Cache Mechanism Isolation
# ---------------------------------------------------------------------------
# Determines which mechanism (Anthropic-style cache_control vs Kimi-native
# prompt_cache_key) actually drives cache hits on the Anthropic-compat
# /messages endpoint. Sends 4 payload variants:
#   A) cache_control only         B) prompt_cache_key only
#   C) both                       D) neither
# Each variant uses its own salted content + key so they don't share cache.
# Variants run in parallel; each does warmup -> 5s sleep -> probe.
cache_mechanism_isolation_check() {
  if [ "${KIMI_E2E_SKIP_CACHE_MATRIX:-0}" = "1" ]; then
    log "=== Test 4a: Cache Mechanism Isolation (skipped) ==="
    return 0
  fi

  log "=== Test 4a: Cache Mechanism Isolation (Anthropic endpoint) ==="

  python3 - <<'PY'
import concurrent.futures
import json
import os
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
verbose = os.environ.get("KIMI_E2E_VERBOSE", "1") == "1"
repeat = int(os.environ.get("KIMI_E2E_CACHE_REPEAT", "2000"))

filler = "This is meaningless filler text for testing Kimi Prompt Cache. " * repeat

headers = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

def build_payload(salt, use_cache_control, prompt_cache_key):
    text = f"variant:{salt}\n{filler}\n\nReply with only: ok"
    block = {"type": "text", "text": text}
    if use_cache_control:
        block["cache_control"] = {"type": "ephemeral"}
    payload = {
        "model": "kimi-for-coding",
        "max_tokens": 50,
        "messages": [{"role": "user", "content": [block]}],
    }
    if prompt_cache_key:
        payload["prompt_cache_key"] = prompt_cache_key
    return payload

def send(label, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        (os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/") + "/messages"),
        data=body, headers=headers, method="POST",
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            cache_read = max(
                int(u.get("cache_read_input_tokens", 0) or 0),
                int(u.get("cached_tokens", 0) or 0),
            )
            cache_create = int(u.get("cache_creation_input_tokens", 0) or 0)
            input_tokens = int(u.get("input_tokens", 0) or 0)
            print(f"[{time.strftime('%X')}] {label}: input={input_tokens} cache_read={cache_read} cache_create={cache_create} elapsed={elapsed:.2f}s", flush=True)
            if verbose:
                print(f"  usage={json.dumps(u, ensure_ascii=False)}", flush=True)
            return cache_read
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return -1
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return -1

def run_variant(name, use_cc, use_key):
    salt = f"{name}-{uuid.uuid4()}"
    pcache_key = f"isolation-{salt}" if use_key else None
    payload = build_payload(salt, use_cc, pcache_key)
    print(f"--- Variant {name} (cache_control={use_cc}, prompt_cache_key={'set' if use_key else 'unset'}) ---", flush=True)
    send(f"warmup_{name}", payload)
    time.sleep(5)
    cache_read = send(f"probe_{name}", payload)
    return name, cache_read

variants = [
    ("A_cc_only",  True,  False),
    ("B_key_only", False, True),
    ("C_both",     True,  True),
    ("D_neither",  False, False),
]

with concurrent.futures.ThreadPoolExecutor(max_workers=len(variants)) as pool:
    futures = [pool.submit(run_variant, *v) for v in variants]
    results = [f.result() for f in concurrent.futures.as_completed(futures)]

results.sort()
print()
print("Variant matrix (probe cache_read_input_tokens):")
hits = set()
for name, read in results:
    hit = read > 0
    if hit:
        hits.add(name)
    print(f"  {name}: {'HIT' if hit else 'MISS'} (cache_read={read})")

print()
if "A_cc_only" in hits and "B_key_only" not in hits:
    print("Conclusion: Kimi /messages honors cache_control. prompt_cache_key alone does NOT cache.")
elif "B_key_only" in hits and "A_cc_only" not in hits:
    print("Conclusion: Kimi /messages honors prompt_cache_key. cache_control alone does NOT cache.")
elif "A_cc_only" in hits and "B_key_only" in hits:
    print("Conclusion: Both mechanisms cache independently on Kimi /messages.")
elif "C_both" in hits and "A_cc_only" not in hits and "B_key_only" not in hits:
    print("Conclusion: Cache hit requires BOTH mechanisms set together.")
elif not hits:
    print("Conclusion: No cache hits across all 4 variants. Cache disabled, or warmup->probe gap too short.")
else:
    print(f"Conclusion: inconclusive. Hits = {sorted(hits)}")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4b: Dual Cache-Breakpoint vs Single Cache-Breakpoint
# ---------------------------------------------------------------------------
# Multi-turn conversation containing assistant tool_use. Compares two marker
# strategies:
#   single: cache_control only on the last block of the last user message
#   dual:   cache_control on the last assistant tool_use AND the last user
#
# Each variant warms with a turn-N payload, sleeps 5s, then probes with
# turn-N+1 (turn-N plus one more assistant+tool_use round and one more user
# message). Measures cache_read_input_tokens on the probe. If dual reads
# substantially more than single, the optimization claimed by
# pi-better-messages-cache (PR #1737) applies to Kimi.
dual_breakpoint_check() {
  if [ "${KIMI_E2E_SKIP_DUAL_BREAKPOINT:-0}" = "1" ]; then
    log "=== Test 4b: Dual vs Single Cache-Breakpoint (skipped) ==="
    return 0
  fi

  log "=== Test 4b: Dual vs Single Cache-Breakpoint (Anthropic endpoint) ==="

  python3 - <<'PY'
import concurrent.futures
import json
import os
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
verbose = os.environ.get("KIMI_E2E_VERBOSE", "1") == "1"
repeat = int(os.environ.get("KIMI_E2E_CACHE_REPEAT", "2000"))

filler = "This is meaningless filler text for testing Kimi Prompt Cache. " * repeat

headers = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

# Tool declared in every request so the assistant tool_use history is
# self-consistent. Without this, some endpoints reject historical tool_use
# blocks whose tool name isn't in the current request's tools list.
TOOLS = [{
    "name": "Read",
    "description": "Read a file from the filesystem.",
    "input_schema": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
}]

def build_turn_n(salt):
    big_user_text = f"variant:{salt}\n{filler}\n\nPlease read package.json and report the version."
    return [
        {"role": "user", "content": [
            {"type": "text", "text": big_user_text},
        ]},
        {"role": "assistant", "content": [
            {"type": "text", "text": "I'll read package.json."},
            {"type": "tool_use", "id": f"toolu_{salt}_1", "name": "Read",
             "input": {"path": "package.json"}},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": f"toolu_{salt}_1",
             "content": '{\n  "name": "demo",\n  "version": "1.0.0"\n}'},
            {"type": "text", "text": "thanks, now wait for the next question"},
        ]},
    ]

def build_turn_n_plus_1(salt):
    msgs = build_turn_n(salt)
    msgs.append({"role": "assistant", "content": [
        {"type": "text", "text": "Acknowledged. What's next?"},
        {"type": "tool_use", "id": f"toolu_{salt}_2", "name": "Read",
         "input": {"path": "README.md"}},
    ]})
    msgs.append({"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": f"toolu_{salt}_2",
         "content": "# Demo\n\nThis is a demo README for cache testing."},
        {"type": "text", "text": "summarize both files in one sentence"},
    ]})
    return msgs

def apply_single_marker(messages):
    """Mark only the last block of the last (user) message."""
    last_msg = messages[-1]
    last_msg["content"][-1]["cache_control"] = {"type": "ephemeral"}

def apply_dual_marker(messages):
    """Mark last assistant tool_use + last user block (pi-better-messages-cache strategy)."""
    apply_single_marker(messages)
    for msg in reversed(messages):
        if msg["role"] == "assistant":
            for block in reversed(msg["content"]):
                if block.get("type") == "tool_use":
                    block["cache_control"] = {"type": "ephemeral"}
                    return
            return

def send(label, messages):
    payload = {
        "model": "kimi-for-coding",
        "max_tokens": 100,
        "tools": TOOLS,
        "messages": messages,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        (os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/") + "/messages"),
        data=body, headers=headers, method="POST",
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            cache_read = max(
                int(u.get("cache_read_input_tokens", 0) or 0),
                int(u.get("cached_tokens", 0) or 0),
            )
            cache_create = int(u.get("cache_creation_input_tokens", 0) or 0)
            input_tokens = int(u.get("input_tokens", 0) or 0)
            print(f"[{time.strftime('%X')}] {label}: input={input_tokens} cache_read={cache_read} cache_create={cache_create} elapsed={elapsed:.2f}s", flush=True)
            if verbose:
                print(f"  usage={json.dumps(u, ensure_ascii=False)}", flush=True)
            return cache_read, input_tokens
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return -1, -1
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return -1, -1

def run_variant(name, marker_fn):
    salt = f"{name}-{uuid.uuid4()}"
    turn_n = build_turn_n(salt)
    marker_fn(turn_n)
    print(f"--- Variant {name}: warm turn N ---", flush=True)
    send(f"{name}_warm_turn_N", turn_n)
    time.sleep(5)

    turn_n1 = build_turn_n_plus_1(salt)
    marker_fn(turn_n1)
    print(f"--- Variant {name}: probe turn N+1 ---", flush=True)
    cache_read, input_tokens = send(f"{name}_probe_turn_N+1", turn_n1)
    return name, cache_read, input_tokens

variants = [
    ("single", apply_single_marker),
    ("dual",   apply_dual_marker),
]

with concurrent.futures.ThreadPoolExecutor(max_workers=len(variants)) as pool:
    futures = [pool.submit(run_variant, *v) for v in variants]
    results = [f.result() for f in concurrent.futures.as_completed(futures)]

results.sort()
print()
print("Turn N+1 probe results:")
data = {}
for name, cache_read, input_tokens in results:
    pct = (cache_read / input_tokens * 100.0) if input_tokens > 0 else 0.0
    data[name] = (cache_read, input_tokens, pct)
    print(f"  {name}: cache_read={cache_read}/{input_tokens} ({pct:.1f}%)")

print()
single = data.get("single")
dual = data.get("dual")
if single and dual and single[0] >= 0 and dual[0] >= 0:
    if dual[0] > single[0] * 1.05:
        delta = dual[0] - single[0]
        print(f"Conclusion: Dual marker reads MORE cache than single (+{delta} tokens, {dual[0]} vs {single[0]}). Worth adopting.")
    elif single[0] > dual[0] * 1.05:
        delta = single[0] - dual[0]
        print(f"Conclusion: Single marker reads MORE cache than dual (+{delta} tokens, {single[0]} vs {dual[0]}). Unexpected.")
    elif single[0] == 0 and dual[0] == 0:
        print("Conclusion: Neither variant read cache. Either the warm->probe gap is too short, or cache_control on multi-turn payloads is not honored.")
    else:
        print(f"Conclusion: Single and dual read similar amounts ({single[0]} vs {dual[0]}). No measurable benefit from dual marking on this workload.")
else:
    print("Conclusion: One or both variants failed; inconclusive.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4c: Cache Key Semantics (multi-agent collision check)
# ---------------------------------------------------------------------------
# Test 4a established that all 4 variants (key/no-key, cc/no-cc) HIT, but those
# variants used distinct content, so they couldn't collide by construction.
# 4c directly attacks the question: does prompt_cache_key participate in cache
# identity, or is it cosmetic?
#
# V1 (collision): same prompt_cache_key, two different contents.
#   warm X with key K -> warm Y with key K -> probe X with key K.
#   - X probe HIT  => key is ignored (cache is content-only, agents safe)
#   - X probe MISS => Y evicted X (key-keyed slot, agents collide)
#
# V2 (segregation): same content, two different keys.
#   warm with K1 -> probe with K2.
#   - probe HIT  => key is fully ignored
#   - probe MISS => key partitions cache (cross-key isolation)
cache_key_semantics_check() {
  if [ "${KIMI_E2E_SKIP_CACHE_KEY_SEMANTICS:-0}" = "1" ]; then
    log "=== Test 4c: Cache Key Semantics (skipped) ==="
    return 0
  fi

  log "=== Test 4c: Cache Key Semantics (Anthropic endpoint) ==="

  python3 - <<'PY'
import concurrent.futures
import json
import os
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
verbose = os.environ.get("KIMI_E2E_VERBOSE", "1") == "1"
repeat = int(os.environ.get("KIMI_E2E_CACHE_REPEAT", "2000"))

filler = "This is meaningless filler text for testing Kimi Prompt Cache. " * repeat

headers = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

def build_payload(salt, prompt_cache_key=None):
    text = f"semantics:{salt}\n{filler}\n\nReply with only: ok"
    payload = {
        "model": "kimi-for-coding",
        "max_tokens": 50,
        "messages": [{"role": "user", "content": [{"type": "text", "text": text}]}],
    }
    if prompt_cache_key:
        payload["prompt_cache_key"] = prompt_cache_key
    return payload

def send(label, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        (os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/") + "/messages"),
        data=body, headers=headers, method="POST",
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            cache_read = max(
                int(u.get("cache_read_input_tokens", 0) or 0),
                int(u.get("cached_tokens", 0) or 0),
            )
            cache_create = int(u.get("cache_creation_input_tokens", 0) or 0)
            input_tokens = int(u.get("input_tokens", 0) or 0)
            print(f"[{time.strftime('%X')}] {label}: input={input_tokens} cache_read={cache_read} cache_create={cache_create} elapsed={elapsed:.2f}s", flush=True)
            if verbose:
                print(f"  usage={json.dumps(u, ensure_ascii=False)}", flush=True)
            return cache_read
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return -1
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return -1

def run_v1_collision():
    shared_key = f"v1-shared-{uuid.uuid4()}"
    salt_x = f"v1x-{uuid.uuid4()}"
    salt_y = f"v1y-{uuid.uuid4()}"
    px = build_payload(salt_x, shared_key)
    py = build_payload(salt_y, shared_key)

    print(f"--- V1 collision: shared_key={shared_key} ---", flush=True)
    send("v1_warm_X", px)
    send("v1_warm_Y", py)
    time.sleep(3)
    read_x = send("v1_probe_X", px)
    read_y = send("v1_probe_Y", py)
    return read_x, read_y

def run_v2_segregation():
    salt = f"v2-{uuid.uuid4()}"
    k1 = f"v2-k1-{uuid.uuid4()}"
    k2 = f"v2-k2-{uuid.uuid4()}"
    p1 = build_payload(salt, k1)
    p2 = build_payload(salt, k2)  # IDENTICAL content, different key

    print(f"--- V2 segregation: same content, K1={k1} K2={k2} ---", flush=True)
    send("v2_warm_with_K1", p1)
    time.sleep(3)
    read_k2 = send("v2_probe_with_K2", p2)
    return read_k2

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    fut_v1 = pool.submit(run_v1_collision)
    fut_v2 = pool.submit(run_v2_segregation)
    read_x, read_y = fut_v1.result()
    read_k2 = fut_v2.result()

v1_x_hit = read_x > 0
v1_y_hit = read_y > 0
v2_hit = read_k2 > 0

print()
print("Results:")
print(f"  V1.X probe (warmed first, same key as Y): {'HIT' if v1_x_hit else 'MISS'} (cache_read={read_x})")
print(f"  V1.Y probe (warmed second, same key as X): {'HIT' if v1_y_hit else 'MISS'} (cache_read={read_y})")
print(f"  V2 probe (same content, different key from warmup): {'HIT' if v2_hit else 'MISS'} (cache_read={read_k2})")

print()
if v1_x_hit and v1_y_hit and v2_hit:
    print("Verdict: prompt_cache_key is FULLY IGNORED. Cache identity = content hash only.")
    print("  - Two agents with different content cannot collide via key.")
    print("  - Two agents with same content (overlapping prefix) share cache => free hit.")
elif (not v1_x_hit) and v1_y_hit:
    print("Verdict: prompt_cache_key enforces SINGLE-SLOT EVICTION. Y evicted X.")
    print("  - WARNING: two agents sharing a key will trash each other's cache.")
elif v1_x_hit and v1_y_hit and not v2_hit:
    print("Verdict: prompt_cache_key PARTITIONS cache (segregation, no eviction).")
    print("  - Different agents get different cache spaces; same key required to hit.")
elif (not v1_x_hit) and (not v1_y_hit) and (not v2_hit):
    print("Verdict: no cache hits at all. Either the warmup gap is too short, or cache is disabled.")
else:
    print(f"Verdict: unexpected combination. v1_x={v1_x_hit} v1_y={v1_y_hit} v2={v2_hit}")
    print("  Need follow-up investigation.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4d: Cache Chain Growth, Persistence, and Divergent Branch
# ---------------------------------------------------------------------------
# 4a/4b/4c established that markers are decorative and cache identity is
# content-hash. 4d directly tests the multi-turn dynamics that matter for a
# coding agent:
#
# Phase 1 (chain growth): send turns 1..5 of a growing conversation. Each turn
#   appends ~50 new tokens to a ~10K-token base. Expectation: turn N's
#   cache_read >= turn N-1's prompt_tokens (delta-only processing).
#
# Phase 2 (persistence): after the chain, re-send earlier turns standalone.
#   Expectation: HIT (older prefixes still readable from cache).
#
# Phase 3 (divergent branch): build a 5-turn variant that branches off at
#   turn 4 (turns 1..3 identical to main, turns 4..5 differ). Expectation:
#   cache_read ~= main turn 3's prompt_tokens (shared prefix is reused).
#
# Also reports cumulative cache_creation_input_tokens (expected: 0 — Kimi
# does not surface cache writes).
cache_chain_check() {
  if [ "${KIMI_E2E_SKIP_CACHE_CHAIN:-0}" = "1" ]; then
    log "=== Test 4d: Cache Chain / Persistence / Branch (skipped) ==="
    return 0
  fi

  log "=== Test 4d: Cache Chain / Persistence / Branch (Anthropic endpoint) ==="

  python3 - <<'PY'
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
verbose = os.environ.get("KIMI_E2E_VERBOSE", "1") == "1"

filler = "This is meaningless filler text for testing Kimi Prompt Cache chain growth. " * 800

headers = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

salt = f"chain-{uuid.uuid4()}"
base_user_text = f"chain-base:{salt}\n{filler}\n\nWe'll have a multi-turn chat. Reply ok-1."

def build_main(turn_n):
    """Linear chain through `turn_n` turns (turn 1 = base only, each new turn
    appends one assistant ack + one user follow-up)."""
    msgs = [{"role": "user", "content": [{"type": "text", "text": base_user_text}]}]
    for i in range(1, turn_n):
        msgs.append({"role": "assistant", "content": [{"type": "text", "text": f"ok-{i}"}]})
        msgs.append({"role": "user", "content": [{"type": "text", "text": f"Question {i+1}. Reply ok-{i+1}."}]})
    return msgs

def build_branch(turn_n, branch_from):
    """Same as build_main, but everything from turn `branch_from` onward gets
    a 'B' suffix so the content diverges past that point."""
    msgs = [{"role": "user", "content": [{"type": "text", "text": base_user_text}]}]
    for i in range(1, turn_n):
        lbl = "B" if i >= branch_from else ""
        msgs.append({"role": "assistant", "content": [{"type": "text", "text": f"ok-{i}{lbl}"}]})
        msgs.append({"role": "user", "content": [{"type": "text", "text": f"Question {i+1}{lbl}. Reply ok-{i+1}{lbl}."}]})
    return msgs

def send(label, messages):
    payload = {
        "model": "kimi-for-coding",
        "max_tokens": 30,
        "messages": messages,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        (os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/") + "/messages"),
        data=body, headers=headers, method="POST",
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            cache_read = max(
                int(u.get("cache_read_input_tokens", 0) or 0),
                int(u.get("cached_tokens", 0) or 0),
            )
            cache_create = int(u.get("cache_creation_input_tokens", 0) or 0)
            input_tokens = int(u.get("input_tokens", 0) or 0)
            prompt_tokens = int(u.get("prompt_tokens", 0) or 0)
            print(f"[{time.strftime('%X')}] {label}: prompt={prompt_tokens} new_input={input_tokens} cache_read={cache_read} cache_create={cache_create} elapsed={elapsed:.2f}s", flush=True)
            return {
                "new_input": input_tokens,
                "prompt": prompt_tokens,
                "cache_read": cache_read,
                "cache_create": cache_create,
            }
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return None
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return None

# Phase 1: linear chain growth
print("--- Phase 1: linear chain growth (5 turns) ---", flush=True)
chain = []
for n in range(1, 6):
    r = send(f"chain_turn_{n}", build_main(n))
    if r is None:
        print("Phase 1 aborted (HTTP error).", flush=True)
        sys.exit(0)
    chain.append((n, r))
    time.sleep(1)

# Phase 2: re-probe earlier turns
print("--- Phase 2: re-probe earlier turns ---", flush=True)
reprobes = {}
for n in [1, 3]:
    r = send(f"reprobe_turn_{n}", build_main(n))
    if r is not None:
        reprobes[n] = r
    time.sleep(1)

# Phase 3: divergent branch
print("--- Phase 3: divergent branch from turn 4 ---", flush=True)
branch = send("branch_from_turn_4", build_branch(5, branch_from=4))

# ---- Summary tables ----
print()
print("Phase 1 chain growth:")
print(f"  {'turn':<6}{'prompt':>10}{'cache_read':>14}{'new_input':>12}{'cache_create':>14}")
for n, r in chain:
    print(f"  {n:<6}{r['prompt']:>10}{r['cache_read']:>14}{r['new_input']:>12}{r['cache_create']:>14}")

print()
print("Phase 2 re-probe:")
for n, r in reprobes.items():
    print(f"  turn {n}: prompt={r['prompt']} cache_read={r['cache_read']} ({'HIT' if r['cache_read'] > 0 else 'MISS'})")

print()
print("Phase 3 branch:")
if branch:
    expected_shared = chain[2][1]["prompt"]  # main turn 3
    ratio = (branch["cache_read"] / expected_shared * 100.0) if expected_shared > 0 else 0.0
    print(f"  branch from turn 4: prompt={branch['prompt']} cache_read={branch['cache_read']}")
    print(f"  (main turn 3 prompt was {expected_shared}; cache_read / main_turn_3 = {ratio:.1f}%)")
else:
    print("  branch request failed")

# ---- Verdicts ----
print()
# V1: chain growth
chain_ok = chain[0][1]["cache_read"] == 0  # turn 1 must miss (first send)
for i in range(1, len(chain)):
    prev_prompt = chain[i-1][1]["prompt"]
    this_cache_read = chain[i][1]["cache_read"]
    if this_cache_read < prev_prompt * 0.95:
        chain_ok = False
        print(f"  [chain growth FAIL] turn {chain[i][0]}: cache_read={this_cache_read} < 95% of prev_prompt={prev_prompt}")
if chain_ok:
    print("Verdict 1: CHAIN GROWTH WORKS. Each new turn reads the previous prefix; only the delta is processed.")
else:
    print("Verdict 1: chain growth broken (see flags above).")

# V2: persistence
persistence_ok = all(r["cache_read"] > 0 for r in reprobes.values())
if persistence_ok:
    print("Verdict 2: OLD PREFIXES PERSIST. Re-sending earlier turns still HITs after newer turns were cached.")
else:
    miss = [n for n, r in reprobes.items() if r["cache_read"] == 0]
    print(f"Verdict 2: older prefixes evicted for turn(s) {miss}.")

# V3: divergent branch
if branch and branch["cache_read"] > 0:
    expected = chain[2][1]["prompt"]
    ratio = branch["cache_read"] / expected if expected > 0 else 0
    if 0.95 <= ratio <= 1.05:
        print(f"Verdict 3: BRANCH REUSES SHARED PREFIX. cache_read ({branch['cache_read']}) ~= main turn 3 prompt ({expected}).")
    elif ratio > 0.5:
        print(f"Verdict 3: branch reused PARTIAL shared prefix. cache_read={branch['cache_read']}, ratio={ratio:.1%} of main turn 3.")
    else:
        print(f"Verdict 3: branch cache_read={branch['cache_read']} is below expected shared prefix size {expected}.")
else:
    print("Verdict 3: branch did NOT hit cache. Either Kimi only caches exact-final-message payloads, or test failed.")

# V4: cache_creation surface area
total_create = sum(r["cache_create"] for _, r in chain) \
             + sum(r["cache_create"] for r in reprobes.values()) \
             + (branch["cache_create"] if branch else 0)
if total_create == 0:
    print("Verdict 4: cache_creation_input_tokens is 0 across ALL requests. Kimi does not surface cache writes (no visible per-write cost).")
else:
    print(f"Verdict 4: cache_creation_input_tokens total = {total_create} across all requests.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4e: Cross-Protocol Cache Share
# ---------------------------------------------------------------------------
# Warm via one protocol, probe via the other with content that maps to the
# same underlying tokens. Two directions:
#   A) Anthropic /messages -> OpenAI /chat/completions
#   B) OpenAI /chat/completions -> Anthropic /messages
# If both probes HIT, the cache is keyed below the protocol layer and
# KIMI_CODE_PROTOCOL switching does not invalidate.
cross_protocol_cache_check() {
  if [ "${KIMI_E2E_SKIP_CROSS_PROTOCOL:-0}" = "1" ]; then
    log "=== Test 4e: Cross-Protocol Cache Share (skipped) ==="
    return 0
  fi

  log "=== Test 4e: Cross-Protocol Cache Share ==="

  python3 - <<'PY'
import json
import os
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
verbose = os.environ.get("KIMI_E2E_VERBOSE", "1") == "1"
repeat = int(os.environ.get("KIMI_E2E_CACHE_REPEAT", "2000"))

filler = "This is meaningless filler text for testing Kimi Prompt Cache. " * repeat

ANTHROPIC_HEADERS = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}
OPENAI_HEADERS = {
    "Authorization": f"Bearer {api_key}",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

def _post(label, url, payload, headers):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            details = u.get("prompt_tokens_details") or {}
            cache_read = max(
                int(u.get("cache_read_input_tokens", 0) or 0),
                int(u.get("cached_tokens", 0) or 0),
                int(details.get("cached_tokens", 0) or 0),
            )
            prompt = int(u.get("prompt_tokens", 0) or u.get("input_tokens", 0) or 0)
            new_input = int(u.get("input_tokens", 0) or max(prompt - cache_read, 0))
            print(f"[{time.strftime('%X')}] {label}: prompt={prompt} cache_read={cache_read} new_input={new_input} elapsed={elapsed:.2f}s", flush=True)
            if verbose:
                print(f"  usage={json.dumps(u, ensure_ascii=False)}", flush=True)
            return cache_read
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return -1
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return -1

def send_anthropic(label, text):
    payload = {
        "model": "kimi-for-coding",
        "max_tokens": 50,
        "messages": [{"role": "user", "content": [{"type": "text", "text": text}]}],
    }
    return _post(label, (os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/") + "/messages"), payload, ANTHROPIC_HEADERS)

def send_openai(label, text):
    payload = {
        "model": "kimi-for-coding",
        "max_tokens": 50,
        "messages": [{"role": "user", "content": text}],
    }
    return _post(label, (os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/") + "/chat/completions"), payload, OPENAI_HEADERS)

# Direction A: warm anthropic, probe openai
salt_a = f"xprotoA-{uuid.uuid4()}"
text_a = f"variant:{salt_a}\n{filler}\n\nReply with only: ok"
print("--- Direction A: warm /messages -> probe /chat/completions ---", flush=True)
send_anthropic("A_warm_anthropic", text_a)
time.sleep(3)
read_a = send_openai("A_probe_openai", text_a)

# Direction B: warm openai, probe anthropic
salt_b = f"xprotoB-{uuid.uuid4()}"
text_b = f"variant:{salt_b}\n{filler}\n\nReply with only: ok"
print("--- Direction B: warm /chat/completions -> probe /messages ---", flush=True)
send_openai("B_warm_openai", text_b)
time.sleep(3)
read_b = send_anthropic("B_probe_anthropic", text_b)

# Thresholds: ignore tiny system-level cache hits (a few dozen tokens) — we
# only care if the bulk of the filler-laden prompt comes from cache.
threshold = 1000
a_hit = read_a > threshold
b_hit = read_b > threshold

print()
print(f"Direction A (anthropic -> openai): cache_read={read_a} ({'HIT' if a_hit else 'MISS'})")
print(f"Direction B (openai -> anthropic): cache_read={read_b} ({'HIT' if b_hit else 'MISS'})")
print()
if a_hit and b_hit:
    print("Verdict: cache is SHARED across protocols. KIMI_CODE_PROTOCOL switching does NOT invalidate cache.")
elif (not a_hit) and (not b_hit):
    print("Verdict: caches are SEPARATE per protocol. Switching KIMI_CODE_PROTOCOL forces a cold prefix.")
else:
    print(f"Verdict: asymmetric. anthropic->openai={'HIT' if a_hit else 'MISS'}, openai->anthropic={'HIT' if b_hit else 'MISS'}.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4f: System Prompt & Tools in Cached Prefix
# ---------------------------------------------------------------------------
# Anthropic API treats `system` and `tools` as fields separate from `messages`.
# We probe whether changing them invalidates the messages-level cache.
#
# F0 (baseline): identical system + messages -> expect full HIT
# F1: same messages, different system text -> does messages cache survive?
# F2: same messages+system, add tools on probe -> impact?
# F3: warm with system, probe without system -> impact?
system_tools_cache_check() {
  if [ "${KIMI_E2E_SKIP_SYSTEM_TOOLS_CACHE:-0}" = "1" ]; then
    log "=== Test 4f: System / Tools Cache Participation (skipped) ==="
    return 0
  fi

  log "=== Test 4f: System / Tools Cache Participation (Anthropic endpoint) ==="

  python3 - <<'PY'
import json
import os
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
verbose = os.environ.get("KIMI_E2E_VERBOSE", "1") == "1"
repeat = int(os.environ.get("KIMI_E2E_CACHE_REPEAT", "2000"))

filler = "This is meaningless filler text for testing system/tools cache impact. " * repeat

headers = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

DEMO_TOOLS = [{
    "name": "Read",
    "description": "Read a file from the filesystem.",
    "input_schema": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
}]

def build_payload(salt, system=None, tools=None):
    text = f"variant:{salt}\n{filler}\n\nReply with only: ok"
    payload = {
        "model": "kimi-for-coding",
        "max_tokens": 50,
        "messages": [{"role": "user", "content": [{"type": "text", "text": text}]}],
    }
    if system is not None:
        payload["system"] = system
    if tools is not None:
        payload["tools"] = tools
    return payload

def send(label, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        (os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/") + "/messages"),
        data=body, headers=headers, method="POST",
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            cache_read = max(
                int(u.get("cache_read_input_tokens", 0) or 0),
                int(u.get("cached_tokens", 0) or 0),
            )
            prompt = int(u.get("prompt_tokens", 0) or u.get("input_tokens", 0) or 0)
            print(f"[{time.strftime('%X')}] {label}: prompt={prompt} cache_read={cache_read} elapsed={elapsed:.2f}s", flush=True)
            return cache_read, prompt
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return -1, -1
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return -1, -1

def run(name, warm_payload, probe_payload):
    print(f"--- {name} ---", flush=True)
    send(f"{name}_warm", warm_payload)
    time.sleep(3)
    return send(f"{name}_probe", probe_payload)

# F0 baseline: identical system + messages -> expect full HIT
salt0 = f"F0-{uuid.uuid4()}"
sys_helpful = "You are a helpful assistant."
p0 = build_payload(salt0, system=sys_helpful)
f0_read, f0_prompt = run("F0_baseline", p0, p0)

# F1: same messages, different system
salt1 = f"F1-{uuid.uuid4()}"
sys_concise = "You are a concise coding expert. Reply briefly."
p1a = build_payload(salt1, system=sys_helpful)
p1b = build_payload(salt1, system=sys_concise)
f1_read, f1_prompt = run("F1_system_changed", p1a, p1b)

# F2: same messages+system, add tools on probe
salt2 = f"F2-{uuid.uuid4()}"
p2a = build_payload(salt2, system=sys_helpful)
p2b = build_payload(salt2, system=sys_helpful, tools=DEMO_TOOLS)
f2_read, f2_prompt = run("F2_tools_added", p2a, p2b)

# F3: warm with system, probe without
salt3 = f"F3-{uuid.uuid4()}"
p3a = build_payload(salt3, system=sys_helpful)
p3b = build_payload(salt3)
f3_read, f3_prompt = run("F3_system_removed", p3a, p3b)

# Analysis
print()
print("Results:")
print(f"  F0 baseline:        cache_read={f0_read} / prompt={f0_prompt}")
print(f"  F1 system changed:  cache_read={f1_read} / prompt={f1_prompt}")
print(f"  F2 tools added:     cache_read={f2_read} / prompt={f2_prompt}")
print(f"  F3 system removed:  cache_read={f3_read} / prompt={f3_prompt}")

print()
if f0_read > 0:
    def ratio(r):
        return (r / f0_read) if (r >= 0 and f0_read > 0) else 0
    r1 = ratio(f1_read)
    r2 = ratio(f2_read)
    r3 = ratio(f3_read)
    print(f"Ratios vs F0 baseline: F1={r1:.1%}  F2={r2:.1%}  F3={r3:.1%}")
    if r1 > 0.9 and r2 > 0.9 and r3 > 0.9:
        print("Verdict: system & tools cache INDEPENDENTLY from messages. Changing them does not invalidate the messages cache.")
    elif r1 < 0.2 and r2 < 0.2 and r3 < 0.2:
        print("Verdict: system & tools are part of the PREFIX. Changing them fully invalidates cache.")
    else:
        print("Verdict: mixed behavior. Some changes invalidate (or partially invalidate) the cache.")
else:
    print("Verdict: F0 baseline failed; cannot interpret.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4g: Large Delta Cross-Boundary
# ---------------------------------------------------------------------------
# Verifies that a single turn whose new content crosses multiple 256-token
# chunk boundaries still caches the intermediate chunks for the NEXT turn.
#
# Sends three payloads sequentially:
#   P1 ~5K tokens   (small base)
#   P2 ~15K tokens  (P1 + ~10K assistant/user middle)
#   P3 ~15K + 50    (P2 + tiny follow-up)
# Expects:
#   - P2 cache_read ~ chunk-floor of P1
#   - P3 cache_read ~ chunk-floor of P2 (proves the 10K middle was cached past
#     the P1 boundary)
large_delta_check() {
  if [ "${KIMI_E2E_SKIP_LARGE_DELTA:-0}" = "1" ]; then
    log "=== Test 4g: Large Delta Cross-Boundary (skipped) ==="
    return 0
  fi

  log "=== Test 4g: Large Delta Cross-Boundary (Anthropic endpoint) ==="

  python3 - <<'PY'
import json
import os
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
verbose = os.environ.get("KIMI_E2E_VERBOSE", "1") == "1"

base_filler = "small text " * 400  # ~5K tokens base
mid_filler = "midfiller text padding for cross-boundary delta test " * 1500  # ~10K tokens

headers = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

salt = f"largedelta-{uuid.uuid4()}"
base_text = f"base:{salt}\n{base_filler}\n\nWe'll have a multi-turn chat. Reply ok-1."

def build(layer):
    msgs = [{"role": "user", "content": [{"type": "text", "text": base_text}]}]
    if layer >= 2:
        msgs.append({"role": "assistant", "content": [{"type": "text", "text": "ok-1"}]})
        msgs.append({"role": "user", "content": [{"type": "text", "text": f"mid:{salt}\n{mid_filler}\n\nNow reply ok-2."}]})
    if layer >= 3:
        msgs.append({"role": "assistant", "content": [{"type": "text", "text": "ok-2"}]})
        msgs.append({"role": "user", "content": [{"type": "text", "text": "small follow-up. Reply ok-3."}]})
    return msgs

def send(label, messages):
    payload = {
        "model": "kimi-for-coding",
        "max_tokens": 30,
        "messages": messages,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        (os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/") + "/messages"),
        data=body, headers=headers, method="POST",
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            cache_read = max(
                int(u.get("cache_read_input_tokens", 0) or 0),
                int(u.get("cached_tokens", 0) or 0),
            )
            prompt = int(u.get("prompt_tokens", 0) or u.get("input_tokens", 0) or 0)
            new_input = int(u.get("input_tokens", 0) or max(prompt - cache_read, 0))
            print(f"[{time.strftime('%X')}] {label}: prompt={prompt} cache_read={cache_read} new_input={new_input} elapsed={elapsed:.2f}s", flush=True)
            return {"prompt": prompt, "cache_read": cache_read, "new_input": new_input}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return None
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return None

print("--- P1 (~5K tokens) ---", flush=True)
r1 = send("P1", build(1))
time.sleep(1)
print("--- P2 (~15K tokens, ~10K delta over P1) ---", flush=True)
r2 = send("P2", build(2))
time.sleep(1)
print("--- P3 (P2 + ~50 token tail) ---", flush=True)
r3 = send("P3", build(3))

print()
print("Summary:")
def line(name, r):
    if r is None:
        return f"  {name}: failed"
    return f"  {name}: prompt={r['prompt']} cache_read={r['cache_read']} new_input={r['new_input']}"
print(line("P1", r1))
print(line("P2", r2))
print(line("P3", r3))

if r1 and r2 and r3:
    p1_aligned = (r1["prompt"] // 256) * 256
    p2_aligned = (r2["prompt"] // 256) * 256
    p2_ok = abs(r2["cache_read"] - p1_aligned) < 256
    p3_ok = abs(r3["cache_read"] - p2_aligned) < 256
    print()
    print(f"Expected P2.cache_read ~ chunk-floor(P1.prompt)={p1_aligned}, got {r2['cache_read']} ({'OK' if p2_ok else 'MISMATCH'})")
    print(f"Expected P3.cache_read ~ chunk-floor(P2.prompt)={p2_aligned}, got {r3['cache_read']} ({'OK' if p3_ok else 'MISMATCH'})")
    print()
    if p2_ok and p3_ok:
        print("Verdict: large multi-chunk deltas cache normally. Intermediate chunks are usable by the next turn.")
    elif p2_ok and not p3_ok:
        print("Verdict: P2 cached only the P1 prefix; the 10K middle did NOT cache for P3.")
    else:
        print("Verdict: chunk alignment differs from the 256-token assumption. Inspect numbers above.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4h: TTL Upper Bound (long-running, off by default)
# ---------------------------------------------------------------------------
# Single warmup -> long sleep -> probe. KIMI_E2E_TTL_UPPER_INTERVALS
# (comma-separated seconds, default "1800") controls which intervals run.
# Set KIMI_E2E_SKIP_TTL_UPPER=0 to enable.
ttl_upper_check() {
  if [ "${KIMI_E2E_SKIP_TTL_UPPER:-1}" = "1" ]; then
    log "=== Test 4h: TTL Upper Bound (skipped — set KIMI_E2E_SKIP_TTL_UPPER=0 to enable) ==="
    return 0
  fi

  log "=== Test 4h: TTL Upper Bound (Anthropic endpoint) ==="
  log "  intervals=${KIMI_E2E_TTL_UPPER_INTERVALS}"

  python3 - <<'PY'
import concurrent.futures
import json
import os
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
verbose = os.environ.get("KIMI_E2E_VERBOSE", "1") == "1"
repeat = int(os.environ.get("KIMI_E2E_CACHE_REPEAT", "2000"))
intervals = [int(x) for x in os.environ["KIMI_E2E_TTL_UPPER_INTERVALS"].split(",") if x.strip()]

filler = "This is meaningless filler text for testing Kimi TTL upper bound. " * repeat

headers = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

def send(label, text):
    payload = {
        "model": "kimi-for-coding",
        "max_tokens": 50,
        "messages": [{"role": "user", "content": [{"type": "text", "text": text}]}],
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        (os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/") + "/messages"),
        data=body, headers=headers, method="POST",
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            cache_read = max(
                int(u.get("cache_read_input_tokens", 0) or 0),
                int(u.get("cached_tokens", 0) or 0),
            )
            prompt = int(u.get("prompt_tokens", 0) or u.get("input_tokens", 0) or 0)
            print(f"[{time.strftime('%X')}] {label}: prompt={prompt} cache_read={cache_read} elapsed={elapsed:.2f}s", flush=True)
            return cache_read
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return -1

def run(target):
    salt = f"ttl-upper-{target}-{uuid.uuid4()}"
    text = f"variant:{salt}\n{filler}\n\nReply with only: ok"
    print(f"--- TTL upper: warm then probe at t={target}s ---", flush=True)
    send(f"warmup_{target}s", text)
    print(f"[round {target}s] sleeping {target}s...", flush=True)
    time.sleep(target)
    read = send(f"probe_{target}s", text)
    return target, read > 0

with concurrent.futures.ThreadPoolExecutor(max_workers=len(intervals)) as pool:
    futures = [pool.submit(run, t) for t in intervals]
    results = sorted([f.result() for f in concurrent.futures.as_completed(futures)])

print()
print("Results:")
for t, hit in results:
    print(f"  {t}s: {'HIT' if hit else 'MISS'}")

hits = [t for t, h in results if h]
misses = [t for t, h in results if not h]
print()
if hits and not misses:
    print(f"Verdict: TTL >= {max(hits)}s (all probes hit).")
elif misses and not hits:
    print(f"Verdict: TTL < {min(misses)}s (all probes missed).")
elif hits and misses:
    print(f"Verdict: TTL is between {max(hits)}s and {min(misses)}s.")
else:
    print("Verdict: no probes ran.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4i: Block Size Sweep
# ---------------------------------------------------------------------------
# Confirms the 256-token chunk-alignment finding from 4d across a range of
# prompt sizes. For each size: warm a payload, then send a 2-turn extension
# and check whether the probe's cache_read matches floor(warm.prompt / 256).
block_size_sweep_check() {
  if [ "${KIMI_E2E_SKIP_BLOCK_SIZE_SWEEP:-0}" = "1" ]; then
    log "=== Test 4i: Block Size Sweep (skipped) ==="
    return 0
  fi

  log "=== Test 4i: Block Size Sweep (Anthropic endpoint) ==="

  python3 - <<'PY'
import concurrent.futures
import json
import os
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
verbose = os.environ.get("KIMI_E2E_VERBOSE", "1") == "1"

repeats = [100, 200, 500, 1500, 4000]  # ~1K / 2K / 5K / 15K / 40K tokens

headers = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

def send(label, messages):
    payload = {
        "model": "kimi-for-coding",
        "max_tokens": 30,
        "messages": messages,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        (os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/") + "/messages"),
        data=body, headers=headers, method="POST",
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            cache_read = max(
                int(u.get("cache_read_input_tokens", 0) or 0),
                int(u.get("cached_tokens", 0) or 0),
            )
            prompt = int(u.get("prompt_tokens", 0) or u.get("input_tokens", 0) or 0)
            print(f"[{time.strftime('%X')}] {label}: prompt={prompt} cache_read={cache_read} elapsed={elapsed:.2f}s", flush=True)
            return {"prompt": prompt, "cache_read": cache_read}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return None
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return None

def run(rep):
    salt = f"size-{rep}-{uuid.uuid4()}"
    base = f"variant:{salt}\n" + ("This is meaningless filler text for testing. " * rep)
    warm_msgs = [{"role": "user", "content": [{"type": "text", "text": base}]}]
    warm = send(f"size_rep{rep}_warm", warm_msgs)
    time.sleep(2)
    probe_msgs = [
        {"role": "user", "content": [{"type": "text", "text": base}]},
        {"role": "assistant", "content": [{"type": "text", "text": "ok-1"}]},
        {"role": "user", "content": [{"type": "text", "text": "follow-up. Reply ok-2."}]},
    ]
    probe = send(f"size_rep{rep}_probe", probe_msgs)
    return rep, warm, probe

with concurrent.futures.ThreadPoolExecutor(max_workers=len(repeats)) as pool:
    futures = [pool.submit(run, r) for r in repeats]
    results = sorted([f.result() for f in concurrent.futures.as_completed(futures)])

print()
print("Block size sweep:")
print(f"  {'repeat':<8}{'warm_prompt':>14}{'probe_cache_read':>20}{'aligned_256':>14}{'delta':>10}{'aligned_match':>16}")
all_ok = True
for rep, warm, probe in results:
    if warm is None or probe is None:
        print(f"  {rep:<8} FAILED")
        all_ok = False
        continue
    aligned = (warm["prompt"] // 256) * 256
    delta = probe["cache_read"] - aligned
    ok = abs(delta) < 256
    if not ok:
        all_ok = False
    print(f"  {rep:<8}{warm['prompt']:>14}{probe['cache_read']:>20}{aligned:>14}{delta:>10}{'OK' if ok else 'MISMATCH':>16}")

print()
if all_ok:
    print("Verdict: 256-token chunk alignment confirmed across all sizes.")
else:
    print("Verdict: alignment is NOT 256 for some size(s). Inspect 'delta' to estimate the actual block size.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4j: Tools-Only Change
# ---------------------------------------------------------------------------
# Same messages and system, but the `tools` array differs between warm and
# probe. Three scenarios:
#   J0 baseline: identical tools -> full HIT expected
#   J1 different tool content
#   J2 add tool on probe (warm had no tools)
tools_change_cache_check() {
  if [ "${KIMI_E2E_SKIP_TOOLS_CHANGE:-0}" = "1" ]; then
    log "=== Test 4j: Tools-Only Change (skipped) ==="
    return 0
  fi

  log "=== Test 4j: Tools-Only Change (Anthropic endpoint) ==="

  python3 - <<'PY'
import json
import os
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
verbose = os.environ.get("KIMI_E2E_VERBOSE", "1") == "1"
repeat = int(os.environ.get("KIMI_E2E_CACHE_REPEAT", "2000"))

filler = "This is meaningless filler text for testing tools cache impact. " * repeat

headers = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

TOOL_READ = {
    "name": "Read",
    "description": "Read a file from the filesystem.",
    "input_schema": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
}
TOOL_WRITE = {
    "name": "Write",
    "description": "Write a file to disk.",
    "input_schema": {
        "type": "object",
        "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
        "required": ["path", "content"],
    },
}

def build_payload(salt, tools=None):
    text = f"variant:{salt}\n{filler}\n\nReply with only: ok"
    p = {
        "model": "kimi-for-coding",
        "max_tokens": 50,
        "messages": [{"role": "user", "content": [{"type": "text", "text": text}]}],
    }
    if tools is not None:
        p["tools"] = tools
    return p

def send(label, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        (os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/") + "/messages"),
        data=body, headers=headers, method="POST",
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            cache_read = max(
                int(u.get("cache_read_input_tokens", 0) or 0),
                int(u.get("cached_tokens", 0) or 0),
            )
            prompt = int(u.get("prompt_tokens", 0) or u.get("input_tokens", 0) or 0)
            print(f"[{time.strftime('%X')}] {label}: prompt={prompt} cache_read={cache_read} elapsed={elapsed:.2f}s", flush=True)
            return cache_read, prompt
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return -1, -1
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return -1, -1

def run(name, warm_payload, probe_payload):
    print(f"--- {name} ---", flush=True)
    send(f"{name}_warm", warm_payload)
    time.sleep(3)
    return send(f"{name}_probe", probe_payload)

# J0 baseline: identical tools
salt0 = f"J0-{uuid.uuid4()}"
p0 = build_payload(salt0, tools=[TOOL_READ])
j0_read, j0_prompt = run("J0_baseline", p0, p0)

# J1: different tool content (Read -> Write)
salt1 = f"J1-{uuid.uuid4()}"
p1a = build_payload(salt1, tools=[TOOL_READ])
p1b = build_payload(salt1, tools=[TOOL_WRITE])
j1_read, j1_prompt = run("J1_tool_swapped", p1a, p1b)

# J2: add tool on probe (warm had no tools)
salt2 = f"J2-{uuid.uuid4()}"
p2a = build_payload(salt2)
p2b = build_payload(salt2, tools=[TOOL_READ])
j2_read, j2_prompt = run("J2_tool_added", p2a, p2b)

print()
print("Results:")
print(f"  J0 baseline:         cache_read={j0_read} / prompt={j0_prompt}")
print(f"  J1 tool swapped:     cache_read={j1_read} / prompt={j1_prompt}")
print(f"  J2 tool added:       cache_read={j2_read} / prompt={j2_prompt}")

print()
if j0_read > 0:
    r1 = (j1_read / j0_read) if (j1_read >= 0 and j0_read > 0) else 0
    r2 = (j2_read / j0_read) if (j2_read >= 0 and j0_read > 0) else 0
    print(f"Ratios vs J0 baseline: J1={r1:.1%}  J2={r2:.1%}")
    if r1 > 0.9 and r2 > 0.9:
        print("Verdict: tools cache INDEPENDENTLY from messages. Changing the tools array does not invalidate the messages cache.")
    elif r1 < 0.2 and r2 < 0.2:
        print("Verdict: tools are part of the PREFIX. Changing them invalidates cache.")
    else:
        print("Verdict: mixed. Adding vs swapping tools behaves differently.")
else:
    print("Verdict: J0 baseline failed; cannot interpret.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4k: Small Prompt / Chunk Boundary Sweep
# ---------------------------------------------------------------------------
# For tiny prompts, prefix-extension hits should stay at 0 until the prompt
# crosses the first 256-token chunk. Exact re-sends should still read the full
# prompt from cache.
small_boundary_cache_check() {
  if [ "${KIMI_E2E_SKIP_SMALL_BOUNDARY:-0}" = "1" ]; then
    log "=== Test 4k: Small Prompt / Chunk Boundary Sweep (skipped) ==="
    return 0
  fi

  log "=== Test 4k: Small Prompt / Chunk Boundary Sweep (Anthropic endpoint) ==="

  python3 - <<'PY'
import json
import os
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
base_url = os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/")

headers = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

repeats = [1, 5, 10, 20, 40, 80]

def cache_read_from_usage(u):
    return max(int(u.get("cache_read_input_tokens", 0) or 0), int(u.get("cached_tokens", 0) or 0))

def send(label, messages):
    payload = {"model": "kimi-for-coding", "max_tokens": 20, "messages": messages}
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{base_url}/messages", data=body, headers=headers, method="POST")
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            prompt = int(u.get("prompt_tokens", 0) or u.get("input_tokens", 0) or 0)
            read = cache_read_from_usage(u)
            print(f"[{time.strftime('%X')}] {label}: prompt={prompt} cache_read={read} elapsed={elapsed:.2f}s", flush=True)
            return {"prompt": prompt, "cache_read": read}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return None
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return None

def build_base(salt, rep):
    text = f"small-boundary:{salt}\n" + ("boundary token padding. " * rep) + "\nReply ok."
    return [{"role": "user", "content": [{"type": "text", "text": text}]}]

def build_extended(salt, rep):
    msgs = build_base(salt, rep)
    msgs.append({"role": "assistant", "content": [{"type": "text", "text": "ok"}]})
    msgs.append({"role": "user", "content": [{"type": "text", "text": "follow-up. Reply ok again."}]})
    return msgs

rows = []
for rep in repeats:
    salt = f"small-{rep}-{uuid.uuid4()}"
    warm = send(f"rep{rep}_warm", build_base(salt, rep))
    time.sleep(1)
    exact = send(f"rep{rep}_exact", build_base(salt, rep))
    time.sleep(1)
    extended = send(f"rep{rep}_extended", build_extended(salt, rep))
    rows.append((rep, warm, exact, extended))

print()
print("Small boundary results:")
print(f"  {'repeat':<8}{'warm_prompt':>14}{'exact_read':>14}{'extended_read':>16}{'floor256':>10}{'prefix_match':>14}")
all_exact = True
all_prefix = True
for rep, warm, exact, extended in rows:
    if warm is None or exact is None or extended is None:
        print(f"  {rep:<8} FAILED")
        all_exact = False
        all_prefix = False
        continue
    floor256 = (warm["prompt"] // 256) * 256
    exact_ok = exact["cache_read"] >= warm["prompt"] * 0.95
    prefix_ok = abs(extended["cache_read"] - floor256) < 256
    all_exact = all_exact and exact_ok
    all_prefix = all_prefix and prefix_ok
    print(f"  {rep:<8}{warm['prompt']:>14}{exact['cache_read']:>14}{extended['cache_read']:>16}{floor256:>10}{'OK' if prefix_ok else 'MISMATCH':>14}")

print()
if all_exact:
    print("Verdict 1: exact re-sends cache fully, including small prompts.")
else:
    print("Verdict 1: at least one exact re-send did not read the full prompt.")
if all_prefix:
    print("Verdict 2: prefix-extension reads follow 256-token floors across the small-prompt boundary.")
else:
    print("Verdict 2: small-prompt prefix-extension alignment differs from the 256-token assumption.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4l: OpenAI Endpoint Cache Boundaries
# ---------------------------------------------------------------------------
# Formalizes the OpenAI-compatible endpoint checks: exact re-send, prefix
# extension, and a short warm->probe delay using prompt_tokens_details.
openai_cache_boundary_check() {
  if [ "${KIMI_E2E_SKIP_OPENAI_CACHE_BOUNDARY:-0}" = "1" ]; then
    log "=== Test 4l: OpenAI Endpoint Cache Boundaries (skipped) ==="
    return 0
  fi

  log "=== Test 4l: OpenAI Endpoint Cache Boundaries ==="

  python3 - <<'PY'
import json
import os
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
base_url = os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/")
repeat = int(os.environ.get("KIMI_E2E_CACHE_REPEAT", "2000"))

headers = {
    "Authorization": f"Bearer {api_key}",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

def cache_read_from_usage(u):
    details = u.get("prompt_tokens_details") or {}
    return max(
        int(u.get("cache_read_input_tokens", 0) or 0),
        int(u.get("cached_tokens", 0) or 0),
        int(details.get("cached_tokens", 0) or 0),
    )

def send(label, messages, **extra):
    payload = {"model": "kimi-for-coding", "max_tokens": 30, "messages": messages}
    payload.update(extra)
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{base_url}/chat/completions", data=body, headers=headers, method="POST")
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            prompt = int(u.get("prompt_tokens", 0) or u.get("input_tokens", 0) or 0)
            read = cache_read_from_usage(u)
            print(f"[{time.strftime('%X')}] {label}: prompt={prompt} cache_read={read} elapsed={elapsed:.2f}s", flush=True)
            return {"prompt": prompt, "cache_read": read, "usage": u}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return None
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return None

salt = f"openai-boundary-{uuid.uuid4()}"
text = f"variant:{salt}\n" + ("This is meaningless filler text for OpenAI cache boundary testing. " * repeat) + "\nReply ok."
base_msgs = [{"role": "user", "content": text}]
extended_msgs = [
    {"role": "user", "content": text},
    {"role": "assistant", "content": "ok"},
    {"role": "user", "content": "follow-up. Reply ok again."},
]

warm = send("openai_warm", base_msgs)
time.sleep(3)
exact = send("openai_exact_probe", base_msgs)
time.sleep(1)
extended = send("openai_extended_probe", extended_msgs)

print()
if warm and exact and extended:
    floor256 = (warm["prompt"] // 256) * 256
    exact_ok = exact["cache_read"] >= warm["prompt"] * 0.95
    extended_ok = abs(extended["cache_read"] - floor256) < 256
    print(f"Exact re-send: cache_read={exact['cache_read']} warm_prompt={warm['prompt']} ({'OK' if exact_ok else 'MISMATCH'})")
    print(f"Prefix extension: cache_read={extended['cache_read']} expected_floor256={floor256} ({'OK' if extended_ok else 'MISMATCH'})")
    if exact_ok and extended_ok:
        print("Verdict: OpenAI endpoint matches Anthropic cache behavior for exact and prefix-extension probes.")
    else:
        print("Verdict: OpenAI endpoint cache behavior differs from Anthropic on this probe.")
else:
    print("Verdict: one or more OpenAI boundary requests failed; inconclusive.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4m: Provider PI_CACHE_RETENTION=none Behavior
# ---------------------------------------------------------------------------
# Runs through pi/provider, not direct curl. Confirms that disabling pi's cache
# knob removes prompt_cache_key injection but Kimi's content cache can still hit.
retention_none_provider_cache_check() {
  if [ "${KIMI_E2E_SKIP_RETENTION_NONE_PROVIDER:-0}" = "1" ]; then
    log "=== Test 4m: Provider PI_CACHE_RETENTION=none Behavior (skipped) ==="
    return 0
  fi

  log "=== Test 4m: Provider PI_CACHE_RETENTION=none Behavior (pi/provider) ==="

  EXT_DIR_PY="$EXT_DIR" PI_BIN_PY="$PI_BIN" python3 - <<'PY'
import json
import os
import subprocess
import tempfile
import time
import uuid

pi_bin = os.environ["PI_BIN_PY"]
ext_dir = os.environ["EXT_DIR_PY"]
model = os.environ.get("KIMI_E2E_MODEL", "kimi-coding/kimi-for-coding")
repeat = min(int(os.environ.get("KIMI_E2E_CACHE_REPEAT", "2000")), 1000)
prompt = f"retention-none:{uuid.uuid4()}\n" + ("This is meaningless filler text for provider cache testing. " * repeat) + "\nReply with only: ok"

# Candidate field names across pi versions / event shapes.
CACHE_READ_FIELDS = (
    "cacheRead", "cache_read",
    "cache_read_input_tokens", "cached_tokens",
)

def scan_for_usage(stdout_text):
    """Walk all JSON lines, look for any dict that contains a recognized
    cache-read field. Returns the first match as (value, field, event_type,
    location) or None."""
    for line in stdout_text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        evt = obj.get("type", "<no-type>")
        # Try top-level usage and message.usage
        for path_label, container in (("usage", obj.get("usage")),
                                     ("message.usage", (obj.get("message") or {}).get("usage") if isinstance(obj.get("message"), dict) else None)):
            if isinstance(container, dict):
                for f in CACHE_READ_FIELDS:
                    v = container.get(f)
                    if v is not None:
                        try:
                            return (int(v), f, evt, path_label)
                        except (TypeError, ValueError):
                            pass
    return None

def run(label):
    env = os.environ.copy()
    env["PI_CACHE_RETENTION"] = "none"
    env["KIMI_CODE_PROTOCOL"] = "anthropic"
    start = time.time()
    proc = subprocess.run(
        [pi_bin, "-ne", "-e", ext_dir, "--model", model, "-p", prompt, "--mode", "json"],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=180,
        check=False,
    )
    elapsed = time.time() - start

    # Always dump full output for post-mortem.
    fd, dump_path = tempfile.mkstemp(prefix=f"kimi_e2e_4m_{label}_", suffix=".jsonl")
    with os.fdopen(fd, "w") as f:
        f.write(proc.stdout)

    found = scan_for_usage(proc.stdout)
    if found is not None:
        value, field, evt, loc = found
        print(f"[{time.strftime('%X')}] {label}: exit={proc.returncode} cache_read={value} (field={field}, event={evt}, at={loc}) elapsed={elapsed:.2f}s dump={dump_path}", flush=True)
        return value
    else:
        # No usage info recognized. Surface tail for debugging.
        lines = proc.stdout.splitlines()
        tail = "\n  ".join(lines[-15:])
        print(f"[{time.strftime('%X')}] {label}: exit={proc.returncode} NO_USAGE_FOUND elapsed={elapsed:.2f}s dump={dump_path}", flush=True)
        print(f"  --- last 15 lines of pi stdout ---", flush=True)
        print(f"  {tail[:2500]}", flush=True)
        print(f"  --- end (full output at {dump_path}) ---", flush=True)
        return None

first = run("retention_none_warm")
time.sleep(3)
second = run("retention_none_probe")

print()
print(f"Results: warm_cacheRead={first} probe_cacheRead={second}")
if first is None or second is None:
    print("Verdict: could not extract cacheRead from pi output. Inspect the dump files above to determine pi's actual event shape, then update the parser.")
elif first == 0 and second > 0:
    print("Verdict: PI_CACHE_RETENTION=none does NOT prevent Kimi's content cache from hitting through the pi provider.")
elif second > 0:
    print(f"Verdict: provider cache hit observed (probe={second}), but warm request also reported cacheRead={first}. Either content was already cached or the warm/probe gap is too short.")
else:
    print("Verdict: no provider cache hit observed with PI_CACHE_RETENTION=none. Either payload varies (e.g. unique session id), or the prefix doesn't reach the cache layer.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4n: Usage Field Extraction Boundaries
# ---------------------------------------------------------------------------
# Keeps the cache-read detector honest across Anthropic, OpenAI top-level, and
# OpenAI prompt_tokens_details shapes, including null and string-number values.
usage_field_extraction_check() {
  if [ "${KIMI_E2E_SKIP_USAGE_FIELDS:-0}" = "1" ]; then
    log "=== Test 4n: Usage Field Extraction Boundaries (skipped) ==="
    return 0
  fi

  log "=== Test 4n: Usage Field Extraction Boundaries ==="

  python3 - <<'PY'
def cache_read_from_usage(u):
    details = u.get("prompt_tokens_details") or {}
    return max(
        int(u.get("cache_read_input_tokens", 0) or 0),
        int(u.get("cached_tokens", 0) or 0),
        int(details.get("cached_tokens", 0) or 0),
    )

cases = [
    ("anthropic_field", {"cache_read_input_tokens": 123}, 123),
    ("openai_top_level", {"cached_tokens": 456}, 456),
    ("openai_details", {"prompt_tokens_details": {"cached_tokens": 789}}, 789),
    ("max_of_all", {"cache_read_input_tokens": 10, "cached_tokens": 20, "prompt_tokens_details": {"cached_tokens": 30}}, 30),
    ("null_values", {"cache_read_input_tokens": None, "cached_tokens": None, "prompt_tokens_details": {"cached_tokens": None}}, 0),
    ("string_numbers", {"cache_read_input_tokens": "42", "cached_tokens": "7"}, 42),
    ("missing", {}, 0),
]

ok = True
for name, usage, expected in cases:
    got = cache_read_from_usage(usage)
    passed = got == expected
    ok = ok and passed
    print(f"  {name}: got={got} expected={expected} {'OK' if passed else 'FAIL'}")
print()
print("Verdict: usage cache-read extraction covers all known field shapes." if ok else "Verdict: usage cache-read extraction missed at least one field shape.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4o: Non-Prompt Parameter Cache Participation
# ---------------------------------------------------------------------------
# Same messages, probe with changed generation parameters. These should not
# invalidate the prompt-prefix cache if cache identity is prompt-only.
non_prompt_params_cache_check() {
  if [ "${KIMI_E2E_SKIP_NON_PROMPT_PARAMS:-0}" = "1" ]; then
    log "=== Test 4o: Non-Prompt Parameter Cache Participation (skipped) ==="
    return 0
  fi

  log "=== Test 4o: Non-Prompt Parameter Cache Participation (OpenAI endpoint) ==="

  python3 - <<'PY'
import json
import os
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
base_url = os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/")
repeat = int(os.environ.get("KIMI_E2E_CACHE_REPEAT", "2000"))
alt_model = os.environ.get("KIMI_E2E_ALT_MODEL")

headers = {
    "Authorization": f"Bearer {api_key}",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

def cache_read_from_usage(u):
    details = u.get("prompt_tokens_details") or {}
    return max(int(u.get("cached_tokens", 0) or 0), int(details.get("cached_tokens", 0) or 0))

def send(label, messages, **extra):
    payload = {"model": "kimi-for-coding", "max_tokens": 50, "messages": messages}
    payload.update(extra)
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{base_url}/chat/completions", data=body, headers=headers, method="POST")
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            prompt = int(u.get("prompt_tokens", 0) or u.get("input_tokens", 0) or 0)
            read = cache_read_from_usage(u)
            print(f"[{time.strftime('%X')}] {label}: prompt={prompt} cache_read={read} elapsed={elapsed:.2f}s", flush=True)
            return {"prompt": prompt, "cache_read": read}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return None
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return None

def run_variant(name, extra):
    salt = f"nonprompt-{name}-{uuid.uuid4()}"
    text = f"variant:{salt}\n" + ("This is meaningless filler text for non-prompt cache testing. " * repeat) + "\nReply ok."
    messages = [{"role": "user", "content": text}]
    warm = send(f"{name}_warm", messages)
    time.sleep(3)
    probe = send(f"{name}_probe", messages, **extra)
    return name, warm, probe

variants = [
    ("temperature", {"temperature": 0}),
    ("top_p", {"top_p": 0.5}),
    ("max_tokens", {"max_tokens": 5}),
    ("reasoning_effort", {"reasoning_effort": "low"}),
]
if alt_model:
    variants.append(("model", {"model": alt_model}))

rows = [run_variant(name, extra) for name, extra in variants]
print()
print("Non-prompt parameter results:")
all_ok = True
for name, warm, probe in rows:
    if warm is None or probe is None:
        print(f"  {name}: failed")
        all_ok = False
        continue
    ratio = probe["cache_read"] / warm["prompt"] if warm["prompt"] else 0
    ok = ratio > 0.9
    all_ok = all_ok and ok
    print(f"  {name}: cache_read={probe['cache_read']} warm_prompt={warm['prompt']} ratio={ratio:.1%} {'OK' if ok else 'MISMATCH'}")
print()
print("Verdict: generation parameters do not invalidate prompt cache." if all_ok else "Verdict: at least one non-prompt parameter changed cache behavior or failed.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4p: Multimodal Cache Boundary
# ---------------------------------------------------------------------------
# Probes whether image_url content participates in cache identity: same
# text+image should hit, while same text with a different image should not
# receive the full exact-prompt hit.
multimodal_cache_check() {
  if [ "${KIMI_E2E_SKIP_MULTIMODAL_CACHE:-0}" = "1" ]; then
    log "=== Test 4p: Multimodal Cache Boundary (skipped) ==="
    return 0
  fi

  log "=== Test 4p: Multimodal Cache Boundary (OpenAI endpoint) ==="

  python3 - <<'PY'
import io
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

from PIL import Image

api_key = os.environ["KIMI_API_KEY"]
base_url = os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/")

headers = {
    "Authorization": f"Bearer {api_key}",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

def make_png(color):
    """Generate a small distinct PNG file. color is (r, g, b)."""
    fd, path = tempfile.mkstemp(suffix=".png", prefix="kimi_e2e_4p_")
    os.close(fd)
    Image.new("RGB", (64, 64), color).save(path, "PNG")
    return path

def upload(path):
    """Upload a file to /files via curl (Kimi rejects inline data: URIs).
    Returns the file_id or None on failure."""
    proc = subprocess.run(
        [
            "curl", "-s", "-X", "POST", f"{base_url}/files",
            "-H", f"Authorization: Bearer {api_key}",
            "-H", "User-Agent: KimiCLI/1.44.0",
            "-H", "X-Msh-Platform: kimi_cli",
            "-H", "X-Msh-Version: 1.44.0",
            "-F", f"file=@{path};type=image/png",
            "-F", "purpose=image",
        ],
        capture_output=True, text=True, timeout=60, check=False,
    )
    try:
        data = json.loads(proc.stdout)
    except Exception:
        print(f"upload parse failed for {path}: {proc.stdout[:200]}", flush=True)
        return None
    file_id = data.get("id")
    if not file_id:
        print(f"upload missing id for {path}: {data}", flush=True)
        return None
    return file_id

path_a = make_png((255, 0, 0))   # red
path_b = make_png((0, 255, 0))   # green
file_a = upload(path_a)
file_b = upload(path_b)
os.unlink(path_a)
os.unlink(path_b)

if not file_a or not file_b:
    print("Verdict: image upload failed; cannot run multimodal cache probe.")
    raise SystemExit(0)

IMG_A = f"ms://{file_a}"
IMG_B = f"ms://{file_b}"
print(f"Uploaded images: A={IMG_A}  B={IMG_B}", flush=True)

def cache_read_from_usage(u):
    details = u.get("prompt_tokens_details") or {}
    return max(int(u.get("cached_tokens", 0) or 0), int(details.get("cached_tokens", 0) or 0))

def send(label, image_url, text):
    payload = {
        "model": "kimi-for-coding",
        "max_tokens": 30,
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": image_url}},
            {"type": "text", "text": text},
        ]}],
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{base_url}/chat/completions", data=body, headers=headers, method="POST")
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            prompt = int(u.get("prompt_tokens", 0) or u.get("input_tokens", 0) or 0)
            read = cache_read_from_usage(u)
            print(f"[{time.strftime('%X')}] {label}: prompt={prompt} cache_read={read} elapsed={elapsed:.2f}s", flush=True)
            return {"prompt": prompt, "cache_read": read}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return None
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return None

salt = f"multimodal-{uuid.uuid4()}"
text = f"multimodal-cache:{salt}\nDescribe the image in one word, then say ok."
warm = send("mm_warm_A", IMG_A, text)
time.sleep(3)
exact = send("mm_exact_A", IMG_A, text)
time.sleep(1)
diff_img = send("mm_diff_image_B", IMG_B, text)

print()
if warm and exact and diff_img:
    exact_ratio = exact["cache_read"] / warm["prompt"] if warm["prompt"] else 0
    diff_ratio = diff_img["cache_read"] / warm["prompt"] if warm["prompt"] else 0
    print(f"Exact same image+text ratio: {exact_ratio:.1%}")
    print(f"Different image, same text ratio: {diff_ratio:.1%}")
    if exact_ratio > 0.9 and diff_ratio < 0.5:
        print("Verdict: image content participates in cache identity (same image hits, different image misses).")
    elif exact_ratio > 0.9 and diff_ratio > 0.9:
        print("Verdict: surprising — different images still read most of the cached prefix. Image content may NOT participate in hash.")
    elif exact_ratio > 0.9:
        print(f"Verdict: same image+text re-send hits ({exact_ratio:.1%}); different image partially hits ({diff_ratio:.1%}).")
    else:
        print("Verdict: multimodal exact cache did not hit; investigate further.")
else:
    print("Verdict: multimodal cache probe failed; one or more requests errored.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4q: Concurrent Same-Prefix Cache Writes
# ---------------------------------------------------------------------------
# Sends identical requests concurrently, then probes exact and prefix-extension
# reads. This catches racey cache writes or inconsistent same-prefix behavior.
concurrent_cache_check() {
  if [ "${KIMI_E2E_SKIP_CONCURRENT_CACHE:-0}" = "1" ]; then
    log "=== Test 4q: Concurrent Same-Prefix Cache Writes (skipped) ==="
    return 0
  fi

  log "=== Test 4q: Concurrent Same-Prefix Cache Writes (Anthropic endpoint) ==="

  python3 - <<'PY'
import concurrent.futures
import json
import os
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
base_url = os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/")
repeat = int(os.environ.get("KIMI_E2E_CACHE_REPEAT", "2000"))

headers = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

def cache_read_from_usage(u):
    return max(int(u.get("cache_read_input_tokens", 0) or 0), int(u.get("cached_tokens", 0) or 0))

def send(label, messages):
    payload = {"model": "kimi-for-coding", "max_tokens": 20, "messages": messages}
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{base_url}/messages", data=body, headers=headers, method="POST")
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            prompt = int(u.get("prompt_tokens", 0) or u.get("input_tokens", 0) or 0)
            read = cache_read_from_usage(u)
            print(f"[{time.strftime('%X')}] {label}: prompt={prompt} cache_read={read} elapsed={elapsed:.2f}s", flush=True)
            return {"prompt": prompt, "cache_read": read}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return None
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return None

salt = f"concurrent-{uuid.uuid4()}"
text = f"concurrent-cache:{salt}\n" + ("This is meaningless filler text for concurrent cache testing. " * repeat) + "\nReply ok."
base_msgs = [{"role": "user", "content": [{"type": "text", "text": text}]}]
extended_msgs = [
    {"role": "user", "content": [{"type": "text", "text": text}]},
    {"role": "assistant", "content": [{"type": "text", "text": "ok"}]},
    {"role": "user", "content": [{"type": "text", "text": "follow-up. Reply ok again."}]},
]

with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
    warms = list(pool.map(lambda i: send(f"concurrent_warm_{i}", base_msgs), range(5)))

time.sleep(3)
exact = send("concurrent_exact_probe", base_msgs)
extended = send("concurrent_extended_probe", extended_msgs)

print()
successful_warms = [r for r in warms if r is not None]
if successful_warms and exact and extended:
    warm_prompt = successful_warms[0]["prompt"]
    floor256 = (warm_prompt // 256) * 256
    exact_ok = exact["cache_read"] >= warm_prompt * 0.95
    extended_ok = abs(extended["cache_read"] - floor256) < 256
    print(f"Warm requests succeeded: {len(successful_warms)}/5")
    print(f"Exact probe: cache_read={exact['cache_read']} warm_prompt={warm_prompt} {'OK' if exact_ok else 'MISMATCH'}")
    print(f"Extended probe: cache_read={extended['cache_read']} floor256={floor256} {'OK' if extended_ok else 'MISMATCH'}")
    if len(successful_warms) == 5 and exact_ok and extended_ok:
        print("Verdict: concurrent same-prefix writes are stable for exact and prefix-extension probes.")
    else:
        print("Verdict: concurrent same-prefix behavior had failures or cache mismatches.")
else:
    print("Verdict: concurrent same-prefix probe failed; inconclusive.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 4r: Very Large Context Cache Boundary (long-running, off by default)
# ---------------------------------------------------------------------------
# Pushes the chunk-alignment and exact re-send checks into ~100K-token prompts.
# Set KIMI_E2E_SKIP_VERY_LARGE_CACHE=0 to enable.
very_large_cache_check() {
  if [ "${KIMI_E2E_SKIP_VERY_LARGE_CACHE:-1}" = "1" ]; then
    log "=== Test 4r: Very Large Context Cache Boundary (skipped — set KIMI_E2E_SKIP_VERY_LARGE_CACHE=0 to enable) ==="
    return 0
  fi

  log "=== Test 4r: Very Large Context Cache Boundary (Anthropic endpoint) ==="

  python3 - <<'PY'
import json
import os
import time
import urllib.error
import urllib.request
import uuid

api_key = os.environ["KIMI_API_KEY"]
base_url = os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/")
repeat = int(os.environ.get("KIMI_E2E_VERY_LARGE_REPEAT", "12000"))

headers = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

def cache_read_from_usage(u):
    return max(int(u.get("cache_read_input_tokens", 0) or 0), int(u.get("cached_tokens", 0) or 0))

def send(label, messages):
    payload = {"model": "kimi-for-coding", "max_tokens": 20, "messages": messages}
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{base_url}/messages", data=body, headers=headers, method="POST")
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start
            u = data.get("usage", {})
            prompt = int(u.get("prompt_tokens", 0) or u.get("input_tokens", 0) or 0)
            read = cache_read_from_usage(u)
            print(f"[{time.strftime('%X')}] {label}: prompt={prompt} cache_read={read} elapsed={elapsed:.2f}s", flush=True)
            return {"prompt": prompt, "cache_read": read}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        print(f"[{time.strftime('%X')}] {label}: HTTP {e.code} {body}", flush=True)
        return None
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: failed: {e}", flush=True)
        return None

salt = f"very-large-{uuid.uuid4()}"
text = f"very-large-cache:{salt}\n" + ("large context cache boundary padding phrase with stable tokens. " * repeat) + "\nReply ok."
base_msgs = [{"role": "user", "content": [{"type": "text", "text": text}]}]
extended_msgs = [
    {"role": "user", "content": [{"type": "text", "text": text}]},
    {"role": "assistant", "content": [{"type": "text", "text": "ok"}]},
    {"role": "user", "content": [{"type": "text", "text": "tiny tail after very large prefix. Reply ok."}]},
]

print(f"repeat={repeat}", flush=True)
warm = send("very_large_warm", base_msgs)
time.sleep(3)
exact = send("very_large_exact", base_msgs)
time.sleep(1)
extended = send("very_large_extended", extended_msgs)

print()
if warm and exact and extended:
    floor256 = (warm["prompt"] // 256) * 256
    exact_ok = exact["cache_read"] >= warm["prompt"] * 0.95
    extended_ok = abs(extended["cache_read"] - floor256) < 256
    size_ok = warm["prompt"] >= 100000
    print(f"Prompt size: {warm['prompt']} tokens ({'>=100K' if size_ok else '<100K; increase KIMI_E2E_VERY_LARGE_REPEAT'})")
    print(f"Exact probe: cache_read={exact['cache_read']} warm_prompt={warm['prompt']} {'OK' if exact_ok else 'MISMATCH'}")
    print(f"Extended probe: cache_read={extended['cache_read']} floor256={floor256} {'OK' if extended_ok else 'MISMATCH'}")
    if size_ok and exact_ok and extended_ok:
        print("Verdict: very large prompt cache matches exact and 256-floor prefix behavior.")
    elif exact_ok and extended_ok:
        print("Verdict: cache behavior matched, but prompt did not reach 100K tokens.")
    else:
        print("Verdict: very large prompt cache behavior differed or request hit a context/API boundary.")
else:
    print("Verdict: very large cache probe failed; likely context limit, timeout, or endpoint rejection.")
PY
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 5: File Upload + Visual Verification
# ---------------------------------------------------------------------------
file_upload_check() {
  log "=== Test 5: File Upload + Visual Verification ==="

  # Download a real photo from picsum, stamp a random code on it, save as large PNG
  local tmpfile
  tmpfile="$(mktemp -t kimi_e2e_upload_XXXXXX.png)"
  local random_code="E2E-$(date +%s | tail -c 7)"

  log "Generating test image with watermark code: $random_code"
  python3 - "$tmpfile" "$random_code" <<'PYIMG'
import sys
import urllib.request
from PIL import Image, ImageDraw, ImageFont
from io import BytesIO

out_path = sys.argv[1]
code = sys.argv[2]

# Download a real photo
url = "https://picsum.photos/1400/1400.jpg"
data = urllib.request.urlopen(url, timeout=30).read()
img = Image.open(BytesIO(data)).convert("RGB")

# Stamp the random code as a large watermark
draw = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 120)
except Exception:
    font = ImageFont.load_default()
bbox = draw.textbbox((0, 0), code, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
x = (img.width - tw) // 2
y = (img.height - th) // 2
# Black outline + white fill for visibility
for dx in range(-3, 4):
    for dy in range(-3, 4):
        draw.text((x + dx, y + dy), code, fill="black", font=font)
draw.text((x, y), code, fill="white", font=font)

# Save as uncompressed PNG to ensure >5MB
img.save(out_path, format="PNG", compress_level=0)
import os
size_mb = os.path.getsize(out_path) / 1024 / 1024
print(f"Generated {out_path} ({size_mb:.1f} MB) with code: {code}")
PYIMG

  log "Uploading to ${BASE_URL}/files ..."

  local http_code
  http_code=$(curl -s -o /tmp/kimi_e2e_upload_resp.json -w "%{http_code}" \
    -X POST "${BASE_URL}/files" \
    -H "Authorization: Bearer ${KIMI_API_KEY}" \
    "${KIMI_HEADERS[@]}" \
    -F "file=@${tmpfile};type=image/png" \
    -F "purpose=image")

  rm -f "$tmpfile"

  if [ "$http_code" != "200" ] && [ "$http_code" != "201" ]; then
    log "Upload FAILED (status=$http_code)"
    cat /tmp/kimi_e2e_upload_resp.json 2>/dev/null
    rm -f /tmp/kimi_e2e_upload_resp.json
    printf '\n'
    return 1
  fi

  local file_id
  file_id=$(python3 -c "import json; d=json.load(open('/tmp/kimi_e2e_upload_resp.json')); print(d.get('id',''))")
  log "Upload OK (status=$http_code). file_id=$file_id  ms_url=ms://$file_id"
  rm -f /tmp/kimi_e2e_upload_resp.json

  # Visual verification: ask the model what text/code is in the image
  log "Verifying: asking model to read the watermark code from uploaded image..."
  local verify_payload
  verify_payload=$(python3 -c "
import json, sys
file_id = '$file_id'
print(json.dumps({
    'model': 'kimi-for-coding',
    'max_tokens': 200,
    'messages': [{
        'role': 'user',
        'content': [
            {'type': 'image_url', 'image_url': {'url': f'ms://{file_id}'}},
            {'type': 'text', 'text': 'What is the text/code written on this image? Reply with ONLY the exact text, nothing else.'},
        ],
    }],
}))
")

  local verify_resp
  verify_resp=$(curl -s -X POST "${BASE_URL}/chat/completions" \
    -H "Authorization: Bearer ${KIMI_API_KEY}" \
    -H "Content-Type: application/json" \
    "${KIMI_HEADERS[@]}" \
    -d "$verify_payload")

  local verify_code
  verify_code=$(echo "$verify_resp" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d.get('choices', [{}])[0].get('message', {}).get('content', '').strip())
")
  local verify_usage
  verify_usage=$(echo "$verify_resp" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(json.dumps(d.get('usage', {}), ensure_ascii=False))
")

  log "Expected: $random_code"
  log "Model replied: $verify_code"
  log "usage=$verify_usage"
  if echo "$verify_code" | grep -qF "$random_code"; then
    log "PASS: model correctly identified the watermark code"
  else
    log "WARN: model reply does not contain expected code (may be OCR variance)"
  fi
  printf '\n'
}

# ---------------------------------------------------------------------------
# Test 6: Cache Key Injection
# ---------------------------------------------------------------------------
cache_key_injection_check() {
  log "=== Test 6: Cache Key Injection (prompt_cache_key in payload) ==="

  local test_cache_key="e2e-cache-key-test-$$-$(date +%s)"
  local payload
  payload=$(python3 -c "
import json
print(json.dumps({
    'model': 'kimi-for-coding',
    'max_tokens': 100,
    'prompt_cache_key': '$test_cache_key',
    'messages': [{'role': 'user', 'content': 'Reply with: ok'}],
}))
")

  if [ "$KIMI_E2E_VERBOSE" = "1" ]; then
    log "+ POST ${BASE_URL}/chat/completions with prompt_cache_key=$test_cache_key"
  fi

  local http_code
  http_code=$(curl -s -o /tmp/kimi_e2e_cache_resp.json -w "%{http_code}" \
    -X POST "${BASE_URL}/chat/completions" \
    -H "Authorization: Bearer ${KIMI_API_KEY}" \
    -H "Content-Type: application/json" \
    "${KIMI_HEADERS[@]}" \
    -d "$payload")

  if [ "$http_code" = "200" ]; then
    local usage
    usage=$(python3 -c "import json; d=json.load(open('/tmp/kimi_e2e_cache_resp.json')); print(json.dumps(d.get('usage',{}), ensure_ascii=False))")
    log "Cache key injection OK (status=200). usage=$usage"
  else
    log "Request failed (status=$http_code)"
    cat /tmp/kimi_e2e_cache_resp.json 2>/dev/null
  fi
  rm -f /tmp/kimi_e2e_cache_resp.json
  printf '\n'
}

# ---------------------------------------------------------------------------
# Run tests
# ---------------------------------------------------------------------------
if [ "${KIMI_E2E_ONLY_CACHE:-0}" = "1" ]; then
  cache_ttl_check
  cache_mechanism_isolation_check
  dual_breakpoint_check
  cache_key_semantics_check
  cache_chain_check
  cross_protocol_cache_check
  system_tools_cache_check
  large_delta_check
  ttl_upper_check
  block_size_sweep_check
  tools_change_cache_check
  small_boundary_cache_check
  openai_cache_boundary_check
  retention_none_provider_cache_check
  usage_field_extraction_check
  non_prompt_params_cache_check
  multimodal_cache_check
  concurrent_cache_check
  very_large_cache_check
  log "E2E Tests complete!"
  exit 0
fi

run_pi_test "Test 1: Anthropic Protocol (Default)" anthropic "Who are you? Respond in one sentence." --mode print
run_pi_test "Test 2: OpenAI Protocol" openai "Who are you? Respond in one sentence." --mode print

# Test 3: save full JSONL to /tmp, extract thinking + text summary
log "=== Test 3: Thinking (High) ==="
KIMI_E2E_T3_JSONL="/tmp/kimi_e2e_test3_$(date +%s).jsonl"
if [ "$KIMI_E2E_VERBOSE" = "1" ]; then
  log "+ output -> $KIMI_E2E_T3_JSONL"
fi
KIMI_CODE_PROTOCOL=anthropic "$PI_BIN" -ne -e "$EXT_DIR" --model "$KIMI_E2E_MODEL" \
  -p "Solve this: 25 * 4 + 10" --mode json --thinking high > "$KIMI_E2E_T3_JSONL" 2>&1
python3 -c "
import json
thinking = []
text_parts = []
for line in open('$KIMI_E2E_T3_JSONL'):
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        continue
    # pi json mode emits message_end with full assistant content
    msg = obj.get('message', {})
    if obj.get('type') == 'message_end' and msg.get('role') == 'assistant':
        for block in msg.get('content', []):
            if block.get('type') == 'thinking':
                thinking.append(block.get('thinking', ''))
            elif block.get('type') == 'text':
                text_parts.append(block.get('text', ''))
if thinking:
    preview = thinking[0][:300].replace(chr(10), ' ')
    suffix = '...' if len(thinking[0]) > 300 else ''
    print(f'Thinking ({len(thinking)} block(s), {sum(len(t) for t in thinking)} chars): {preview}{suffix}')
else:
    print('Thinking: (none detected in message_end events)')
if text_parts:
    print(f'Answer: {\" \".join(text_parts).strip()}')
else:
    print('Answer: (none detected)')
# Extract usage from the last turn_end event
for line in open('$KIMI_E2E_T3_JSONL'):
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        continue
    if obj.get('type') == 'turn_end' and 'usage' in obj:
        u = obj['usage']
        print(f'usage: input={u.get(\"input\",\"?\")} output={u.get(\"output\",\"?\")} cacheRead={u.get(\"cacheRead\",\"?\")} cacheWrite={u.get(\"cacheWrite\",\"?\")}')
        break
print(f'Full JSONL: $KIMI_E2E_T3_JSONL')
"
printf '\n'

cache_ttl_check
cache_mechanism_isolation_check
dual_breakpoint_check
cache_key_semantics_check
cache_chain_check
cross_protocol_cache_check
system_tools_cache_check
large_delta_check
ttl_upper_check
block_size_sweep_check
tools_change_cache_check
small_boundary_cache_check
openai_cache_boundary_check
retention_none_provider_cache_check
usage_field_extraction_check
non_prompt_params_cache_check
multimodal_cache_check
concurrent_cache_check
very_large_cache_check
file_upload_check
cache_key_injection_check

log "E2E Tests complete!"
