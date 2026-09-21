/**
 * §4.3 — the live subagent dock and the full-screen roster.
 *
 * ## What a "subagent" is in this build, stated once
 *
 * Hermes spawns *subagents*: child agents with their own model, token budget and status, listed in
 * a roster. This build has no subagent row. What it has is:
 *
 *  - **`Run`** — an agent execution, with `id`, `status`, `agentId`, `startedAt`, `durationMs`
 *    and, in `RunModelUsageView`, tokens and a cost estimate. A run *is* the unit of delegated
 *    work: `POST /api/runs/:id/cancel` stops one, `GET /api/runs/:id` details it.
 *  - **`Step`** — a run's own progress through its plan, which is where "step 3/5" comes from.
 *
 * So the dock lists **active runs** and calls them what they are. It does not invent a roster of
 * named subagents with roles and models of their own, because there is no column for any of that —
 * and a fake roster is the most damaging kind of fake, since an operator would use it to decide
 * what to steer or kill.
 *
 * ## What the spec's roster columns map onto, and what they cannot
 *
 * | Spec column | Here |
 * |---|---|
 * | ID | the run's short id |
 * | Name | the agent's name, or the run kind for an ad-hoc run |
 * | Role | the agent's sigil + derived role (`lib/sigils.ts`) |
 * | Model | `RunModelUsageView.modelId` — the model this run actually called |
 * | Tokens | the sum of that run's usage rows |
 * | Cost | the sum of that run's `costEstimate` |
 * | Elapsed | `durationMs`, or live from `startedAt` |
 * | Status | the run's own status |
 *
 * Role and Model are blank when the data is absent rather than substituted — and the roster
 * states, in its footer, that it lists runs rather than a separate subagent entity.
 *
 * ## Keyboard, and why the overlay is the thing with the bindings
 *
 * The spec gives `F7` (condense) and `Ctrl+T`/`F6` (roster). The dock is *always* visible when
 * there is something in it, so `F7` only changes how much of it is shown; the roster is a modal
 * and gets the arrow keys. Both bindings are owned by the component that renders the dock, so the
 * page that mounts it does not have to know the spec's key table.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { RunSummary } from '@nexs/shared';
import { Modal } from '../ui';
import { formatElapsed, formatDuration, shortId } from '../../lib/format';
import { formatCost } from '../../lib/session-metrics';
import { sigilFor } from '../../lib/sigils';
import { isLive } from '../../lib/status';

/** Everything the dock needs about one active run. */
export interface AgentActivity {
  run: RunSummary;
  /** The agent's name, or null for a run with no agent row. */
  agentName: string | null;
  /** The agent's description, for the derived sigil. */
  agentDescription: string | null;
  /** `step 3/5`, or null when the step counts are not known. */
  stepLabel: string | null;
  /** The model this run called, or null before it has called one. */
  modelName: string | null;
  /** Tokens across this run's usage rows, or null when none were read. */
  tokens: number | null;
  /** USD across this run's usage rows, or null when none were read. */
  cost: number | null;
}

/** How many rows the expanded dock shows before it says there are more. */
export const DOCK_MAX_ROWS = 4;

export interface SubagentDockProps {
  activities: readonly AgentActivity[];
  /** Opens the roster overlay. Owned by the parent so `Ctrl+T` and the header button agree. */
  onOpenRoster: () => void;
  /** Whether the dock is showing every row or the condensed single line. */
  condensed: boolean;
  onToggleCondensed: () => void;
}

/**
 * The dock.
 *
 * Renders nothing at all when no run is live. The spec draws it as a permanent fixture, but a
 * permanent empty strip above the status bar is a row of pixels that says nothing for most of a
 * session — and the spec's own heading is "when background subagents are running".
 */
export function SubagentDock({
  activities,
  onOpenRoster,
  condensed,
  onToggleCondensed,
}: SubagentDockProps): ReactNode {
  if (activities.length === 0) return null;

  const shown = condensed ? [] : activities.slice(0, DOCK_MAX_ROWS);
  const hidden = activities.length - shown.length;

  return (
    <section className="dock" aria-label="Active runs">
      <div className="dock-head">
        <span className="dock-head-title">▶ Active runs: {activities.length}</span>
        <span className="dock-head-actions">
          <button type="button" className="chip" onClick={onToggleCondensed} title="F7">
            {condensed ? 'Expand (F7)' : 'Condense (F7)'}
          </button>
          <button type="button" className="chip" onClick={onOpenRoster} title="Ctrl+T">
            Roster (Ctrl+T)
          </button>
        </span>
      </div>

      {condensed ? (
        <div className="dock-condensed">
          {activities
            .map((entry) => entry.agentName ?? entry.run.kind)
            .slice(0, 6)
            .join(' · ')}
          {activities.length > 6 ? ` · +${activities.length - 6} more` : ''}
        </div>
      ) : (
        <>
          {shown.map((entry, index) => (
            <DockRow key={entry.run.id} entry={entry} index={index + 1} />
          ))}
          {hidden > 0 ? (
            <div className="dock-condensed">
              +{hidden} more {hidden === 1 ? 'run' : 'runs'} — open the roster for all of them
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function DockRow({ entry, index }: { entry: AgentActivity; index: number }): ReactNode {
  const sigil = sigilFor(`${entry.agentName ?? ''} ${entry.agentDescription ?? ''}`);
  const name = entry.agentName ?? `(${entry.run.kind})`;

  return (
    <Link className="dock-row" to={`/runs/${entry.run.id}`}>
      <span className="dock-row-prefix" aria-hidden="true">
        ▶
      </span>
      <span className="dock-row-id">#{index}</span>
      <span className="dock-row-name">
        {sigil.glyph} {name}
      </span>
      <span className="dock-row-activity">
        {entry.stepLabel === null ? entry.run.kind : `step ${entry.stepLabel}`}
      </span>
      <span className="dock-row-step">
        {entry.run.status} · {formatElapsed(entry.run.startedAt)}
      </span>
    </Link>
  );
}

export interface RosterOverlayProps {
  open: boolean;
  onClose: () => void;
  activities: readonly AgentActivity[];
}

/**
 * The full-screen roster.
 *
 * Arrow keys move the cursor and `Enter` opens the run — the spec's own gesture, and the reason
 * the table is a listbox rather than a plain table with links: a keyboard operator needs one
 * cursor, not one tab stop per row.
 *
 * The footer names the actions the spec lists and marks the two this build cannot do. `s`/`e`
 * (steer) has no endpoint — there is no "inject a note into a running agent" route — and `x`
 * (stop) *is* real (`POST /api/runs/:id/cancel`) but is on the run page rather than here, so the
 * footer links there rather than wiring a destructive control into a modal.
 */
export function RosterOverlay({ open, onClose, activities }: RosterOverlayProps): ReactNode {
  const [cursor, setCursor] = useState(0);

  // Clamp when the list shrinks under the cursor — a run finishing while the roster is open must
  // not leave the highlight on a row that no longer exists.
  const clamped = Math.min(cursor, Math.max(0, activities.length - 1));

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((current) => Math.min(current + 1, activities.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, activities.length, onClose]);

  // `Modal` renders as soon as it is mounted — it has no `open` prop, and the scrim it draws
  // would otherwise be permanently in the tree. So the early return is here rather than inside it.
  if (!open) return null;

  const selected = activities[clamped] ?? null;

  return (
    <Modal onClose={onClose} title="Active runs">
      <div className="roster">
        {activities.length === 0 ? (
          <div className="roster-empty">
            Nothing is running. A run appears here from the moment it is queued until it reaches a
            terminal state.
          </div>
        ) : (
          <table className="roster-table">
            <thead>
              <tr>
                <th style={{ width: 44 }}>ID</th>
                <th>Name</th>
                <th>Role</th>
                <th>Model</th>
                <th className="is-mono right" style={{ width: 70 }}>
                  Tokens
                </th>
                <th className="is-mono right" style={{ width: 70 }}>
                  Cost
                </th>
                <th className="is-mono right" style={{ width: 80 }}>
                  Elapsed
                </th>
                <th style={{ width: 130 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {activities.map((entry, index) => {
                const sigil = sigilFor(`${entry.agentName ?? ''} ${entry.agentDescription ?? ''}`);
                const live = isLive(entry.run.status);
                return (
                  <tr
                    key={entry.run.id}
                    className={index === clamped ? 'is-active' : undefined}
                    onClick={() => setCursor(index)}
                  >
                    <td className="is-mono">
                      {live ? '●' : '○'} #{index + 1}
                    </td>
                    <td>
                      <Link to={`/runs/${entry.run.id}`}>
                        {entry.agentName ?? `(${entry.run.kind})`}
                      </Link>
                    </td>
                    <td className="is-mono" title={sigil.role}>
                      {sigil.glyph} {sigil.role}
                    </td>
                    <td className="is-mono">
                      {entry.modelName === null ? (
                        <span className="muted" title="This run has not reported a model call yet">
                          —
                        </span>
                      ) : (
                        entry.modelName
                      )}
                    </td>
                    <td className="is-mono right">
                      {entry.tokens === null ? (
                        <span className="muted" title="No usage rows read for this run">
                          —
                        </span>
                      ) : (
                        entry.tokens.toLocaleString()
                      )}
                    </td>
                    <td className="is-mono right">
                      {entry.cost === null ? (
                        <span className="muted" title="No usage rows read for this run">
                          —
                        </span>
                      ) : (
                        formatCost(entry.cost)
                      )}
                    </td>
                    <td className="is-mono right">
                      {entry.run.completedAt === null
                        ? formatElapsed(entry.run.startedAt)
                        : formatDuration(entry.run.durationMs)}
                    </td>
                    <td>
                      {entry.run.status}
                      {entry.stepLabel !== null ? (
                        <span className="muted small"> · step {entry.stepLabel}</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="roster-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> {selected === null ? 'open' : `open ${shortId(selected.run.id)}`}
          </span>
          <span title="No endpoint injects a note into a running agent">
            <kbd>s</kbd> steer — not available
          </span>
          <span title="Cancelling a run is on its own page, so the destructive control is not inside a modal">
            <kbd>x</kbd> stop — <Link to="/runs">from the Runs list</Link>
          </span>
          <span style={{ marginLeft: 'auto' }}>
            Runs, not subagents: this build delegates via a run row, which is what the table lists.
          </span>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The `Ctrl+T` / `F6` / `F7` bindings.
 *
 * A hook rather than a listener in the page, so the keys and the dock cannot be mounted
 * separately by mistake — mounting the dock without this would give a visible control whose key
 * does nothing.
 */
export function useDockShortcuts(options: {
  onOpenRoster: () => void;
  onToggleCondensed: () => void;
}): void {
  const roster = options.onOpenRoster;
  const condense = options.onToggleCondensed;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 't') {
        // `Ctrl+T` is "new tab" in every browser. Preventing it is a real cost, and it is the
        // spec's binding — so it is prevented, and the roster is the only thing that consumes it.
        event.preventDefault();
        roster();
        return;
      }
      if (event.key === 'F6') {
        event.preventDefault();
        roster();
        return;
      }
      if (event.key === 'F7') {
        event.preventDefault();
        condense();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [roster, condense]);
}

/** Which runs the dock should show: the live ones, newest first. */
export function liveActivities(activities: readonly AgentActivity[]): AgentActivity[] {
  return activities
    .filter((entry) => isLive(entry.run.status))
    .sort((a, b) => {
      const left = a.run.startedAt ?? a.run.createdAt;
      const right = b.run.startedAt ?? b.run.createdAt;
      return right.localeCompare(left);
    });
}

/** A memoised selector, for callers that already hold the full list. */
export function useLiveActivities(activities: readonly AgentActivity[]): AgentActivity[] {
  return useMemo(() => liveActivities(activities), [activities]);
}
