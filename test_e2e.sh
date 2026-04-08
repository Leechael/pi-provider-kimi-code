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

KIMI_HEADERS=(
  -H "User-Agent: KimiCLI/1.30.0"
  -H "X-Msh-Platform: kimi_cli"
  -H "X-Msh-Version: 1.30.0"
)
BASE_URL="${KIMI_CODE_BASE_URL:-https://api.kimi.com/coding/v1}"
BASE_URL="${BASE_URL%/}"

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
    log "+ KIMI_CODE_PROTOCOL=$protocol $PI_BIN -ne -e $SCRIPT_DIR --model $KIMI_E2E_MODEL -p $prompt $*"
  fi
  KIMI_CODE_PROTOCOL="$protocol" "$PI_BIN" -ne -e "$SCRIPT_DIR" --model "$KIMI_E2E_MODEL" -p "$prompt" "$@"
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
    "User-Agent": "KimiCLI/1.30.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.30.0",
}

results = []

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
            results.append({"label": label, "cache_read": cache_read, "cache_create": cache_create, "input": input_tokens})
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

# --- Conclusion ---
print()
any_hit = any(r["cache_read"] > 0 for r in results)
if any_hit:
    first_hit = next(r for r in results if r["cache_read"] > 0)
    last_hit = [r for r in results if r["cache_read"] > 0][-1]
    last_miss = [r for r in results if r["cache_read"] == 0]
    if last_miss and last_miss[-1] != results[0]:
        miss_label = last_miss[-1]["label"]
        print(f"Conclusion: cache hit observed (first at {first_hit['label']}), expired by {miss_label}.")
    else:
        print(f"Conclusion: cache hit observed at {first_hit['label']}. TTL >= {intervals[-1]}s (all probes hit).")
else:
    print("Conclusion: NO cache hit observed at any interval. Possible causes:")
    print("  - prompt_cache_key + cache_control may not be effective on this endpoint")
    print("  - cache TTL < shortest probe interval")
    print("  - server-side caching disabled for this model/key")
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
    'model': 'kimi-code',
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
    'model': 'kimi-code',
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
KIMI_CODE_PROTOCOL=anthropic "$PI_BIN" -ne -e "$SCRIPT_DIR" --model "$KIMI_E2E_MODEL" \
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
file_upload_check
cache_key_injection_check

log "E2E Tests complete!"
