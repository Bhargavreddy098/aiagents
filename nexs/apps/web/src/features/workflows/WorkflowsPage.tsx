/**
 * Workflows — §4-PHASE13.6: *"step editor (type picker → type-specific config form →
 * position/dependsOn); versioned step list (readable, not a fake canvas); run history;
 * activate/deactivate."*
 *
 * ## "Readable, not a fake canvas"
 *
 * The spec is explicit that the step list must be a readable list and not a diagram. That is
 * not a shortcut: a canvas implies a layout the data does not have. `dependsOn` holds step
 * **names**, and a step's `position` is an integer — there is no x/y, and drawing one would
 * mean inventing geometry that a reorder would silently invalidate.
 *
 * ## The type picker drives the form
 *
 * `workflowStepRequiresTool` decides whether a `toolId` field appears. It is the same
 * predicate the server validates with, imported rather than reimplemented — so the form
 * cannot offer a step the engine will refuse, and the rule lives in one place.
 */

import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  WORKFLOW_ON_FAIL,
  WORKFLOW_STEP_TYPES,
  WORKFLOW_STATUSES,
  workflowStepRequiresTool,
  type RunSummary,
  type WorkflowDetail,
  type WorkflowStepDetail,
  type WorkflowStepType,
  type WorkflowSummary,
} from '@nexs/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
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
import { api, qs } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import { EM_DASH, formatDateTime, formatRelative, formatSpan, shortId } from '../../lib/format';
import { labelForStatus } from '../../lib/status';
import { useTools } from '../catalog/queries';
import {
  useCreateWorkflow,
  usePublishWorkflowVersion,
  useRunWorkflow,
  useWorkflow,
  useWorkflowActivation,
  useWorkflows,
  type WorkflowStepDraft,
} from './queries';

/** A step as the editor holds it — config as text, so a half-typed object does not crash. */
interface StepDraft {
  name: string;
  stepType: WorkflowStepType;
  toolId: string;
  dependsOn: string;
  onFail: (typeof WORKFLOW_ON_FAIL)[number];
  timeoutMs: string;
  configJson: string;
}

function blankStep(index: number): StepDraft {
  return {
    name: `Step ${index + 1}`,
    stepType: 'ai',
    toolId: '',
    dependsOn: '',
    onFail: 'stop',
    timeoutMs: '',
    configJson: '{}',
  };
}

function fromExisting(step: WorkflowStepDetail): StepDraft {
  return {
    name: step.name,
    stepType: step.stepType,
    toolId:
      step.config !== null && typeof step.config === 'object'
        ? String((step.config as { toolId?: unknown }).toolId ?? '')
        : '',
    dependsOn: step.dependsOn.join(', '),
    onFail: step.onFail,
    timeoutMs: step.timeoutMs === null ? '' : String(step.timeoutMs),
    configJson: JSON.stringify(step.config ?? {}, null, 2),
  };
}

/** Turn the editor's text back into the payload, reporting the first parse failure. */
function toPayload(drafts: readonly StepDraft[]): { steps: WorkflowStepDraft[] } | { error: string } {
  const steps: WorkflowStepDraft[] = [];
  for (const [index, draft] of drafts.entries()) {
    if (draft.name.trim().length === 0) {
      return { error: `Step ${index + 1} needs a name.` };
    }
    let config: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(draft.configJson);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: `Step ${index + 1}: config must be a JSON object.` };
      }
      config = parsed as Record<string, unknown>;
    } catch {
      return { error: `Step ${index + 1}: config is not valid JSON.` };
    }
    if (workflowStepRequiresTool(draft.stepType) && draft.toolId.trim().length === 0) {
      return { error: `Step ${index + 1}: a "${draft.stepType}" step must name a tool.` };
    }
    const dependsOn = draft.dependsOn
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    steps.push({
      name: draft.name.trim(),
      stepType: draft.stepType,
      config,
      ...(draft.toolId.trim().length > 0 ? { toolId: draft.toolId.trim() } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      onFail: draft.onFail,
      ...(draft.timeoutMs.trim().length > 0 ? { timeoutMs: Number(draft.timeoutMs) } : {}),
    });
  }
  return { steps };
}

function StepEditor({
  drafts,
  onChange,
}: {
  drafts: StepDraft[];
  onChange: (drafts: StepDraft[]) => void;
}): ReactNode {
  const tools = useTools();
  const patch = (index: number, changes: Partial<StepDraft>): void => {
    onChange(drafts.map((draft, i) => (i === index ? { ...draft, ...changes } : draft)));
  };
  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= drafts.length) return;
    const next = [...drafts];
    const [moved] = next.splice(index, 1);
    if (moved !== undefined) next.splice(target, 0, moved);
    onChange(next);
  };

  return (
    <div className="stack">
      {drafts.map((draft, index) => (
        <div className="card" key={index}>
          <div className="card-head">
            <span className="row" style={{ gap: 6 }}>
              <Badge>{index + 1}</Badge>
              <span className="card-title">{draft.name || '(unnamed)'}</span>
            </span>
            <span className="row" style={{ gap: 4 }}>
              <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => move(index, -1)}>
                ↑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={index === drafts.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onChange(drafts.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </span>
          </div>
          <div className="card-body">
            <div className="grid-2">
              <Field label="Name">
                <input
                  className="input"
                  value={draft.name}
                  onChange={(event) => patch(index, { name: event.target.value })}
                />
              </Field>
              <Field label="Type">
                <select
                  className="select"
                  value={draft.stepType}
                  onChange={(event) =>
                    patch(index, { stepType: event.target.value as WorkflowStepType })
                  }
                >
                  {WORKFLOW_STEP_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {labelForStatus(type)}
                    </option>
                  ))}
                </select>
              </Field>

              {workflowStepRequiresTool(draft.stepType) ? (
                <Field
                  label="Tool"
                  hint="Required: this step type is a tool call in the engine."
                >
                  <select
                    className="select"
                    value={draft.toolId}
                    onChange={(event) => patch(index, { toolId: event.target.value })}
                  >
                    <option value="">Select a tool…</option>
                    {(tools.data ?? []).map((tool) => (
                      <option key={tool.id} value={tool.id}>
                        {tool.name} · {tool.source}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}

              <Field label="Depends on" hint="Comma-separated step names.">
                <input
                  className="input"
                  value={draft.dependsOn}
                  onChange={(event) => patch(index, { dependsOn: event.target.value })}
                />
              </Field>
              <Field label="On failure">
                <select
                  className="select"
                  value={draft.onFail}
                  onChange={(event) =>
                    patch(index, { onFail: event.target.value as StepDraft['onFail'] })
                  }
                >
                  {WORKFLOW_ON_FAIL.map((mode) => (
                    <option key={mode} value={mode}>
                      {labelForStatus(mode)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Timeout (ms)" hint="Optional.">
                <input
                  className="input"
                  inputMode="numeric"
                  value={draft.timeoutMs}
                  onChange={(event) => patch(index, { timeoutMs: event.target.value })}
                />
              </Field>
            </div>
            <div style={{ marginTop: 8 }}>
              <Field label="Config (JSON)">
                <textarea
                  className="textarea"
                  value={draft.configJson}
                  onChange={(event) => patch(index, { configJson: event.target.value })}
                />
              </Field>
            </div>
          </div>
        </div>
      ))}

      <Button onClick={() => onChange([...drafts, blankStep(drafts.length)])}>Add step</Button>
    </div>
  );
}

export function WorkflowsPage(): ReactNode {
  const [status, setStatus] = useState<string>('');
  const query = useWorkflows(status === '' ? undefined : (status as WorkflowSummary['status']));
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [drafts, setDrafts] = useState<StepDraft[]>([blankStep(0)]);
  const [error, setError] = useState<string | null>(null);

  const create = useCreateWorkflow();

  const submit = async (): Promise<void> => {
    setError(null);
    const payload = toPayload(drafts);
    if ('error' in payload) {
      setError(payload.error);
      return;
    }
    try {
      await create.mutateAsync({
        name: name.trim(),
        steps: payload.steps,
        ...(description.trim().length > 0 ? { description: description.trim() } : {}),
      });
      setCreating(false);
      setName('');
      setDescription('');
      setDrafts([blankStep(0)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the workflow.');
    }
  };

  return (
    <>
      <PageHead
        title="Workflows"
        subtitle="A stored program. Every edit publishes a new, immutable version."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New workflow
          </Button>
        }
      />

      <div className="toolbar">
        <button
          type="button"
          className={status === '' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
          onClick={() => setStatus('')}
        >
          All
        </button>
        {WORKFLOW_STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            className={status === value ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
            onClick={() => setStatus(value)}
          >
            {labelForStatus(value)}
          </button>
        ))}
      </div>

      <Card flush>
        <QueryBoundary
          query={query}
          loadingLabel="Loading workflows…"
          isEmpty={(rows) => rows.length === 0}
          empty={<EmptyState title="No workflows" hint="A workflow is a list of steps." />}
        >
          {(rows) => (
            <table className="table table-clickable">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Active version</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((workflow) => (
                  <tr key={workflow.id}>
                    <td>
                      <Link to={`/workflows/${workflow.id}`}>{workflow.name}</Link>
                      {workflow.description !== null ? (
                        <div className="muted small truncate">{workflow.description}</div>
                      ) : null}
                    </td>
                    <td>
                      <StatusBadge status={workflow.status} />
                    </td>
                    <td className="mono small">
                      {workflow.activeVersionId === null ? EM_DASH : shortId(workflow.activeVersionId)}
                    </td>
                    <td className="muted small nowrap" title={workflow.updatedAt}>
                      {formatRelative(workflow.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </QueryBoundary>
      </Card>

      {creating ? (
        <Modal
          title="New workflow"
          onClose={() => setCreating(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={create.isPending}
                disabled={name.trim().length === 0}
                onClick={() => void submit()}
              >
                Create
              </Button>
            </>
          }
        >
          <div className="stack">
            {error !== null ? <div className="error-box">{error}</div> : null}
            <Field label="Name">
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Description" hint="Optional.">
              <input
                className="input"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <div className="muted small">Steps</div>
            <StepEditor drafts={drafts} onChange={setDrafts} />
          </div>
        </Modal>
      ) : null}
    </>
  );
}

export function WorkflowDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const workflowId = id ?? '';
  const [tab, setTab] = useState('steps');
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<StepDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  const query = useWorkflow(workflowId);
  const activate = useWorkflowActivation('activate');
  const disable = useWorkflowActivation('disable');
  const publish = usePublishWorkflowVersion(workflowId);
  const runWorkflow = useRunWorkflow();

  const runs = useQuery({
    queryKey: [...queryKeys.runs.all, { workflowId }] as const,
    queryFn: () => api<{ runs: RunSummary[]; total: number }>(`/runs${qs({ workflowId })}`),
    enabled: tab === 'runs' && workflowId !== '',
  });

  if (query.isPending) return <Loading label="Loading workflow…" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const workflow: WorkflowDetail = query.data;
  const activeVersion =
    workflow.versions.find((version) => version.id === workflow.activeVersionId) ??
    workflow.versions[workflow.versions.length - 1];

  const startEditing = (): void => {
    setDrafts((activeVersion?.steps ?? []).map(fromExisting));
    setError(null);
    setEditing(true);
  };

  const save = async (): Promise<void> => {
    setError(null);
    const payload = toPayload(drafts);
    if ('error' in payload) {
      setError(payload.error);
      return;
    }
    try {
      await publish.mutateAsync({ steps: payload.steps });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not publish the version.');
    }
  };

  return (
    <>
      <PageHead
        title={
          <span className="row" style={{ gap: 8 }}>
            {workflow.name}
            <StatusBadge status={workflow.status} />
          </span>
        }
        subtitle={workflow.description ?? 'No description.'}
        actions={
          <>
            {workflow.status === 'active' ? (
              <Button
                size="sm"
                variant="primary"
                loading={runWorkflow.isPending}
                onClick={() => runWorkflow.mutate({ id: workflow.id, body: {} })}
              >
                Run
              </Button>
            ) : null}
            {workflow.status === 'draft' || workflow.status === 'disabled' ? (
              <Button
                size="sm"
                variant="primary"
                loading={activate.isPending}
                onClick={() => activate.mutate(workflow.id)}
              >
                Activate
              </Button>
            ) : null}
            {workflow.status === 'active' ? (
              <Button
                size="sm"
                loading={disable.isPending}
                onClick={() => disable.mutate(workflow.id)}
              >
                Deactivate
              </Button>
            ) : null}
            <Button size="sm" onClick={startEditing}>
              New version
            </Button>
          </>
        }
      />

      {editing ? (
        <div className="stack" style={{ marginBottom: 16 }}>
          <Card
            title="Publishing a new version"
            actions={
              <>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  loading={publish.isPending}
                  onClick={() => void save()}
                >
                  Publish
                </Button>
              </>
            }
          >
            <p className="muted small">
              The step set is replaced wholesale. The current version stays as it is, and runs
              pinned to it keep meaning what they meant.
            </p>
            {error !== null ? (
              <div className="error-box" style={{ marginTop: 8 }}>
                {error}
              </div>
            ) : null}
            <div style={{ marginTop: 12 }}>
              <StepEditor drafts={drafts} onChange={setDrafts} />
            </div>
          </Card>
        </div>
      ) : null}

      <Tabs
        tabs={[
          { id: 'steps', label: 'Steps', badge: <Badge>{activeVersion?.steps.length ?? 0}</Badge> },
          { id: 'versions', label: 'Versions', badge: <Badge>{workflow.versions.length}</Badge> },
          { id: 'runs', label: 'Runs' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ marginTop: 16 }} className="stack">
        {tab === 'steps' ? (
          <Card
            title={`Version ${activeVersion?.version ?? '—'} steps`}
            flush
          >
            {activeVersion === undefined || activeVersion.steps.length === 0 ? (
              <EmptyState title="No steps in this version" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Depends on</th>
                    <th>On failure</th>
                    <th>Timeout</th>
                  </tr>
                </thead>
                <tbody>
                  {activeVersion.steps.map((step) => (
                    <tr key={step.id}>
                      <td className="muted small">{step.position}</td>
                      <td>{step.name}</td>
                      <td>
                        <Badge>{step.stepType}</Badge>
                      </td>
                      <td className="muted small">
                        {step.dependsOn.length === 0 ? EM_DASH : step.dependsOn.join(', ')}
                      </td>
                      <td className="muted small">{labelForStatus(step.onFail)}</td>
                      <td className="muted small">
                        {step.timeoutMs === null ? EM_DASH : `${step.timeoutMs}ms`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        ) : null}

        {tab === 'versions' ? (
          <div className="stack">
            {[...workflow.versions].reverse().map((version) => (
              <Card
                key={version.id}
                title={
                  <span className="row" style={{ gap: 6 }}>
                    <Badge>v{version.version}</Badge>
                    {version.id === workflow.activeVersionId ? (
                      <Badge tone="ok">active</Badge>
                    ) : null}
                    <span className="muted small">
                      {version.steps.length} {version.steps.length === 1 ? 'step' : 'steps'}
                    </span>
                  </span>
                }
                actions={<span className="muted small">{formatDateTime(version.createdAt)}</span>}
              >
                <ol className="stack-sm" style={{ margin: 0, paddingLeft: 18 }}>
                  {version.steps.map((step) => (
                    <li key={step.id} className="small">
                      {step.name} <Badge>{step.stepType}</Badge>
                    </li>
                  ))}
                </ol>
              </Card>
            ))}
          </div>
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

        <Card title="Identity">
          <KeyValue
            entries={[
              ['Id', <span className="mono">{workflow.id}</span>],
              ['Status', <StatusBadge status={workflow.status} />],
              ['Active version', workflow.activeVersionId ?? EM_DASH],
              ['Versions', String(workflow.versions.length)],
              ['Created', formatDateTime(workflow.createdAt)],
              ['Updated', formatDateTime(workflow.updatedAt)],
            ]}
          />
        </Card>
      </div>
    </>
  );
}
