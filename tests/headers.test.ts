import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { KIMI_UPSTREAM_VERSION } from "../src/constants.ts";
import {
  asciiHeaderValue,
  getCommonHeaders,
  getKimiProviderHeaders,
  getOsVersion,
} from "../src/device.ts";
import { buildModelsUrl } from "../src/models.ts";

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
    assert.equal(KIMI_UPSTREAM_VERSION, "0.26.0");
  });

  it("uses Kimi Code-compatible identity headers", () => {
    const headers = getCommonHeaders();
    assert.equal(headers["X-Msh-Platform"], "kimi_code_cli");
    assert.equal(headers["User-Agent"], `kimi-code-cli/${KIMI_UPSTREAM_VERSION}`);
    assert.equal(headers["X-Msh-Version"], KIMI_UPSTREAM_VERSION);
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
