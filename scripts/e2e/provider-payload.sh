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

CAPTURE_DIR="${CAPTURE_DIR:-$(mktemp -d -t kimi-provider-payload-XXXXXX)}"
CAPTURE_PORT="${CAPTURE_PORT:-$(python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)}"
CAPTURE_TARGET_ORIGIN="${CAPTURE_TARGET_ORIGIN:-https://api.kimi.com}"

cleanup() {
  if [ -n "${proxy_pid:-}" ]; then
    kill "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
  fi
  if [ "${KIMI_E2E_KEEP_CAPTURES:-0}" != "1" ]; then
    rm -rf "$CAPTURE_DIR"
  else
    log "Captures retained at $CAPTURE_DIR"
  fi
}
trap cleanup EXIT

CAPTURE_PORT="$CAPTURE_PORT" CAPTURE_TARGET_ORIGIN="$CAPTURE_TARGET_ORIGIN" CAPTURE_DIR="$CAPTURE_DIR" \
  node "$SCRIPT_DIR/../kimi-compat/capture_proxy.mjs" >/tmp/kimi-provider-payload-proxy.log 2>&1 &
proxy_pid=$!

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:${CAPTURE_PORT}/health" >/dev/null; then
    break
  fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:${CAPTURE_PORT}/health" >/dev/null

proxy_base_url="http://127.0.0.1:${CAPTURE_PORT}/coding/v1"
KIMI_CODE_BASE_URL="$proxy_base_url" KIMI_CODE_PROTOCOL="${KIMI_E2E_PROVIDER_PROTOCOL:-openai}" \
  "$PI_BIN" -ne -e "$EXT_DIR" --model "$KIMI_E2E_MODEL" \
  -p "What is 17 * 23? Reply with just the number." \
  --thinking "${KIMI_E2E_PROVIDER_THINKING:-high}" --mode print >/dev/null

python3 - "$CAPTURE_DIR" "${KIMI_E2E_WIRE_MODEL}" "${KIMI_E2E_EXPECT_THINKING_EFFORT:-none}" <<'PY'
import json
import pathlib
import sys

capture_dir = pathlib.Path(sys.argv[1])
expected_model = sys.argv[2]
expected_effort = sys.argv[3]
requests = sorted(capture_dir.glob("*-request.json"))
if not requests:
    print("FAIL: provider emitted no captured HTTP request")
    sys.exit(1)

for path in requests:
    request = json.loads(path.read_text())
    body = request.get("bodyJson")
    if not isinstance(body, dict) or "model" not in body:
        continue
    if body["model"] != expected_model:
        print(f"FAIL: expected wire model {expected_model!r}, got {body['model']!r}")
        sys.exit(1)
    if "reasoning_effort" in body:
        print(f"FAIL: legacy reasoning_effort must be absent, got {body['reasoning_effort']!r}")
        sys.exit(1)
    thinking = body.get("thinking")
    if not isinstance(thinking, dict) or thinking.get("type") != "enabled":
        print(f"FAIL: expected root thinking.type=enabled, got {thinking!r}")
        sys.exit(1)
    actual_effort = thinking.get("effort")
    if expected_effort == "none" and actual_effort is not None:
        print(f"FAIL: model advertises no effort support, got thinking.effort={actual_effort!r}")
        sys.exit(1)
    if expected_effort != "none" and actual_effort != expected_effort:
        print(f"FAIL: expected thinking.effort={expected_effort!r}, got {actual_effort!r}")
        sys.exit(1)
    print(f"PASS: captured {request.get('url')} with model={body['model']!r} and thinking={thinking!r}")
    sys.exit(0)

print("FAIL: no captured model request payload")
sys.exit(1)
PY
