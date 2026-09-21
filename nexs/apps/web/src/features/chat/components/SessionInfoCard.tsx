/**
 * Everything about the conversation that is not the conversation.
 *
 * ## Why these three moved off the page
 *
 * The chat surface carried, under the transcript: a startup banner above it, a subagent dock and
 * a status bar below it. All three are *about* the turn rather than *being* it, and together
 * they were most of what a reader saw when they opened a conversation — a box of system-prompt
 * sections, a row of activity, and a bar of seven cells, around an answer that was two lines
 * long.
 *
 * ChatGPT and Hermes both answer this the same way: the surface is the header, the messages and
 * the composer, and everything else is one click behind a control in the header. That is what
 * this card is. Nothing was dropped and no number was removed — `StartupBanner`, `StatusBar` and
 * `SubagentDock` are the same components with the same data, in a card instead of in the way.
 *
 * ## Why the real components rather than a summary
 *
 * A hand-written summary of the status bar would be a second place for its honesty labels to
 * live — the `~` on a derived figure, the "not recorded" cells, the tooltip that says a duration
 * was measured on the wire rather than by the tool. Reusing the components is what keeps this
 * card from becoming a version of the truth that drifts from the one on `/runs`.
 */

import { useEffect, type ReactNode } from 'react';
import type { ModelSummary } from '@nexs/shared';
import { Button, Modal } from '../../../components/ui';
import { StartupBanner } from '../../../components/terminal/StartupBanner';
import { StatusBar } from '../../../components/terminal/StatusBar';
import type { SessionMetrics } from '../../../lib/session-metrics';
import type { ContextReading } from '../../../lib/context';

export interface SessionInfoCardProps {
  open: boolean;
  onClose: () => void;
  /** The workspace name for the banner's header chip. */
  workspace: string;
  /** The session's own agent. `null` for an ad-hoc conversation. */
  agentId: string | null;
  /** The session title, for the status bar's badge. */
  title: string | null;
  /** The model the conversation runs on, when one is known. */
  model: Pick<ModelSummary, 'name' | 'contextWindow' | 'externalModelId'> | null;
  metrics: SessionMetrics;
  context: ContextReading | null;
  approximate: boolean;
  contextNote: string;
  stashCount: number;
  /** Opens §9.3's context grid, which is mounted on the page behind this card. */
  onOpenContext: () => void;
  /** The in-flight turn's run, so the card can link to the page where its steps live. */
  runId: string | null;
  onOpenRun: (runId: string) => void;
}

export function SessionInfoCard({
  open,
  onClose,
  workspace,
  agentId,
  title,
  model,
  metrics,
  context,
  approximate,
  contextNote,
  stashCount,
  onOpenContext,
  runId,
  onOpenRun,
}: SessionInfoCardProps): ReactNode {
  /**
   * Escape closes it, attached only while open.
   *
   * `Modal` draws the scrim and the dialog and owns no keyboard handling. A card that traps
   * focus with no way out but the ✕ is the overlay people learn to avoid.
   */
  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <Modal title="This conversation" onClose={onClose}>
      <div className="session-card">
        <p className="session-card-lead">
          What the next message will run as, and what this one has cost so far. Every figure below
          is read from a row — none of it is estimated.
        </p>

        {runId === null ? null : (
          <div className="session-card-run">
            <span className="label">Turn in flight</span>
            <Button size="sm" onClick={() => onOpenRun(runId)}>
              Open run
            </Button>
          </div>
        )}

        {/* §3.1 — the startup banner. The agent is the session's own, never a picked one. */}
        <StartupBanner workspace={workspace} agentId={agentId} />

        {/* §3.2 — the status bar. It used to be the last element on the page, permanently, under
            every conversation. It is the same component with the same data; what changed is that
            it is no longer the thing between the answer and the composer. */}
        <StatusBar
          model={model}
          metrics={metrics}
          context={context}
          approximate={approximate}
          contextNote={contextNote}
          title={title}
          stashCount={stashCount}
          onOpenContext={() => {
            // The grid is a modal of its own, and two stacked dialogs is one too many — so this
            // closes the card first. The reader asked for the breakdown, not for both.
            onClose();
            onOpenContext();
          }}
        />
      </div>
    </Modal>
  );
}
