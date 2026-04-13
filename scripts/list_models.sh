#!/bin/bash
set -euo pipefail

API_KEY="${KIMI_API_KEY:-${1:-}}"

if [ -z "$API_KEY" ]; then
  echo "Usage: KIMI_API_KEY=sk-... $0"
  echo "   or: $0 sk-..."
  exit 1
fi

BASE_URL="${KIMI_CODE_BASE_URL:-https://api.kimi.com/coding/v1}"
BASE_URL="${BASE_URL%/}"

KIMI_HEADERS=(
  -H "User-Agent: KimiCLI/1.30.0"
  -H "X-Msh-Platform: kimi_cli"
  -H "X-Msh-Version: 1.30.0"
)

curl -s "${BASE_URL}/models" \
  -H "Authorization: Bearer ${API_KEY}" \
  "${KIMI_HEADERS[@]}" | python3 -c "
import json, sys
d = json.load(sys.stdin)
models = d.get('data', d) if isinstance(d, dict) else d
if not isinstance(models, list):
    print(json.dumps(d, indent=2, ensure_ascii=False))
    sys.exit(0)
for m in models:
    mid = m.get('id', '?')
    ctx = m.get('context_length', '?')
    reasoning = m.get('supports_reasoning', '?')
    img = m.get('supports_image_in', '?')
    vid = m.get('supports_video_in', '?')
    print(f'{mid}  context={ctx}  reasoning={reasoning}  image={img}  video={vid}')
print()
print('--- raw ---')
print(json.dumps(models, indent=2, ensure_ascii=False))
"
