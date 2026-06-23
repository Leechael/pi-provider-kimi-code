import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildKimiUsageUrl,
  formatResetTime,
  formatUsageRow,
  parseMembership,
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

  it("reports unavailable and empty payloads with existing messages", () => {
    assert.equal(parseUsageSummary(null), "Usage: unavailable");
    assert.equal(parseUsageSummary([]), "Usage: unavailable");
    assert.equal(parseUsageSummary({}), "Usage: no usage data");
  });
});

describe("parseMembership", () => {
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
