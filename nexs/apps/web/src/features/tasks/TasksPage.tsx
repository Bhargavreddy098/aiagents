/**
 * Tasks — §4-PHASE13.5: *"active/scheduled/completed tabs; status timeline, input/output,
 * error, retry count, linked run."*
 *
 * The tabs are status *sets*, not single statuses: "Active" is everything not yet finished,
 * "Scheduled" is the triggers that have a time, "Completed" is the terminal states. The
 * server's `listTasksSchema` filters by one status, so the grouping happens here over the
 * full list — which also means the tab counts are the counts of what the tab shows.
 */

import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { TaskStatus, TaskSummary } from '@nexs/shared';
import {
  Badge,
  Card,
  Code,
  Dot,
  EmptyState,
  ErrorState,
  KeyValue,
  Loading,
  PageHead,
  QueryBoundary,
  StatusBadge,
  Tabs,
} from '../../components/ui';
import {
  EM_DASH,
  formatDateTime,
  formatRelative,
  prettyJson,
  shortId,
} from '../../lib/format';
import { labelForStatus, toneFor } from '../../lib/status';
import { useTask, useTaskAction, useTasks } from './queries';

const ACTIVE: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'running',
  'paused',
  'waiting_approval',
]);
const SCHEDULED_TRIGGERS = new Set(['scheduled', 'recurring', 'event']);
const TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled']);

function TaskTable({ rows }: { rows: readonly TaskSummary[] }): ReactNode {
  return (
    <table className="table table-clickable">
      <thead>
        <tr>
          <th>Task</th>
          <th>Status</th>
          <th>Trigger</th>
          <th>Agent</th>
          <th>Retries</th>
          <th>Scheduled</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((task) => (
          <tr key={task.id}>
            <td>
              <Link to={`/tasks/${task.id}`}>{task.title}</Link>
              {task.error !== null ? (
                <div className="small" style={{ color: 'var(--status-failed)' }}>
                  {task.error}
                </div>
              ) : null}
            </td>
            <td>
              <StatusBadge status={task.status} />
            </td>
            <td>
              <Badge>{task.triggerType}</Badge>
            </td>
            <td className="mono small">
              {task.agentId === null ? EM_DASH : shortId(task.agentId)}
            </td>
            <td className="muted small">{task.retryCount}</td>
            <td className="muted small nowrap">{formatDateTime(task.scheduledAt)}</td>
            <td className="muted small nowrap" title={task.updatedAt}>
              {formatRelative(task.updatedAt)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TasksPage(): ReactNode {
  const [tab, setTab] = useState('active');
  const query = useTasks();

  return (
    <>
      <PageHead title="Tasks" subtitle="The unit of work. Every run belongs to one." />

      <QueryBoundary query={query} loadingLabel="Loading tasks…">
        {(tasks) => {
          const groups = {
            active: tasks.filter((task) => ACTIVE.has(task.status)),
            scheduled: tasks.filter(
              (task) => !TERMINAL.has(task.status) && SCHEDULED_TRIGGERS.has(task.triggerType),
            ),
            completed: tasks.filter((task) => TERMINAL.has(task.status)),
          };
          const rows = groups[tab as keyof typeof groups] ?? [];

          return (
            <>
              <Tabs
                tabs={[
                  { id: 'active', label: 'Active', badge: <Badge>{groups.active.length}</Badge> },
                  {
                    id: 'scheduled',
                    label: 'Scheduled',
                    badge: <Badge>{groups.scheduled.length}</Badge>,
                  },
                  {
                    id: 'completed',
                    label: 'Completed',
                    badge: <Badge>{groups.completed.length}</Badge>,
                  },
                ]}
                active={tab}
                onChange={setTab}
              />

              <div style={{ marginTop: 16 }}>
                <Card flush>
                  {rows.length === 0 ? (
                    <EmptyState title={`No ${tab} tasks`} />
                  ) : (
                    <TaskTable rows={rows} />
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

export function TaskDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const taskId = id ?? '';
  const query = useTask(taskId);
  const cancel = useTaskAction('cancel');
  const retry = useTaskAction('retry');

  if (query.isPending) return <Loading label="Loading task…" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const task = query.data;

  // The timeline is built from the timestamps the row actually carries, in the order they
  // can happen. A stage with no timestamp is shown as "not reached" rather than omitted —
  // an absent row would read as "this stage does not exist".
  const stages: { label: string; at: string | null }[] = [
    { label: 'Created', at: task.createdAt },
    { label: 'Scheduled for', at: task.scheduledAt },
    { label: 'Started', at: task.startedAt },
    { label: 'Completed', at: task.completedAt },
  ];

  return (
    <>
      <PageHead
        title={
          <span className="row" style={{ gap: 8 }}>
            {task.title}
            <StatusBadge status={task.status} />
          </span>
        }
        subtitle={task.description ?? 'No description.'}
        actions={
          <>
            {!TERMINAL.has(task.status) ? (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(task.id)}
              >
                Cancel
              </button>
            ) : null}
            {task.status === 'failed' || task.status === 'cancelled' ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={retry.isPending}
                onClick={() => retry.mutate(task.id)}
              >
                Retry
              </button>
            ) : null}
          </>
        }
      />

      {task.error !== null ? (
        <div className="error-box" style={{ marginBottom: 16 }}>
          <div className="error-code">last error</div>
          <div>{task.error}</div>
          <div className="muted small" style={{ marginTop: 4 }}>
            Retried {task.retryCount} {task.retryCount === 1 ? 'time' : 'times'}.
          </div>
        </div>
      ) : null}

      <div className="grid-2">
        <Card title="Timeline">
          <div className="timeline">
            {stages.map((stage) => (
              <div className="timeline-item" key={stage.label}>
                <div className="timeline-rail">
                  <Dot tone={stage.at === null ? 'neutral' : 'ok'} />
                  <span className="timeline-line" />
                </div>
                <div className="row-between">
                  <span className="small">{stage.label}</span>
                  <span className="muted small nowrap">
                    {stage.at === null ? 'not reached' : formatDateTime(stage.at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Details">
          <KeyValue
            entries={[
              ['Id', <span className="mono">{task.id}</span>],
              ['Status', <StatusBadge status={task.status} />],
              ['Priority', String(task.priority)],
              ['Trigger', <Badge>{task.triggerType}</Badge>],
              ['Retries', String(task.retryCount)],
              [
                'Agent',
                task.agentId === null ? (
                  EM_DASH
                ) : (
                  <Link to={`/agents/${task.agentId}`}>{shortId(task.agentId)}</Link>
                ),
              ],
              [
                'Goal',
                task.goalId === null ? (
                  EM_DASH
                ) : (
                  <Link to={`/goals/${task.goalId}`}>{shortId(task.goalId)}</Link>
                ),
              ],
              [
                'Workflow',
                task.workflowId === null ? (
                  EM_DASH
                ) : (
                  <Link to={`/workflows/${task.workflowId}`}>{shortId(task.workflowId)}</Link>
                ),
              ],
              ['Schedule', task.scheduleId ?? EM_DASH],
              ['Event subscription', task.eventSubscriptionId ?? EM_DASH],
            ]}
          />
        </Card>

        <Card title="Input">
          {task.input === null || task.input === undefined ? (
            <EmptyState title="No input" />
          ) : (
            <Code>{prettyJson(task.input)}</Code>
          )}
        </Card>

        <Card title="Output">
          {task.output === null || task.output === undefined ? (
            <EmptyState title="No output yet" />
          ) : (
            <Code>{prettyJson(task.output)}</Code>
          )}
        </Card>

        <Card title={`Runs · ${task.runIds.length}`} flush>
          {task.runIds.length === 0 ? (
            <EmptyState
              title="No runs yet"
              hint="A task produces a run when its trigger fires."
            />
          ) : (
            <table className="table table-clickable">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Open</th>
                </tr>
              </thead>
              <tbody>
                {task.runIds.map((runId) => (
                  <tr key={runId}>
                    <td className="mono small">{shortId(runId)}</td>
                    <td>
                      <Link to={`/runs/${runId}`}>Open workspace</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Status vocabulary">
          <p className="muted small">
            A task's status mirrors its run's, minus the states that describe execution inside a
            run — a task does not plan, and a task that times out has a run that timed out.
          </p>
          <div className="row-wrap" style={{ marginTop: 8 }}>
            {(['queued', 'running', 'paused', 'waiting_approval', 'completed', 'failed', 'cancelled'] as const).map(
              (status) => (
                <span key={status} className="row small" style={{ gap: 4 }}>
                  <Dot tone={toneFor(status)} />
                  {labelForStatus(status)}
                </span>
              ),
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
