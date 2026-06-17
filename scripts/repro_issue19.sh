#!/bin/bash
set -euo pipefail

# Reproduce https://github.com/Leechael/pi-provider-kimi-code/issues/19
# Tests each v0.6.0 payload change in isolation to find which one triggers 400.

API_KEY="${KIMI_API_KEY:-${1:-}}"
if [ -z "$API_KEY" ]; then
  echo "Usage: KIMI_API_KEY=sk-... $0"
  echo "   or: $0 sk-..."
  exit 1
fi

BASE_URL="${KIMI_CODE_BASE_URL:-https://api.kimi.com/coding/v1}"
BASE_URL="${BASE_URL%/}"

OPENAI_URL="$BASE_URL/chat/completions"
ANTHROPIC_URL="$BASE_URL/messages"

python3 - "$API_KEY" "$OPENAI_URL" "$ANTHROPIC_URL" <<'PY'
import json
import sys
import urllib.error
import urllib.request

api_key = sys.argv[1]
openai_url = sys.argv[2]
anthropic_url = sys.argv[3]

OPENAI_HEADERS = {
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}

ANTHROPIC_HEADERS = {
    "x-api-key": api_key,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
    "User-Agent": "KimiCLI/1.44.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.44.0",
}


def send(label, url, headers, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read().decode("utf-8")
            print(f"  [{label}] OK (status=200)")
            return True
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        print(f"  [{label}] FAIL (status={e.code})")
        print(f"  response: {err[:500]}")
        return False


def openai(label, payload):
    return send(label, openai_url, OPENAI_HEADERS, payload)


def anthropic(label, payload):
    return send(label, anthropic_url, ANTHROPIC_HEADERS, payload)


base_openai = {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": False,
}

base_anthropic = {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Say hello in one word."}
    ]}],
    "max_tokens": 32,
}

results = []


def test(name, fn):
    print(f"\n=== {name} ===")
    ok = fn()
    results.append((name, ok))


# -------------------------------------------------------------------------
# T1: baseline (v0.4.0 style payload, no new fields)
# -------------------------------------------------------------------------
test("T1a: OpenAI baseline", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": False,
}))

test("T1b: Anthropic baseline", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Say hello in one word."}
    ]}],
    "max_tokens": 32,
}))

# -------------------------------------------------------------------------
# T2: reasoning_effort: null (v0.6.0 sends this when thinking=none/off)
# -------------------------------------------------------------------------
test("T2a: OpenAI reasoning_effort=null", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": False,
    "reasoning_effort": None,
}))

test("T2b: Anthropic reasoning_effort=null", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Say hello in one word."}
    ]}],
    "max_tokens": 32,
    "reasoning_effort": None,
}))

# -------------------------------------------------------------------------
# T3: extra_body.thinking.type=disabled (v0.6.0 sends this when off)
# -------------------------------------------------------------------------
test("T3a: OpenAI thinking disabled", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": False,
    "extra_body": {"thinking": {"type": "disabled"}},
}))

test("T3b: Anthropic thinking disabled", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Say hello in one word."}
    ]}],
    "max_tokens": 32,
    "extra_body": {"thinking": {"type": "disabled"}},
}))

# -------------------------------------------------------------------------
# T4: both reasoning_effort=null + thinking disabled (combined v0.6.0 off)
# -------------------------------------------------------------------------
test("T4a: OpenAI combined off payload", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": False,
    "reasoning_effort": None,
    "extra_body": {"thinking": {"type": "disabled"}},
}))

test("T4b: Anthropic combined off payload", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Say hello in one word."}
    ]}],
    "max_tokens": 32,
    "reasoning_effort": None,
    "extra_body": {"thinking": {"type": "disabled"}},
}))

# -------------------------------------------------------------------------
# T5: reasoning_effort=low + thinking enabled (v0.6.0 on payload)
# -------------------------------------------------------------------------
test("T5a: OpenAI thinking enabled", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": False,
    "reasoning_effort": "low",
    "extra_body": {"thinking": {"type": "enabled"}},
}))

test("T5b: Anthropic thinking enabled", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Say hello in one word."}
    ]}],
    "max_tokens": 32,
    "reasoning_effort": "low",
    "extra_body": {"thinking": {"type": "enabled"}},
}))

# -------------------------------------------------------------------------
# T6: reasoning_effort=high + thinking enabled + keep
# -------------------------------------------------------------------------
test("T6a: OpenAI thinking high+keep", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": False,
    "reasoning_effort": "high",
    "extra_body": {"thinking": {"type": "enabled", "keep": "all"}},
}))

test("T6b: Anthropic thinking high+keep", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Say hello in one word."}
    ]}],
    "max_tokens": 32,
    "reasoning_effort": "high",
    "extra_body": {"thinking": {"type": "enabled", "keep": "all"}},
}))

# -------------------------------------------------------------------------
# T7: stream=true (v0.6.0 uses streaming; check if any field combo +
#     streaming triggers the error)
# -------------------------------------------------------------------------
test("T7a: OpenAI stream + reasoning null", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": True,
    "reasoning_effort": None,
    "extra_body": {"thinking": {"type": "disabled"}},
}))

test("T7b: OpenAI stream + reasoning high", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": True,
    "reasoning_effort": "high",
    "extra_body": {"thinking": {"type": "enabled", "keep": "all"}},
}))

# -------------------------------------------------------------------------
# T8: prompt_cache_key present (v0.6.0 injects this on OpenAI path)
# -------------------------------------------------------------------------
test("T8: OpenAI with prompt_cache_key", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": False,
    "prompt_cache_key": "test-session-key",
}))

# -------------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------------
print("\n" + "=" * 60)
print("SUMMARY")
print("=" * 60)
for name, ok in results:
    status = "PASS" if ok else "FAIL <---"
    print(f"  {status}  {name}")

fails = [name for name, ok in results if not ok]
if not fails:
    print("\nAll tests passed. The 400 may be triggered by a different condition.")
    print("Possible next steps:")
    print("  - Try with a tool_use message in the conversation")
    print("  - Try with an image attachment")
    print("  - Check if Pi sends additional fields not covered here")
else:
    print(f"\n{len(fails)} test(s) failed. These payload changes likely cause issue #19.")
PY
