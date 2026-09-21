/**
 * Retry timing for provider calls.
 *
 * The only thing worth being clever about here is `Retry-After`: when a provider tells
 * you exactly when to come back, guessing with exponential backoff is strictly worse —
 * too short and you get another 429, too long and you waste the window it just offered.
 */

const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Parse an HTTP `Retry-After` header in either documented form.
 * Returns milliseconds to wait, or null when the header is absent or unparseable.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  // delta-seconds form.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return null;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  // HTTP-date form.
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS);
}

/**
 * Exponential backoff with jitter.
 *
 * The floor matters as much as the jitter: without it, a batch of workers that failed
 * together would all retry in the same millisecond. Jitter alone does not prevent that
 * when the random source is seeded or coarse.
 */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const floor = exponential / 2;
  return Math.round(floor + random() * (exponential - floor));
}

export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseMs: 500,
  maxMs: 8_000,
};

export interface RetryAttemptContext {
  attempt: number;
  /** Set when the failure carried a `Retry-After`. */
  retryAfterMs: number | null;
  /** Total milliseconds already spent waiting across previous attempts. */
  waitedMs: number;
}

/**
 * Decide how long to wait before the next attempt, or null to give up.
 *
 * `Retry-After` wins over the computed backoff, and is **not** clamped to `maxMs`:
 * retrying earlier than the provider asked for just earns another 429 and burns an
 * attempt. The only ceiling is the parser's own 60 s cap, which exists so one hostile
 * or buggy header cannot park a worker indefinitely.
 */
export function nextDelay(
  policy: RetryPolicy,
  context: RetryAttemptContext,
  random: () => number = Math.random,
): number | null {
  if (context.attempt >= policy.maxAttempts) return null;
  if (context.retryAfterMs !== null) return context.retryAfterMs;
  return backoffDelay(context.attempt, policy.baseMs, policy.maxMs, random);
}
