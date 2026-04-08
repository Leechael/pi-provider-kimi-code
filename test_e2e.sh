#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
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
export KIMI_E2E_MODEL="${KIMI_E2E_MODEL:-kimi-coding/kimi-code}"
export KIMI_E2E_CACHE_INTERVALS="${KIMI_E2E_CACHE_INTERVALS:-60,300}"
export KIMI_E2E_CACHE_KEY="${KIMI_E2E_CACHE_KEY:-pi-provider-kimi-code-e2e-$$-$(date +%s)}"
export KIMI_E2E_CACHE_REPEAT="${KIMI_E2E_CACHE_REPEAT:-2000}"
export KIMI_E2E_SKIP_CACHE="${KIMI_E2E_SKIP_CACHE:-0}"

log() {
  printf '%s\n' "$*"
}

if [ "$KIMI_E2E_VERBOSE" = "1" ]; then
  log "Using extension: $SCRIPT_DIR"
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
    log "+ KIMI_CODE_PROTOCOL=$protocol $PI_BIN -ne -e $SCRIPT_DIR --model $KIMI_E2E_MODEL -p $prompt --mode print $*"
  fi
  KIMI_CODE_PROTOCOL="$protocol" "$PI_BIN" -ne -e "$SCRIPT_DIR" --model "$KIMI_E2E_MODEL" -p "$prompt" --mode print "$@"
  printf '\n'
}

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
    ("这是一段用于测试 Kimi Prompt Cache TTL 的无意义文本。 " * repeat) +
    "\n\n请只回复：ok"
)
payload = {
    "model": "kimi-code",
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
}


def send(label: str):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        "https://api.kimi.com/coding/v1/messages",
        data=body,
        headers=headers,
        method="POST",
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
            print(f"[{time.strftime('%X')}] {label}: status=200 elapsed={elapsed:.2f}s input={input_tokens} cache_read={cache_read} cache_create={cache_create}")
            if verbose:
                print(f"usage={json.dumps(usage, ensure_ascii=False)}")
            return cache_read, usage
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"[{time.strftime('%X')}] {label}: status={e.code} body={body}")
        raise
    except Exception as e:
        print(f"[{time.strftime('%X')}] {label}: request failed: {e}")
        raise

first_cache_read, _ = send("warmup")
for idx, wait in enumerate(intervals):
    print(f"sleeping {wait}s before next cache probe...")
    time.sleep(wait)
    cache_read, _ = send(f"probe_after_{wait}s")
    if idx == 0 and wait >= 60 and cache_read <= 0:
        print("WARNING: no cache hit observed on the first >=60s probe")

print("Cache TTL check complete. Inspect cache_read values above.")
PY
  printf '\n'
}

run_pi_test "Test 1: Anthropic Protocol (Default)" anthropic "Who are you? Respond in one sentence."
run_pi_test "Test 2: OpenAI Protocol" openai "Who are you? Respond in one sentence."
run_pi_test "Test 3: Thinking (High)" anthropic "Solve this: 25 * 4 + 10" --thinking high
cache_ttl_check

log "E2E Tests complete!"
