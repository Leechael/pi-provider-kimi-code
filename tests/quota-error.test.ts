import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { improveKimiErrorMessage, isKimiQuotaExhaustedMessage } from "../src/errors.ts";

describe("Kimi quota error classification", () => {
  it("matches a 429 carrying exceeded_current_quota_error", () => {
    const message =
      '429 {"error":{"message":"You have exceeded your current quota","type":"exceeded_current_quota_error"}}';
    assert.equal(isKimiQuotaExhaustedMessage(message), true);
  });

  it("matches nested anthropic-style error bodies", () => {
    const message =
      'Error: 429 {"error":{"type":"error","error":{"type":"exceeded_current_quota_error","message":"quota exceeded"}}}';
    assert.equal(isKimiQuotaExhaustedMessage(message), true);
  });

  it("does not match a plain transient 429 rate limit", () => {
    assert.equal(isKimiQuotaExhaustedMessage('429 {"error":{"type":"rate_limit_error"}}'), false);
  });

  it("does not match the quota code without a 429 status", () => {
    assert.equal(isKimiQuotaExhaustedMessage("exceeded_current_quota_error"), false);
  });

  it("rewrites quota errors into actionable guidance", () => {
    const raw =
      '429 {"error":{"message":"You have exceeded your current quota","type":"exceeded_current_quota_error"}}';
    const improved = improveKimiErrorMessage(raw);
    assert.match(improved, /hard quota limit/);
    assert.match(improved, /\/kimi-settings/);
    assert.match(improved, new RegExp(`Original error: ${raw.slice(0, 20)}`));
  });

  it("leaves unrelated errors untouched", () => {
    const raw = "500 internal server error";
    assert.equal(improveKimiErrorMessage(raw), raw);
  });
});
