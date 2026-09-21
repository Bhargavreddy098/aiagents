/**
 * One agent: identity, config, and everything it owns.
 *
 * The tabs that show *related* rows (goals, tasks, runs, approvals) query by `agentId`
 * rather than filtering the whole workspace in the browser — those collections grow, and the
 * server already supports the filter.
 *
 * ## The Schedules tab, and why it is a join
 *
 * There is no agent-scoped schedule. `SCHEDULE_TARGET_KINDS` is `task | workflow`, so a
 * schedule points at a task or a workflow and never at an agent. The honest answer to "what
 * is scheduled for this agent" is therefore *the schedules whose target is one of this
 * agent's tasks*, which is a join this page performs over two real queries. The alternative
 * — listing every schedule in the workspace under an agent's name — would be a number on
 * screen that does not trace to a relationship.
 *
 * ## "Run" is a task, not a run
 *
 * There is no `POST /runs`. Work starts by creating a task, and an `immediate` trigger is
 * what makes it produce a run right away. So the Run button creates an immediate task
 * against this agent, which is the same path the task list uses.
 */

import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ApprovalSummary, GoalSummary, RunSummary, TaskSummary } from '@nexs/shared';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  KeyValue,
  Loading,
  Modal,
  PageHead,
  QueryBoundary,
  StatusBadge,
  Tabs,
} from '../../components/ui';
import { useQuery } from '@tanstack/react-query';
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
import { useSchedules } from '../catalog/queries';
import { useCreateTask } from '../tasks/queries';
import {
  useAgent,
  useAgentAction,
  useArchiveAgent,
  useUpdateAgent,
  type AgentAction,
} from './queries';

function RunAgentModal({
  agentId,
  agentName,
  onClose,
}: {
  agentId: string;
  agentName: string;
  onClose: () => void;
}): ReactNode {
  const [title, setTitle] = useState(`Run ${agentName}`);
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<unknown>(null);
  const createTask = useCreateTask();

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      await createTask.mutateAsync({
        title: title.trim(),
        agentId,
        triggerType: 'immediate',
        ...(instructions.trim().length > 0 ? { input: { instructions: instructions.trim() } } : {}),
      });
      onClose();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Modal
      title="Run this agent"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={createTask.isPending}
            disabled={title.trim().length === 0}
            onClick={() => void submit()}
          >
            Start run
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted small">
          This creates an immediate task, which is how a run is started — the run appears in
          Runs a moment later.
        </p>
        {error !== null ? (
          <div className="error-box">
            {error instanceof Error ? error.message : 'Could not start the run.'}
          </div>
        ) : null}
        <Field label="Task title">
          <input
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="Instructions" hint="Optional. Passed to the run as input.">
          <textarea
            className="textarea"
            style={{ fontFamily: 'inherit' }}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

export function AgentDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const agentId = id ?? '';
  const [tab, setTab] = useState('overview');
  const [runOpen, setRunOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftInstructions, setDraftInstructions] = useState('');

  const query = useAgent(agentId);

  const goals = useQuery({
    queryKey: [...queryKeys.goals.all, { agentId }] as const,
    queryFn: () => apiOf<GoalSummary[]>(`/goals${qs({ agentId })}`, 'goals'),
    enabled: tab === 'goals',
  });

  const tasks = useQuery({
    queryKey: [...queryKeys.tasks.all, { agentId }] as const,
    queryFn: () => apiOf<TaskSummary[]>(`/tasks${qs({ agentId })}`, 'tasks'),
    enabled: tab === 'tasks' || tab === 'schedules',
  });

  const runs = useQuery({
    queryKey: [...queryKeys.runs.all, { agentId }] as const,
    queryFn: () => api<{ runs: RunSummary[]; total: number }>(`/runs${qs({ agentId })}`),
    enabled: tab === 'runs',
  });

  const approvals = useQuery({
    queryKey: [...queryKeys.approvals.all, { agentId }] as const,
    queryFn: () => api<{ approvals: ApprovalSummary[]; pendingCount: number }>(
      `/approvals${qs({ agentId })}`,
    ),
    enabled: tab === 'approvals',
  });

  const schedules = useSchedules();

  const activate = useAgentAction('activate');
  const pause = useAgentAction('pause');
  const resume = useAgentAction('resume');
  const disable = useAgentAction('disable');
  const duplicate = useAgentAction('duplicate');
  const archive = useArchiveAgent();
  const update = useUpdateAgent(agentId);

  if (query.isPending) return <Loading label="Loading agent…" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const agent = query.data;

  const actionButton = (action: AgentAction, label: string, variant?: 'primary' | 'danger') => (
    <Button
      size="sm"
      variant={variant ?? 'default'}
      loading={
        action === 'activate'
          ? activate.isPending
          : action === 'pause'
            ? pause.isPending
            : action === 'resume'
              ? resume.isPending
              : action === 'disable'
                ? disable.isPending
                : duplicate.isPending
      }
      onClick={() => {
        const mutation =
          action === 'activate'
            ? activate
            : action === 'pause'
              ? pause
              : action === 'resume'
                ? resume
                : action === 'disable'
                  ? disable
                  : duplicate;
        mutation.mutate(agent.id);
      }}
    >
      {label}
    </Button>
  );

  // The schedules whose target is one of this agent's tasks. See the file header.
  const taskIds = new Set((tasks.data ?? []).map((task) => task.id));
  const agentSchedules = (schedules.data?.schedules ?? []).filter(
    (schedule) => schedule.targetKind === 'task' && taskIds.has(schedule.targetId),
  );

  return (
    <>
      <PageHead
        title={
          <span className="row" style={{ gap: 8 }}>
            {agent.name}
            <StatusBadge status={agent.status} />
            <Badge>v{agent.version}</Badge>
          </span>
        }
        subtitle={agent.description ?? 'No description.'}
        actions={
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={agent.status !== 'active'}
              title={
                agent.status === 'active'
                  ? 'Create an immediate task'
                  : 'Only an active agent can run'
              }
              onClick={() => setRunOpen(true)}
            >
              Run
            </Button>
            {agent.status === 'active' ? actionButton('pause', 'Pause') : null}
            {agent.status === 'paused' ? actionButton('resume', 'Resume') : null}
            {agent.status === 'disabled' || agent.status === 'draft'
              ? actionButton('activate', 'Activate', 'primary')
              : null}
            {agent.status === 'active' || agent.status === 'paused'
              ? actionButton('disable', 'Disable')
              : null}
            {actionButton('duplicate', 'Duplicate')}
            <Button
              size="sm"
              variant="danger"
              loading={archive.isPending}
              title="Archiving is terminal; duplicate the agent to bring it back."
              onClick={() => archive.mutate(agent.id)}
            >
              Delete
            </Button>
          </>
        }
      />

      <Tabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'config', label: 'Config' },
          { id: 'goals', label: 'Goals', badge: <Badge>{agent.counts.goals}</Badge> },
          { id: 'tasks', label: 'Tasks', badge: <Badge>{agent.counts.tasks}</Badge> },
          { id: 'runs', label: 'Runs', badge: <Badge>{agent.counts.runs}</Badge> },
          { id: 'versions', label: 'Versions', badge: <Badge>{agent.versions.length}</Badge> },
          { id: 'schedules', label: 'Schedules' },
          { id: 'approvals', label: 'Approvals' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ marginTop: 16 }} className="stack">
        {tab === 'overview' ? (
          <div className="grid-2">
            <Card title="Identity">
              <KeyValue
                entries={[
                  ['Id', <span className="mono">{agent.id}</span>],
                  ['Status', <StatusBadge status={agent.status} />],
                  ['Version', `v${agent.version}`],
                  ['Active version', agent.activeVersionId ?? EM_DASH],
                  ['Created', formatDateTime(agent.createdAt)],
                  ['Updated', formatDateTime(agent.updatedAt)],
                  ['Archived', formatDateTime(agent.archivedAt)],
                ]}
              />
            </Card>
            <Card title="What it owns">
              <div className="grid-3">
                <div>
                  <div className="stat-label">Goals</div>
                  <div className="stat-value">{agent.counts.goals}</div>
                </div>
                <div>
                  <div className="stat-label">Tasks</div>
                  <div className="stat-value">{agent.counts.tasks}</div>
                </div>
                <div>
                  <div className="stat-label">Runs</div>
                  <div className="stat-value">{agent.counts.runs}</div>
                </div>
              </div>
            </Card>
          </div>
        ) : null}

        {tab === 'config' ? (
          <>
            <Card
              title="Instructions"
              actions={
                editing ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(false);
                        setDraftInstructions(agent.instructions);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={update.isPending}
                      onClick={() => {
                        // A change here mints a new version, because instructions are part of
                        // the config snapshot — the server decides that, not this form.
                        update.mutate(
                          { instructions: draftInstructions },
                          { onSuccess: () => setEditing(false) },
                        );
                      }}
                    >
                      Save
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => {
                      setDraftInstructions(agent.instructions);
                      setEditing(true);
                    }}
                  >
                    Edit
                  </Button>
                )
              }
            >
              {editing ? (
                <textarea
                  className="textarea"
                  style={{ minHeight: 240 }}
                  value={draftInstructions}
                  onChange={(event) => setDraftInstructions(event.target.value)}
                />
              ) : (
                <Code>{agent.instructions.length > 0 ? agent.instructions : '(empty)'}</Code>
              )}
            </Card>

            <Card title="Capabilities">
              <div className="stack-sm">
                <Checkbox
                  checked={agent.memoryEnabled}
                  onChange={(checked) => update.mutate({ memoryEnabled: checked })}
                  label="Memory enabled"
                />
                <Checkbox
                  checked={agent.browserAccess}
                  onChange={(checked) => update.mutate({ browserAccess: checked })}
                  label="Browser access"
                />
                <Checkbox
                  checked={agent.sandboxAccess}
                  onChange={(checked) => update.mutate({ sandboxAccess: checked })}
                  label="Sandbox access"
                />
              </div>
            </Card>

            <Card title="Policy and limits">
              <div className="grid-2">
                <div>
                  <div className="muted small">Approval policy</div>
                  <Code>{prettyJson(agent.approvalPolicy)}</Code>
                </div>
                <div>
                  <div className="muted small">Execution limits</div>
                  <Code>{prettyJson(agent.executionLimits)}</Code>
                </div>
              </div>
            </Card>

            <Card title="Grants">
              <KeyValue
                entries={[
                  ['Model', agent.modelId ?? EM_DASH],
                  ['Fallback model', agent.fallbackModelId ?? EM_DASH],
                  ['Tools', `${agent.toolIds.length}`],
                  ['MCP servers', `${agent.mcpServerIds.length}`],
                  ['Connector accounts', `${agent.connectorAccountIds.length}`],
                ]}
              />
              {agent.toolIds.length > 0 ? (
                <div className="row-wrap" style={{ marginTop: 8 }}>
                  {agent.toolIds.map((toolId) => (
                    <Link key={toolId} to={`/tools/${toolId}`}>
                      <Badge>{shortId(toolId, 10)}</Badge>
                    </Link>
                  ))}
                </div>
              ) : null}
            </Card>
          </>
        ) : null}

        {tab === 'goals' ? (
          <Card flush>
            <QueryBoundary query={goals} isEmpty={(rows) => rows.length === 0}>
              {(rows) => (
                <table className="table table-clickable">
                  <thead>
                    <tr>
                      <th>Goal</th>
                      <th>Status</th>
                      <th>Priority</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((goal) => (
                      <tr key={goal.id}>
                        <td>
                          <Link to={`/goals/${goal.id}`}>{goal.title}</Link>
                        </td>
                        <td>
                          <StatusBadge status={goal.status} />
                        </td>
                        <td className="muted small">{goal.priority}</td>
                        <td className="muted small nowrap" title={goal.updatedAt}>
                          {formatRelative(goal.updatedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </QueryBoundary>
            <div style={{ padding: 8 }}>
              <EmptyState title="No goals" />
            </div>
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
                      <th>Retries</th>
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
                        <td className="muted small">{task.retryCount}</td>
                        <td className="muted small nowrap" title={task.updatedAt}>
                          {formatRelative(task.updatedAt)}
                        </td>
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

        {tab === 'versions' ? (
          <Card flush>
            {agent.versions.length === 0 ? (
              <EmptyState title="No versions" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Created</th>
                    <th>Active</th>
                  </tr>
                </thead>
                <tbody>
                  {agent.versions.map((version) => (
                    <tr key={version.id}>
                      <td>
                        <Badge>v{version.version}</Badge>
                      </td>
                      <td className="muted small">{formatDateTime(version.createdAt)}</td>
                      <td>
                        {version.id === agent.activeVersionId ? (
                          <Badge tone="ok">active</Badge>
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        ) : null}

        {tab === 'schedules' ? (
          <Card flush>
            {schedules.isPending || tasks.isPending ? (
              <Loading />
            ) : schedules.isError ? (
              <ErrorState error={schedules.error} onRetry={() => void schedules.refetch()} />
            ) : agentSchedules.length === 0 ? (
              <EmptyState
                title="Nothing scheduled"
                hint="A schedule targets a task or a workflow; none of this agent's tasks are scheduled."
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Schedule</th>
                    <th>Kind</th>
                    <th>Cron</th>
                    <th>Next fire</th>
                    <th>Last fired</th>
                  </tr>
                </thead>
                <tbody>
                  {agentSchedules.map((schedule) => (
                    <tr key={schedule.id}>
                      <td>{schedule.name}</td>
                      <td>
                        <Badge>{schedule.kind}</Badge>
                      </td>
                      <td className="mono small">{schedule.cron ?? EM_DASH}</td>
                      <td className="small nowrap">{formatDateTime(schedule.nextFireAt)}</td>
                      <td className="muted small nowrap">
                        {formatRelative(schedule.lastFiredAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        ) : null}

        {tab === 'approvals' ? (
          <Card flush>
            <QueryBoundary query={approvals} isEmpty={(data) => data.approvals.length === 0}>
              {(data) => (
                <table className="table table-clickable">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Risk</th>
                      <th>Status</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.approvals.map((approval) => (
                      <tr key={approval.id}>
                        <td>{approval.title}</td>
                        <td>
                          <Badge
                            tone={
                              approval.risk.level === 'high'
                                ? 'failed'
                                : approval.risk.level === 'medium'
                                  ? 'waiting'
                                  : 'ok'
                            }
                          >
                            {approval.risk.level}
                          </Badge>
                        </td>
                        <td>
                          <StatusBadge status={approval.status} />
                        </td>
                        <td className="muted small nowrap">
                          {formatRelative(approval.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </QueryBoundary>
          </Card>
        ) : null}
      </div>

      {runOpen ? (
        <RunAgentModal
          agentId={agent.id}
          agentName={agent.name}
          onClose={() => setRunOpen(false)}
        />
      ) : null}

      <div style={{ marginTop: 16 }}>
        <CopyButton text={agent.id} label="Copy agent id" />
      </div>
    </>
  );
}
