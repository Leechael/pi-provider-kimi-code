import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { asciiHeaderValue, buildModelsUrl, getOsVersion } from "../index.ts";

describe("asciiHeaderValue", () => {
  it("passes ASCII strings through unchanged", () => {
    assert.equal(asciiHeaderValue("KimiCLI/1.44.0"), "KimiCLI/1.44.0");
  });

  it("strips non-ASCII characters", () => {
    assert.equal(asciiHeaderValue("hést"), "hst");
  });

  it("falls back to the given default when the result is empty", () => {
    assert.equal(asciiHeaderValue("你好"), "unknown");
    assert.equal(asciiHeaderValue("你好", "host"), "host");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(asciiHeaderValue("  KimiCLI/1.44.0  "), "KimiCLI/1.44.0");
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
  it("uses Node's OS version string, matching upstream platform.version semantics", () => {
    assert.equal(getOsVersion(), os.version());
  });
});
