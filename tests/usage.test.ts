import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildKimiUsageUrl,
  buildKimiUserInfoUrl,
  fetchKimiUsageSnapshot,
  formatKimiUserInfo,
  formatResetTime,
  formatUsageRow,
  parseKimiUserInfo,
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
    let refreshStarted = false;
    let refreshAborted = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/usages")) return new Response("unauthorized", { status: 401 });
      if (url.endsWith("/api/oauth/token")) {
        refreshStarted = true;
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
      assert.equal(refreshStarted && !refreshAborted, false);
      assert.match(snapshot.summary, /^Usage: fetch failed/);
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
  it("formats weekly usage and limit details", () => {
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
    assert.equal(lines[0], "Current week");
    assert.match(lines[1], /^████████████▌ {37} 25% used$/);
    assert.equal(lines[2], "Resets May 19 at 12:12pm (Asia/Shanghai)");
    assert.equal(lines[3], "");
    assert.equal(lines[4], "Current 5h window");
    assert.match(lines[5], /^███████████████████████████████████ {15} 70% used$/);
    assert.deepEqual(lines.slice(6), [
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

  it("formats day- and week-based limit windows", () => {
    const summary = parseUsageSummary({
      limits: [
        {
          window: { duration: 1, timeUnit: "TIME_UNIT_DAY" },
          detail: { limit: 50, used: 10 },
        },
        {
          window: { duration: 2, timeUnit: "TIME_UNIT_WEEK" },
          detail: { limit: 200, used: 40 },
        },
      ],
    });

    assert.match(summary, /^Current 1d window/);
    assert.match(summary, /Current 2w window/);
  });

  it("reports unavailable and empty payloads with existing messages", () => {
    assert.equal(parseUsageSummary(null), "Usage: unavailable");
    assert.equal(parseUsageSummary([]), "Usage: unavailable");
    assert.equal(parseUsageSummary({}), "Usage: no usage data");
  });

  it("formats quota-model rows from the new /usages payload", () => {
    const summary = parseUsageSummary(
      {
        usage: { limit: "100", used: "20" },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", used: "5" },
          },
        ],
        usages: {
          limit_5h: { used_ratio: 0.047931, reset_time: "2026-10-01T06:59:34Z" },
          limit_7d: { used_ratio: 0.195916, reset_time: "2026-10-05T08:59:34Z" },
        },
      },
      { now: NOW, timeZone: SHANGHAI },
    );

    assert.deepEqual(summary.split("\n"), [
      "5h limit",
      "██▍                                                5% used",
      "Resets Oct 1 at 2:59pm (Asia/Shanghai)",
      "",
      "Weekly limit",
      "█████████▊                                         20% used",
      "Resets Oct 5 at 4:59pm (Asia/Shanghai)",
    ]);
  });

  it("adds the kimi/code breakdown line to the monthly quota row", () => {
    const summary = parseUsageSummary(
      {
        usages: {
          limit_month_total: { used_ratio: 0.42, reset_time: "2026-10-01T00:00:00Z" },
          limit_month_code: { used_ratio: 0.21 },
        },
      },
      { now: new Date("2026-09-20T04:00:00Z"), timeZone: SHANGHAI },
    );

    assert.deepEqual(summary.split("\n"), [
      "Monthly limit",
      "█████████████████████                              42% used",
      "Resets Oct 1 at 8:00am (Asia/Shanghai)",
      "kimi 21% · code 21%",
    ]);
  });

  it("omits monthly breakdown when the code split is not served", () => {
    const summary = parseUsageSummary({
      usages: { limit_month_total: { used_ratio: 0.1 } },
    });

    assert.deepEqual(summary.split("\n"), ["Monthly limit", summary.split("\n")[1]]);
    assert.match(summary, / 10% used$/);
  });

  it("accepts string ratios and clamps out-of-range values", () => {
    const summary = parseUsageSummary({
      usages: {
        limit_5h: { used_ratio: "0.5" },
        limit_7d: { used_ratio: 1.7 },
      },
    });

    assert.match(summary, /5h limit\n[^\n]* 50% used/);
    assert.match(summary, /Weekly limit\n[^\n]* 100% used/);
  });

  it("skips quota windows the backend omitted and falls back to legacy rows", () => {
    const onlyWeekly = parseUsageSummary({
      usages: { limit_7d: { used_ratio: 0.3, reset_time: "2026-10-05T08:59:34Z" } },
    });
    assert.match(onlyWeekly, /^Weekly limit/);
    assert.doesNotMatch(onlyWeekly, /5h limit/);

    const malformed = parseUsageSummary({
      usages: { limit_5h: { used_ratio: "nope" }, limit_7d: null },
    });
    assert.equal(malformed, "Usage: no usage data");

    const nullRatioFallback = parseUsageSummary({
      usage: { limit: 100, used: 25 },
      usages: { limit_5h: { used_ratio: null } },
    });
    assert.match(nullRatioFallback, /^Current week\n[^\n]* 25% used$/);

    const emptyRatioFallback = parseUsageSummary({
      usage: { limit: 100, used: 25 },
      usages: { limit_5h: { used_ratio: "" } },
    });
    assert.match(emptyRatioFallback, /^Current week\n[^\n]* 25% used$/);

    const falseRatioWithValidWeekly = parseUsageSummary({
      usages: { limit_5h: { used_ratio: false }, limit_7d: { used_ratio: 0.3 } },
    });
    assert.deepEqual(falseRatioWithValidWeekly.split("\n"), [
      "Weekly limit",
      "███████████████                                    30% used",
    ]);

    const legacyFallback = parseUsageSummary({
      usage: { limit: 100, used: 25 },
    });
    assert.match(legacyFallback, /^Current week\n[^\n]* 25% used$/);
  });

  it("keeps Extra Usage behind quota rows", () => {
    const summary = parseUsageSummary({
      usages: { limit_5h: { used_ratio: 0.2 } },
      boosterWallet: {
        balance: { type: "BOOSTER", amount: "100000000", amountLeft: "50000000" },
      },
    });

    assert.match(summary, /^5h limit/);
    assert.match(summary, /\nExtra Usage\n/);
    assert.match(summary, /Balance: \$0\.50$/);
  });
});

describe("parseKimiUserInfo", () => {
  it("parses the /me payload shape from upstream managed-userinfo", () => {
    const info = parseKimiUserInfo({
      user_id: "u_123",
      nickname: "moonwalker",
      status: "USER_STATUS_NORMAL",
      region: "REGION_CN",
      user_level: 30,
      user_level_name: "Vivace",
      domain: 1,
      domain_name: "DOMAIN_EXAMPLE",
      email: "user@example.com",
    });

    assert.deepEqual(info, {
      userId: "u_123",
      nickname: "moonwalker",
      userLevel: 30,
      userLevelName: "Vivace",
      email: "user@example.com",
    });
  });

  it("accepts string-typed numeric fields", () => {
    const info = parseKimiUserInfo({ user_id: "u_1", user_level: "30" });
    assert.equal(info?.userLevel, 30);
  });

  it("rejects payloads without a user id", () => {
    assert.equal(parseKimiUserInfo(null), null);
    assert.equal(parseKimiUserInfo({}), null);
    assert.equal(parseKimiUserInfo({ nickname: "moonwalker" }), null);
  });
});

describe("formatKimiUserInfo", () => {
  it("joins nickname, level, and email", () => {
    assert.equal(
      formatKimiUserInfo({
        userId: "u_123",
        nickname: "moonwalker",
        userLevel: 30,
        userLevelName: "Vivace",
        email: "user@example.com",
      }),
      "moonwalker · Vivace (Lv 30) · user@example.com",
    );
  });

  it("falls back to the user id and omits empty fields", () => {
    assert.equal(
      formatKimiUserInfo({ userId: "u_123", nickname: "", userLevel: 0, userLevelName: "" }),
      "u_123",
    );
  });
});

describe("buildKimiUserInfoUrl", () => {
  it("uses /me under v1 base URLs", () => {
    assert.equal(
      buildKimiUserInfoUrl("https://api.kimi.com/coding/v1"),
      "https://api.kimi.com/coding/v1/me",
    );
    assert.equal(
      buildKimiUserInfoUrl("https://api.kimi.com/coding/v1/"),
      "https://api.kimi.com/coding/v1/me",
    );
    assert.equal(
      buildKimiUserInfoUrl("https://proxy.example.com"),
      "https://proxy.example.com/v1/me",
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
