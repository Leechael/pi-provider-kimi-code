import { describe, it } from "node:test";
import assert from "node:assert/strict";

// These tests exercise pi-ai's real getSupportedThinkingLevels gate: the pi
// thinking selector offers xhigh/max only for models with an explicit
// thinkingLevelMap entry and hides levels mapped to null. If pi changes that
// contract, these tests must fail — they encode WHY the map is built.
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { DEFAULT_KIMI_CODE_CONFIG } from "../src/config.ts";
import {
  applyKimiOAuthExtrasToModel,
  buildKimiModelFromConfig,
  buildKimiThinkingLevelMap,
} from "../src/models.ts";

const DEFAULT_REASONING_MAP = DEFAULT_KIMI_CODE_CONFIG.model.reasoningMap;

const K3_EXTRAS = {
  supportEfforts: ["low", "high", "max"],
  supportsThinkingType: "only" as const,
};

function baseK3Model() {
  return buildKimiModelFromConfig(DEFAULT_KIMI_CODE_CONFIG.model, "k3");
}

describe("buildKimiThinkingLevelMap", () => {
  it("returns undefined when the server advertised no effort control", () => {
    assert.equal(buildKimiThinkingLevelMap(DEFAULT_REASONING_MAP, {}), undefined);
    assert.equal(
      buildKimiThinkingLevelMap(DEFAULT_REASONING_MAP, { supportEfforts: [] }),
      undefined,
    );
  });

  it("offers exactly the levels whose mapped effort the server advertises", () => {
    const map = buildKimiThinkingLevelMap(DEFAULT_REASONING_MAP, K3_EXTRAS);
    assert.deepEqual(map, {
      off: null, // thinking-only model cannot disable reasoning
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
    });
  });

  it("keeps off selectable for models where thinking can be disabled", () => {
    const map = buildKimiThinkingLevelMap(DEFAULT_REASONING_MAP, {
      ...K3_EXTRAS,
      supportsThinkingType: "both",
    });
    assert.equal(map?.off, "off");
  });

  it("hides levels whose mapped effort is not advertised", () => {
    const map = buildKimiThinkingLevelMap(DEFAULT_REASONING_MAP, {
      supportEfforts: ["low"],
      supportsThinkingType: "both",
    });
    assert.deepEqual(map, {
      off: "off",
      minimal: "low",
      low: "low",
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    });
  });

  it("respects a user-remapped reasoningMap", () => {
    const custom = {
      ...DEFAULT_REASONING_MAP,
      medium: { effort: "low", enabled: true },
    };
    const map = buildKimiThinkingLevelMap(custom, {
      supportEfforts: ["low"],
      supportsThinkingType: "both",
    });
    assert.equal(map?.medium, "low");
    assert.equal(map?.high, null);
  });
});

describe("thinking levels through pi-ai's real selector gate", () => {
  it("K3 with advertised efforts exposes minimal..max (and not off)", () => {
    const model = applyKimiOAuthExtrasToModel(baseK3Model(), K3_EXTRAS, DEFAULT_REASONING_MAP);
    assert.deepEqual(getSupportedThinkingLevels(model), [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("models without advertised efforts keep pi's default ceiling (high)", () => {
    const model = applyKimiOAuthExtrasToModel(baseK3Model(), {}, DEFAULT_REASONING_MAP);
    assert.equal(model.thinkingLevelMap, undefined);
    const levels = getSupportedThinkingLevels(model);
    assert.ok(levels.includes("high"));
    assert.ok(!levels.includes("max"));
    assert.ok(!levels.includes("xhigh"));
  });

  it("omitting the reasoningMap leaves the model untouched (back-compat)", () => {
    const model = applyKimiOAuthExtrasToModel(baseK3Model(), K3_EXTRAS);
    assert.equal(model.thinkingLevelMap, undefined);
  });

  it("a catalog refresh that drops effort control clears the derived map and efforts", () => {
    // modifyModels re-applies extras onto previously modified models, so the
    // merge must be rebuild-safe: capability removal must not leave a stale
    // selector map or stale efforts the payload would keep sending.
    const withEfforts = applyKimiOAuthExtrasToModel(baseK3Model(), K3_EXTRAS, DEFAULT_REASONING_MAP);
    assert.ok(getSupportedThinkingLevels(withEfforts).includes("max"));
    const refreshed = applyKimiOAuthExtrasToModel(
      withEfforts,
      { supportsThinkingType: "only" },
      DEFAULT_REASONING_MAP,
    );
    assert.equal(refreshed.thinkingLevelMap, undefined);
    assert.equal(
      (refreshed as { supportEfforts?: string[] }).supportEfforts,
      undefined,
    );
    assert.equal((refreshed as { defaultEffort?: string }).defaultEffort, undefined);
    const levels = getSupportedThinkingLevels(refreshed);
    assert.ok(levels.includes("high"));
    assert.ok(!levels.includes("max"));
    assert.ok(!levels.includes("xhigh"));
  });
});
