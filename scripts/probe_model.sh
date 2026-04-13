#!/bin/bash
set -euo pipefail

API_KEY="${KIMI_API_KEY:-}"
MODEL_ID="${KIMI_PROBE_MODEL:-${1:-}}"

if [ -z "$API_KEY" ] || [ -z "$MODEL_ID" ]; then
  echo "Usage: KIMI_API_KEY=sk-... $0 <model-id>"
  echo "   or: KIMI_API_KEY=sk-... KIMI_PROBE_MODEL=kimi-xxx $0"
  exit 1
fi

BASE_URL="${KIMI_CODE_BASE_URL:-https://api.kimi.com/coding/v1}"
BASE_URL="${BASE_URL%/}"

KIMI_HEADERS=(
  -H "User-Agent: KimiCLI/1.30.0"
  -H "X-Msh-Platform: kimi_cli"
  -H "X-Msh-Version: 1.30.0"
)

PROMPT="Reply with only: ok"

echo "Probing model: $MODEL_ID"
echo "Base URL: $BASE_URL"
echo ""

# ---------------------------------------------------------------------------
# Anthropic Messages API
# ---------------------------------------------------------------------------
echo "--- Anthropic Messages API ---"
ANTHROPIC_PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'model': '${MODEL_ID}',
  'max_tokens': 50,
  'messages': [{'role': 'user', 'content': '${PROMPT}'}],
}))
")

HTTP_CODE=$(curl -s -o /tmp/kimi_probe_anthropic.json -w "%{http_code}" \
  -X POST "${BASE_URL}/messages" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "x-api-key: ${API_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  "${KIMI_HEADERS[@]}" \
  -d "$ANTHROPIC_PAYLOAD")

if [ "$HTTP_CODE" = "200" ]; then
  python3 -c "
import json
d = json.load(open('/tmp/kimi_probe_anthropic.json'))
text = d.get('content', [{}])[0].get('text', '(no text)')
usage = d.get('usage', {})
print(f'status=200  reply={text!r}  usage={json.dumps(usage)}')
"
else
  python3 -c "
import json, sys
try:
  d = json.load(open('/tmp/kimi_probe_anthropic.json'))
  print(f'status=${HTTP_CODE}  error={json.dumps(d)}')
except Exception:
  print(f'status=${HTTP_CODE}  body=' + open('/tmp/kimi_probe_anthropic.json').read())
"
fi
rm -f /tmp/kimi_probe_anthropic.json
echo ""

# ---------------------------------------------------------------------------
# OpenAI Chat Completions API
# ---------------------------------------------------------------------------
echo "--- OpenAI Chat Completions API ---"
OPENAI_PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'model': '${MODEL_ID}',
  'max_tokens': 50,
  'messages': [{'role': 'user', 'content': '${PROMPT}'}],
}))
")

HTTP_CODE=$(curl -s -o /tmp/kimi_probe_openai.json -w "%{http_code}" \
  -X POST "${BASE_URL}/chat/completions" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  "${KIMI_HEADERS[@]}" \
  -d "$OPENAI_PAYLOAD")

if [ "$HTTP_CODE" = "200" ]; then
  python3 -c "
import json
d = json.load(open('/tmp/kimi_probe_openai.json'))
text = d.get('choices', [{}])[0].get('message', {}).get('content', '(no text)')
usage = d.get('usage', {})
print(f'status=200  reply={text!r}  usage={json.dumps(usage)}')
"
else
  python3 -c "
import json, sys
try:
  d = json.load(open('/tmp/kimi_probe_openai.json'))
  print(f'status=${HTTP_CODE}  error={json.dumps(d)}')
except Exception:
  print(f'status=${HTTP_CODE}  body=' + open('/tmp/kimi_probe_openai.json').read())
"
fi
rm -f /tmp/kimi_probe_openai.json
