import { describe, expect, it } from 'vitest';
import {
  CRON_MAX_SEARCH_DAYS,
  describeCron,
  isValidCron,
  nextCronFire,
  parseCron,
} from '@nexs/shared';

/**
 * The cron evaluator.
 *
 * Worth its own suite because it is the one piece of Phase 11 whose correctness cannot be
 * checked by looking at a database row: a wrong `nextFireAt` is a plausible-looking
 * timestamp, and a wrong day-of-month/day-of-week rule produces a schedule that fires on
 * almost the right days. Both would survive review and show up as "the schedule is a bit
 * off" weeks later.
 *
 * The reference is Vixie cron's documented behaviour, which is what pg-boss's scheduler
 * implements — so an expression that means something different here than it does in the
 * transport would be a schedule that fires at one time and displays another.
 */

/** Saturday, 20 September 2026, 08:17:47 UTC — mid-minute, so truncation is exercised. */
const FROM = new Date('2026-09-20T08:17:47.000Z');

function next(expression: string, from: Date = FROM): string | null {
  const result = nextCronFire(expression, from);
  return result === null ? null : result.toISOString();
}

describe('cron: next fire', () => {
  it('advances to the next whole minute strictly after the reference', () => {
    // 08:17:47 is mid-minute. The next fire of a every-minute expression is 08:18:00, not
    // 08:17:00 — a fire time already in the past would make `nextFireAt` a value every
    // consumer agrees is due.
    expect(next('* * * * *')).toBe('2026-09-20T08:18:00.000Z');
  });

  it('handles a step divisor', () => {
    expect(next('*/10 * * * *')).toBe('2026-09-20T08:20:00.000Z');
    expect(next('*/15 * * * *')).toBe('2026-09-20T08:30:00.000Z');
  });

  it('finds the next day when the hour has passed', () => {
    expect(next('0 0 * * *')).toBe('2026-09-21T00:00:00.000Z');
    expect(next('30 2 * * *')).toBe('2026-09-21T02:30:00.000Z');
  });

  it('honours a minute and hour pair later the same day', () => {
    expect(next('45 23 * * *')).toBe('2026-09-20T23:45:00.000Z');
  });

  it('handles a weekday range', () => {
    // 2026-09-20 is a Sunday, so the next weekday is Monday the 21st.
    expect(next('0 9 * * 1-5')).toBe('2026-09-21T09:00:00.000Z');
  });

  it('treats 7 as Sunday', () => {
    expect(next('0 3 * * 7')).toBe('2026-09-27T03:00:00.000Z');
    expect(next('0 3 * * 0')).toBe('2026-09-27T03:00:00.000Z');
  });

  it('finds a leap day four years out', () => {
    // The reason the search bound is five years rather than one. A naive "next 366 days"
    // implementation returns null here and the schedule silently never fires.
    expect(next('0 0 29 2 *')).toBe('2028-02-29T00:00:00.000Z');
  });

  it('returns null for an expression that can never fire', () => {
    // 30 February is well formed and unsatisfiable. `null` is the honest answer — the
    // schedule is creatable and visibly never due, rather than rejected as malformed.
    expect(next('0 0 30 2 *')).toBeNull();
  });
});

describe('cron: the dom/dow OR rule', () => {
  it('fires on either field when both are constrained', () => {
    // "the 1st, or a Monday". 2026-09-21 is a Monday and not the 1st, so an AND
    // implementation would skip to October and this asserts the OR.
    expect(next('0 0 1 * 1')).toBe('2026-09-21T00:00:00.000Z');
  });

  it('fires on the day-of-month alone when day-of-week is a wildcard', () => {
    expect(next('0 0 1 * *')).toBe('2026-10-01T00:00:00.000Z');
  });

  it('treats a stepped wildcard as a wildcard, not a constraint', () => {
    // Vixie's rule: a field beginning with `*` is not "restricted", so `*/2` in
    // day-of-month does not combine with a weekday by OR — it is the only day rule.
    // With `*/2` on day-of-month, an AND reading would land on an even-numbered day that is
    // also a Sunday; the correct reading is simply the next even-numbered day.
    expect(next('0 0 */2 * 1')).toBe('2026-09-21T00:00:00.000Z');
  });

  it('applies day-of-week alone when day-of-month is a wildcard', () => {
    expect(next('0 12 * * 3')).toBe('2026-09-23T12:00:00.000Z');
  });
});

describe('cron: parsing', () => {
  it('sorts values ascending, so the first candidate found is the earliest', () => {
    const fields = parseCron('30,5,15 * * * *');
    expect(fields.minutes).toEqual([5, 15, 30]);
  });

  it('expands a range with a step', () => {
    expect(parseCron('0 0-12/6 * * *').hours).toEqual([0, 6, 12]);
  });

  it('accepts a comma list of ranges and single values', () => {
    expect(parseCron('1,5-7,20 * * * *').minutes).toEqual([1, 5, 6, 7, 20]);
  });

  it('marks a field restricted only when it does not begin with a wildcard', () => {
    const both = parseCron('0 0 1 * 1');
    expect(both.dayOfMonthRestricted).toBe(true);
    expect(both.dayOfWeekRestricted).toBe(true);

    const neither = parseCron('0 0 * * *');
    expect(neither.dayOfMonthRestricted).toBe(false);
    expect(neither.dayOfWeekRestricted).toBe(false);

    const stepped = parseCron('0 0 */2 * *');
    expect(stepped.dayOfMonthRestricted).toBe(false);
  });
});

describe('cron: rejection', () => {
  const invalid: ReadonlyArray<[string, string]> = [
    ['60 * * * *', 'minute out of range'],
    ['* 24 * * *', 'hour out of range'],
    ['* * 0 * *', 'day-of-month below range'],
    ['* * 32 * *', 'day-of-month above range'],
    ['* * * 13 *', 'month out of range'],
    ['* * * * 8', 'day-of-week out of range'],
    ['* * * *', 'too few fields'],
    ['* * * * * *', 'too many fields'],
    ['5-1 * * * *', 'backwards range'],
    ['*/0 * * * *', 'zero step'],
    ['JAN * * * *', 'named field'],
    ['0 0 * * MON', 'named weekday'],
    ['1-2-3 * * * *', 'double dash'],
    ['1//2 * * * *', 'double slash'],
    ['1, * * * *', 'empty list element'],
    ['', 'empty'],
  ];

  for (const [expression, why] of invalid) {
    it(`rejects "${expression}" (${why})`, () => {
      expect(isValidCron(expression)).toBe(false);
      expect(() => parseCron(expression)).toThrow();
    });
  }

  it('accepts a valid expression', () => {
    expect(isValidCron('*/10 * * * *')).toBe(true);
    expect(isValidCron('0 0 29 2 *')).toBe(true);
  });

  it('names the offending field in the error', () => {
    // The message is what a caller sees in a 400, so it has to say which field is wrong.
    expect(() => parseCron('* 24 * * *')).toThrow(/hour/);
    expect(() => parseCron('* * * 13 *')).toThrow(/month/);
  });
});

describe('cron: bounds', () => {
  it('searches far enough for a leap day but not forever', () => {
    expect(CRON_MAX_SEARCH_DAYS).toBeGreaterThanOrEqual(366 * 4);
  });

  it('does not search beyond the bound for an unsatisfiable expression', () => {
    const started = Date.now();
    expect(next('0 0 30 2 *')).toBeNull();
    // A minute-by-minute walk over five years would take seconds; the day-first search is
    // what keeps this a test rather than a hang. Generous bound, still catches a regression
    // to the naive implementation.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('cron: description', () => {
  it('names the common shapes', () => {
    expect(describeCron('*/10 * * * *')).toBe('every 10 minutes');
    expect(describeCron('0 * * * *')).toBe('hourly at minute 0');
    expect(describeCron('0 9 * * *')).toBe('daily at 09:00 UTC');
    expect(describeCron('0 9 * * 1')).toBe('weekly on day 1 at 09:00 UTC');
  });

  it('falls back to the expression itself rather than inventing prose', () => {
    // A second description of a schedule that can drift from the first is worse than none.
    expect(describeCron('15 3 1 * *')).toBe('15 3 1 * *');
    expect(describeCron('not a cron')).toBe('not a cron');
  });
});
