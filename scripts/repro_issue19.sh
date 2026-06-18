#!/bin/bash
set -euo pipefail

# Reproduce https://github.com/Leechael/pi-provider-kimi-code/issues/19
#
# Tests old (v0.6.0) and fixed payload shapes against Kimi's OpenAI and
# Anthropic endpoints. Covers reasoning_effort null vs omitted,
# extra_body nesting vs top-level thinking, streaming combos, and
# stream_options.

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
            resp.read()
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


results = []


def test(name, fn):
    print(f"\n=== {name} ===")
    ok = fn()
    results.append((name, ok))


# -------------------------------------------------------------------------
# Group A: Baselines
# -------------------------------------------------------------------------
test("A1: OpenAI baseline (no reasoning fields)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": False,
}))

test("A2: Anthropic baseline (no reasoning fields)", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Say hello in one word."}
    ]}],
    "max_tokens": 32,
}))

# -------------------------------------------------------------------------
# Group B: OLD behavior — reasoning_effort: null (v0.6.0 bug)
# -------------------------------------------------------------------------
test("B1: OpenAI reasoning_effort=null", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": False,
    "reasoning_effort": None,
}))

test("B2: Anthropic reasoning_effort=null", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Say hello in one word."}
    ]}],
    "max_tokens": 32,
    "reasoning_effort": None,
}))

# -------------------------------------------------------------------------
# Group C: OLD behavior — thinking nested in extra_body (v0.6.0 bug)
# -------------------------------------------------------------------------
test("C1: OpenAI thinking in extra_body (old)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": False,
    "reasoning_effort": "high",
    "extra_body": {"thinking": {"type": "enabled"}},
}))

test("C2: OpenAI thinking disabled in extra_body (old)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": False,
    "reasoning_effort": None,
    "extra_body": {"thinking": {"type": "disabled"}},
}))

test("C3: Anthropic thinking in extra_body (old)", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Say hello in one word."}
    ]}],
    "max_tokens": 32,
    "reasoning_effort": "high",
    "extra_body": {"thinking": {"type": "enabled"}},
}))

test("C4: Anthropic thinking disabled in extra_body (old)", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Say hello in one word."}
    ]}],
    "max_tokens": 32,
    "reasoning_effort": None,
    "extra_body": {"thinking": {"type": "disabled"}},
}))

# -------------------------------------------------------------------------
# Group D: FIXED behavior — thinking at top level, no null effort
# -------------------------------------------------------------------------
test("D1: OpenAI thinking enabled at top level (fixed)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": False,
    "reasoning_effort": "high",
    "thinking": {"type": "enabled"},
}))

test("D2: OpenAI thinking disabled at top level (fixed)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": False,
    "thinking": {"type": "disabled"},
}))

test("D3: Anthropic thinking enabled at top level (fixed)", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Say hello in one word."}
    ]}],
    "max_tokens": 32,
    "reasoning_effort": "high",
    "thinking": {"type": "enabled"},
}))

test("D4: Anthropic thinking disabled at top level (fixed)", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Say hello in one word."}
    ]}],
    "max_tokens": 32,
    "thinking": {"type": "disabled"},
}))

# -------------------------------------------------------------------------
# Group E: Streaming + old combos
# -------------------------------------------------------------------------
test("E1: OpenAI stream + reasoning null + extra_body (old)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": True,
    "reasoning_effort": None,
    "extra_body": {"thinking": {"type": "disabled"}},
}))

test("E2: OpenAI stream + reasoning high + extra_body (old)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": True,
    "reasoning_effort": "high",
    "extra_body": {"thinking": {"type": "enabled", "keep": "all"}},
}))

# -------------------------------------------------------------------------
# Group F: Streaming + fixed combos + stream_options
# -------------------------------------------------------------------------
test("F1: OpenAI stream + thinking disabled at top level (fixed)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": True,
    "thinking": {"type": "disabled"},
    "stream_options": {"include_usage": True},
}))

test("F2: OpenAI stream + thinking enabled at top level (fixed)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_completion_tokens": 32,
    "stream": True,
    "reasoning_effort": "high",
    "thinking": {"type": "enabled", "keep": "all"},
    "stream_options": {"include_usage": True},
}))

# -------------------------------------------------------------------------
# Group G: prompt_cache_key
# -------------------------------------------------------------------------
test("G1: OpenAI with prompt_cache_key", lambda: openai("openai", {
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

old_tests = [n for n, _ in results if n.startswith(("B", "C", "E"))]
new_tests = [n for n, _ in results if n.startswith(("D", "F"))]
result_map = {n: ok for n, ok in results}

print("\nBaselines:")
for name, ok in results:
    if name.startswith("A"):
        print(f"  {'PASS' if ok else 'FAIL':>4}  {name}")

print("\nOld (v0.6.0) payloads:")
for name in old_tests:
    ok = result_map[name]
    print(f"  {'PASS' if ok else 'FAIL':>4}  {name}")

print("\nFixed payloads:")
for name in new_tests:
    ok = result_map[name]
    print(f"  {'PASS' if ok else 'FAIL':>4}  {name}")

print("\nOther:")
for name, ok in results:
    if name.startswith("G"):
        print(f"  {'PASS' if ok else 'FAIL':>4}  {name}")

old_fails = [n for n in old_tests if not result_map[n]]
new_fails = [n for n in new_tests if not result_map[n]]
all_fails = [n for n, ok in results if not ok]

print()
if old_fails and not new_fails:
    print(f"Old payloads broke: {', '.join(old_fails)}")
    print("Fixed payloads all pass. The fix addresses the issue.")
elif not all_fails:
    print("All tests passed. Kimi accepts both old and new payloads.")
    print("The 400 may depend on Pi version, auth method, or conversation state.")
elif new_fails:
    print(f"Fixed payloads FAILED: {', '.join(new_fails)}")
    print("Investigate — the fix may be wrong or incomplete.")
else:
    print(f"Failures: {', '.join(all_fails)}")
PY
