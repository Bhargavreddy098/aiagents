/**
 * The Decision Inbox — §4-PHASE13.8.
 *
 * *"risk badges; detail drawer (action JSON, permissions, reason, expiry countdown);
 * Approve/Reject with optimistic update + SSE confirm."*
 *
 * ## Why the decision is optimistic, and why that is safe here
 *
 * Approving is a two-party handshake: the row is decided, and then the run that was parked
 * on it moves. Making the operator wait for both would leave the button spinning through a
 * round trip for an answer the server is going to give — the decision is not in doubt, only
 * the run's next step is.
 *
 * So the row settles immediately and rolls back if the request fails. The "SSE confirm" the
 * spec asks for is not a second mechanism bolted on: `approval.resolved` invalidates
 * `['approvals']` and `['runs']`, so the server's own version of the row replaces the
 * optimistic one a moment later. If the two ever disagreed, the server wins — which is the
 * property that makes optimism acceptable rather than a lie.
 *
 * ## The countdown
 *
 * `isExpired` is computed server-side as of the response, and the drawer shows a live
 * countdown from `expiresAt`. Those can disagree for up to a second, and the countdown is
 * the one that is right at the moment you look at it — but the *button* follows `isExpired`,
 * because offering an Approve that the server will refuse is worse than a stale label.
 *
 * ## Two vocabularies, and the page has to know which (§4.4)
 *
 * A **tool** approval takes `approved`/`rejected` through `POST /approvals/:id/decide`. An
 * **exec** approval takes `allow_once`/`allow_always`/`deny` through
 * `POST /approvals/:id/decide-exec`, because `allow_always` writes a standing allowlist rule —
 * a different write with a different shape. Sending the wrong vocabulary is a 400, and the
 * service's own error says so in a sentence.
 *
 * So the split is by the approval's own `requiredPermissions` (there is no `kind` column on the
 * wire — see `exec-queries.ts`), and it decides **which modal opens**: the drawer for a tool
 * approval, the §6.2 overlay for an exec one. That is not decoration. The overlay is the
 * surface that offers "Allow always", and offering it on a tool approval would be offering a
 * capability the endpoint refuses.
 *
 * ## The allowlist is shown here because this is where it is written
 *
 * `GET /approvals/exec/rules` is the standing-permission list, and an operator who has just
 * granted one needs to be able to see it, and revoke it, without leaving the inbox. The panel
 * is below the table rather than on its own page for that reason.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type {
  ApprovalDecision,
  ApprovalSummary,
  ExecDecisionOption,
  RiskLevel,
} from '@nexs/shared';
import {
  Badge,
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorBox,
  Loading,
  PageHead,
  QueryBoundary,
  StatusBadge,
  Tabs,
} from '../../components/ui';
import { ApprovalOverlay } from '../../components/terminal/Overlays';
import { EM_DASH, EXPIRED_COUNTDOWN, formatCountdown, formatDateTime, formatRelative, shortId } from '../../lib/format';
import { queryKeys } from '../../lib/query-keys';
import { useApproval, useApprovals, useDecideApproval } from './queries';
import {
  isExecApproval,
  splitApprovalsByKind,
  useDecideExecApproval,
  useExecRules,
  useRevokeExecRule,
} from './exec-queries';

interface ApprovalListCache {
  approvals: ApprovalSummary[];
  pendingCount: number;
}

function riskTone(level: RiskLevel): 'ok' | 'waiting' | 'failed' {
  if (level === 'high') return 'failed';
  if (level === 'medium') return 'waiting';
  return 'ok';
}

/** Re-render on an interval, so the countdown actually counts. */
function useTick(active: boolean, ms = 1000): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setTick((value) => value + 1), ms);
    return () => window.clearInterval(timer);
  }, [active, ms]);
}

/**
 * The deadline as a sentence.
 *
 * `formatCountdown` answers with the *word* `expired` once the deadline has passed, so the
 * `in ` prefix is only correct when there is a duration after it — the naive version printed
 * "in expired (lapsed)". The `(lapsed)` note stays, because a countdown that has run out while
 * the row is still `pending` is a different fact from a countdown that is still running.
 */
function deadlineLabel(expiresAt: string, isPending: boolean, isExpired: boolean): string {
  if (!isPending) return formatDateTime(expiresAt);
  const countdown = formatCountdown(expiresAt);
  const phrase = countdown === EXPIRED_COUNTDOWN ? EXPIRED_COUNTDOWN : `in ${countdown}`;
  return isExpired ? `${phrase} (lapsed)` : phrase;
}

function DecisionDrawer({
  approvalId,
  onClose,
}: {
  approvalId: string;
  onClose: () => void;
}): ReactNode {
  const query = useApproval(approvalId);
  const decide = useDecideApproval();
  const client = useQueryClient();

  const approval = query.data;
  // Only ticks while there is something to count down to and a decision still to make.
  useTick(approval !== undefined && approval.status === 'pending' && approval.expiresAt !== null);

  const onDecide = async (decision: ApprovalDecision): Promise<void> => {
    if (approval === undefined) return;

    const previous = client.getQueryData<ApprovalListCache>(queryKeys.approvals.all);
    if (previous !== undefined) {
      client.setQueryData<ApprovalListCache>(queryKeys.approvals.all, {
        approvals: previous.approvals.map((row) =>
          row.id === approval.id ? { ...row, status: decision, isExpired: false } : row,
        ),
        // The count only moves when the row it counted was actually pending.
        pendingCount:
          approval.status === 'pending' ? Math.max(0, previous.pendingCount - 1) : previous.pendingCount,
      });
    }

    try {
      await decide.mutateAsync({ id: approval.id, decision });
      onClose();
    } catch {
      // Roll back to the row the server still believes in. `decide.mutateAsync` rethrows, so
      // the caller sees the failure too — the rollback is not a substitute for reporting it.
      if (previous !== undefined) {
        client.setQueryData(queryKeys.approvals.all, previous);
      }
    }
  };

  return (
    <Drawer
      title={
        approval === undefined ? (
          'Approval'
        ) : (
          <span className="row" style={{ gap: 6 }}>
            <Badge tone={riskTone(approval.risk.level)}>{approval.risk.level} risk</Badge>
            <StatusBadge status={approval.status} />
          </span>
        )
      }
      onClose={onClose}
      footer={
        approval === undefined || approval.status !== 'pending' ? (
          <span className="muted small">
            {approval === undefined ? '' : 'This decision has already been made.'}
          </span>
        ) : (
          <>
            <Button
              variant="danger"
              disabled={decide.isPending || approval.isExpired}
              onClick={() => void onDecide('rejected')}
            >
              Reject
            </Button>
            <Button
              variant="primary"
              disabled={decide.isPending || approval.isExpired}
              onClick={() => void onDecide('approved')}
            >
              Approve
            </Button>
          </>
        )
      }
    >
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorBox message="Could not load this approval." />
      ) : (
        <div className="stack">
          <div className="stack-sm">
            <h2>{query.data.title}</h2>
            {query.data.description !== null ? (
              <p className="muted small">{query.data.description}</p>
            ) : null}
          </div>

          {decide.isError ? (
            <ErrorBox
              message={
                decide.error instanceof Error ? decide.error.message : 'The decision failed.'
              }
            />
          ) : null}

          <Card title="Why this needs a decision">
            <ul className="stack-sm" style={{ margin: 0, paddingLeft: 18 }}>
              {query.data.risk.reasons.length === 0 ? (
                <li className="muted small">The engine recorded no specific reason.</li>
              ) : (
                query.data.risk.reasons.map((reason) => (
                  <li key={reason} className="small">
                    {reason}
                  </li>
                ))
              )}
            </ul>
          </Card>

          <Card title="Permissions requested">
            {query.data.requiredPermissions.length === 0 ? (
              <span className="muted small">None declared.</span>
            ) : (
              <div className="row-wrap">
                {query.data.requiredPermissions.map((permission) => (
                  <Badge key={permission}>{permission}</Badge>
                ))}
              </div>
            )}
          </Card>

          <Card title="Action">
            <pre className="code">{JSON.stringify(query.data.requestedAction, null, 2)}</pre>
          </Card>

          <Card title="Context">
            <dl className="kv">
              <dt>Expires</dt>
              <dd>
                {query.data.expiresAt === null
                  ? 'never'
                  : deadlineLabel(
                      query.data.expiresAt,
                      query.data.status === 'pending',
                      query.data.isExpired,
                    )}
              </dd>
              <dt>Created</dt>
              <dd>{formatDateTime(query.data.createdAt)}</dd>
              <dt>Decided by</dt>
              <dd>{query.data.decidedBy ?? EM_DASH}</dd>
              <dt>Decided at</dt>
              <dd>{formatDateTime(query.data.decidedAt)}</dd>
              <dt>Action</dt>
              <dd>
                {query.data.action.title}{' '}
                <span className="muted small">
                  ({query.data.action.kind}, {query.data.action.status})
                </span>
              </dd>
              <dt>Run</dt>
              <dd>
                {query.data.run === null ? (
                  EM_DASH
                ) : (
                  <Link to={`/runs/${query.data.run.id}`}>
                    {shortId(query.data.run.id)} · {query.data.run.status}
                  </Link>
                )}
              </dd>
            </dl>
          </Card>
        </div>
      )}
    </Drawer>
  );
}

export function ApprovalsPage(): ReactNode {
  const query = useApprovals();
  const [tab, setTab] = useState('actionable');
  const [openId, setOpenId] = useState<string | null>(null);
  /** Which approval the §6.2 overlay is open on. Only ever an exec one. */
  const [overlayId, setOverlayId] = useState<string | null>(null);

  const client = useQueryClient();
  const decideExec = useDecideExecApproval();
  const overlayDetail = useApproval(overlayId ?? '');
  const rules = useExecRules({ includeInactive: false });

  // The overlay shows an `ApprovalDetail`, so it renders from its own read rather than from the
  // list row: the list carries no `requestedAction`, and the command is the whole point of the
  // panel. Nothing is shown until that read lands, which is why `approval` is `null` while it is
  // in flight — the overlay's own "closed" state, so it cannot flash an empty box.
  const overlayApproval = overlayId === null ? null : (overlayDetail.data ?? null);

  // The rule that already covers this command, so the panel can say "already permitted — the
  // engine is asking because the arguments changed" rather than implying nothing was granted.
  const matchingRule = useMemo(() => {
    if (overlayApproval === null) return null;
    const action = overlayApproval.requestedAction;
    if (typeof action !== 'object' || action === null) return null;
    const command = (action as { command?: unknown }).command;
    if (typeof command !== 'string') return null;
    return (
      (rules.data ?? []).find((rule) => rule.isActive && rule.command === command) ?? null
    );
  }, [overlayApproval, rules.data]);

  /** The same optimistic settle the drawer does, applied from the overlay. */
  async function decideFromOverlay(decision: ExecDecisionOption): Promise<void> {
    if (overlayApproval === null) return;
    const previous = client.getQueryData<ApprovalListCache>(queryKeys.approvals.all);
    if (previous !== undefined) {
      client.setQueryData<ApprovalListCache>(queryKeys.approvals.all, {
        approvals: previous.approvals.map((row) =>
          row.id === overlayApproval.id
            ? { ...row, status: decision === 'deny' ? 'rejected' : 'approved', isExpired: false }
            : row,
        ),
        pendingCount:
          overlayApproval.status === 'pending'
            ? Math.max(0, previous.pendingCount - 1)
            : previous.pendingCount,
      });
    }

    try {
      await decideExec.mutateAsync({ id: overlayApproval.id, decision });
      setOverlayId(null);
    } catch {
      if (previous !== undefined) client.setQueryData(queryKeys.approvals.all, previous);
    }
  }

  return (
    <>
      <PageHead
        title="Decision Inbox"
        subtitle="Runs parked on a decision only you can make."
        actions={
          query.data !== undefined ? (
            <Badge tone={query.data.pendingCount > 0 ? 'waiting' : 'ok'}>
              {query.data.pendingCount} pending
            </Badge>
          ) : null
        }
      />

      <QueryBoundary query={query} loadingLabel="Loading approvals…">
        {(data) => {
          const rows =
            tab === 'actionable'
              ? data.approvals.filter((row) => row.status === 'pending' && !row.isExpired)
              : data.approvals;

          const split = splitApprovalsByKind(data.approvals);

          return (
            <>
              <Tabs
                tabs={[
                  { id: 'actionable', label: 'Waiting on you' },
                  { id: 'all', label: 'All', badge: <Badge>{data.approvals.length}</Badge> },
                ]}
                active={tab}
                onChange={setTab}
              />

              {split.exec.length > 0 ? (
                <p className="muted small" style={{ marginTop: 10 }}>
                  {split.exec.length} of these ask to run a command and take three answers —
                  allow once, allow always, or deny. Opening one shows that panel.
                </p>
              ) : null}

              <div style={{ marginTop: 16 }}>
                <Card flush>
                  {rows.length === 0 ? (
                    <EmptyState
                      title={tab === 'actionable' ? 'Nothing waiting' : 'No approvals recorded'}
                      hint={
                        tab === 'actionable'
                          ? 'When a step needs a decision it appears here, and the run waits.'
                          : undefined
                      }
                    />
                  ) : (
                    <table className="table table-clickable">
                      <thead>
                        <tr>
                          <th>Title</th>
                          <th>Kind</th>
                          <th>Risk</th>
                          <th>Status</th>
                          <th>Permissions</th>
                          <th>Expires</th>
                          <th>Created</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((approval) => {
                          const exec = isExecApproval(approval);
                          return (
                            <tr
                              key={approval.id}
                              onClick={() =>
                                // The two answers are different, so the two surfaces are.
                                exec ? setOverlayId(approval.id) : setOpenId(approval.id)
                              }
                              tabIndex={0}
                              onKeyDown={(event) => {
                                if (event.key !== 'Enter') return;
                                if (exec) setOverlayId(approval.id);
                                else setOpenId(approval.id);
                              }}
                            >
                              <td>
                                <div className="truncate">{approval.title}</div>
                                {approval.runId !== null ? (
                                  <div className="muted small mono">
                                    run {shortId(approval.runId)}
                                  </div>
                                ) : null}
                              </td>
                              <td>
                                <Badge tone={exec ? 'waiting' : 'neutral'}>
                                  {exec ? 'command' : 'tool'}
                                </Badge>
                              </td>
                              <td>
                                <Badge tone={riskTone(approval.risk.level)}>
                                  {approval.risk.level}
                                </Badge>
                              </td>
                              <td>
                                <StatusBadge status={approval.isExpired ? 'expired' : approval.status} />
                              </td>
                              <td className="muted small truncate">
                                {approval.requiredPermissions.length === 0
                                  ? EM_DASH
                                  : approval.requiredPermissions.join(', ')}
                              </td>
                              <td className="small nowrap">
                                {approval.expiresAt === null
                                  ? EM_DASH
                                  : approval.status === 'pending'
                                    ? formatCountdown(approval.expiresAt)
                                    : formatDateTime(approval.expiresAt)}
                              </td>
                              <td
                                className="muted small nowrap"
                                title={formatDateTime(approval.createdAt)}
                              >
                                {formatRelative(approval.createdAt)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </Card>
              </div>

              {/* §4.4 — the standing permissions this page writes. */}
              <div style={{ marginTop: 16 }}>
                <ExecRulePanel />
              </div>
            </>
          );
        }}
      </QueryBoundary>

      {openId !== null ? (
        <DecisionDrawer approvalId={openId} onClose={() => setOpenId(null)} />
      ) : null}

      {/* §6.2 — the command panel. Closed by a `null` id, so no state has to agree about `open`. */}
      <ApprovalOverlay
        approval={overlayApproval}
        matchingRule={matchingRule}
        busy={decideExec.isPending}
        error={
          decideExec.isError
            ? decideExec.error instanceof Error
              ? decideExec.error.message
              : 'The decision failed.'
            : null
        }
        onDecideTool={() => {
          // Unreachable: the overlay only opens for an exec approval, and it picks its own
          // vocabulary from the row. Closing is the honest no-op rather than a silent approve.
          setOverlayId(null);
        }}
        onDecideExec={(decision) => {
          void decideFromOverlay(decision);
        }}
        onClose={() => setOverlayId(null)}
      />
    </>
  );
}

/**
 * The exec allowlist (§4.4).
 *
 * ## Why this is on the inbox page
 *
 * `allow_always` is one of this page's three answers, and it writes a row here. An operator who
 * has just granted a standing permission has to be able to see it — otherwise the only way to
 * learn what they allowed is to hit the same wall again.
 *
 * ## Revoke is a POST, not a DELETE
 *
 * `POST /approvals/exec/rules/:id/revoke` rather than `DELETE …/:id`, because the row is not
 * deleted: `revokedAt` is stamped and `isActive` flips, so the history of what was allowed stays
 * readable. The button says "Revoke" for that reason, not "Delete".
 *
 * ## The panel says what it cannot show
 *
 * The rule's `lastUsedAt` is `null` until the engine consults it, and an inactive rule is not
 * listed at all here — so a granted permission that has since been revoked disappears rather
 * than showing as struck through. That is stated instead of left as a puzzle.
 */
function ExecRulePanel(): ReactNode {
  const rules = useExecRules({ includeInactive: false });
  const revoke = useRevokeExecRule();
  const rows = rules.data ?? [];

  return (
    <Card
      title="Standing command permissions"
      actions={<Badge tone={rows.length > 0 ? 'ok' : 'neutral'}>{rows.length} active</Badge>}
    >
      {rules.isPending ? (
        <Loading label="Loading rules…" />
      ) : rules.isError ? (
        <ErrorBox message="Could not read the allowlist." />
      ) : rows.length === 0 ? (
        <p className="muted small">
          Nothing has been allowed permanently. Every risky command will come back here. Revoked
          rules are not listed — the history stays in the database but has no surface yet.
        </p>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Command</th>
                <th>Directory</th>
                <th>Agent</th>
                <th>Expires</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((rule) => (
                <tr key={rule.id}>
                  <td className="mono small truncate">
                    {rule.command}
                    {rule.args.length > 0 ? ` ${rule.args.join(' ')}` : ''}
                  </td>
                  <td className="mono small truncate">{rule.cwd}</td>
                  <td className="muted small mono truncate">
                    {rule.agentId === null ? EM_DASH : shortId(rule.agentId)}
                  </td>
                  <td className="small nowrap">
                    {rule.expiresAt === null ? 'never' : formatDateTime(rule.expiresAt)}
                  </td>
                  <td className="small nowrap">
                    {rule.lastUsedAt === null ? (
                      <span className="muted" title="The engine has not needed it yet">
                        never used
                      </span>
                    ) : (
                      formatRelative(rule.lastUsedAt)
                    )}
                  </td>
                  <td>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={revoke.isPending}
                      onClick={() => revoke.mutate(rule.id)}
                      title="Stamp this rule revoked — the history is kept"
                    >
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {revoke.isError ? (
            <p className="field-error">The rule could not be revoked.</p>
          ) : null}
        </>
      )}
    </Card>
  );
}
