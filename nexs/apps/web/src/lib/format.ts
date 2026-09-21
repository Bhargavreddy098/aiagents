/**
 * Formatting helpers.
 *
 * Every one of these takes the value the API actually sends. For timestamps that is an ISO
 * **string**, not a `Date` — `types/control.ts` states this explicitly, because a client
 * that calls `.getTime()` on a string fails at runtime. So the parse happens here, once,
 * and a bad value produces an em dash rather than `Invalid Date` on screen.
 */

const EM_DASH = '—';

function parse(iso: string | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === '') return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** An absolute, unambiguous timestamp. Used where the exact moment matters (a receipt). */
export function formatDateTime(iso: string | null | undefined): string {
  const date = parse(iso);
  if (date === null) return EM_DASH;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Date only — for a list column where the time of day is noise. */
export function formatDate(iso: string | null | undefined): string {
  const date = parse(iso);
  if (date === null) return EM_DASH;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 1000],
  ['minute', 60_000],
  ['hour', 3_600_000],
  ['day', 86_400_000],
  ['week', 604_800_000],
  ['month', 2_629_800_000],
  ['year', 31_557_600_000],
];

/**
 * "3 minutes ago" / "in 2 hours".
 *
 * The `title` of the element this is rendered into should carry `formatDateTime`, so the
 * relative form stays readable without making the exact time unreachable.
 */
export function formatRelative(iso: string | null | undefined): string {
  const date = parse(iso);
  if (date === null) return EM_DASH;

  const deltaMs = date.getTime() - Date.now();
  const absoluteMs = Math.abs(deltaMs);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  // Below a minute, "now" is more honest than "in 0 seconds".
  if (absoluteMs < 45_000) return formatter.format(0, 'second');

  let chosen: readonly [Intl.RelativeTimeFormatUnit, number] = RELATIVE_UNITS[0]!;
  for (const entry of RELATIVE_UNITS) {
    if (absoluteMs >= entry[1]) chosen = entry;
  }
  const [unit, unitMs] = chosen;
  return formatter.format(Math.round(deltaMs / unitMs), unit);
}

/**
 * A duration in ms as a compact human string.
 *
 * Sub-second values keep their milliseconds — "0.4s" and "0s" are different facts about a
 * tool call, and rounding the first to the second would hide the fast path.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return EM_DASH;
  if (ms < 0) return EM_DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  // Round to whole seconds *before* splitting them into minutes. Rounding the remainder on
  // its own can carry past its base — 4m59.6s rounded its seconds to 60 and printed
  // "4m 60s", which is not a duration anyone has ever seen.
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

/** The elapsed time of something still running, measured from `startedAt`. */
export function formatElapsed(startedAt: string | null | undefined): string {
  const start = parse(startedAt);
  if (start === null) return EM_DASH;
  return formatDuration(Date.now() - start.getTime());
}

/**
 * A duration between two stamps, preferring the server's own `durationMs`.
 *
 * The server computes `durationMs` from the same two columns, so recomputing it here would
 * be a second opinion that can disagree by the clock skew between the row write and the
 * response. Only when the server did not send one — a run still in flight — is it derived.
 */
export function formatSpan(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
  durationMs?: number | null,
): string {
  if (durationMs !== null && durationMs !== undefined) return formatDuration(durationMs);
  const start = parse(startedAt);
  if (start === null) return EM_DASH;
  const end = parse(completedAt);
  if (end === null) return formatElapsed(startedAt);
  return formatDuration(end.getTime() - start.getTime());
}

/** A countdown to a deadline, or "expired". Used by the approval drawer. */
/**
 * What a countdown says once its deadline has passed.
 *
 * Exported because it is a *word*, not a duration, and a caller that phrases around a
 * countdown has to know which one it got: the Decision Inbox renders `in <countdown>`, and
 * `in expired` is not a sentence. Comparing against this constant is how that caller tells
 * the two apart without re-deriving the arithmetic or matching a bare string literal.
 */
export const EXPIRED_COUNTDOWN = 'expired';

export function formatCountdown(expiresAt: string | null | undefined): string {
  const date = parse(expiresAt);
  if (date === null) return EM_DASH;
  const remaining = date.getTime() - Date.now();
  if (remaining <= 0) return EXPIRED_COUNTDOWN;
  return formatDuration(remaining);
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return value.toLocaleString();
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return EM_DASH;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

/**
 * Pretty-print anything for a `<pre>`.
 *
 * A non-serializable value cannot reach here from the API — the server refuses to emit one
 * over SSE and `res.json` would have failed — but a client-side `undefined` can, and
 * `JSON.stringify(undefined)` returns `undefined`, which React renders as nothing. The
 * fallback makes that visible instead of blank.
 */
export function prettyJson(value: unknown): string {
  if (value === undefined) return '(undefined)';
  try {
    const rendered = JSON.stringify(value, null, 2);
    return rendered ?? String(value);
  } catch {
    return String(value);
  }
}

/** A one-line preview of a JSON value, for a table cell. */
export function inlineJson(value: unknown, maxLength = 80): string {
  if (value === null) return 'null';
  if (value === undefined) return EM_DASH;
  let rendered: string;
  try {
    rendered = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  if (rendered === undefined) return EM_DASH;
  const flat = rendered.replace(/\s+/g, ' ');
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

/** An id shortened for a table column, with the full value available via `title`. */
export function shortId(id: string | null | undefined, length = 8): string {
  if (id === null || id === undefined || id === '') return EM_DASH;
  return id.length <= length ? id : `${id.slice(0, length)}…`;
}

export { EM_DASH };
