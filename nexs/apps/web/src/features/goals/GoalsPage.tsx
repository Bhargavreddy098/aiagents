/**
 * Goals — §4-PHASE13.4: *"active/history; success criteria with per-criterion verification
 * state; progress (tasks completed/total); linked runs; evidence panel."*
 *
 * "Active/history" is not a server filter here — `listGoalsSchema` takes a `status`, and the
 * two tabs are sets of statuses, so the filter is applied over the one fetched list. That
 * keeps the tab counts honest: a tab labelled "History (4)" is counting the rows it will
 * show, not a number from a second request.
 */

import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { RunSummary, TaskSummary } from '@nexs/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Card,
  Code,
  EmptyState,
  ErrorState,
  KeyValue,
  Loading,
  PageHead,
  ProgressBar,
  QueryBoundary,
  StatusBadge,
  Tabs,
} from '../../components/ui';
import { api, apiOf, qs } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import {
  EM_DASH,
  formatDateTime,
  formatRelative,
  formatSpan,
  prettyJson,
  shortId,
} from '../../lib/format';
import { isTerminalGoalStatus } from '@nexs/shared';
import { useGoal, useGoalAction, useGoalVerifications, useGoals } from './queries';

const ACTIVE_STATUSES = new Set(['draft', 'active', 'paused', 'blocked']);

export function GoalsPage(): ReactNode {
  const [tab, setTab] = useState('active');
  const query = useGoals();

  return (
    <>
      <PageHead
        title="Goals"
        subtitle="An outcome with criteria that must be verified before it can complete."
      />

      <QueryBoundary query={query} loadingLabel="Loading goals…">
        {(goals) => {
          const active = goals.filter((goal) => ACTIVE_STATUSES.has(goal.status));
          const history = goals.filter((goal) => !ACTIVE_STATUSES.has(goal.status));
          const rows = tab === 'active' ? active : history;

          return (
            <>
              <Tabs
                tabs={[
                  { id: 'active', label: 'Active', badge: <Badge>{active.length}</Badge> },
                  { id: 'history', label: 'History', badge: <Badge>{history.length}</Badge> },
                ]}
                active={tab}
                onChange={setTab}
              />

              <div style={{ marginTop: 16 }}>
                <Card flush>
                  {rows.length === 0 ? (
                    <EmptyState
                      title={tab === 'active' ? 'No active goals' : 'No finished goals'}
                    />
                  ) : (
                    <table className="table table-clickable">
                      <thead>
                        <tr>
                          <th>Goal</th>
                          <th>Status</th>
                          <th>Agent</th>
                          <th>Priority</th>
                          <th>Deadline</th>
                          <th>Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((goal) => (
                          <tr key={goal.id}>
                            <td>
                              <Link to={`/goals/${goal.id}`}>{goal.title}</Link>
                              {goal.description !== null ? (
                                <div className="muted small truncate">{goal.description}</div>
                              ) : null}
                            </td>
                            <td>
                              <StatusBadge status={goal.status} />
                            </td>
                            <td className="mono small">
                              {goal.agentId === null ? (
                                EM_DASH
                              ) : (
                                <Link to={`/agents/${goal.agentId}`}>
                                  {shortId(goal.agentId)}
                                </Link>
                              )}
                            </td>
                            <td className="muted small">{goal.priority}</td>
                            <td className="muted small nowrap">{formatDateTime(goal.deadline)}</td>
                            <td className="muted small nowrap" title={goal.updatedAt}>
                              {formatRelative(goal.updatedAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}

interface CriterionView {
  type: string;
  description?: string;
  config?: unknown;
}

function readCriteria(value: unknown): CriterionView[] {
  if (!Array.isArray(value)) return [];
  const out: CriterionView[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const candidate = entry as Partial<CriterionView>;
    if (typeof candidate.type !== 'string') continue;
    out.push({
      type: candidate.type,
      ...(candidate.description !== undefined ? { description: candidate.description } : {}),
      ...(candidate.config !== undefined ? { config: candidate.config } : {}),
    });
  }
  return out;
}

export function GoalDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const goalId = id ?? '';
  const [tab, setTab] = useState('criteria');

  const query = useGoal(goalId);
  const verifications = useGoalVerifications(goalId, query.data !== undefined);

  const tasks = useQuery({
    queryKey: [...queryKeys.tasks.all, { goalId }] as const,
    queryFn: () => apiOf<TaskSummary[]>(`/tasks${qs({ goalId })}`, 'tasks'),
    enabled: goalId !== '',
  });

  const runs = useQuery({
    queryKey: [...queryKeys.runs.all, { goalId }] as const,
    queryFn: () => api<{ runs: RunSummary[]; total: number }>(`/runs${qs({ goalId })}`),
    enabled: goalId !== '',
  });

  const pause = useGoalAction('pause');
  const resume = useGoalAction('resume');

  if (query.isPending) return <Loading label="Loading goal…" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const goal = query.data;
  const criteria = readCriteria(goal.criteria);

  // Progress is computed from the task rows themselves, not from `counts.tasks` — a count of
  // tasks is not a count of *finished* tasks, and "3/8" has to be both.
  const taskRows = tasks.data ?? [];
  const completedTasks = taskRows.filter((task) => task.status === 'completed').length;

  const verificationRows = verifications.data ?? [];
  // A criterion is matched to a verification by type, which is the only key both sides share.
  const verifiedTypes = new Set(
    verificationRows.filter((row) => row.verification.passed === true).map((row) => row.verification.type),
  );

  return (
    <>
      <PageHead
        title={
          <span className="row" style={{ gap: 8 }}>
            {goal.title}
            <StatusBadge status={goal.status} />
            {isTerminalGoalStatus(goal.status) ? <Badge>terminal</Badge> : null}
          </span>
        }
        subtitle={goal.description ?? 'No description.'}
        actions={
          <>
            {goal.status === 'active' || goal.status === 'blocked' ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={pause.isPending}
                onClick={() => pause.mutate(goal.id)}
              >
                Pause
              </button>
            ) : null}
            {goal.status === 'paused' ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={resume.isPending}
                onClick={() => resume.mutate(goal.id)}
              >
                Resume
              </button>
            ) : null}
          </>
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Card title="Progress">
          <ProgressBar done={completedTasks} total={taskRows.length} />
          <p className="muted small" style={{ marginTop: 6 }}>
            {completedTasks} of {taskRows.length} tasks completed
          </p>
        </Card>
        <Card title="Verifications">
          <div className="stat-value">{verificationRows.length}</div>
          <p className="muted small">recorded against this goal</p>
        </Card>
        <Card title="Runs">
          <div className="stat-value">{runs.data?.total ?? 0}</div>
          <p className="muted small">linked to this goal</p>
        </Card>
      </div>

      <Tabs
        tabs={[
          {
            id: 'criteria',
            label: 'Success criteria',
            badge: <Badge>{criteria.length}</Badge>,
          },
          { id: 'tasks', label: 'Tasks', badge: <Badge>{taskRows.length}</Badge> },
          { id: 'runs', label: 'Runs', badge: <Badge>{runs.data?.total ?? 0}</Badge> },
          { id: 'evidence', label: 'Evidence', badge: <Badge>{verificationRows.length}</Badge> },
          { id: 'settings', label: 'Constraints' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ marginTop: 16 }} className="stack">
        {tab === 'criteria' ? (
          <Card flush>
            {criteria.length === 0 ? (
              <EmptyState
                title="No criteria declared"
                hint="A goal with no criteria cannot be verified, so it cannot complete."
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Criterion</th>
                    <th>Type</th>
                    <th>Verified</th>
                    <th>Config</th>
                  </tr>
                </thead>
                <tbody>
                  {criteria.map((criterion, index) => (
                    <tr key={`${criterion.type}-${index}`}>
                      <td>{criterion.description ?? criterion.type}</td>
                      <td>
                        <Badge>{criterion.type}</Badge>
                      </td>
                      <td>
                        {verifications.isPending ? (
                          <span className="muted small">checking…</span>
                        ) : verifiedTypes.has(criterion.type) ? (
                          <Badge tone="ok">passed</Badge>
                        ) : (
                          <Badge tone="waiting">unverified</Badge>
                        )}
                      </td>
                      <td className="mono small truncate">
                        {criterion.config === undefined
                          ? EM_DASH
                          : prettyJson(criterion.config)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        ) : null}

        {tab === 'tasks' ? (
          <Card flush>
            <QueryBoundary query={tasks} isEmpty={(rows) => rows.length === 0}>
              {(rows) => (
                <table className="table table-clickable">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Status</th>
                      <th>Trigger</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <Link to={`/tasks/${task.id}`}>{task.title}</Link>
                        </td>
                        <td>
                          <StatusBadge status={task.status} />
                        </td>
                        <td>
                          <Badge>{task.triggerType}</Badge>
                        </td>
                        <td className="muted small nowrap">{formatRelative(task.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </QueryBoundary>
          </Card>
        ) : null}

        {tab === 'runs' ? (
          <Card flush>
            <QueryBoundary query={runs} isEmpty={(data) => data.runs.length === 0}>
              {(data) => (
                <table className="table table-clickable">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Status</th>
                      <th>Kind</th>
                      <th>Duration</th>
                      <th>Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.map((run) => (
                      <tr key={run.id}>
                        <td>
                          <Link className="mono" to={`/runs/${run.id}`}>
                            {shortId(run.id)}
                          </Link>
                        </td>
                        <td>
                          <StatusBadge status={run.status} />
                        </td>
                        <td>
                          <Badge tone="accent">{run.kind}</Badge>
                        </td>
                        <td className="muted small">
                          {formatSpan(run.startedAt, run.completedAt, run.durationMs)}
                        </td>
                        <td className="muted small nowrap">
                          {formatRelative(run.startedAt ?? run.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </QueryBoundary>
          </Card>
        ) : null}

        {tab === 'evidence' ? (
          <div className="stack">
            {verifications.isPending ? (
              <Card>
                <Loading label="Reading the goal's runs for verifications…" />
              </Card>
            ) : verifications.isError ? (
              <Card>
                <ErrorState
                  error={verifications.error}
                  onRetry={() => void verifications.refetch()}
                />
              </Card>
            ) : verificationRows.length === 0 ? (
              <Card>
                <EmptyState
                  title="No verification evidence"
                  hint="A verification row is written when a check is scheduled and completed when it runs."
                />
              </Card>
            ) : (
              verificationRows.map(({ verification, runId }) => (
                <Card
                  key={verification.id}
                  title={
                    <span className="row" style={{ gap: 6 }}>
                      <span>{verification.type}</span>
                      <Badge>{verification.scope}</Badge>
                      <StatusBadge status={verification.status} />
                      {verification.passed === true ? <Badge tone="ok">passed</Badge> : null}
                      {verification.passed === false ? <Badge tone="failed">failed</Badge> : null}
                    </span>
                  }
                  actions={
                    <Link className="small" to={`/runs/${runId}`}>
                      run {shortId(runId)}
                    </Link>
                  }
                >
                  <div className="stack-sm">
                    <Code>{prettyJson(verification.evidence)}</Code>
                    <span className="muted small">
                      Completed {formatDateTime(verification.completedAt)}
                    </span>
                  </div>
                </Card>
              ))
            )}
          </div>
        ) : null}

        {tab === 'settings' ? (
          <div className="grid-2">
            <Card title="Identity">
              <KeyValue
                entries={[
                  ['Id', <span className="mono">{goal.id}</span>],
                  ['Status', <StatusBadge status={goal.status} />],
                  ['Priority', String(goal.priority)],
                  ['Agent', goal.agentId ?? EM_DASH],
                  ['Deadline', formatDateTime(goal.deadline)],
                  ['Created', formatDateTime(goal.createdAt)],
                  ['Completed', formatDateTime(goal.completedAt)],
                  ['Verification', goal.completedVerificationId ?? EM_DASH],
                ]}
              />
            </Card>
            <Card title="Constraints">
              <Code>{prettyJson(goal.constraints)}</Code>
            </Card>
          </div>
        ) : null}
      </div>
    </>
  );
}
