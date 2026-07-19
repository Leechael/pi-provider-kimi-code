import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { DEFAULT_KIMI_CODE_CONFIG } from "../src/config.ts";
import {
  applyKimiOAuthExtrasToModel,
  buildKimiModelFromConfig,
  KIMI_K3_MODEL_ID,
} from "../src/models.ts";

// Pi only offers "xhigh"/"max" in its thinking-level selector when the model
// carries a thinkingLevelMap entry for them. K3 advertises a "max" effort and
// the payload layer already maps xhigh/max onto it, so the registered model
// must expose those levels.
describe("K3 thinking levels", () => {
  it("exposes xhigh and max in Pi's thinking-level selector", () => {
    const model = buildKimiModelFromConfig(DEFAULT_KIMI_CODE_CONFIG.model, KIMI_K3_MODEL_ID);
    const levels = getSupportedThinkingLevels(model);
    assert.ok(levels.includes("max"), `expected "max" in [${levels.join(", ")}]`);
    assert.ok(levels.includes("xhigh"), `expected "xhigh" in [${levels.join(", ")}]`);
  });

  it("keeps xhigh and max selectable after catalog metadata is applied", () => {
    const model = applyKimiOAuthExtrasToModel(
      buildKimiModelFromConfig(DEFAULT_KIMI_CODE_CONFIG.model, KIMI_K3_MODEL_ID),
      {
        wireModelId: "k3",
        supportsThinkingType: "only",
        supportEfforts: ["low", "high", "max"],
        defaultEffort: "max",
      },
    );
    const levels = getSupportedThinkingLevels(model);
    assert.ok(levels.includes("max"), `expected "max" in [${levels.join(", ")}]`);
  });
});
