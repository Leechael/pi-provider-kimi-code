import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildKimiUsageUrl,
  fetchKimiUsageSnapshot,
  formatResetTime,
  formatUsageRow,
  parseMembership,
  parseMembershipLevel,
  parseUsageRow,
  parseUsageSummary,
} from "../src/usage.ts";

const SHANGHAI = "Asia/Shanghai";
const NOW = new Date("2026-05-18T04:00:00Z");

describe("buildKimiUsageUrl", () => {
  it("uses /usages under v1 base URLs", () => {
    assert.equal(
      buildKimiUsageUrl("https://api.kimi.com/coding/v1"),
      "https://api.kimi.com/coding/v1/usages",
    );
    assert.equal(
      buildKimiUsageUrl("https://proxy.example/kimi/v1/"),
      "https://proxy.example/kimi/v1/usages",
    );
  });

  it("adds /v1/usages under non-v1 base URLs", () => {
    assert.equal(
      buildKimiUsageUrl("https://api.kimi.com/coding"),
      "https://api.kimi.com/coding/v1/usages",
    );
    assert.equal(
      buildKimiUsageUrl("https://proxy.example/kimi"),
      "https://proxy.example/kimi/v1/usages",
    );
  });
});

describe("fetchKimiUsageSnapshot", () => {
  it("bounds OAuth refresh by the usage timeout", { timeout: 1000 }, async () => {
    const originalFetch = globalThis.fetch;
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const originalKimiCodeHome = process.env.KIMI_CODE_HOME;
    const originalKimiShareDir = process.env.KIMI_SHARE_DIR;
    const agentDir = mkdtempSync(join(tmpdir(), "pi-kimi-usage-timeout-"));
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({
        "kimi-coding": {
          type: "oauth",
          access: "stale-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      }),
      "utf8",
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.KIMI_CODE_HOME = join(agentDir, "no-kimi-code");
    process.env.KIMI_SHARE_DIR = join(agentDir, "no-kimi-share");
    let refreshAborted = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/usages")) return new Response("unauthorized", { status: 401 });
      if (url.endsWith("/api/oauth/token")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            refreshAborted = true;
            reject(init.signal?.reason);
          });
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    try {
      const snapshot = await fetchKimiUsageSnapshot({ timeoutMs: 10 });
      assert.equal(refreshAborted, true);
      assert.match(snapshot.summary, /^Usage: fetch failed/);
      assert.equal(snapshot.membershipLevel, null);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(agentDir, { recursive: true, force: true });
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      if (originalKimiCodeHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = originalKimiCodeHome;
      if (originalKimiShareDir === undefined) delete process.env.KIMI_SHARE_DIR;
      else process.env.KIMI_SHARE_DIR = originalKimiShareDir;
    }
  });
});

describe("parseUsageSummary", () => {
  it("formats membership, weekly usage, and limit details like Claude Code", () => {
    const summary = parseUsageSummary(
      {
        user: { membership: { level: "LEVEL_ADVANCED" } },
        usage: {
          name: "Weekly requests",
          limit: 100,
          used: 25,
          resetTime: "2026-05-19T04:12:48Z",
        },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: 10, remaining: 3 },
          },
          { title: "Daily", limit: 5, used: 6, reset_at: "2026-05-18T08:00:00Z" },
        ],
      },
      { now: NOW, timeZone: SHANGHAI },
    );

    const lines = summary.split("\n");
    assert.deepEqual(lines.slice(0, 3), [
      "Membership: Allegro (LEVEL_ADVANCED)",
      "",
      "Current week",
    ]);
    assert.match(lines[3], /^████████████▌ {37} 25% used$/);
    assert.equal(lines[4], "Resets May 19 at 12:12pm (Asia/Shanghai)");
    assert.equal(lines[5], "");
    assert.equal(lines[6], "Current 5h window");
    assert.match(lines[7], /^███████████████████████████████████ {15} 70% used$/);
    assert.deepEqual(lines.slice(8), [
      "",
      "Daily",
      "██████████████████████████████████████████████████ 100% used",
      "Resets 4:00pm (Asia/Shanghai)",
    ]);
  });

  it("formats Extra Usage balance and monthly spending", () => {
    const summary = parseUsageSummary({
      boosterWallet: {
        balance: {
          type: "BOOSTER",
          amount: "20000000000",
          amountLeft: "10000000000",
        },
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimit: { currency: "USD", priceInCents: "20000" },
        monthlyUsed: { currency: "USD", priceInCents: "5000" },
      },
    });

    assert.deepEqual(summary.split("\n"), [
      "Extra Usage",
      "████████████▌                                      25% used",
      "Used this month: $50.00",
      "Monthly limit: $200.00",
      "Balance: $100.00",
    ]);
  });

  it("shows depleted Extra Usage wallets with a zero balance", () => {
    const summary = parseUsageSummary({
      boosterWallet: {
        balance: {
          type: "BOOSTER",
          amount: "0",
          amountLeft: "0",
        },
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimit: { currency: "USD", priceInCents: "20000" },
        monthlyUsed: { currency: "USD", priceInCents: "20000" },
      },
    });

    assert.deepEqual(summary.split("\n"), [
      "Extra Usage",
      "██████████████████████████████████████████████████ 100% used",
      "Used this month: $200.00",
      "Monthly limit: $200.00",
      "Balance: $0.00",
    ]);
  });

  it("preserves fixed-point cents above JavaScript's safe integer range", () => {
    const summary = parseUsageSummary({
      boosterWallet: {
        balance: {
          type: "BOOSTER",
          amount: "9007199255499999",
          amountLeft: "9007199255499999",
        },
      },
    });

    assert.match(summary, /Balance: \$90071992\.55$/);
  });

  it("formats limits-only payloads without a leading blank and normalizes window units", () => {
    const summary = parseUsageSummary({
      limits: [
        {
          window: { duration: 300, timeUnit: "time_unit_minute" },
          detail: { limit: 10, remaining: 3 },
        },
      ],
    });

    assert.match(summary, /^Current 5h window\n███████████████████████████████████\s+70% used$/);
  });

  it("reports unavailable and empty payloads with existing messages", () => {
    assert.equal(parseUsageSummary(null), "Usage: unavailable");
    assert.equal(parseUsageSummary([]), "Usage: unavailable");
    assert.equal(parseUsageSummary({}), "Usage: no usage data");
  });
});

describe("parseMembership", () => {
  it("returns the raw plan level used for model entitlement checks", () => {
    assert.equal(
      parseMembershipLevel({ user: { membership: { level: "LEVEL_STANDARD" } } }),
      "LEVEL_STANDARD",
    );
    assert.equal(parseMembershipLevel({}), null);
  });

  it("keeps unknown membership levels readable", () => {
    assert.equal(
      parseMembership({ user: { membership: { level: "LEVEL_UNKNOWN" } } }),
      "Membership: LEVEL_UNKNOWN",
    );
  });
});

describe("parseUsageRow", () => {
  it("derives used value from remaining when used is absent", () => {
    assert.deepEqual(parseUsageRow({ title: "Window", limit: "20", remaining: "8" }, "Fallback"), {
      label: "Window",
      used: 12,
      limit: 20,
    });
  });

  it("parses reset time aliases", () => {
    assert.deepEqual(
      parseUsageRow({ limit: "20", used: "8", reset_at: "2026-05-19T04:12:48Z" }, "Fallback"),
      {
        label: "Fallback",
        used: 8,
        limit: 20,
        resetTime: "2026-05-19T04:12:48Z",
      },
    );
  });

  it("returns null when neither limit nor used can be parsed", () => {
    assert.equal(parseUsageRow({ name: "Empty" }, "Fallback"), null);
  });
});

describe("formatUsageRow", () => {
  it("formats rows without a positive limit as used-only", () => {
    assert.equal(formatUsageRow({ label: "Tokens", used: 12, limit: 0 }), "Tokens\n12 used");
  });

  it("caps usage at the row limit", () => {
    assert.equal(
      formatUsageRow({ label: "Weekly", used: 110, limit: 100 }),
      ["Weekly", "██████████████████████████████████████████████████ 100% used"].join("\n"),
    );
  });

  it("formats reset timestamps in the selected timezone", () => {
    assert.equal(
      formatResetTime("2026-05-19T04:12:48Z", { now: NOW, timeZone: SHANGHAI }),
      "May 19 at 12:12pm (Asia/Shanghai)",
    );
    assert.equal(
      formatResetTime("2026-05-18T08:00:00Z", { now: NOW, timeZone: SHANGHAI }),
      "4:00pm (Asia/Shanghai)",
    );
    assert.equal(
      formatResetTime(1_779_163_968, { now: NOW, timeZone: SHANGHAI }),
      "May 19 at 12:12pm (Asia/Shanghai)",
    );
  });
});
