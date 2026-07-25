import { describe, it } from "node:test";

import assert from "node:assert/strict";

// Encodes the window-cap invariant: a model's output cap (maxTokens) tracks its
// context window. pi-ai clamps the request cap to contextWindow - used - 4096
// (clampMaxTokensToContext), so maxTokens = contextWindow yields the official
// kimi-code output budget (maxCtx clamped to maxCtx - used) instead of a fixed
// small cap that truncates long max-effort reasoning. These fail if either
// contextWindow-update site (buildKimiModelFromConfig, applyKimiOAuthExtrasToModel)
// stops reconciling maxTokens.
import { DEFAULT_KIMI_CODE_CONFIG } from "../src/config.ts";
import { applyKimiOAuthExtrasToModel, buildKimiModelFromConfig } from "../src/models.ts";

describe("window-cap invariant: maxTokens tracks contextWindow", () => {
  it("buildKimiModelFromConfig caps maxTokens at the config context window", () => {
    const model = buildKimiModelFromConfig(DEFAULT_KIMI_CODE_CONFIG.model, "k3");
    assert.equal(model.contextWindow, DEFAULT_KIMI_CODE_CONFIG.model.contextWindow);
    assert.equal(model.maxTokens, model.contextWindow);
  });

  it("applyKimiOAuthExtrasToModel re-caps maxTokens when discovery grows the window", () => {
    const base = buildKimiModelFromConfig(DEFAULT_KIMI_CODE_CONFIG.model, "k3");
    const discovered = applyKimiOAuthExtrasToModel(base, { contextLength: 1048576 });
    assert.equal(discovered.contextWindow, 1048576);
    assert.equal(discovered.maxTokens, 1048576);
  });

  it("keeps maxTokens tracking the window when extras carry no contextLength", () => {
    const base = buildKimiModelFromConfig(DEFAULT_KIMI_CODE_CONFIG.model, "k3");
    const unchanged = applyKimiOAuthExtrasToModel(base, {});
    assert.equal(unchanged.contextWindow, base.contextWindow);
    assert.equal(unchanged.maxTokens, unchanged.contextWindow);
  });
});
