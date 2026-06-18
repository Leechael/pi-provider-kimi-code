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


def has_thinking_openai(data):
    """Check if OpenAI response contains reasoning_content."""
    for choice in data.get("choices", []):
        msg = choice.get("message") or choice.get("delta") or {}
        if msg.get("reasoning_content"):
            return True
    return False


def has_thinking_anthropic(data):
    """Check if Anthropic response contains a thinking block."""
    for block in data.get("content", []):
        if block.get("type") == "thinking":
            return True
    return False


def send(label, url, headers, payload, expect_thinking=None):
    is_stream = payload.get("stream", False)
    is_anthropic = "x-api-key" in headers
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8", errors="replace")

            has_think = False
            if is_stream:
                for line in raw.splitlines():
                    if not line.startswith("data: ") or line.strip() == "data: [DONE]":
                        continue
                    chunk = json.loads(line[6:])
                    if is_anthropic:
                        if chunk.get("type") == "content_block_start":
                            cb = chunk.get("content_block", {})
                            if cb.get("type") == "thinking":
                                has_think = True
                    else:
                        for ch in chunk.get("choices", []):
                            delta = ch.get("delta", {})
                            if delta.get("reasoning_content"):
                                has_think = True
            else:
                data = json.loads(raw)
                if is_anthropic:
                    has_think = has_thinking_anthropic(data)
                else:
                    has_think = has_thinking_openai(data)

            status = "OK"
            thinking_tag = f"thinking={'yes' if has_think else 'no'}"
            if expect_thinking is not None:
                if expect_thinking and not has_think:
                    status = "WARN: expected thinking but got none"
                elif not expect_thinking and has_think:
                    status = "WARN: got thinking but expected none"
            print(f"  [{label}] {status} ({thinking_tag})")
            return {"ok": True, "thinking": has_think}
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        print(f"  [{label}] FAIL (status={e.code})")
        print(f"  response: {err[:500]}")
        return {"ok": False, "thinking": None}


def openai(label, payload, expect_thinking=None):
    return send(label, openai_url, OPENAI_HEADERS, payload, expect_thinking)


def anthropic(label, payload, expect_thinking=None):
    return send(label, anthropic_url, ANTHROPIC_HEADERS, payload, expect_thinking)


results = []


def test(name, fn):
    print(f"\n=== {name} ===")
    result = fn()
    results.append((name, result))


# Use a prompt that requires reasoning so thinking output is detectable.
PROMPT = "What is 17 * 23? Reply with just the number."
OPENAI_MSG = [{"role": "user", "content": PROMPT}]
ANTHROPIC_MSG = [{"role": "user", "content": [{"type": "text", "text": PROMPT}]}]

# -------------------------------------------------------------------------
# Group A: Baselines
# -------------------------------------------------------------------------
test("A1: OpenAI baseline (no reasoning fields)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": OPENAI_MSG,
    "max_completion_tokens": 128,
    "stream": False,
}))

test("A2: Anthropic baseline (no reasoning fields)", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": ANTHROPIC_MSG,
    "max_tokens": 128,
}))

# -------------------------------------------------------------------------
# Group B: OLD behavior — reasoning_effort: null (v0.6.0 bug)
# -------------------------------------------------------------------------
test("B1: OpenAI reasoning_effort=null", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": OPENAI_MSG,
    "max_completion_tokens": 128,
    "stream": False,
    "reasoning_effort": None,
}))

test("B2: Anthropic reasoning_effort=null", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": ANTHROPIC_MSG,
    "max_tokens": 128,
    "reasoning_effort": None,
}))

# -------------------------------------------------------------------------
# Group C: OLD behavior — thinking nested in extra_body (v0.6.0 bug)
# -------------------------------------------------------------------------
test("C1: OpenAI thinking in extra_body (old)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": OPENAI_MSG,
    "max_completion_tokens": 128,
    "stream": False,
    "reasoning_effort": "high",
    "extra_body": {"thinking": {"type": "enabled"}},
}, expect_thinking=True))

test("C2: OpenAI thinking disabled in extra_body (old)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": OPENAI_MSG,
    "max_completion_tokens": 128,
    "stream": False,
    "reasoning_effort": None,
    "extra_body": {"thinking": {"type": "disabled"}},
}, expect_thinking=False))

test("C3: Anthropic thinking in extra_body (old)", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": ANTHROPIC_MSG,
    "max_tokens": 128,
    "reasoning_effort": "high",
    "extra_body": {"thinking": {"type": "enabled"}},
}, expect_thinking=True))

test("C4: Anthropic thinking disabled in extra_body (old)", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": ANTHROPIC_MSG,
    "max_tokens": 128,
    "reasoning_effort": None,
    "extra_body": {"thinking": {"type": "disabled"}},
}, expect_thinking=False))

# -------------------------------------------------------------------------
# Group D: FIXED behavior — thinking at top level, no null effort
# -------------------------------------------------------------------------
test("D1: OpenAI thinking enabled at top level (fixed)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": OPENAI_MSG,
    "max_completion_tokens": 128,
    "stream": False,
    "reasoning_effort": "high",
    "thinking": {"type": "enabled"},
}, expect_thinking=True))

test("D2: OpenAI thinking disabled at top level (fixed)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": OPENAI_MSG,
    "max_completion_tokens": 128,
    "stream": False,
    "thinking": {"type": "disabled"},
}, expect_thinking=False))

test("D3: Anthropic thinking enabled at top level (fixed)", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": ANTHROPIC_MSG,
    "max_tokens": 128,
    "reasoning_effort": "high",
    "thinking": {"type": "enabled"},
}, expect_thinking=True))

test("D4: Anthropic thinking disabled at top level (fixed)", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": ANTHROPIC_MSG,
    "max_tokens": 128,
    "thinking": {"type": "disabled"},
}, expect_thinking=False))

# -------------------------------------------------------------------------
# Group E: Streaming + old combos
# -------------------------------------------------------------------------
test("E1: OpenAI stream + reasoning null + extra_body (old)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": OPENAI_MSG,
    "max_completion_tokens": 128,
    "stream": True,
    "reasoning_effort": None,
    "extra_body": {"thinking": {"type": "disabled"}},
}, expect_thinking=False))

test("E2: OpenAI stream + reasoning high + extra_body (old)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": OPENAI_MSG,
    "max_completion_tokens": 128,
    "stream": True,
    "reasoning_effort": "high",
    "extra_body": {"thinking": {"type": "enabled", "keep": "all"}},
}, expect_thinking=True))

# -------------------------------------------------------------------------
# Group F: Streaming + fixed combos + stream_options (both endpoints)
# -------------------------------------------------------------------------
test("F1: OpenAI stream + thinking disabled (fixed)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": OPENAI_MSG,
    "max_completion_tokens": 128,
    "stream": True,
    "thinking": {"type": "disabled"},
    "stream_options": {"include_usage": True},
}, expect_thinking=False))

test("F2: OpenAI stream + thinking enabled (fixed)", lambda: openai("openai", {
    "model": "kimi-for-coding",
    "messages": OPENAI_MSG,
    "max_completion_tokens": 128,
    "stream": True,
    "reasoning_effort": "high",
    "thinking": {"type": "enabled", "keep": "all"},
    "stream_options": {"include_usage": True},
}, expect_thinking=True))

test("F3: Anthropic stream + thinking disabled (fixed)", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": ANTHROPIC_MSG,
    "max_tokens": 128,
    "stream": True,
    "thinking": {"type": "disabled"},
}, expect_thinking=False))

test("F4: Anthropic stream + thinking enabled (fixed)", lambda: anthropic("anthropic", {
    "model": "kimi-for-coding",
    "messages": ANTHROPIC_MSG,
    "max_tokens": 128,
    "stream": True,
    "reasoning_effort": "high",
    "thinking": {"type": "enabled", "keep": "all"},
}, expect_thinking=True))

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

result_map = {n: r for n, r in results}

def fmt(name, r):
    if not r["ok"]:
        return f"  FAIL  {name}"
    think = r.get("thinking")
    tag = f" (thinking={'yes' if think else 'no'})"
    return f"  PASS  {name}{tag}"

old_tests = [n for n, _ in results if n.startswith(("B", "C", "E"))]
new_tests = [n for n, _ in results if n.startswith(("D", "F"))]

print("\nBaselines:")
for name, r in results:
    if name.startswith("A"):
        print(fmt(name, r))

print("\nOld (v0.6.0) payloads — does server honor extra_body.thinking?")
for name in old_tests:
    print(fmt(name, result_map[name]))

print("\nFixed payloads — does server honor top-level thinking?")
for name in new_tests:
    print(fmt(name, result_map[name]))

print("\nOther:")
for name, r in results:
    if name.startswith("G"):
        print(fmt(name, r))

# Check if thinking config is actually effective
old_ignored = []
new_ignored = []
for name in old_tests:
    r = result_map[name]
    if not r["ok"]:
        continue
    if "enabled" in name.lower() and not r["thinking"]:
        old_ignored.append(name)
    if "disabled" in name.lower() and r["thinking"]:
        old_ignored.append(name)
for name in new_tests:
    r = result_map[name]
    if not r["ok"]:
        continue
    if "enabled" in name.lower() and not r["thinking"]:
        new_ignored.append(name)
    if "disabled" in name.lower() and r["thinking"]:
        new_ignored.append(name)

http_fails = [n for n, r in results if not r["ok"]]

print()
if http_fails:
    print(f"HTTP failures: {', '.join(http_fails)}")
if old_ignored:
    print(f"Server IGNORED thinking config (old payloads): {', '.join(old_ignored)}")
if new_ignored:
    print(f"Server IGNORED thinking config (fixed payloads): {', '.join(new_ignored)}")
if not http_fails and not old_ignored and not new_ignored:
    print("All tests passed and thinking config is respected on both protocols.")
elif not http_fails and old_ignored and not new_ignored:
    print("Old extra_body nesting is ignored by server. Fixed top-level thinking works.")
elif not http_fails and not new_ignored:
    print("Fixed payloads work correctly. Some old payloads may be ignored.")
PY
