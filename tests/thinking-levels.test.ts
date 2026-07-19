import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { DEFAULT_KIMI_CODE_CONFIG } from "../src/config.ts";
import {
  applyKimiOAuthExtrasToModel,
  buildKimiModelFromConfig,
  KIMI_K3_MODEL_ID,
} from "../src/models.ts";

// Pi only offers "xhigh"/"max" in its thinking-level selector when the model
// carries a thinkingLevelMap entry for them. K3 advertises a "max" effort and
// the payload layer already maps xhigh/max onto it, so the registered model
// must expose those levels. The "max" level itself only exists in newer pi-ai
// releases; on older ones "xhigh" is the top level and already maps to "max".
function piKnowsMaxLevel(): boolean {
  const probe = {
    reasoning: true,
    thinkingLevelMap: { max: "max" },
  } as unknown as Model<Api>;
  const levels: string[] = getSupportedThinkingLevels(probe);
  return levels.includes("max");
}

function buildK3Model(): Model<Api> {
  return buildKimiModelFromConfig(DEFAULT_KIMI_CODE_CONFIG.model, KIMI_K3_MODEL_ID);
}

function assertTopLevelsExposed(model: Model<Api>): void {
  const levels: string[] = getSupportedThinkingLevels(model);
  assert.ok(levels.includes("xhigh"), `expected "xhigh" in [${levels.join(", ")}]`);
  if (piKnowsMaxLevel()) {
    assert.ok(levels.includes("max"), `expected "max" in [${levels.join(", ")}]`);
  }
}

describe("K3 thinking levels", () => {
  it("exposes xhigh and max in Pi's thinking-level selector", () => {
    assertTopLevelsExposed(buildK3Model());
  });

  it("keeps xhigh and max selectable after catalog metadata is applied", () => {
    const model = applyKimiOAuthExtrasToModel(buildK3Model(), {
      wireModelId: "k3",
      supportsThinkingType: "only",
      supportEfforts: ["low", "high", "max"],
      defaultEffort: "max",
    });
    assertTopLevelsExposed(model);
  });
});
