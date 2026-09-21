/**
 * Grouping and compact time.
 *
 * ## Why these are asserted against an injected clock rather than the real one
 *
 * Every rule here is a rule about *time*, and the interesting cases are all boundary cases: a
 * session touched at 23:59 seen at 00:01, a conversation from the previous calendar month, a
 * schedule whose next fire is overdue. Reaching any of those through a render would mean
 * freezing the global clock and building a DOM, and the test would then be asserting a heading
 * rather than the rule.
 *
 * So `now` is a parameter, and every case below passes the same one.
 */

import { describe, expect, it } from 'vitest';
import type { ChatSessionSummary, ScheduleSummary } from '@nexs/shared';
import {
  groupSessions,
  sessionActivityAt,
  sessionLabel,
  shortRelative,
  timeBucket,
  upcomingSchedules,
} from './session-groups';

/** 21 September 2026, 08:27 local. Local rather than UTC because the buckets are calendar days. */
const NOW = new Date(2026, 8, 21, 8, 27, 0);

/** A local-time Date as the ISO string the API would send. */
function at(year: number, month: number, day: number, hour = 9, minute = 0): string {
  return new Date(year, month, day, hour, minute).toISOString();
}

function session(
  id: string,
  updatedAt: string,
  overrides: Partial<ChatSessionSummary> = {},
): ChatSessionSummary {
  return {
    id,
    title: null,
    agentId: null,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 0,
    lastMessageAt: null,
    ...overrides,
  };
}

function schedule(
  id: string,
  nextFireAt: string | null,
  enabled = true,
): ScheduleSummary {
  return {
    id,
    name: id,
    kind: 'recurring',
    cron: '0 9 * * *',
    timezone: 'UTC',
    runAt: null,
    targetKind: 'task',
    targetId: 'task-1',
    enabled,
    lastFiredAt: null,
    nextFireAt,
    createdAt: at(2026, 8, 1),
    updatedAt: at(2026, 8, 1),
  };
}

describe('shortRelative', () => {
  it('says now rather than 0m for anything under a minute', () => {
    expect(shortRelative(new Date(NOW.getTime() - 20_000).toISOString(), NOW)).toBe('now');
  });

  it('counts minutes, hours and days', () => {
    expect(shortRelative(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBe('5m');
    expect(shortRelative(new Date(NOW.getTime() - 2 * 3_600_000).toISOString(), NOW)).toBe('2h');
    expect(shortRelative(new Date(NOW.getTime() - 13 * 86_400_000).toISOString(), NOW)).toBe('13d');
  });

  it('keeps a three-digit day count rather than rolling up to months', () => {
    // The reference design shows `127d`, and a conversation from four months ago is easier to
    // place as a day count than as a rounded "4mo".
    expect(shortRelative(new Date(NOW.getTime() - 127 * 86_400_000).toISOString(), NOW)).toBe('127d');
  });

  it('marks a future timestamp as future', () => {
    // A schedule's `nextFireAt` is in the future, and rendering it as though it had already
    // happened would be a wrong number on screen.
    expect(shortRelative(new Date(NOW.getTime() + 3 * 3_600_000).toISOString(), NOW)).toBe('in 3h');
  });

  it('never renders a bare zero', () => {
    // 45 seconds is the floor of the sub-minute branch; `Math.floor` alone would give `0m`.
    expect(shortRelative(new Date(NOW.getTime() - 45_000).toISOString(), NOW)).toBe('1m');
  });

  it('returns an em dash for a missing or unparseable value', () => {
    expect(shortRelative(null, NOW)).toBe('—');
    expect(shortRelative(undefined, NOW)).toBe('—');
    expect(shortRelative('not a date', NOW)).toBe('—');
  });
});

describe('timeBucket', () => {
  it('places today and yesterday by calendar day, not by elapsed hours', () => {
    // 22:00 yesterday is ten and a half hours ago and is still *yesterday* to the person reading
    // it. A 24-hour-span rule would file it under Today, which is the one wrong answer.
    expect(timeBucket(at(2026, 8, 20, 22, 0), NOW).label).toBe('Yesterday');
    expect(timeBucket(at(2026, 8, 21, 7, 0), NOW).label).toBe('Today');
  });

  it('places the rest of the current week, then the current month', () => {
    expect(timeBucket(at(2026, 8, 16, 9, 0), NOW).label).toBe('Earlier this week');
    expect(timeBucket(at(2026, 8, 11, 9, 0), NOW).label).toBe('Earlier this month');
  });

  it('names the month once the month has changed', () => {
    expect(timeBucket(at(2026, 4, 17), NOW).label).toBe('May');
  });

  it('adds the year only when it is not the current year', () => {
    // "May" and "May 2025" are different facts, and a list that shows the first for both is a
    // list where an old conversation cannot be told from a recent one.
    expect(timeBucket(at(2025, 4, 17), NOW).label).toBe('May 2025');
  });

  it('gives every bucket a stable key', () => {
    expect(timeBucket(at(2026, 4, 17), NOW).key).toBe('ym:2026-05');
    expect(timeBucket(at(2026, 8, 21, 7, 0), NOW).key).toBe('today');
  });

  it('puts an unreadable date in its own bucket rather than claiming today', () => {
    const bucket = timeBucket(null, NOW);
    expect(bucket.key).toBe('undated');
    expect(bucket.label).toBe('Undated');
  });

  it('tolerates a timestamp slightly in the future', () => {
    // A skewed client clock must not produce a heading that reads "in 1 day".
    expect(timeBucket(at(2026, 8, 22), NOW).key).toBe('today');
  });
});

describe('groupSessions', () => {
  it('orders newest first and buckets in the order the data produces', () => {
    const groups = groupSessions(
      [
        session('old', at(2026, 4, 17)),
        session('today', at(2026, 8, 21, 7, 0)),
        session('week', at(2026, 8, 16)),
      ],
      NOW,
    );

    expect(groups.map((group) => group.key)).toEqual(['today', 'week', 'ym:2026-05']);
    expect(groups[0]!.items.map((row) => row.id)).toEqual(['today']);
  });

  it('orders rows within a group by activity, newest first', () => {
    const groups = groupSessions(
      [session('a', at(2026, 8, 21, 6, 0)), session('b', at(2026, 8, 21, 8, 0))],
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('prefers the last message over the row update, and falls back when there is none', () => {
    // Renaming a session touches `updatedAt` and nothing else; a conversation with messages is
    // placed by when it was last *spoken in*.
    const spoken = session('spoken', at(2026, 8, 1), { lastMessageAt: at(2026, 8, 21, 7, 0) });
    expect(sessionActivityAt(spoken)).toBe(spoken.lastMessageAt);
    expect(groupSessions([spoken], NOW)[0]!.key).toBe('today');

    const silent = session('silent', at(2026, 8, 21, 7, 0));
    expect(sessionActivityAt(silent)).toBe(silent.updatedAt);
    expect(groupSessions([silent], NOW)[0]!.key).toBe('today');
  });

  it('produces no empty groups', () => {
    const groups = groupSessions([session('only', at(2026, 8, 21, 7, 0))], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(1);
  });

  it('handles an empty list', () => {
    expect(groupSessions([], NOW)).toEqual([]);
  });
});

describe('sessionLabel', () => {
  it('names an unnamed conversation rather than rendering a blank row', () => {
    expect(sessionLabel(session('x', at(2026, 8, 21)))).toBe('Untitled');
    expect(sessionLabel(session('x', at(2026, 8, 21), { title: '   ' }))).toBe('Untitled');
  });

  it('trims a title, because a title is stored as typed and rendered as a row', () => {
    // A title with a leading space would otherwise push the row's text out of alignment with
    // every other row in the panel, which reads as a rendering bug rather than as a typo.
    expect(sessionLabel(session('x', at(2026, 8, 21), { title: '  Resolve the flaky job  ' }))).toBe(
      'Resolve the flaky job',
    );
  });
});

describe('upcomingSchedules', () => {
  it('keeps only what will actually fire', () => {
    const entries = upcomingSchedules(
      [
        schedule('soon', at(2026, 8, 21, 12, 0)),
        schedule('disabled', at(2026, 8, 21, 11, 0), false),
        // `nextFireAt: null` means "nothing computed yet", not "never" — either way it is not a
        // job that is about to run, and the panel lists jobs that are about to run.
        schedule('uncomputed', null),
      ],
      NOW,
    );

    expect(entries.map((entry) => entry.schedule.id)).toEqual(['soon']);
  });

  it('sorts soonest first, because this is the one list about the future', () => {
    const entries = upcomingSchedules(
      [
        schedule('later', at(2026, 8, 22, 9, 0)),
        schedule('sooner', at(2026, 8, 21, 9, 30)),
      ],
      NOW,
    );
    expect(entries.map((entry) => entry.schedule.id)).toEqual(['sooner', 'later']);
  });

  it('carries the label it sorted by, so a row cannot disagree with its own order', () => {
    const entries = upcomingSchedules([schedule('a', at(2026, 8, 21, 11, 27))], NOW);
    expect(entries[0]!.nextRun).toBe('in 3h');
  });

  it('handles an empty list', () => {
    expect(upcomingSchedules([], NOW)).toEqual([]);
  });
});
