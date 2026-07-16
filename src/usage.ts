import { PROVIDER_ID, getBaseUrl } from "./constants.ts";
import { getKimiProviderHeaders } from "./device.ts";
import { readStoredOAuthCredential, refreshKimiAuthToken } from "./oauth.ts";

const MEMBERSHIP_LEVEL_NAMES: Record<string, string> = {
  LEVEL_FREE: "Free",
  LEVEL_BASIC: "Adagio",
  LEVEL_STANDARD: "Moderato",
  LEVEL_INTERMEDIATE: "Allegretto",
  LEVEL_ADVANCED: "Allegro",
  LEVEL_PREMIUM: "Vivace",
};

const RESET_TIME_KEYS = [
  "resetTime",
  "reset_time",
  "resetAt",
  "reset_at",
  "resetsAt",
  "resets_at",
  "nextResetTime",
  "next_reset_time",
] as const;

export interface UsageRow {
  label: string;
  used: number;
  limit: number;
  resetTime?: string;
}

export interface UsageFormatOptions {
  now?: Date;
  timeZone?: string;
}

export interface KimiUsageSnapshot {
  summary: string;
  membershipLevel: string | null;
}

interface BoosterWalletInfo {
  balanceCents: bigint;
  monthlyChargeLimitEnabled: boolean;
  monthlyChargeLimitCents: bigint;
  monthlyUsedCents: bigint;
  currency: string;
}

const FIXED_POINT_CENTS = 1_000_000n;

export function getKimiUsageToken(): string | null {
  const credential = readStoredOAuthCredential(PROVIDER_ID);
  if (credential?.access) return credential.access;
  const apiKey = process.env.KIMI_API_KEY?.trim();
  return apiKey || null;
}

function toNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function getResetTime(record: Record<string, unknown>): string | undefined {
  for (const key of RESET_TIME_KEYS) {
    const value = toStringValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

function fixedPointToCents(value: bigint): bigint {
  if (value > 0n && value < FIXED_POINT_CENTS) return 1n;
  return (value + FIXED_POINT_CENTS / 2n) / FIXED_POINT_CENTS;
}

function parseMoney(value: unknown): { cents: bigint; currency: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const cents = toBigInt(record.priceInCents);
  if (cents === null) return null;
  return {
    cents,
    currency: typeof record.currency === "string" ? record.currency : "",
  };
}

function parseBoosterWallet(value: unknown): BoosterWalletInfo | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const balance = record.balance;
  if (typeof balance !== "object" || balance === null || Array.isArray(balance)) return null;
  const balanceRecord = balance as Record<string, unknown>;
  if (balanceRecord.type !== "BOOSTER") return null;
  const amount = toBigInt(balanceRecord.amount);
  if (amount === null || amount < 0n) return null;

  const amountLeft = toBigInt(balanceRecord.amountLeft);
  const monthlyLimit = parseMoney(record.monthlyChargeLimit);
  const monthlyUsed = parseMoney(record.monthlyUsed);
  return {
    balanceCents: amountLeft === null ? 0n : fixedPointToCents(amountLeft),
    monthlyChargeLimitEnabled: record.monthlyChargeLimitEnabled === true,
    monthlyChargeLimitCents: monthlyLimit?.cents ?? 0n,
    monthlyUsedCents: monthlyUsed?.cents ?? 0n,
    currency: monthlyLimit?.currency || monthlyUsed?.currency || "USD",
  };
}

function formatCurrency(cents: bigint, currency: string): string {
  const symbol =
    currency.toUpperCase() === "USD" ? "$" : currency.toUpperCase() === "CNY" ? "¥" : "";
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  const amount = `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
  return symbol ? `${symbol}${amount}` : `${amount} ${currency}`.trim();
}

function formatExtraUsage(info: BoosterWalletInfo): string[] {
  const hasMonthlyLimit = info.monthlyChargeLimitEnabled && info.monthlyChargeLimitCents > 0n;
  const lines = ["Extra Usage"];
  if (hasMonthlyLimit) {
    const used =
      info.monthlyUsedCents < info.monthlyChargeLimitCents
        ? info.monthlyUsedCents
        : info.monthlyChargeLimitCents;
    const percent = Number(
      (used * 100n + info.monthlyChargeLimitCents / 2n) / info.monthlyChargeLimitCents,
    );
    const barUnits = Number((used * 400n) / info.monthlyChargeLimitCents);
    lines.push(`${quotaBar(barUnits, 400)} ${percent}% used`);
  }
  lines.push(`Used this month: ${formatCurrency(info.monthlyUsedCents, info.currency)}`);
  lines.push(
    `Monthly limit: ${hasMonthlyLimit ? formatCurrency(info.monthlyChargeLimitCents, info.currency) : "Unlimited"}`,
  );
  lines.push(`Balance: ${formatCurrency(info.balanceCents, info.currency)}`);
  return lines;
}

export function parseUsageRow(value: unknown, fallbackLabel: string): UsageRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const limit = toNumber(record.limit);
  const usedValue = toNumber(record.used);
  const remaining = toNumber(record.remaining);
  const used = usedValue ?? (limit !== null && remaining !== null ? limit - remaining : null);
  if (limit === null && used === null) return null;
  return {
    label: String(record.name || record.title || fallbackLabel),
    used: used ?? 0,
    limit: limit ?? 0,
    ...(getResetTime(record) ? { resetTime: getResetTime(record) } : {}),
  };
}

export function parseUsageSummary(payload: unknown, options: UsageFormatOptions = {}): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "Usage: unavailable";
  }

  const record = payload as Record<string, unknown>;
  const lines: string[] = [];
  const membership = parseMembership(record);
  if (membership) lines.push(membership, "");

  const summary = parseUsageRow(record.usage, "Current week");
  if (summary)
    lines.push(formatUsageRow({ ...summary, label: normalizeUsageLabel(summary.label) }, options));

  if (Array.isArray(record.limits)) {
    for (const [index, item] of record.limits.entries()) {
      const itemRecord =
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : undefined;
      const detail = itemRecord ? (itemRecord.detail ?? itemRecord) : item;
      const fallbackLabel = itemRecord
        ? formatWindowLabel(
            itemRecord.window,
            index === 0 ? "Current 5h window" : `Limit #${index + 1}`,
          )
        : index === 0
          ? "Current 5h window"
          : `Limit #${index + 1}`;
      const row = parseUsageRow(detail, fallbackLabel);
      if (row) {
        if (lines.length > 0) lines.push("");
        lines.push(formatUsageRow(row, options));
      }
    }
  }

  const extraUsage = parseBoosterWallet(record.boosterWallet);
  if (extraUsage) {
    if (lines.length > 0) lines.push("");
    lines.push(...formatExtraUsage(extraUsage));
  }

  while (lines.at(-1) === "") lines.pop();
  return lines.length === 0 ? "Usage: no usage data" : lines.join("\n");
}

function normalizeUsageLabel(label: string): string {
  return /weekly|week/i.test(label) ? "Current week" : label;
}

function formatWindowLabel(value: unknown, fallbackLabel: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallbackLabel;
  const record = value as Record<string, unknown>;
  const duration = toNumber(record.duration);
  const unit = String(record.timeUnit ?? record.time_unit ?? "").toUpperCase();
  if (!duration || !unit) return fallbackLabel;

  const minutes = unit.includes("HOUR")
    ? duration * 60
    : unit.includes("MINUTE")
      ? duration
      : undefined;
  if (!minutes) return fallbackLabel;
  if (minutes % 60 === 0) return `Current ${minutes / 60}h window`;
  return `Current ${minutes}m window`;
}

export function parseMembershipLevel(record: Record<string, unknown>): string | null {
  const user = record.user;
  if (typeof user !== "object" || user === null || Array.isArray(user)) return null;
  const membership = (user as Record<string, unknown>).membership;
  if (typeof membership !== "object" || membership === null || Array.isArray(membership)) {
    return null;
  }
  const level = (membership as Record<string, unknown>).level;
  return typeof level === "string" && level ? level : null;
}

export function parseMembership(record: Record<string, unknown>): string | null {
  const level = parseMembershipLevel(record);
  if (!level) return null;
  const name = MEMBERSHIP_LEVEL_NAMES[level];
  return name ? `Membership: ${name} (${level})` : `Membership: ${level}`;
}

export function formatUsageRow(row: UsageRow, options: UsageFormatOptions = {}): string {
  if (row.limit <= 0) return `${row.label}\n${row.used} used`;
  const used = Math.max(0, Math.min(row.used, row.limit));
  const percent = Math.round((used / row.limit) * 100);
  const lines = [row.label, `${quotaBar(used, row.limit)} ${percent}% used`];
  const reset = formatResetTime(row.resetTime, options);
  if (reset) lines.push(`Resets ${reset}`);
  return lines.join("\n");
}

export function formatResetTime(value: unknown, options: UsageFormatOptions = {}): string | null {
  const text = toStringValue(value);
  if (!text) return null;
  const date = parseDate(text);
  if (!date) return null;

  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const sameDay = datePart(date, timeZone) === datePart(now, timeZone);
  const time = formatTime(date, timeZone);
  const prefix = sameDay ? "" : `${formatMonthDay(date, timeZone)} at `;
  return `${prefix}${time} (${timeZone})`;
}

function parseDate(value: string): Date | null {
  const timestamp = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  const date = Number.isFinite(timestamp)
    ? new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function datePart(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).format(date);
}

function formatMonthDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone,
  }).format(date);
}

function formatTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: true,
    minute: "2-digit",
    timeZone,
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";
  const dayPeriod = parts.find((part) => part.type === "dayPeriod")?.value.toLowerCase() ?? "";
  return `${hour}:${minute}${dayPeriod}`;
}

function quotaBar(used: number, limit: number): string {
  const width = 50;
  const ratio = Math.max(0, Math.min(1, used / limit));
  const filled = Math.floor(ratio * width);
  const partial = partialBlock(ratio * width - filled);
  const empty = width - filled - (partial ? 1 : 0);
  return `${"█".repeat(filled)}${partial}${" ".repeat(Math.max(0, empty))}`;
}

function partialBlock(value: number): string {
  if (value < 0.125) return "";
  if (value < 0.25) return "▏";
  if (value < 0.375) return "▎";
  if (value < 0.5) return "▍";
  if (value < 0.625) return "▌";
  if (value < 0.75) return "▋";
  if (value < 0.875) return "▊";
  return "▉";
}

export function buildKimiUsageUrl(baseUrl = getBaseUrl("openai")): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? `${normalized}/usages` : `${normalized}/v1/usages`;
}

function fetchKimiUsage(token: string, signal: AbortSignal): Promise<Response> {
  return fetch(buildKimiUsageUrl(), {
    method: "GET",
    headers: {
      ...getKimiProviderHeaders(),
      Authorization: `Bearer ${token}`,
    },
    signal,
  });
}

export async function fetchKimiUsageSnapshot(
  options: { timeoutMs?: number; token?: string; refreshOnUnauthorized?: boolean } = {},
): Promise<KimiUsageSnapshot> {
  const token = options.token ?? getKimiUsageToken();
  if (!token) {
    return {
      summary: "Usage: missing credentials. Run /login kimi-coding.",
      membershipLevel: null,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    let response = await fetchKimiUsage(token, controller.signal);
    if (response.status === 401 && options.refreshOnUnauthorized !== false) {
      const refreshed = await refreshKimiAuthToken(token, { signal: controller.signal });
      if (refreshed) response = await fetchKimiUsage(refreshed, controller.signal);
    }
    if (!response.ok) {
      return { summary: `Usage: fetch failed (${response.status})`, membershipLevel: null };
    }
    const payload = (await response.json()) as unknown;
    const membershipLevel =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? parseMembershipLevel(payload as Record<string, unknown>)
        : null;
    return { summary: parseUsageSummary(payload), membershipLevel };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { summary: `Usage: fetch failed (${message})`, membershipLevel: null };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchKimiUsageSummary(): Promise<string> {
  return (await fetchKimiUsageSnapshot()).summary;
}
