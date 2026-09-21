/**
 * Sidebar grouping and compact relative time.
 *
 * The work panel is a *memory of work*, and a flat list of forty conversations is not a memory —
 * it is a log. This module turns one into the other: newest first, bucketed by how recently the
 * conversation was touched, with a two-character age beside each row.
 *
 * ## Why this is a separate pure module
 *
 * Every rule here is a rule about *time*, and time is the one input a component cannot control.
 * A `SessionList` that computed its own buckets from `Date.now()` would be testable only by
 * freezing the clock globally and rendering — and the interesting cases (a session at 23:59
 * yesterday seen at 00:01, a conversation from the previous calendar month, a schedule whose
 * next fire is overdue) are exactly the ones that are awkward to reach through a render.
 *
 * So `now` is a parameter with a default, the functions are pure, and the tests pass the clock
 * in. The components below call them with the real one.
 *
 * ## Buckets are calendar days, not 24-hour spans
 *
 * "Yesterday" means the previous calendar day, not "more than 24 hours ago". At 00:30, something
 * from 22:00 is two and a half hours old and is still *yesterday* to the person reading it —
 * and a 24-hour-span rule would file it under "Today", which is the one answer that is wrong.
 */

import type { ChatSessionSummary, ScheduleSummary } from '@nexs/shared';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function parseIso(iso: string | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === '') return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A compact age: `now`, `5m`, `2h`, `13d`, or `in 3h` for a future timestamp.
 *
 * The spec's screenshot shows `1h`, `2h`, `7h`, `13d`, `127d` — two or three characters, always,
 * because a sidebar row has room for a title *or* a timestamp and not both. That is the reason
 * this exists alongside `formatRelative`: "2 hours ago" is the right string in a table cell and
 * the wrong one here.
 *
 * A future timestamp reads `in 3h`. Schedules use the same function, and a next-fire time that
 * silently rendered as though it were in the past would be a wrong number on screen.
 *
 * An overdue schedule therefore reads as a past age (`2m`), which is the honest reading: the
 * column says when it *was* due, and the row's `title` carries the absolute moment.
 */
export function shortRelative(iso: string | null | undefined, now: Date = new Date()): string {
  const date = parseIso(iso);
  if (date === null) return '—';

  const delta = date.getTime() - now.getTime();
  const abs = Math.abs(delta);
  const past = delta < 0;

  // Below a minute, "now" is more useful than "0m" — and `0m` would read as a bug.
  if (abs < 45_000) return past ? 'now' : 'soon';

  const value =
    abs < HOUR
      ? `${Math.max(1, Math.floor(abs / MINUTE))}m`
      : abs < DAY
        ? `${Math.max(1, Math.floor(abs / HOUR))}h`
        : `${Math.max(1, Math.floor(abs / DAY))}d`;

  return past ? value : `in ${value}`;
}

/** Midnight local time, so a comparison is between calendar days rather than instants. */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Whole calendar days between two instants, ignoring the time of day.
 *
 * `Math.round` rather than `Math.floor` because a daylight-saving boundary makes the difference
 * 23 or 25 hours, and either one must still read as exactly one day.
 */
function dayDifference(date: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(date)) / DAY);
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** `May`, or `May 2025` once the year stops being the current one. */
function monthLabel(date: Date, now: Date): string {
  const name = MONTH_NAMES[date.getMonth()] ?? 'Unknown';
  return date.getFullYear() === now.getFullYear() ? name : `${name} ${date.getFullYear()}`;
}

export interface TimeBucket {
  /** Stable identity for React keys — a month bucket is `ym:2026-05`. */
  key: string;
  label: string;
}

/**
 * Which section a timestamp belongs to.
 *
 * The four fixed buckets are the spec's own headings. Beyond a month, the group is named after
 * the month itself, which is what makes a two-year-old conversation findable by name rather
 * than lost under an ever-growing "Earlier".
 */
export function timeBucket(iso: string | null | undefined, now: Date = new Date()): TimeBucket {
  const date = parseIso(iso);
  // Not "Today" — a row whose date cannot be read has not been placed, and saying it is from
  // today would be a claim the data does not support.
  if (date === null) return { key: 'undated', label: 'Undated' };

  const days = dayDifference(date, now);

  // A future timestamp lands here too. A conversation cannot have been touched tomorrow, but a
  // clock skew between the browser and the server is real, and the top group is the sane place
  // for it — the alternative is a heading that reads "in 1 day".
  if (days <= 0) return { key: 'today', label: 'Today' };
  if (days === 1) return { key: 'yesterday', label: 'Yesterday' };
  if (days < 7) return { key: 'week', label: 'Earlier this week' };

  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
    return { key: 'month', label: 'Earlier this month' };
  }

  return { key: `ym:${monthKey(date)}`, label: monthLabel(date, now) };
}

export interface SessionGroup {
  key: string;
  label: string;
  items: readonly ChatSessionSummary[];
}

/**
 * When a conversation was last worked on.
 *
 * `lastMessageAt` is the real answer and is `null` for a session nobody has written in. Falling
 * back to `updatedAt` rather than `createdAt` matters for exactly that case: opening a session
 * and renaming it touches `updatedAt` and nothing else, and a row that jumped back to the top
 * is what the person who renamed it expects to see.
 */
export function sessionActivityAt(session: ChatSessionSummary): string {
  return session.lastMessageAt ?? session.updatedAt;
}

/** The same value as a number, for sorting. An unparseable date sorts last rather than throwing. */
function activityMs(session: ChatSessionSummary): number {
  return parseIso(sessionActivityAt(session))?.getTime() ?? 0;
}

/**
 * Sessions, newest first, in ordered sections.
 *
 * Sorting happens **before** bucketing, so the section order falls out of the data instead of
 * being a second hard-coded list that can disagree with the first. An empty bucket is dropped
 * rather than rendered as a heading with nothing under it.
 */
export function groupSessions(
  sessions: readonly ChatSessionSummary[],
  now: Date = new Date(),
): readonly SessionGroup[] {
  // Sorted numerically rather than by comparing the ISO strings. Both work on well-formed
  // timestamps, but `localeCompare` is locale-sensitive, and a sort whose order depends on the
  // browser's locale is one that reorders the sidebar when someone changes their language.
  const sorted = [...sessions].sort((left, right) => activityMs(right) - activityMs(left));

  const groups: { key: string; label: string; items: ChatSessionSummary[] }[] = [];
  for (const session of sorted) {
    const bucket = timeBucket(sessionActivityAt(session), now);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === bucket.key) {
      last.items.push(session);
    } else {
      groups.push({ key: bucket.key, label: bucket.label, items: [session] });
    }
  }

  return groups;
}

/** The label a row shows: `title`, or the honest name for a conversation nothing has named. */
export function sessionLabel(session: ChatSessionSummary): string {
  const title = session.title?.trim() ?? '';
  return title === '' ? 'Untitled' : title;
}

export interface UpcomingSchedule {
  schedule: ScheduleSummary;
  /** The compact form of `nextFireAt`, computed once so the row cannot disagree with the sort. */
  nextRun: string;
}

/**
 * Schedules that will actually fire, soonest first.
 *
 * Three filters, and each one is a distinction the data makes:
 *
 *  - **`enabled`** — a disabled schedule has a `nextFireAt` in the row and will not fire at it.
 *    Listing it under a heading that says "Scheduled jobs" would be a claim about the future
 *    that the row itself contradicts.
 *  - **`nextFireAt !== null`** — the column is stored rather than derived, so `null` means
 *    "nothing computed yet", which is the state of a schedule whose first fire has not been
 *    processed. It is not a job that is about to run.
 *  - **Newest first is wrong here.** This is the one list in the panel that is about the future,
 *    so it sorts ascending.
 */
export function upcomingSchedules(
  schedules: readonly ScheduleSummary[],
  now: Date = new Date(),
): readonly UpcomingSchedule[] {
  return schedules
    .filter((schedule) => schedule.enabled && schedule.nextFireAt !== null)
    .sort((left, right) => (left.nextFireAt ?? '').localeCompare(right.nextFireAt ?? ''))
    .map((schedule) => ({ schedule, nextRun: shortRelative(schedule.nextFireAt, now) }));
}
