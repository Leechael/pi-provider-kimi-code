import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { KIMI_UPSTREAM_VERSION } from "../src/constants.ts";
import {
  asciiHeaderValue,
  computeDeviceModel,
  getCommonHeaders,
  getKimiProviderHeaders,
  getOsVersion,
} from "../src/device.ts";
import { buildModelsUrl } from "../src/models.ts";

// The device model has to keep matching what the retired `sw_vers` call
// produced: it is part of the identity Kimi Code sends upstream.
function expectedDarwinDeviceModel(): string {
  const productVersion = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
    encoding: "utf-8",
  }).trim();
  return computeDeviceModel({
    platform: "darwin",
    release: os.release(),
    arch: os.machine() || process.arch,
    macVersion: productVersion,
  });
}

// A separate module instance per case, so one case's synchronous fallback
// cannot satisfy the other case's async read.
function freshDeviceModule(tag: string): Promise<typeof import("../src/device.ts")> {
  return import(`../src/device.ts?device-model-${tag}`);
}

describe("asciiHeaderValue", () => {
  it("passes ASCII strings through unchanged", () => {
    assert.equal(asciiHeaderValue("kimi-code-cli/0.1.1"), "kimi-code-cli/0.1.1");
  });

  it("strips non-ASCII characters", () => {
    assert.equal(asciiHeaderValue("hést"), "hst");
  });

  it("falls back to the given default when the result is empty", () => {
    assert.equal(asciiHeaderValue("你好"), "unknown");
    assert.equal(asciiHeaderValue("你好", "host"), "host");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(asciiHeaderValue("  kimi-code-cli/0.1.1  "), "kimi-code-cli/0.1.1");
  });
});

describe("getCommonHeaders", () => {
  it("identifies requests as the synced Kimi Code release", () => {
    assert.equal(KIMI_UPSTREAM_VERSION, "0.28.0");
  });

  it("uses Kimi Code-compatible identity headers", () => {
    const headers = getCommonHeaders();
    assert.equal(headers["X-Msh-Platform"], "kimi_code_cli");
    assert.equal(headers["User-Agent"], `kimi-code-cli/${KIMI_UPSTREAM_VERSION}`);
    assert.equal(headers["X-Msh-Version"], KIMI_UPSTREAM_VERSION);
  });

  it("reports the device model sw_vers would have produced", (t) => {
    if (process.platform !== "darwin") {
      t.skip("macOS product version lookup only runs on darwin");
      return;
    }

    assert.equal(getCommonHeaders()["X-Msh-Device-Model"], expectedDarwinDeviceModel());
  });

  // Two ways in: the read started at module load, or a header was needed before
  // that read landed. Both have to put the same identity on the wire, so each
  // gets its own freshly imported module instance.
  it("resolves the device model from the async module-load read", async (t) => {
    if (process.platform !== "darwin") {
      t.skip("macOS product version lookup only runs on darwin");
      return;
    }
    const fresh = await freshDeviceModule("async");
    await fresh.deviceModelReady;

    assert.equal(fresh.getCommonHeaders()["X-Msh-Device-Model"], expectedDarwinDeviceModel());
  });

  it("resolves the device model when a header is needed before that read lands", async (t) => {
    if (process.platform !== "darwin") {
      t.skip("macOS product version lookup only runs on darwin");
      return;
    }
    const fresh = await freshDeviceModule("sync");

    assert.equal(fresh.getCommonHeaders()["X-Msh-Device-Model"], expectedDarwinDeviceModel());
  });
});

describe("getKimiProviderHeaders", () => {
  it("applies custom provider headers below Kimi identity headers", () => {
    const headers = getKimiProviderHeaders({
      KIMI_CODE_CUSTOM_HEADERS:
        "X-Gateway: internal\nUser-Agent: overridden\nauthorization: leaked\nx-msh-version: fake\ncontent-type: text/plain\ninvalid",
    });

    assert.equal(headers["X-Gateway"], "internal");
    assert.equal(headers["User-Agent"], `kimi-code-cli/${KIMI_UPSTREAM_VERSION}`);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["x-msh-version"], undefined);
    assert.equal(headers["content-type"], undefined);
  });

  it("drops invalid custom header names without breaking valid lines", () => {
    const headers = getKimiProviderHeaders({
      KIMI_CODE_CUSTOM_HEADERS:
        "Valid-Header: yes\nBad Header: no\nBad@Header: no\n你好: no\nX-Token_~: kept",
    });

    assert.equal(headers["Valid-Header"], "yes");
    assert.equal(headers["Bad Header"], undefined);
    assert.equal(headers["Bad@Header"], undefined);
    assert.equal(headers["你好"], undefined);
    assert.equal(headers["X-Token_~"], "kept");
    assert.doesNotThrow(() => new Headers(headers));
  });

  it("sanitizes non-ASCII custom header values before requests", () => {
    const headers = getKimiProviderHeaders({
      KIMI_CODE_CUSTOM_HEADERS: "X-Gateway: héllo\nX-Region: 你好",
    });

    assert.equal(headers["X-Gateway"], "hllo");
    assert.equal(headers["X-Region"], "unknown");
    assert.doesNotThrow(() => new Headers(headers));
  });
});

describe("buildModelsUrl", () => {
  it("appends /v1/models when baseUrl does not already include /v1", () => {
    assert.equal(
      buildModelsUrl("https://api.kimi.com/coding"),
      "https://api.kimi.com/coding/v1/models",
    );
  });

  it("appends only /models when baseUrl already ends with /v1", () => {
    assert.equal(
      buildModelsUrl("https://api.kimi.com/coding/v1"),
      "https://api.kimi.com/coding/v1/models",
    );
  });

  it("strips trailing slashes before composing the path", () => {
    assert.equal(
      buildModelsUrl("https://api.kimi.com/coding/"),
      "https://api.kimi.com/coding/v1/models",
    );
    assert.equal(
      buildModelsUrl("https://api.kimi.com/coding/v1/"),
      "https://api.kimi.com/coding/v1/models",
    );
  });

  it("respects test/proxy baseUrl overrides", () => {
    assert.equal(
      buildModelsUrl("http://127.0.0.1:8080/proxy"),
      "http://127.0.0.1:8080/proxy/v1/models",
    );
  });
});

describe("getOsVersion", () => {
  it("uses Node's OS release string, matching upstream Kimi Code identity headers", () => {
    assert.equal(getOsVersion(), os.release());
  });
});
