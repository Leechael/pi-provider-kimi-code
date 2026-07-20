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

python3 - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

base_url = os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1").rstrip("/")
models_url = f"{base_url}/models" if base_url.endswith("/v1") else f"{base_url}/v1/models"
usage_url = f"{base_url}/usages"
headers = {
    "Authorization": f"Bearer {os.environ['KIMI_API_KEY']}",
    "Accept": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}


def fetch(url: str):
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")[:500]
        print(f"FAIL {url}: HTTP {error.code}: {body}")
        sys.exit(1)
    except Exception as error:
        print(f"FAIL {url}: {error}")
        sys.exit(1)


print(f"MODELS_URL {models_url}")
models_payload = fetch(models_url)
models = models_payload.get("data", models_payload) if isinstance(models_payload, dict) else models_payload
if not isinstance(models, list):
    print("FAIL /models: expected a JSON array or an object with data[]")
    sys.exit(1)

print(f"MODELS_COUNT {len(models)}")
for model in models:
    if not isinstance(model, dict):
        print("FAIL /models: every entry must be an object")
        sys.exit(1)
    if not isinstance(model.get("id"), str) or not model["id"]:
        print("FAIL /models: model is missing a non-empty id")
        sys.exit(1)
    context_length = model.get("context_length")
    if not isinstance(context_length, int) or context_length <= 0:
        print(f"FAIL /models: {model['id']} is missing a positive integer context_length")
        sys.exit(1)
    print(
        json.dumps(
            {
                "id": model.get("id"),
                "display_name": model.get("display_name"),
                "context_length": model.get("context_length"),
                "supports_reasoning": model.get("supports_reasoning"),
                "supports_thinking_type": model.get("supports_thinking_type"),
                "think_efforts": model.get("think_efforts"),
                "protocol": model.get("protocol"),
                "supports_image_in": model.get("supports_image_in"),
                "supports_video_in": model.get("supports_video_in"),
                "supports_tool_use": model.get("supports_tool_use"),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )

print(f"USAGES_URL {usage_url}")
usage_payload = fetch(usage_url)
user = usage_payload.get("user") if isinstance(usage_payload, dict) else None
membership = user.get("membership") if isinstance(user, dict) else None
print(
    "USAGES_MEMBERSHIP "
    + json.dumps(membership, ensure_ascii=False, sort_keys=True)
)
PY
