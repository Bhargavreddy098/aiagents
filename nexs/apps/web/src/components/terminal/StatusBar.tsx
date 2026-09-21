/**
 * §3.2 — the persistent two-column status bar.
 *
 * ## The two-column structure, and why the split is not cosmetic
 *
 * Left is what the *machine* is doing: which model, how much of its window is spent, what it has
 * cost. Right is what the *session* is doing: how much has been compacted, how many tasks are
 * running, how many drafts are stashed, how long it has been open, what it is called. Two
 * different questions, two columns, and a reader can find one without reading the other.
 *
 * ## The honesty rule, made visible
 *
 * Four of the spec's seven readings have no backing in this build (see `lib/session-metrics.ts`
 * for the full account: no compaction column, no `/bg` queue, no auto-approval toggle, and no
 * per-session token column). Each of those renders as an explicit **"not recorded"** marker with
 * the reason in its `title`, never as a zero.
 *
 * That is a deliberate visual cost. A status bar with three quiet "not recorded" markers looks
 * less finished than one with `🗜️ 0 │ ▶ 0` — and the second one is lying. A zero in a status bar
 * is read as a measurement; there is no reading to report here, and saying so is the only correct
 * option. The marker is styled as muted dotted-underlined text so it reads as a note rather than
 * an error.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ModelSummary } from '@nexs/shared';
import {
  type ContextReading,
  formatTokens,
  readContext,
} from '../../lib/context';
import {
  type Metric,
  type SessionMetrics,
  formatCost,
  formatSessionDuration,
} from '../../lib/session-metrics';
import { formatTokens as tokens } from '../../lib/context';

/** A "not recorded" marker. The reason is in the title, and the text says what it is. */
function Absent({ label, reason }: { label: string; reason: string }): ReactNode {
  return (
    <span className="statusbar-missing" title={reason}>
      {label} —
    </span>
  );
}

/**
 * A metric value, with the absent case handled by the caller.
 *
 * Narrowing is done with an `if` rather than a ternary on purpose: `metric.kind === 'absent' ?
 * <Absent/> : <span>{metric.value}</span>` does **not** narrow `metric` in the false branch, so
 * the ternary version does not compile — which is fortunate, because the `if` makes the absent
 * case impossible to skip.
 */
function metricValue(metric: Metric): number | null {
  if (metric.kind === 'absent') return null;
  return metric.value;
}

/** Whether a metric is derived — i.e. deserves the spec's `~`. */
function isDerived(metric: Metric): boolean {
  return metric.kind === 'derived';
}

/** The `title` for a metric: the caveat when derived, the reason when absent. */
function metricTitle(metric: Metric, fallback: string): string {
  if (metric.kind === 'absent') return metric.reason;
  if (metric.kind === 'derived') return metric.caveat;
  return fallback;
}

function Sep(): ReactNode {
  return (
    <span className="statusbar-sep" aria-hidden="true">
      │
    </span>
  );
}

/**
 * The context meter.
 *
 * The `~` in front of the pair is the spec's own convention for a non-exact token count, and it
 * is doing real work here: the numerator is a *cumulative* total over the session's runs rather
 * than a live window reading, because the schema records usage on the run and not on the turn.
 * The `title` says so in a full sentence rather than leaving the tilde unexplained.
 */
function ContextMeter({
  reading,
  approximate,
  note,
  onOpen,
}: {
  reading: ContextReading | null;
  approximate: boolean;
  note: string;
  /** Open §9.3’s grid. Absent when the host page has no modal mounted. */
  onOpen?: () => void;
}): ReactNode {
  if (reading === null) {
    return (
      <span className="statusbar-missing" title="No token usage and no model window to compare it against">
        context —
      </span>
    );
  }

  const percent = reading.percent.toFixed(0);
  const label = `${reading.percent.toFixed(1)}% of the window · ${reading.band}`;

  // The meter is a button when a modal is wired up and plain text when it is not. Making it
  // always-a-button would put a control on the bar that does nothing on every page except Chat,
  // and §9.3 draws it as a reading rather than as a control, so the affordance appears exactly
  // where it leads somewhere.
  const body = (
    <>
      <span className="statusbar-metric">{approximate ? '~' : ''}{reading.label}</span>
      <span className={`statusbar-bar statusbar-band-${reading.band}`} aria-hidden={onOpen ? true : undefined}>
        [{reading.bar}] {percent}%
      </span>
    </>
  );

  if (onOpen === undefined) {
    return (
      <>
        <span className="statusbar-metric" title={note}>
          {approximate ? '~' : ''}
          {reading.label}
        </span>
        <span
          className={`statusbar-bar statusbar-band-${reading.band}`}
          title={label}
          aria-label={`Context ${percent} percent used`}
        >
          [{reading.bar}] {percent}%
        </span>
      </>
    );
  }

  return (
    <button
      type="button"
      className="statusbar-context-button"
      onClick={onOpen}
      title={`${note} — open the full breakdown`}
      aria-label={`Context ${percent} percent used. Open the context breakdown.`}
    >
      {body}
    </button>
  );
}

/**
 * How long the session has been open, re-rendered on a timer.
 *
 * The interval is 1s because every unit the formatter emits is at least a second. The timer is
 * only started when there is a measured duration to show — a bar that ticked against an absent
 * reading would be a re-render every second for nothing.
 */
function useTickingDuration(value: number | null): number | null {
  const [, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (value === null) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
    // Keyed on whether there is something to tick, not on the value: re-arming the interval
    // every time `value` changed would reset it on every render of the parent.
  }, [value === null]);

  return value;
}

export interface StatusBarProps {
  /** The active model, or null for an ad-hoc session with none chosen yet. */
  model: Pick<ModelSummary, 'name' | 'contextWindow' | 'externalModelId'> | null;
  /** The metrics from `sessionMetrics`. */
  metrics: SessionMetrics;
  /** The context reading from `readContext`, or null. */
  context: ContextReading | null;
  /** True when the numerator is a cumulative total rather than a live occupancy. */
  approximate: boolean;
  /** The full explanation of what the context pair compares. */
  contextNote: string;
  /** The session's title, for the badge. */
  title: string | null;
  /** How many drafts are stashed. Client-side, from the composer. */
  stashCount: number;
  /** Opens §9.3’s context grid. Omit on a page with no modal mounted. */
  onOpenContext?: () => void;
}

/**
 * The bar.
 *
 * `role="status"` with `aria-live="off"` — the whole bar changes constantly and announcing every
 * second of the duration would make it unusable with a screen reader. It is a status region so
 * that a reader navigating to it finds a labelled group rather than a run of loose text.
 */
export function StatusBar({
  model,
  metrics,
  context,
  approximate,
  contextNote,
  title,
  stashCount,
  onOpenContext,
}: StatusBarProps): ReactNode {
  const duration = useTickingDuration(
    metrics.durationMs.kind === 'measured' ? metrics.durationMs.value : null,
  );

  return (
    <div className="statusbar" role="status" aria-live="off" aria-label="Session status">
      {/* ── left: the model and what it is spending ─────────────────────────── */}
      <span className="statusbar-model" title={model?.externalModelId ?? 'No model selected'}>
        <span className="statusbar-sigil" aria-hidden="true">
          ☤
        </span>
        {model === null ? <span className="muted">no model</span> : model.name}
      </span>

      <Sep />

      <ContextMeter
        reading={context}
        approximate={approximate}
        note={contextNote}
        onOpen={onOpenContext}
      />

      <Sep />

      {metricValue(metrics.cost) === null ? (
        <Absent label="cost" reason={metrics.cost.kind === 'absent' ? metrics.cost.reason : ''} />
      ) : (
        <span className="statusbar-metric" title={metricTitle(metrics.cost, 'Accumulated provider cost')}>
          {isDerived(metrics.cost) ? '~' : ''}
          {formatCost(metricValue(metrics.cost))}
        </span>
      )}

      {/* ── right: what the session is doing ────────────────────────────────── */}
      <span className="statusbar-right">
        {metricValue(metrics.compressions) === null ? (
          <Absent
            label="🗜️"
            reason={metrics.compressions.kind === 'absent' ? metrics.compressions.reason : ''}
          />
        ) : (
          <span className="statusbar-badge is-live" title="Context compactions">
            🗜️ {metricValue(metrics.compressions)}
          </span>
        )}

        <Sep />

        {metricValue(metrics.backgroundTasks) === null ? (
          <Absent
            label="▶"
            reason={metrics.backgroundTasks.kind === 'absent' ? metrics.backgroundTasks.reason : ''}
          />
        ) : (
          <span className="statusbar-badge is-live" title="Background tasks">
            ▶ {metricValue(metrics.backgroundTasks)}
          </span>
        )}

        <Sep />

        {/*
          Stashed prompts is the one right-column number that *is* real, because the stash lives
          in this tab. It is rendered even at zero, because zero is a true measurement here —
          "nothing is stashed" — and hiding it would make the gesture unfindable.
        */}
        <span
          className={`statusbar-badge${stashCount > 0 ? ' is-live' : ''}`}
          title={stashCount === 0 ? 'No stashed drafts' : `${stashCount} stashed draft(s)`}
        >
          📌 {stashCount}
        </span>

        <Sep />

        {metricValue(metrics.durationMs) === null ? (
          <Absent
            label="duration"
            reason={metrics.durationMs.kind === 'absent' ? metrics.durationMs.reason : ''}
          />
        ) : (
          <span className="statusbar-metric" title="Wall clock since the session was created">
            {formatSessionDuration(duration ?? metricValue(metrics.durationMs))}
          </span>
        )}

        {title !== null && title !== '' ? (
          <>
            <Sep />
            <Link className="statusbar-title" to="#" title={title} onClick={(event) => event.preventDefault()}>
              {title}
            </Link>
          </>
        ) : null}

        {/*
          §3.2's `⚠ YOLO`. There is no auto-approval mode in this build, so the badge is never
          rendered — but the *replacement* is, and it is not silent about why. A bar that simply
          omitted the badge would leave a reader who knows the spec wondering whether they had
          switched it off; this says the feature does not exist.
        */}
        {metrics.yolo.kind === 'absent' ? (
          <span className="statusbar-missing" title={metrics.yolo.reason}>
            ⚠ YOLO n/a
          </span>
        ) : (
          <span className="statusbar-yolo">⚠ YOLO</span>
        )}
      </span>
    </div>
  );
}

/** Everything the bar needs, assembled from what the caller already has. */
export function statusBarContext(
  tokenTotal: number | null,
  model: Pick<ModelSummary, 'name' | 'contextWindow' | 'externalModelId'> | null,
): { reading: ContextReading | null; approximate: boolean; note: string } {
  if (model === null || tokenTotal === null) {
    return { reading: null, approximate: false, note: 'No model or no usage recorded' };
  }
  if (model.contextWindow === null || model.contextWindow <= 0) {
    return {
      reading: null,
      approximate: false,
      note: `${model.name} has no context window recorded, so there is nothing to compare against`,
    };
  }
  return {
    reading: readContext(tokenTotal, model.contextWindow),
    approximate: true,
    note: `Cumulative tokens across this session's runs, against ${model.name}'s ${tokens(
      model.contextWindow,
    )}-token window. Not a live occupancy reading — the window is applied to the request rather than recorded per turn.`,
  };
}

export { formatTokens };
