import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyKimiMembershipLimitsToModel,
  getKimiMembershipLevelOverride,
  isKimiModelAvailableForMembership,
} from "../src/models.ts";
import { fetchKimiUsageSnapshot, parseMembership } from "../src/usage.ts";

function withMembershipEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.KIMI_MEMBERSHIP_LEVEL;
  if (value === undefined) {
    delete process.env.KIMI_MEMBERSHIP_LEVEL;
  } else {
    process.env.KIMI_MEMBERSHIP_LEVEL = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.KIMI_MEMBERSHIP_LEVEL;
    } else {
      process.env.KIMI_MEMBERSHIP_LEVEL = previous;
    }
  }
}

describe("getKimiMembershipLevelOverride", () => {
  it("returns null when the variable is unset or blank", () => {
    assert.equal(getKimiMembershipLevelOverride({}), null);
    assert.equal(getKimiMembershipLevelOverride({ KIMI_MEMBERSHIP_LEVEL: "" }), null);
    assert.equal(getKimiMembershipLevelOverride({ KIMI_MEMBERSHIP_LEVEL: "   " }), null);
  });

  it("accepts LEVEL_* values case-insensitively", () => {
    assert.equal(
      getKimiMembershipLevelOverride({ KIMI_MEMBERSHIP_LEVEL: "LEVEL_PREMIUM" }),
      "LEVEL_PREMIUM",
    );
    assert.equal(
      getKimiMembershipLevelOverride({ KIMI_MEMBERSHIP_LEVEL: "level_intermediate" }),
      "LEVEL_INTERMEDIATE",
    );
  });

  it("accepts tempo aliases case-insensitively", () => {
    assert.equal(
      getKimiMembershipLevelOverride({ KIMI_MEMBERSHIP_LEVEL: "vivace" }),
      "LEVEL_PREMIUM",
    );
    assert.equal(
      getKimiMembershipLevelOverride({ KIMI_MEMBERSHIP_LEVEL: "Allegretto" }),
      "LEVEL_INTERMEDIATE",
    );
    assert.equal(
      getKimiMembershipLevelOverride({ KIMI_MEMBERSHIP_LEVEL: "adagio" }),
      "LEVEL_BASIC",
    );
  });

  it("trims surrounding whitespace", () => {
    assert.equal(
      getKimiMembershipLevelOverride({ KIMI_MEMBERSHIP_LEVEL: " vivace " }),
      "LEVEL_PREMIUM",
    );
  });

  it("rejects unknown values", () => {
    assert.equal(getKimiMembershipLevelOverride({ KIMI_MEMBERSHIP_LEVEL: "prestissimo" }), null);
    assert.equal(getKimiMembershipLevelOverride({ KIMI_MEMBERSHIP_LEVEL: "LEVEL_ULTRA" }), null);
  });

  it("rejects Object.prototype keys instead of returning inherited members", () => {
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      assert.equal(getKimiMembershipLevelOverride({ KIMI_MEMBERSHIP_LEVEL: key }), null, key);
    }
  });
});

async function withMembershipEnvAsync<T>(
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.KIMI_MEMBERSHIP_LEVEL;
  if (value === undefined) {
    delete process.env.KIMI_MEMBERSHIP_LEVEL;
  } else {
    process.env.KIMI_MEMBERSHIP_LEVEL = value;
  }
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.KIMI_MEMBERSHIP_LEVEL;
    } else {
      process.env.KIMI_MEMBERSHIP_LEVEL = previous;
    }
  }
}

describe("fetchKimiUsageSnapshot failure paths with override set", () => {
  it("returns the override when credentials are missing", async () => {
    await withMembershipEnvAsync("vivace", async () => {
      const snapshot = await fetchKimiUsageSnapshot({ token: "" });
      assert.equal(snapshot.summary, "Usage: missing credentials. Run /login kimi-coding.");
      assert.equal(snapshot.membershipLevel, "LEVEL_PREMIUM");
    });
  });

  it("returns the override when the fetch responds non-2xx", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("server error", { status: 500 });
    try {
      await withMembershipEnvAsync("allegretto", async () => {
        const snapshot = await fetchKimiUsageSnapshot({
          token: "test-token",
          refreshOnUnauthorized: false,
        });
        assert.equal(snapshot.summary, "Usage: fetch failed (500)");
        assert.equal(snapshot.membershipLevel, "LEVEL_INTERMEDIATE");
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns the override when the fetch throws", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    try {
      await withMembershipEnvAsync("vivace", async () => {
        const snapshot = await fetchKimiUsageSnapshot({
          token: "test-token",
          refreshOnUnauthorized: false,
        });
        assert.equal(snapshot.summary, "Usage: fetch failed (network down)");
        assert.equal(snapshot.membershipLevel, "LEVEL_PREMIUM");
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps membershipLevel null on failure when the override is unset", async () => {
    await withMembershipEnvAsync(undefined, async () => {
      const snapshot = await fetchKimiUsageSnapshot({ token: "" });
      assert.equal(snapshot.membershipLevel, null);
    });
  });
});

describe("membership override end to end", () => {
  it("beats the level reported by /usages in parseMembership", () => {
    withMembershipEnv("vivace", () => {
      assert.equal(
        parseMembership({ user: { membership: { level: "LEVEL_STANDARD" } } }),
        "Membership: Vivace (LEVEL_PREMIUM) — set by KIMI_MEMBERSHIP_LEVEL",
      );
    });
  });

  it("leaves the reported level untouched when unset", () => {
    withMembershipEnv(undefined, () => {
      assert.equal(
        parseMembership({ user: { membership: { level: "LEVEL_STANDARD" } } }),
        "Membership: Moderato (LEVEL_STANDARD)",
      );
    });
  });

  it("unlocks tier-gated models and the K3 context window at the overridden rank", () => {
    const level = getKimiMembershipLevelOverride({ KIMI_MEMBERSHIP_LEVEL: "vivace" });
    assert.equal(isKimiModelAvailableForMembership("kimi-for-coding-highspeed", level), true);
    const k3 = {
      id: "k3",
      name: "Kimi K3",
      reasoning: true,
      input: ["text"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      contextWindow: 1048576,
      maxTokens: 131072,
    };
    // deliberately loose typing: the helper only reads id/contextWindow
    const clamped = applyKimiMembershipLimitsToModel(k3 as never, level);
    assert.equal((clamped as { contextWindow: number }).contextWindow, 1048576);
  });
});
