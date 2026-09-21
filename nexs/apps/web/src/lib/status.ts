/**
 * Status → tone, in one place.
 *
 * The app has nine status vocabularies (run, step, tool call, agent, goal, task, workflow,
 * approval, verification) plus health states for providers, MCP servers, browser sessions
 * and sandbox executions. They overlap: `completed` is the same green wherever it appears,
 * `failed` the same red.
 *
 * Mapping them here rather than per-page is what keeps the meaning stable. A page that
 * chose its own colour for `paused` would make the run list and the task list disagree
 * about what paused looks like, and an operator reads colour before text.
 *
 * The tone vocabulary is the spec's §6.3 status set — `ok`, `waiting`, `failed`, `running`
 * — plus `neutral` for the states that are none of the four: a draft, an archived row, an
 * expired approval. Neutral is deliberately a fifth tone rather than being folded into
 * `waiting`: "nothing has happened yet" and "this is over" are different, and painting them
 * the same amber would say a cancelled run is still waiting.
 */

export type Tone = 'ok' | 'waiting' | 'failed' | 'running' | 'neutral';

/**
 * A tone a **label** may carry, which is one thing more than a status may.
 *
 * `accent` is not a status and is deliberately not in `Tone`. It is for the badges that are
 * not describing state at all — a run's `kind`, a capability's name — where the point is
 * emphasis rather than meaning. Folding it into `Tone` would put it in reach of `toneFor`,
 * `dotClass` and `StatusBadge`, and a status badge painted accent-coloured would be a status
 * whose colour means nothing.
 */
export type BadgeTone = Tone | 'accent';

const TONES: Readonly<Record<string, Tone>> = {
  // ── success ───────────────────────────────────────────────────────────────
  completed: 'ok',
  approved: 'ok',
  passed: 'ok',
  executed: 'ok',
  connected: 'ok',
  success: 'ok',
  ok: 'ok',
  enabled: 'ok',
  ready: 'ok',
  active: 'ok',

  // ── in flight ─────────────────────────────────────────────────────────────
  running: 'running',
  planning: 'running',
  executing: 'running',
  in_progress: 'running',
  started: 'running',
  connecting: 'running',
  streaming: 'running',

  // ── not yet, or held ──────────────────────────────────────────────────────
  queued: 'waiting',
  pending: 'waiting',
  paused: 'waiting',
  waiting_approval: 'waiting',
  waiting: 'waiting',
  blocked: 'waiting',
  scheduled: 'waiting',
  requested: 'waiting',
  retrying: 'waiting',

  // ── failure ───────────────────────────────────────────────────────────────
  failed: 'failed',
  error: 'failed',
  rejected: 'failed',
  timeout: 'failed',
  denied: 'failed',
  disconnected: 'failed',
  unavailable: 'failed',

  // ── over, without having failed ───────────────────────────────────────────
  cancelled: 'neutral',
  canceled: 'neutral',
  expired: 'neutral',
  skipped: 'neutral',
  archived: 'neutral',
  disabled: 'neutral',
  draft: 'neutral',
  closed: 'neutral',
  unknown: 'neutral',
};

export function toneFor(status: string | null | undefined): Tone {
  if (status === null || status === undefined) return 'neutral';
  return TONES[status.toLowerCase()] ?? 'neutral';
}

/**
 * A status as a label.
 *
 * `waiting_approval` becomes "Waiting approval". The vocabulary is closed and snake_case by
 * construction, so a mechanical transform is correct here — and it means a status added to
 * the server appears with a sensible label instead of a blank cell.
 */
export function labelForStatus(status: string | null | undefined): string {
  if (status === null || status === undefined || status === '') return 'Unknown';
  const words = status.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The CSS class suffix for a tone: `ok` → `badge-ok`, `neutral` → `badge`. */
export function badgeClass(tone: BadgeTone): string {
  return tone === 'neutral' ? 'badge' : `badge badge-${tone}`;
}

/**
 * The CSS class for the dot that precedes a status.
 *
 * Narrower than `badgeClass` on purpose: there is no `.dot-accent`, because a dot is the
 * status indicator and a label has no status to indicate.
 */
export function dotClass(tone: Tone): string {
  return tone === 'neutral' ? 'dot' : `dot dot-${tone}`;
}

/** True for the statuses that mean the row will not change again on its own. */
const TERMINAL = new Set([
  'completed',
  'failed',
  'cancelled',
  'canceled',
  'archived',
  'expired',
  'rejected',
  'approved',
  'passed',
]);

export function isTerminal(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && TERMINAL.has(status.toLowerCase());
}

/**
 * Whether a status is still moving.
 *
 * Used to decide if a view should keep polling or show a spinner, so it is intentionally
 * narrower than `!isTerminal` — a `queued` row is not moving yet, and animating it would
 * suggest progress that is not happening.
 */
export function isLive(status: string | null | undefined): boolean {
  if (status === null || status === undefined) return false;
  return toneFor(status) === 'running';
}
