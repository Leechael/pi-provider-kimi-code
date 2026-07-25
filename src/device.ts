// Device identification: device-id persistence, Kimi Code-compatible request
// headers, and the cross-platform device-model string. Pure helpers live near
// the side-effecting one-shots (file IO) they support.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { dirname } from "node:path";

import {
  DEVICE_ID_PATH,
  KIMI_CODE_USER_AGENT,
  KIMI_UPSTREAM_VERSION,
  KIMI_PLATFORM,
} from "./constants.ts";

function createDeviceId(): string {
  return randomBytes(16).toString("hex");
}

function ensurePrivateFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Ignore chmod failures on platforms/filesystems that do not support it.
  }
}

function readPersistedDeviceId(): string | null {
  try {
    if (!existsSync(DEVICE_ID_PATH)) return null;
    const deviceId = readFileSync(DEVICE_ID_PATH, "utf8").trim();
    return deviceId || null;
  } catch {
    return null;
  }
}

function persistDeviceId(deviceId: string): void {
  try {
    mkdirSync(dirname(DEVICE_ID_PATH), { recursive: true });
    writeFileSync(DEVICE_ID_PATH, deviceId, "utf8");
    ensurePrivateFile(DEVICE_ID_PATH);
  } catch {
    // Ignore persistence failures and fall back to the in-memory device id.
  }
}

// Normalize Node's lower-case `process.platform` (`linux`, `freebsd`,
// `sunos`...) to the canonical OS names used by Kimi Code identity headers.
const SYSTEM_NAME: Record<string, string> = {
  aix: "AIX",
  freebsd: "FreeBSD",
  linux: "Linux",
  openbsd: "OpenBSD",
  sunos: "SunOS",
};

export interface DeviceModelInput {
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  /** macOS productVersion (e.g. "15.2"). Required only on darwin. */
  macVersion?: string;
}

// Pure function exposed for tests. Mirrors upstream Kimi Code identity
// formatting in `packages/oauth/src/identity.ts`.
export function computeDeviceModel(input: DeviceModelInput): string {
  const { platform, release, arch, macVersion } = input;
  if (platform === "darwin") {
    const version = macVersion || release;
    if (version && arch) return `macOS ${version} ${arch}`;
    if (version) return `macOS ${version}`;
    return `macOS ${arch}`.trim();
  }
  if (platform === "win32") {
    // Only show the major release (e.g. "Windows 10", "Windows 11") to match
    // the upstream behavior. Windows 11 still reports kernel version
    // "10.0.xxxxx"; treat build ≥ 22000 as Windows 11.
    const parts = release.split(".");
    let label = parts[0];
    if (label === "10" && parts.length >= 3) {
      const build = parseInt(parts[2], 10);
      if (!isNaN(build) && build >= 22000) {
        label = "11";
      }
    }
    if (label && arch) return `Windows ${label} ${arch}`;
    if (label) return `Windows ${label}`;
    return `Windows ${arch}`.trim();
  }
  const system = SYSTEM_NAME[platform] ?? platform;
  if (release && arch) return `${system} ${release} ${arch}`;
  if (release) return `${system} ${release}`;
  return `${system} ${arch}`.trim();
}

// Where macOS keeps its product version. Upstream Kimi Code reads it through
// Python's platform.mac_ver(), which parses this same file, so it is the same
// source of truth as `sw_vers -productVersion` without the process spawn: a
// spawn costs ~10ms of blocked event loop, and pi pays it again on every
// /reload because it re-evaluates extension modules.
const MAC_PRODUCT_VERSION_PATH = "/System/Library/CoreServices/SystemVersion.plist";

// Exposed for tests. The plist is a flat XML property list, so the version sits
// in the <string> immediately after the ProductVersion key.
export function parseMacProductVersion(plist: string): string | undefined {
  const match = /<key>ProductVersion<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
  return match?.[1].trim() || undefined;
}

let DEVICE_MODEL: string | undefined;

function setDeviceModel(macVersion: string | undefined): string {
  DEVICE_MODEL ??= computeDeviceModel({
    platform: process.platform,
    release: os.release(),
    arch: os.machine() || process.arch,
    macVersion,
  });
  return DEVICE_MODEL;
}

async function loadMacDeviceModel(): Promise<void> {
  try {
    setDeviceModel(parseMacProductVersion(await readFile(MAC_PRODUCT_VERSION_PATH, "utf-8")));
  } catch {
    setDeviceModel(undefined);
  }
}

/**
 * Settles once the module-load lookup has produced a device model. Nothing in
 * the provider waits for it — headers stay synchronous — but tests use it to
 * exercise the async path without racing the fallback below.
 */
export const deviceModelReady: Promise<void> = (() => {
  if (process.platform !== "darwin") {
    // Nothing to read: every other platform derives the model from os.release().
    setDeviceModel(undefined);
    return Promise.resolve();
  }
  // Read the version off the event loop at module load so the value is usually
  // in place before anything asks for a header.
  return loadMacDeviceModel();
})();

function getDeviceModel(): string {
  if (DEVICE_MODEL !== undefined) return DEVICE_MODEL;
  // A header was needed before the async read landed. Read the same file
  // synchronously rather than reporting the kernel release, which would put a
  // different device model on the wire than every later request. This costs
  // ~0.02ms against the ~10ms a `sw_vers` subprocess used to cost, and both
  // paths memoize into the same slot.
  try {
    return setDeviceModel(parseMacProductVersion(readFileSync(MAC_PRODUCT_VERSION_PATH, "utf-8")));
  } catch {
    return setDeviceModel(undefined);
  }
}

export function getOsVersion(): string {
  return os.release();
}

export function asciiHeaderValue(value: string, fallback = "unknown"): string {
  const trimmed = value.trim();
  /* oxlint-disable-next-line no-control-regex */
  if (/^[\x00-\x7F]*$/.test(trimmed)) {
    return trimmed;
  }
  /* oxlint-disable-next-line no-control-regex */
  const sanitized = trimmed.replace(/[^\x00-\x7F]/g, "").trim();
  return sanitized || fallback;
}

let DEVICE_ID: string | null = null;

function getStableDeviceId(): string {
  if (DEVICE_ID) {
    return DEVICE_ID;
  }

  const persisted = readPersistedDeviceId();
  if (persisted) {
    DEVICE_ID = persisted;
    return DEVICE_ID;
  }

  DEVICE_ID = createDeviceId();
  persistDeviceId(DEVICE_ID);
  return DEVICE_ID;
}

export function parseKimiCodeCustomHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const raw = env.KIMI_CODE_CUSTOM_HEADERS?.trim();
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    headers[name] = asciiHeaderValue(line.slice(colon + 1));
  }
  return headers;
}

export function getCommonHeaders(): Record<string, string> {
  const headers = {
    "User-Agent": KIMI_CODE_USER_AGENT,
    "X-Msh-Platform": KIMI_PLATFORM,
    "X-Msh-Version": KIMI_UPSTREAM_VERSION,
    "X-Msh-Device-Name": os.hostname(),
    "X-Msh-Device-Model": getDeviceModel(),
    "X-Msh-Os-Version": getOsVersion(),
    "X-Msh-Device-Id": getStableDeviceId(),
  };
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, asciiHeaderValue(value)]),
  ) as Record<string, string>;
}

const RESERVED_PROVIDER_HEADERS = new Set([
  "accept",
  "anthropic-version",
  "authorization",
  "content-type",
  "user-agent",
  "x-api-key",
]);

function isReservedProviderHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return RESERVED_PROVIDER_HEADERS.has(normalized) || normalized.startsWith("x-msh-");
}

export function getKimiProviderHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const customHeaders = Object.fromEntries(
    Object.entries(parseKimiCodeCustomHeaders(env)).filter(
      ([name]) => !isReservedProviderHeader(name),
    ),
  );
  return { ...customHeaders, ...getCommonHeaders() };
}
