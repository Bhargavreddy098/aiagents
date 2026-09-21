/**
 * Session metrics for the status bar (§3.2).
 *
 * ## The honesty problem this module exists to solve
 *
 * §3.2 draws a status bar reading `18.2K/200K │ $0.08 │ 🗜️ 1 │ ▶ 2 │ 📌 1 │ 12m 45s │ ⚠ YOLO`.
 * Five of those numbers come from somewhere real in this build and four do not, and the
 * difference is the whole reason this file is not a component.
 *
 * What the database actually holds:
 *
 *  - **Tokens.** Per *run*, in `RunModelUsageView` (`promptTokens`, `completionTokens`,
 *    `totalTokens`, `costEstimate`). There is no per-session token column and no per-session
 *    cost column: a `ChatSession` row is `id, title, agentId, createdAt, updatedAt`.
 *  - **A context window.** On the *model* (`ModelSummary.contextWindow`), not on the session.
 *  - **A duration.** From `session.createdAt` — the wall clock the spec means.
 *  - **A title.** `session.title`, which `PATCH /chat/sessions/:id` writes.
 *  - **A stash count.** Client-side, from `stash.ts`.
 *  - **Compressions.** Nothing records them. `ChatMessageDto` has no `compressed` flag and no
 *    compaction row exists.
 *  - **Background tasks.** A run is not a background task: `/bg` has no server counterpart, and
 *    the runs a session started are visible in the Runs list rather than counted here.
 *  - **YOLO.** There is no auto-approval toggle in any config or route.
 *
 * So the metrics below are split into `measured`, `derived` and `absent`. A caller renders the
 * first two and must render the third as an explicit "not recorded" rather than as a zero — a
 * `🗜️ 0` next to a `18.2K/200K` would be read as a fact, and it would be an invented one.
 *
 * ## Why `derived` is a separate list rather than folded into `measured`
 *
 * A derived number can be wrong in a way a measured one cannot. The session's token total is the
 * sum over its runs *as far as this client has read them* — a session with more runs than the
 * client fetched reports a total that is too low, and a cost that is too low with it. Labelling
 * it derived is what lets the UI put a `~` on it, which is exactly what the spec's own
 * "leading `~` indicates local token estimation" rule is for.
 */

import type { ChatSessionSummary, ModelSummary, RunModelUsageView, RunSummary } from '@nexs/shared';

/** A number the UI may render as-is. */
export interface MeasuredMetric {
  kind: 'measured';
  value: number;
}

/** A number computed from what the client has read. Rendered with a `~`. */
export interface DerivedMetric {
  kind: 'derived';
  value: number;
  /** What would make it exact, for the title attribute. */
  caveat: string;
}

/** A number this build does not record. Rendered as "not recorded", never as 0. */
export interface AbsentMetric {
  kind: 'absent';
  /** Why — phrased for a user, and shown rather than hidden in a tooltip. */
  reason: string;
}

export type Metric = MeasuredMetric | DerivedMetric | AbsentMetric;

export interface SessionMetrics {
  /** Token usage across the session's runs, or absent when none have been read. */
  tokens: Metric;
  /** USD across the session's runs. Absent when no usage row carried a cost. */
  cost: Metric;
  /** How many times the context was compacted. */
  compressions: AbsentMetric;
  /** Background tasks spawned with `/bg`. */
  backgroundTasks: AbsentMetric;
  /** Wall-clock elapsed since the session was created. Measured — `createdAt` is a column. */
  durationMs: Metric;
  /** Auto-approval mode. */
  yolo: AbsentMetric;
}

const NO_COMPRESSION_RECORD: AbsentMetric = {
  kind: 'absent',
  reason: 'No compaction events are recorded — the schema has no column for them',
};

const NO_BACKGROUND_TASKS: AbsentMetric = {
  kind: 'absent',
  reason: 'No background-task queue: `/bg` has no server counterpart in this build',
};

const NO_YOLO: AbsentMetric = {
  kind: 'absent',
  reason: 'Auto-approval is not configurable — every risky step goes to the Decision Inbox',
};

/**
 * Build the status bar's metrics from what the client has.
 *
 * `runs` are the runs the session started and `usage` every usage row read for those runs. Both
 * are passed in rather than fetched here: the caller already has them for the run workspace, and
 * a hook in this module would fetch the same rows a second time under a different key.
 */
export function sessionMetrics(input: {
  session: ChatSessionSummary | null;
  runs: readonly RunSummary[];
  usage: readonly RunModelUsageView[];
  now?: number;
}): SessionMetrics {
  const now = input.now ?? Date.now();

  const durationMs =
    input.session === null
      ? null
      : now - new Date(input.session.createdAt).getTime();

  const tokenTotal = input.usage.reduce((sum, row) => sum + row.totalTokens, 0);
  const costTotal = input.usage.reduce((sum, row) => sum + row.costEstimate, 0);

  return {
    tokens:
      input.usage.length === 0
        ? {
            kind: 'absent',
            reason: 'No model usage recorded yet for this session',
          }
        : {
            kind: 'derived',
            value: tokenTotal,
            caveat: `Summed over ${input.usage.length} usage row${
              input.usage.length === 1 ? '' : 's'
            } from ${input.runs.length} run${input.runs.length === 1 ? '' : 's'} — runs older than the fetch are not included`,
          },
    cost:
      input.usage.length === 0
        ? { kind: 'absent', reason: 'No model usage recorded yet for this session' }
        : {
            kind: 'derived',
            value: costTotal,
            caveat:
              'Summed from the provider’s own per-call estimates; a free or local model reports 0',
          },
    compressions: NO_COMPRESSION_RECORD,
    backgroundTasks: NO_BACKGROUND_TASKS,
    durationMs:
      durationMs === null || !Number.isFinite(durationMs) || durationMs < 0
        ? { kind: 'absent', reason: 'No session is open' }
        : { kind: 'measured', value: durationMs },
    yolo: NO_YOLO,
  };
}

/**
 * The context reading for the status bar.
 *
 * The numerator is the session's token total; the denominator is the **model's** `contextWindow`,
 * which is the only window this build knows. The pairing is a real mismatch and is stated rather
 * than smoothed over: a conversation's cumulative token count is not its context-window occupancy,
 * because compaction and windowing mean the live context is smaller. So this is labelled
 * `approximate` and the bar renders with a `~` in front of the pair.
 *
 * `null` when there is no model, no window, or no usage — the caller renders an em dash for each.
 */
export interface ContextOccupancy {
  used: number;
  max: number;
  /** True when the numerator is a cumulative total rather than a live window reading. */
  approximate: boolean;
  /** What is actually being compared, for the title attribute. */
  note: string;
}

export function contextOccupancy(
  tokenTotal: number | null,
  model: Pick<ModelSummary, 'contextWindow' | 'name'> | null,
): ContextOccupancy | null {
  if (tokenTotal === null) return null;
  if (model === null) return null;
  if (model.contextWindow === null || model.contextWindow <= 0) return null;
  return {
    used: tokenTotal,
    max: model.contextWindow,
    approximate: true,
    note: `Cumulative tokens across this session's runs, against ${model.name}'s ${model.contextWindow.toLocaleString()}-token window. Not a live occupancy reading — the window is applied to the request, not recorded per turn.`,
  };
}

/** A duration rendered the spec's way: `12m 45s`, `1h 04m`. */
export function formatSessionDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** USD, at the precision a per-call estimate deserves. `$0.08`, `$1.2400` when tiny. */
export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  // Below a cent, two decimals would round a real cost to `$0.00`. Four is what the provider's
  // own estimate carries, so nothing is invented by showing them.
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
