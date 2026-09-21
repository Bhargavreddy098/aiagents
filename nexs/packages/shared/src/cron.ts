/**
 * A five-field cron expression, and the next time it fires.
 *
 * ## Why this exists at all
 *
 * `GET /api/schedules` is specified to return **next-fire times** (§4-PHASE11), and the
 * `Schedule` row stores `nextFireAt` as a real column. pg-boss will happily accept a cron
 * expression and fire it, but it never tells you when it will next fire — so a schedule
 * list built on pg-boss alone can show a schedule's cron string and not its next fire, or
 * can store a `nextFireAt` that nothing ever computes. Either would be a column that lies.
 *
 * ## Scope, stated honestly
 *
 * - **Numeric fields only.** `JAN`/`MON` names are rejected rather than silently
 *   unsupported. A cron string that parses but means something different from what the
 *   operator intended is the failure mode worth avoiding, and the spec's own expressions
 *   use step divisors rather than names.
 * - **UTC only.** Everything here is computed with `Date.UTC` and `getUTC*`, so it is
 *   exact and DST-free. A schedule in another IANA zone cannot have a correct `nextFireAt`
 *   computed without a full tz database, so the schedule service **refuses** a non-UTC
 *   `timezone` instead of storing a time that is wrong for part of the year.
 * - **No `@reboot`, `L`, `W`, `#`.** These are Quartz/cronie extensions, not Vixie cron.
 *
 * ## The dom/dow OR rule
 *
 * Vixie cron's least obvious behaviour, and the one a naive implementation gets wrong: when
 * **both** day-of-month and day-of-week are constrained, a day matches if **either** does.
 * So "the 1st, or a Monday" fires on the 1st *and* on every Monday — not only on a Monday
 * that happens to be the 1st. When one of the two is a plain wildcard, only the other
 * applies. "Constrained" is decided by whether the field *begins* with a wildcard, which is
 * Vixie's own rule: a wildcard carrying a step divisor counts as a wildcard.
 */

/** Longest gap this will search for a fire time. A leap-day expression needs four years. */
export const CRON_MAX_SEARCH_DAYS = 366 * 5;

export interface CronFields {
  /** Ascending, so the first candidate found is the earliest one. */
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  readonly daysOfWeek: readonly number[];
  /** True when the field does not begin with a wildcard. See the OR rule above. */
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

const FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'] as const;

/** Inclusive bounds per field. Day-of-week is 0-6 with 0 = Sunday. */
const FIELD_BOUNDS: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Parse one field into the set of values it allows.
 *
 * Returns `restricted: false` for a field beginning with a wildcard — including one with a
 * step divisor, which is Vixie's rule and what makes an "every other day" day-of-month
 * OR'ed with a weekday mean "every other day, or that weekday" rather than "every other
 * day that is that weekday".
 */
function parseField(raw: string, index: number): { values: number[]; restricted: boolean } {
  const bounds = FIELD_BOUNDS[index];
  if (bounds === undefined) fail(`cron field ${index} has no bounds`);
  const [min, max] = bounds;
  const name = FIELD_NAMES[index];

  const restricted = !raw.startsWith('*');
  const values = new Set<number>();

  for (const part of raw.split(',')) {
    if (part.length === 0) fail(`cron ${name} field has an empty element`);

    const segments = part.split('/');
    if (segments.length > 2) fail(`cron ${name} field "${part}" has more than one step`);
    const rangeText = segments[0];
    const stepText = segments[1];
    if (rangeText === undefined || rangeText.length === 0) {
      fail(`cron ${name} field "${part}" has no range before its step`);
    }

    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) fail(`cron ${name} step "${stepText}" is not a number`);
      step = Number(stepText);
      if (step < 1) fail(`cron ${name} step must be at least 1, got ${step}`);
    }

    let lo: number;
    let hi: number;
    if (rangeText === '*') {
      lo = min;
      hi = max;
    } else if (rangeText.includes('-')) {
      const rangeParts = rangeText.split('-');
      if (rangeParts.length > 2) fail(`cron ${name} range "${rangeText}" has more than one dash`);
      const loText = rangeParts[0];
      const hiText = rangeParts[1];
      if (loText === undefined || hiText === undefined) {
        fail(`cron ${name} range "${rangeText}" is incomplete`);
      }
      if (!/^\d+$/.test(loText) || !/^\d+$/.test(hiText)) {
        // Also the path taken for `JAN`, `MON` and friends: named fields are rejected here
        // rather than mapped, so a name is never quietly read as a number.
        fail(`cron ${name} range "${rangeText}" must be numeric (names are not supported)`);
      }
      lo = Number(loText);
      hi = Number(hiText);
      if (lo > hi) fail(`cron ${name} range "${rangeText}" runs backwards`);
    } else {
      if (!/^\d+$/.test(rangeText)) {
        fail(`cron ${name} value "${rangeText}" must be numeric (names are not supported)`);
      }
      lo = Number(rangeText);
      hi = lo;
    }

    if (lo < min || hi > max) {
      fail(`cron ${name} value must be between ${min} and ${max}, got ${lo}-${hi}`);
    }

    for (let value = lo; value <= hi; value += step) {
      // 7 is an accepted spelling of Sunday in day-of-week. Normalised here so nothing
      // downstream has to know about the alias.
      values.add(index === 4 && value === 7 ? 0 : value);
    }
  }

  return { values: [...values].sort((a, b) => a - b), restricted };
}

/**
 * Parse a five-field cron expression, or throw with a message naming the field.
 *
 * Throws rather than returning a result type because the two callers want different things
 * — `isValidCron` swallows it, and the schedule service turns it into an `ApiError` — and a
 * thrown `Error` carries the field name through both without an intermediate shape.
 */
export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    fail(
      `a cron expression needs 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }

  const parsed = fields.map((field, index) => parseField(field, index));
  const minute = parsed[0];
  const hour = parsed[1];
  const dayOfMonth = parsed[2];
  const month = parsed[3];
  const dayOfWeek = parsed[4];
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    fail('a cron expression needs exactly 5 fields');
  }

  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dayOfMonth.values,
    months: month.values,
    daysOfWeek: dayOfWeek.values,
    dayOfMonthRestricted: dayOfMonth.restricted,
    dayOfWeekRestricted: dayOfWeek.restricted,
  };
}

/** Whether an expression parses. Used to reject a schedule before it is written. */
export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * The dom/dow OR rule, applied.
 *
 * Split out because it is the one piece of cron semantics worth testing on its own — every
 * other rule is a simple membership test.
 */
function dayMatches(fields: CronFields, dayOfMonth: number, dayOfWeek: number): boolean {
  const domOk = fields.daysOfMonth.includes(dayOfMonth);
  const dowOk = fields.daysOfWeek.includes(dayOfWeek);

  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) return domOk || dowOk;
  if (fields.dayOfMonthRestricted) return domOk;
  if (fields.dayOfWeekRestricted) return dowOk;
  return true;
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * The first instant strictly after `after` that the expression fires, or `null` when there
 * is none within `CRON_MAX_SEARCH_DAYS`.
 *
 * Strictly after, and always on a whole minute: a schedule that has just fired must not
 * report the instant it fired as its next fire, or `nextFireAt` would sit in the past and
 * every consumer polling it would agree the schedule was due.
 *
 * `null` is a real answer rather than an error — a "30 February" expression is well-formed
 * and never fires, and a schedule built on it should be creatable and visibly never due
 * rather than rejected as malformed.
 */
export function nextCronFire(expression: string, after: Date): Date | null {
  const fields = parseCron(expression);

  // The next whole minute after `after`. `Math.floor` on a whole minute is that minute, so
  // adding one minute is the first instant that is strictly later.
  const first = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;

  // Bounded by day rather than by minute: a leap-day expression is four years out, and a
  // minute-by-minute walk would be 2 million iterations to answer it. The loop bound *is*
  // the horizon, so there is no separate limit to compare against.
  for (let offset = 0; offset <= CRON_MAX_SEARCH_DAYS; offset += 1) {
    const dayStart = startOfUtcDay(new Date(first)) + offset * 86_400_000;
    const day = new Date(dayStart);

    if (!fields.months.includes(day.getUTCMonth() + 1)) continue;
    if (!dayMatches(fields, day.getUTCDate(), day.getUTCDay())) continue;

    for (const hour of fields.hours) {
      for (const minute of fields.minutes) {
        const candidate = dayStart + hour * 3_600_000 + minute * 60_000;
        if (candidate >= first) return new Date(candidate);
      }
    }
  }

  return null;
}

/**
 * How often an expression fires, for a human-readable schedule list.
 *
 * Deliberately crude: it names the common shapes and falls back to the expression itself.
 * A "next fire" timestamp is the answer an operator actually needs, and inventing prose for
 * every expression would be a second description of the schedule that can drift from the
 * first.
 */
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return expression;
  const minute = fields[0] ?? '';
  const hour = fields[1] ?? '';
  const dom = fields[2] ?? '';
  const month = fields[3] ?? '';
  const dow = fields[4] ?? '';

  const everyMinute = dom === '*' && month === '*' && dow === '*';
  if (minute.startsWith('*/') && hour === '*' && everyMinute) {
    return `every ${minute.slice(2)} minutes`;
  }
  if (/^\d+$/.test(minute) && hour === '*' && everyMinute) {
    return `hourly at minute ${minute}`;
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && everyMinute) {
    return `daily at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')} UTC`;
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && month === '*' && dow !== '*') {
    return `weekly on day ${dow} at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')} UTC`;
  }
  return expression;
}
