import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDeviceModel, parseMacProductVersion } from "../src/device.ts";

// The macOS product version comes out of SystemVersion.plist rather than a
// `sw_vers` subprocess, so the parser has to hold up against the real file
// layout as well as the shapes a missing or truncated read can produce.
describe("parseMacProductVersion", () => {
  it("reads the version out of a plist", () => {
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<plist>",
      "<dict>",
      "\t<key>ProductName</key>",
      "\t<string>macOS</string>",
      "\t<key>ProductVersion</key>",
      "\t<string>26.5</string>",
      "\t<key>ProductBuildVersion</key>",
      "\t<string>25F74</string>",
      "</dict>",
      "</plist>",
    ].join("\n");
    assert.equal(parseMacProductVersion(plist), "26.5");
  });

  it("does not confuse ProductVersion with the neighbouring keys", () => {
    const plist = "<key>ProductBuildVersion</key><string>25F74</string>";
    assert.equal(parseMacProductVersion(plist), undefined);
  });

  it("returns undefined for an empty or unparseable file", () => {
    assert.equal(parseMacProductVersion(""), undefined);
    assert.equal(parseMacProductVersion("<key>ProductVersion</key><string></string>"), undefined);
    assert.equal(parseMacProductVersion("not a plist at all"), undefined);
  });
});

// Mirror upstream Kimi Code identity formatting per OS so that the
// X-Msh-Device-Model header reported by this provider stays in lockstep.

describe("computeDeviceModel", () => {
  it("macOS: prefers explicit macVersion over release", () => {
    assert.equal(
      computeDeviceModel({
        platform: "darwin",
        release: "23.6.0",
        arch: "arm64",
        macVersion: "15.4.1",
      }),
      "macOS 15.4.1 arm64",
    );
  });

  it("macOS: falls back to release when macVersion missing", () => {
    assert.equal(
      computeDeviceModel({ platform: "darwin", release: "23.6.0", arch: "arm64" }),
      "macOS 23.6.0 arm64",
    );
  });

  it("macOS: keeps version when arch is missing", () => {
    assert.equal(
      computeDeviceModel({
        platform: "darwin",
        release: "23.6.0",
        arch: "",
        macVersion: "15.4.1",
      }),
      "macOS 15.4.1",
    );
  });

  it("Windows: build >= 22000 reports Windows 11", () => {
    assert.equal(
      computeDeviceModel({ platform: "win32", release: "10.0.26100", arch: "x64" }),
      "Windows 11 x64",
    );
  });

  it("Windows: build < 22000 reports Windows 10", () => {
    assert.equal(
      computeDeviceModel({ platform: "win32", release: "10.0.19045", arch: "x64" }),
      "Windows 10 x64",
    );
  });

  it("Windows: only exposes the major release label (not full kernel version)", () => {
    const out = computeDeviceModel({ platform: "win32", release: "10.0.26100", arch: "x64" });
    assert.ok(!out.includes("26100"));
  });

  it("Windows: keeps release when arch is missing", () => {
    assert.equal(
      computeDeviceModel({ platform: "win32", release: "10.0.19045", arch: "" }),
      "Windows 10",
    );
  });

  it("Linux: capitalizes process.platform to match Python platform.system()", () => {
    assert.equal(
      computeDeviceModel({ platform: "linux", release: "6.8.0-generic", arch: "x86_64" }),
      "Linux 6.8.0-generic x86_64",
    );
  });

  it("FreeBSD/OpenBSD/SunOS/AIX: expands to canonical casing", () => {
    assert.equal(
      computeDeviceModel({ platform: "freebsd", release: "14.0", arch: "amd64" }),
      "FreeBSD 14.0 amd64",
    );
    assert.equal(
      computeDeviceModel({ platform: "openbsd", release: "7.4", arch: "amd64" }),
      "OpenBSD 7.4 amd64",
    );
    assert.equal(
      computeDeviceModel({ platform: "sunos", release: "5.11", arch: "i86pc" }),
      "SunOS 5.11 i86pc",
    );
    assert.equal(
      computeDeviceModel({ platform: "aix", release: "7.3", arch: "powerpc" }),
      "AIX 7.3 powerpc",
    );
  });

  it("unknown platform: passes through verbatim", () => {
    assert.equal(
      computeDeviceModel({
        platform: "haiku" as NodeJS.Platform,
        release: "1.0",
        arch: "x86_64",
      }),
      "haiku 1.0 x86_64",
    );
  });

  it("empty release on non-darwin: omits release segment", () => {
    assert.equal(
      computeDeviceModel({ platform: "linux", release: "", arch: "x86_64" }),
      "Linux x86_64",
    );
  });

  it("empty arch on non-darwin: keeps release segment", () => {
    assert.equal(
      computeDeviceModel({ platform: "linux", release: "6.8.0", arch: "" }),
      "Linux 6.8.0",
    );
  });
});
