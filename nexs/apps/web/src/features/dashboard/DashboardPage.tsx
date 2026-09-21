/**
 * The dashboard.
 *
 * §4-PHASE12.3 is explicit that this page must show **"zero hard-coded numbers"**. Every
 * figure below is read from `DashboardSummary`, including the ones that would be tempting to
 * write down: the failure window's label comes from `failures.days` (not a literal `7`), the
 * unread count comes from the payload, and each tile is a `count()` the service ran.
 *
 * The consequence is that a tile reading `0` is a real zero, and it is styled muted rather
 * than hidden — a real zero and a missing read must not look the same, and hiding it would
 * make them look the same.
 *
 * The page does not poll. `useDashboard` is invalidated by the SSE map on every `run.*`,
 * `step.*`, `approval.*` and `schedule.*` frame, so it refreshes when something changes
 * rather than every N seconds regardless.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Card,
  EmptyState,
  PageHead,
  ProgressBar,
  QueryBoundary,
  Stat,
  StatusBadge,
  Dot,
  Badge,
} from '../../components/ui';
import { formatRelative, formatNumber, inlineJson, shortId } from '../../lib/format';
import { toneFor } from '../../lib/status';
import { useDashboard } from './queries';

export function DashboardPage(): ReactNode {
  const query = useDashboard();

  return (
    <>
      <PageHead
        title="Dashboard"
        subtitle={
          query.data === undefined
            ? 'Live workspace state.'
            : `Snapshot taken ${formatRelative(query.data.generatedAt)}.`
        }
      />

      <QueryBoundary query={query} loadingLabel="Reading the workspace…">
        {(data) => (
          <div className="stack" style={{ gap: 16 }}>
            <div className="grid-4">
              <Stat
                label="Agents active"
                value={data.counts.agentsActive}
                hint={`${formatNumber(data.counts.agentsTotal)} in the workspace`}
              />
              <Stat label="Goals active" value={data.counts.goalsActive} />
              <Stat label="Tasks running" value={data.counts.tasksRunning} />
              <Stat
                label="Runs in flight"
                value={data.counts.runsActive}
                hint="Planning, running or awaiting approval"
              />
              <Stat label="Workflows active" value={data.counts.workflowsActive} />
              <Stat
                label="Approvals pending"
                value={data.counts.approvalsPending}
                hint={
                  data.counts.approvalsPending > 0 ? (
                    <Link to="/approvals">Open the inbox</Link>
                  ) : (
                    'Nothing waiting'
                  )
                }
              />
              <Stat
                label="Unread notifications"
                value={data.unreadNotifications}
                hint="Addressed to you"
              />
              <Stat
                label={`Failures · ${data.failures.days}d`}
                value={data.failures.count}
                hint={`Since ${formatRelative(data.failures.since)}`}
              />
            </div>

            <div className="grid-2">
              <Card
                title="Recent runs"
                actions={
                  <Link className="small" to="/runs">
                    All runs
                  </Link>
                }
                flush
              >
                {data.recentRuns.length === 0 ? (
                  <EmptyState title="No runs yet" hint="Start one from an agent." />
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Kind</th>
                        <th>Status</th>
                        <th>Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentRuns.map((run) => (
                        <tr key={run.id}>
                          <td>
                            <Link className="mono" to={`/runs/${run.id}`} title={run.id}>
                              {shortId(run.id)}
                            </Link>
                            {run.error !== null ? (
                              <div className="small" style={{ color: 'var(--status-failed)' }}>
                                {run.error}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            <Badge tone="accent">{run.kind}</Badge>
                          </td>
                          <td>
                            <StatusBadge status={run.status} />
                          </td>
                          <td className="muted small nowrap" title={run.createdAt}>
                            {formatRelative(run.startedAt ?? run.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>

              <Card title="Recent agent activity" flush>
                {data.recentActivity.length === 0 ? (
                  <EmptyState title="No steps recorded yet" />
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Step</th>
                        <th>Type</th>
                        <th>Status</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentActivity.map((step) => (
                        <tr key={step.stepId}>
                          <td>
                            <Link to={`/runs/${step.runId}`} className="truncate">
                              <span className="muted mono small">{step.seq}</span> {step.name}
                            </Link>
                          </td>
                          <td>
                            <Badge>{step.type}</Badge>
                          </td>
                          <td>
                            <StatusBadge status={step.status} />
                          </td>
                          <td className="muted small nowrap" title={step.startedAt ?? ''}>
                            {formatRelative(step.completedAt ?? step.startedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>

            <div className="grid-3">
              <Card title="Provider health" flush>
                {data.providerHealth.length === 0 ? (
                  <EmptyState title="No providers configured" />
                ) : (
                  <table className="table">
                    <tbody>
                      {data.providerHealth.map((provider) => (
                        <tr key={provider.providerId}>
                          <td>
                            <Dot tone={toneFor(provider.status)} title={provider.status} />{' '}
                            {provider.name}
                          </td>
                          <td className="muted small">{provider.type}</td>
                          <td className="muted small nowrap">
                            {provider.lastHealthCheck === null
                              ? 'never checked'
                              : formatRelative(provider.lastHealthCheck)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>

              <Card title="Connected services" flush>
                {data.connectedServices.length === 0 ? (
                  <EmptyState
                    title="None connected"
                    hint="MCP servers appear here once they connect."
                  />
                ) : (
                  <table className="table">
                    <tbody>
                      {data.connectedServices.map((service) => (
                        <tr key={service.id}>
                          <td>
                            <Dot tone={toneFor(service.status)} title={service.status} />{' '}
                            {service.name}
                          </td>
                          <td>
                            <Badge>{service.kind}</Badge>
                          </td>
                          <td className="muted small nowrap">
                            {formatNumber(service.toolCount)} tools
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>

              <Card title="Next schedules" flush>
                {data.upcomingSchedules.length === 0 ? (
                  <EmptyState title="Nothing scheduled" />
                ) : (
                  <table className="table">
                    <tbody>
                      {data.upcomingSchedules.map((schedule) => (
                        <tr key={schedule.id}>
                          <td className="truncate">{schedule.name}</td>
                          <td className="muted small nowrap">
                            {schedule.cron ?? 'one-off'}
                          </td>
                          <td className="small nowrap" title={schedule.nextFireAt}>
                            {formatRelative(schedule.nextFireAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>

            <div className="grid-2">
              <Card title="Verifications">
                {data.verifications.total === 0 ? (
                  <EmptyState title="No verifications recorded" />
                ) : (
                  <div className="stack-sm">
                    <ProgressBar
                      done={data.verifications.passed}
                      total={data.verifications.total}
                    />
                    <div className="row-wrap small">
                      <Badge tone="ok">{data.verifications.passed} passed</Badge>
                      <Badge tone="failed">{data.verifications.failed} failed</Badge>
                      <Badge tone="waiting">{data.verifications.pending} pending</Badge>
                      <span className="muted">
                        of {formatNumber(data.verifications.total)} recorded
                      </span>
                    </div>
                  </div>
                )}
              </Card>

              <Card title="Recent execution receipts" flush>
                {data.recentReceipts.length === 0 ? (
                  <EmptyState
                    title="No receipts yet"
                    hint="A receipt is written for every side-effecting tool call."
                  />
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Tool</th>
                        <th>Effect</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentReceipts.map((receipt) => (
                        <tr key={receipt.id}>
                          <td>
                            {receipt.runId === null ? (
                              <span className="muted">{receipt.toolName ?? 'unknown tool'}</span>
                            ) : (
                              <Link to={`/runs/${receipt.runId}`}>
                                {receipt.toolName ?? 'unknown tool'}
                              </Link>
                            )}
                          </td>
                          <td className="mono small truncate">{inlineJson(receipt.effect, 48)}</td>
                          <td className="muted small nowrap" title={receipt.createdAt}>
                            {formatRelative(receipt.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>
          </div>
        )}
      </QueryBoundary>
    </>
  );
}
