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

# Unset KIMI_E2E_EXPECT_THINKING_EFFORT derives from /models: send effort only
# when the catalog advertises the mapped Pi thinking level (default high →
# kimi effort high). kimi-for-coding now ships think_efforts; a hardcoded
# none default false-fails the capture against current catalogs.
export KIMI_E2E_PROVIDER_THINKING="${KIMI_E2E_PROVIDER_THINKING:-high}"
if [ -z "${KIMI_E2E_EXPECT_THINKING_EFFORT:-}" ]; then
  KIMI_E2E_EXPECT_THINKING_EFFORT="$(python3 - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

base_url = os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/")
model_id = os.environ["KIMI_E2E_WIRE_MODEL"]
thinking = os.environ.get("KIMI_E2E_PROVIDER_THINKING", "high")
# Mirrors DEFAULT_KIMI_CODE_CONFIG.model.reasoningMap.
level_to_effort = {
    "none": None,
    "off": None,
    "minimal": "low",
    "low": "low",
    "medium": "high",
    "high": "high",
    "xhigh": "max",
    "max": "max",
}
if thinking not in level_to_effort:
    print(f"FAIL: unknown KIMI_E2E_PROVIDER_THINKING={thinking!r}", file=sys.stderr)
    sys.exit(1)
mapped = level_to_effort[thinking]
request = urllib.request.Request(
    f"{base_url}/models",
    headers={
        "Authorization": f"Bearer {os.environ['KIMI_API_KEY']}",
        "Accept": "application/json",
        "User-Agent": "KimiCLI/1.44.0",
        "X-Msh-Platform": "kimi_cli",
        "X-Msh-Version": "1.44.0",
    },
)
try:
    with urllib.request.urlopen(request, timeout=60) as response:
        catalog = json.load(response)
except urllib.error.HTTPError as error:
    print(f"FAIL /models: HTTP {error.code}: {error.read().decode('utf-8', errors='replace')[:500]}", file=sys.stderr)
    sys.exit(1)
except Exception as error:
    print(f"FAIL /models: {error}", file=sys.stderr)
    sys.exit(1)

models = catalog.get("data", catalog) if isinstance(catalog, dict) else catalog
model = next((item for item in models if isinstance(item, dict) and item.get("id") == model_id), None)
if model is None:
    print(f"FAIL /models: model {model_id!r} was not returned", file=sys.stderr)
    sys.exit(1)

if mapped is None:
    print("none")
    sys.exit(0)
efforts = model.get("think_efforts")
valid = efforts.get("valid_efforts") if isinstance(efforts, dict) else None
if (
    isinstance(efforts, dict)
    and efforts.get("support") is True
    and isinstance(valid, list)
    and mapped in valid
):
    print(mapped)
else:
    print("none")
PY
)"
  export KIMI_E2E_EXPECT_THINKING_EFFORT
  log "Derived expected thinking.effort=${KIMI_E2E_EXPECT_THINKING_EFFORT} (thinking=${KIMI_E2E_PROVIDER_THINKING})"
fi

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
  --thinking "${KIMI_E2E_PROVIDER_THINKING:-high}" --mode text >/dev/null

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
