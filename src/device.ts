// Device identification: device-id persistence, kimi-cli-compatible request
// headers, and the cross-platform device-model string. Pure helpers live near
// the side-effecting one-shots (file IO, exec) they support.

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";

import {
  DEVICE_ID_PATH,
  KIMI_CLI_USER_AGENT,
  KIMI_CLI_VERSION,
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

function getMacOSVersion(): string {
  try {
    return execSync("sw_vers -productVersion", { encoding: "utf8" }).trim();
  } catch {
    return os.release();
  }
}

// Normalize Node's lower-case `process.platform` (`linux`, `freebsd`,
// `sunos`...) to Python `platform.system()` casing used by upstream kimi-cli.
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

// Pure function exposed for tests. Mirror of upstream kimi-cli's
// `_device_model()` in `src/kimi_cli/auth/oauth.py`.
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

function getDeviceModel(): string {
  return computeDeviceModel({
    platform: process.platform,
    release: os.release(),
    arch: os.machine() || process.arch,
    macVersion: process.platform === "darwin" ? getMacOSVersion() : undefined,
  });
}

export function getOsVersion(): string {
  return os.version();
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

const DEVICE_MODEL = getDeviceModel();
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

export function getCommonHeaders(): Record<string, string> {
  const headers = {
    "User-Agent": KIMI_CLI_USER_AGENT,
    "X-Msh-Platform": KIMI_PLATFORM,
    "X-Msh-Version": KIMI_CLI_VERSION,
    "X-Msh-Device-Name": os.hostname(),
    "X-Msh-Device-Model": DEVICE_MODEL,
    "X-Msh-Os-Version": getOsVersion(),
    "X-Msh-Device-Id": getStableDeviceId(),
  };
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, asciiHeaderValue(value)]),
  ) as Record<string, string>;
}
