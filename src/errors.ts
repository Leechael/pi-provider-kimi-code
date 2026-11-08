// Kimi error-message classification, mirroring upstream kimi-code #4477 /
// #4703: quota exhaustion is a hard limit with explicit non-retryability, not
// a transient rate limit — say so instead of letting the raw 429 body read
// like something a retry would fix.

const QUOTA_ERROR_CODE = "exceeded_current_quota_error";

/**
 * Detect Kimi's structured quota error in a flattened error message
 * (status line + JSON body). Both markers are required to avoid matching
 * unrelated 429 rate limits, which ARE transient.
 */
export function isKimiQuotaExhaustedMessage(message: unknown): boolean {
  const text = String(message ?? "").toLowerCase();
  return text.includes(QUOTA_ERROR_CODE) && /\b429\b/.test(text);
}

/**
 * Rewrite a raw upstream error into actionable text. Returns the input
 * unchanged when nothing applies.
 */
export function improveKimiErrorMessage(message: string): string {
  if (!isKimiQuotaExhaustedMessage(message)) return message;
  return (
    "Kimi Code quota exhausted (HTTP 429, exceeded_current_quota_error). " +
    "This is a hard quota limit, not a transient rate limit — retrying will " +
    "keep failing until the quota window resets. Run /kimi-settings to check " +
    "your current usage. " +
    `Original error: ${message}`
  );
}
