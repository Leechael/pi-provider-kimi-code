#!/bin/bash
set -euo pipefail

API_KEY="${KIMI_API_KEY:-${1:-}}"
if [ -z "$API_KEY" ]; then
  echo "Usage: KIMI_API_KEY=sk-... $0"
  echo "   or: $0 sk-..."
  exit 1
fi
export KIMI_API_KEY="$API_KEY"

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

run_pi_test() {
  local title="$1"
  local protocol="$2"
  local prompt="$3"
  shift 3

  log "=== $title ==="
  KIMI_CODE_PROTOCOL="$protocol" "$PI_BIN" -ne -e "$EXT_DIR" --model "$KIMI_E2E_MODEL" \
    -p "$prompt" "$@"
  printf '\n'
}

run_pi_test "Smoke: Anthropic protocol" anthropic "Who are you? Respond in one sentence." --mode text
run_pi_test "Smoke: OpenAI protocol" openai "Who are you? Respond in one sentence." --mode text

log "=== Thinking level x protocol matrix ==="
pass=0
fail=0
levels="${KIMI_E2E_THINKING_LEVELS:-off low medium high}"
for protocol in anthropic openai; do
  for level in $levels; do
    label="$protocol/thinking=$level"
    if KIMI_CODE_PROTOCOL="$protocol" "$PI_BIN" -ne -e "$EXT_DIR" --model "$KIMI_E2E_MODEL" \
      -p "What is 17*23? Reply with just the number." --thinking "$level" --mode text >/dev/null 2>&1; then
      log "  PASS  $label"
      pass=$((pass + 1))
    else
      log "  FAIL  $label"
      fail=$((fail + 1))
    fi
  done
done
log "Result: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
