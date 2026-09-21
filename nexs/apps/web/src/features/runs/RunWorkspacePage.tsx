/**
 * The Agent Workspace — §4-PHASE13.7's nine tabs.
 *
 * *"Overview / Timeline (real step rows with timing) / Tools (ToolCall table) / Browser (live
 * URL/title/screenshots) / Terminal (sandbox executions) / Files / Artifacts (receipts+outputs)
 * / Approvals / Verification (with evidence). Live via SSE."*
 *
 * ## Two tabs whose data is not where you would expect, and why
 *
 * **Files.** There is no `GET /files?scope=run`. `ATTACHMENT_SCOPES` is `chat | agent | task`
 * — an attachment belongs to a conversation, an agent or a task, never to a run. So this tab
 * shows the files the run *produced*, which is a different question and is answered by the
 * run's own rows: a tool result carrying a `ref` is the only record that this run wrote
 * something. Inventing a run-scoped attachment list would have meant a query that returns
 * nothing and a tab that always looks empty.
 *
 * **Browser / Terminal.** Browser sessions and sandbox executions are separate resources
 * with their own lifecycles, so they are not in the run payload. Both list endpoints accept
 * a `runId` filter, so each tab fetches its own.
 *
 * ## Live
 *
 * No polling anywhere. `run.*` and `step.*` frames invalidate `['runs']`, which by prefix
 * covers `['runs', id]`, so the timeline grows as the engine writes steps.
 */

import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  RunDetail,
  RunStepView,
  RunToolCallView,
  SandboxExecutionSummary,
} from '@nexs/shared';
import {
  Badge,
  Card,
  Code,
  CopyButton,
  Dot,
  EmptyState,
  ErrorState,
  KeyValue,
  Loading,
  PageHead,
  StatusBadge,
  Tabs,
} from '../../components/ui';
import {
  EM_DASH,
  formatDateTime,
  formatDuration,
  formatElapsed,
  formatNumber,
  formatRelative,
  formatSpan,
  inlineJson,
  prettyJson,
  shortId,
} from '../../lib/format';
import { isLive, toneFor } from '../../lib/status';
import {
  usePauseRun,
  useResumeRun,
  useCancelRun,
  useRun,
  useRunApprovals,
  useRunBrowserSessions,
  useRunSandboxExecutions,
} from './queries';

/**
 * The files a run produced.
 *
 * A `ToolResult` carries an optional `ref` — the pointer to an artifact too large to inline —
 * and that is the only row that records this run writing something. Deriving the list from
 * the tool calls means the tab cannot disagree with the run's own history.
 */
interface FileArtifact {
  toolName: string;
  ref: string;
  at: string;
}

function fileArtifacts(run: RunDetail): FileArtifact[] {
  const artifacts: FileArtifact[] = [];
  for (const call of run.toolCalls) {
    if (typeof call.result !== 'object' || call.result === null) continue;
    const ref = (call.result as { ref?: unknown }).ref;
    if (typeof ref === 'string' && ref.length > 0) {
      artifacts.push({
        toolName: call.toolName ?? call.toolId,
        ref,
        at: call.createdAt,
      });
    }
  }
  return artifacts;
}

function StepRow({ step }: { step: RunStepView }): ReactNode {
  return (
    <div className="timeline-item">
      <div className="timeline-rail">
        <Dot tone={toneFor(step.status)} title={step.status} />
        <span className="timeline-line" />
      </div>
      <div className="stack-sm" style={{ paddingBottom: 4 }}>
        <div className="row-between">
          <span className="row" style={{ gap: 6 }}>
            <span className="muted mono small">{step.seq}</span>
            <strong className="small">{step.name}</strong>
            <Badge>{step.stepType}</Badge>
            {step.retryCount > 0 ? (
              <Badge tone="waiting">
                retry {step.retryCount} · attempt {step.attempt}
              </Badge>
            ) : null}
          </span>
          <span className="muted small nowrap" title={step.startedAt ?? ''}>
            {formatSpan(step.startedAt, step.completedAt)}
            {isLive(step.status) ? ' (running)' : ''}
          </span>
        </div>
        {step.description !== null ? <span className="muted small">{step.description}</span> : null}
        {step.error !== null && step.error !== undefined ? (
          <div className="error-box">
            <div className="error-code">step error</div>
            <div className="mono small">{inlineJson(step.error, 300)}</div>
          </div>
        ) : null}
        {step.output !== null && step.output !== undefined ? (
          <details>
            <summary className="muted small" style={{ cursor: 'pointer' }}>
              output
            </summary>
            <Code>{prettyJson(step.output)}</Code>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function ToolCallRow({ call }: { call: RunToolCallView }): ReactNode {
  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div className="card-head">
        <span className="row" style={{ gap: 6 }}>
          <Dot tone={toneFor(call.status)} />
          <strong className="small">{call.toolName ?? '(tool deleted)'}</strong>
          {call.sideEffect ? <Badge tone="waiting">side effect</Badge> : null}
          <StatusBadge status={call.status} />
        </span>
        <span className="muted small nowrap">
          {formatDuration(call.durationMs)} · {formatRelative(call.createdAt)}
        </span>
      </div>
      <div className="card-body stack-sm">
        <details open>
          <summary className="muted small" style={{ cursor: 'pointer' }}>
            arguments
          </summary>
          <Code>{prettyJson(call.args)}</Code>
        </details>
        {call.error !== null ? (
          <div className="error-box">
            <div className="error-code">tool error</div>
            <div className="mono small">{call.error}</div>
          </div>
        ) : (
          <details>
            <summary className="muted small" style={{ cursor: 'pointer' }}>
              result
            </summary>
            <Code>{prettyJson(call.result)}</Code>
          </details>
        )}
      </div>
    </div>
  );
}

export function RunWorkspacePage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const runId = id ?? '';
  const [tab, setTab] = useState('overview');

  const query = useRun(runId);

  const cancel = useCancelRun();
  const pause = usePauseRun();
  const resume = useResumeRun();

  // Only fetched when their tab is open. A run with no browser step should not pay for a
  // browser-session request, and the tab's own spinner is honest about what is loading.
  const browser = useRunBrowserSessions(tab === 'browser' ? runId : '');
  const sandbox = useRunSandboxExecutions(tab === 'terminal' ? runId : '');
  const approvals = useRunApprovals(tab === 'approvals' ? runId : '');

  if (query.isPending) return <Loading label="Loading run…" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const run = query.data;
  const files = fileArtifacts(run);
  const active = isLive(run.status);

  return (
    <>
      <PageHead
        title={
          <span className="row" style={{ gap: 8 }}>
            <span className="mono">{shortId(run.id, 12)}</span>
            <StatusBadge status={run.status} />
            <Badge tone="accent">{run.kind}</Badge>
          </span>
        }
        subtitle={
          <>
            Started {formatRelative(run.startedAt ?? run.createdAt)} ·{' '}
            {active ? (
              <>running for {formatElapsed(run.startedAt)}</>
            ) : (
              <>took {formatDuration(run.durationMs)}</>
            )}
            {run.agentId !== null ? (
              <>
                {' · '}
                <Link to={`/agents/${run.agentId}`}>agent {shortId(run.agentId)}</Link>
              </>
            ) : null}
            {run.taskId !== null ? (
              <>
                {' · '}
                <Link to={`/tasks/${run.taskId}`}>task {shortId(run.taskId)}</Link>
              </>
            ) : null}
            {run.goalId !== null ? (
              <>
                {' · '}
                <Link to={`/goals/${run.goalId}`}>goal {shortId(run.goalId)}</Link>
              </>
            ) : null}
            {run.workflowId !== null ? (
              <>
                {' · '}
                <Link to={`/workflows/${run.workflowId}`}>workflow {shortId(run.workflowId)}</Link>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            {active ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={pause.isPending}
                onClick={() => pause.mutate(run.id)}
              >
                Pause
              </button>
            ) : null}
            {run.status === 'paused' ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={resume.isPending}
                onClick={() => resume.mutate(run.id)}
              >
                Resume
              </button>
            ) : null}
            {!['completed', 'failed', 'cancelled'].includes(run.status) ? (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(run.id)}
              >
                Cancel
              </button>
            ) : null}
          </>
        }
      />

      {run.error !== null ? (
        <div className="error-box" style={{ marginBottom: 16 }}>
          <div className="error-code">{run.error.code}</div>
          <div>{run.error.message}</div>
          {run.error.raw !== undefined ? (
            <div className="mono small">{run.error.raw}</div>
          ) : null}
        </div>
      ) : null}

      <Tabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'timeline', label: 'Timeline', badge: <Badge>{run.steps.length}</Badge> },
          { id: 'tools', label: 'Tools', badge: <Badge>{run.toolCalls.length}</Badge> },
          { id: 'browser', label: 'Browser' },
          { id: 'terminal', label: 'Terminal' },
          { id: 'files', label: 'Files', badge: <Badge>{files.length}</Badge> },
          { id: 'artifacts', label: 'Artifacts', badge: <Badge>{run.receipts.length}</Badge> },
          { id: 'approvals', label: 'Approvals' },
          {
            id: 'verification',
            label: 'Verification',
            badge: <Badge>{run.verifications.length}</Badge>,
          },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ marginTop: 16 }} className="stack">
        {tab === 'overview' ? (
          <div className="grid-2">
            <Card title="Run">
              <KeyValue
                entries={[
                  ['Id', <span className="mono">{run.id}</span>],
                  ['Correlation', <span className="mono">{run.correlationId}</span>],
                  ['Idempotency key', run.idempotencyKey ?? EM_DASH],
                  ['Agent version', run.agentVersionId ?? EM_DASH],
                  ['Created', formatDateTime(run.createdAt)],
                  ['Started', formatDateTime(run.startedAt)],
                  ['Completed', formatDateTime(run.completedAt)],
                  ['Last heartbeat', formatDateTime(run.lastHeartbeatAt)],
                ]}
              />
            </Card>

            <Card title="Plan">
              {run.plan === null || run.plan === undefined ? (
                <EmptyState title="No plan recorded" />
              ) : Array.isArray(run.plan) ? (
                <ol className="stack-sm" style={{ margin: 0, paddingLeft: 18 }}>
                  {(run.plan as { id?: string; description?: string; stepType?: string }[]).map(
                    (step, index) => (
                      <li key={step.id ?? index}>
                        <span className="small">{step.description ?? step.id ?? 'step'}</span>{' '}
                        {step.stepType !== undefined ? <Badge>{step.stepType}</Badge> : null}
                      </li>
                    ),
                  )}
                </ol>
              ) : (
                <Code>{prettyJson(run.plan)}</Code>
              )}
            </Card>

            <Card title="Input">
              {run.input === null || run.input === undefined ? (
                <EmptyState title="No input" />
              ) : (
                <Code>{prettyJson(run.input)}</Code>
              )}
            </Card>

            <Card title="Output">
              {run.output === null || run.output === undefined ? (
                <EmptyState title="No output yet" />
              ) : (
                <Code>{prettyJson(run.output)}</Code>
              )}
            </Card>

            <Card title="Model usage" flush>
              {run.modelUsage.length === 0 ? (
                <EmptyState title="No model calls recorded" />
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th className="right">Prompt</th>
                      <th className="right">Completion</th>
                      <th className="right">Total</th>
                      <th className="right">Latency</th>
                      <th className="right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.modelUsage.map((usage) => (
                      <tr key={usage.id}>
                        <td className="mono small truncate" title={usage.modelId}>
                          {shortId(usage.modelId, 16)}
                          {usage.cached ? <Badge> cached</Badge> : null}
                        </td>
                        <td className="right small">{formatNumber(usage.promptTokens)}</td>
                        <td className="right small">{formatNumber(usage.completionTokens)}</td>
                        <td className="right small">{formatNumber(usage.totalTokens)}</td>
                        <td className="right small">{formatDuration(usage.latencyMs)}</td>
                        <td className="right small">{usage.costEstimate.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        ) : null}

        {tab === 'timeline' ? (
          <Card title={`Steps · ${run.steps.length}`}>
            {run.steps.length === 0 ? (
              <EmptyState title="No steps yet" hint="Steps appear as the engine writes them." />
            ) : (
              <div className="timeline">
                {run.steps.map((step) => (
                  <StepRow key={step.id} step={step} />
                ))}
              </div>
            )}
          </Card>
        ) : null}

        {tab === 'tools' ? (
          <Card title={`Tool calls · ${run.toolCalls.length}`}>
            {run.toolCalls.length === 0 ? (
              <EmptyState title="No tool calls" />
            ) : (
              run.toolCalls.map((call) => <ToolCallRow key={call.id} call={call} />)
            )}
          </Card>
        ) : null}

        {tab === 'browser' ? (
          <Card title="Browser sessions" flush>
            {browser.isPending ? (
              <Loading />
            ) : browser.isError ? (
              <div className="card-body">
                <ErrorState error={browser.error} onRetry={() => void browser.refetch()} />
              </div>
            ) : (browser.data ?? []).length === 0 ? (
              <EmptyState
                title="No browser sessions"
                hint="This run did not drive a browser, or its sessions have been closed."
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Status</th>
                    <th>URL</th>
                    <th>Title</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {(browser.data ?? []).map((session) => (
                    <tr key={session.id}>
                      <td className="mono small">{shortId(session.id)}</td>
                      <td>
                        <StatusBadge status={session.status} />
                      </td>
                      <td className="truncate small" title={session.currentUrl ?? ''}>
                        {session.currentUrl === null ? (
                          EM_DASH
                        ) : (
                          <a href={session.currentUrl} target="_blank" rel="noreferrer">
                            {session.currentUrl}
                          </a>
                        )}
                      </td>
                      <td className="small truncate">{session.title ?? EM_DASH}</td>
                      <td className="muted small nowrap" title={session.updatedAt}>
                        {formatRelative(session.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        ) : null}

        {tab === 'terminal' ? (
          <Card title="Sandbox executions">
            {sandbox.isPending ? (
              <Loading />
            ) : sandbox.isError ? (
              <ErrorState error={sandbox.error} onRetry={() => void sandbox.refetch()} />
            ) : (sandbox.data ?? []).length === 0 ? (
              <EmptyState title="No sandbox executions" />
            ) : (
              (sandbox.data ?? []).map((execution: SandboxExecutionSummary) => (
                <div key={execution.id} className="card" style={{ marginBottom: 8 }}>
                  <div className="card-head">
                    <span className="row" style={{ gap: 6 }}>
                      <Dot tone={toneFor(execution.status)} />
                      <StatusBadge status={execution.status} />
                      {execution.exitCode !== null ? (
                        <Badge>exit {execution.exitCode}</Badge>
                      ) : null}
                    </span>
                    <span className="muted small">
                      {formatSpan(execution.startedAt, execution.completedAt)}
                    </span>
                  </div>
                  <div className="card-body stack-sm">
                    <Code>{execution.command}</Code>
                    {execution.stdout !== null && execution.stdout.length > 0 ? (
                      <details open>
                        <summary className="muted small" style={{ cursor: 'pointer' }}>
                          stdout
                        </summary>
                        <Code>{execution.stdout}</Code>
                      </details>
                    ) : null}
                    {execution.stderr !== null && execution.stderr.length > 0 ? (
                      <details open>
                        <summary className="muted small" style={{ cursor: 'pointer' }}>
                          stderr
                        </summary>
                        <Code>{execution.stderr}</Code>
                      </details>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </Card>
        ) : null}

        {tab === 'files' ? (
          <Card title="Files produced" flush>
            {files.length === 0 ? (
              <EmptyState
                title="No files produced"
                hint="A file appears here when a tool returns an artifact reference."
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Reference</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((file) => (
                    <tr key={`${file.ref}-${file.at}`}>
                      <td className="small">{file.toolName}</td>
                      <td className="mono small">{file.ref}</td>
                      <td className="muted small nowrap" title={file.at}>
                        {formatRelative(file.at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        ) : null}

        {tab === 'artifacts' ? (
          <Card title="Execution receipts" flush>
            {run.receipts.length === 0 ? (
              <EmptyState
                title="No receipts"
                hint="A receipt is written for every side-effecting tool call."
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Tool call</th>
                    <th>Idempotency key</th>
                    <th>Effect</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {run.receipts.map((receipt) => (
                    <tr key={receipt.id}>
                      <td className="mono small">{shortId(receipt.id)}</td>
                      <td className="mono small">{shortId(receipt.toolCallId)}</td>
                      <td className="mono small truncate" title={receipt.idempotencyKey}>
                        {receipt.idempotencyKey}
                      </td>
                      <td className="mono small truncate" title={prettyJson(receipt.effect)}>
                        {inlineJson(receipt.effect, 60)}
                      </td>
                      <td className="muted small nowrap" title={receipt.createdAt}>
                        {formatRelative(receipt.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        ) : null}

        {tab === 'approvals' ? (
          <Card title="Approvals" flush>
            {approvals.isPending ? (
              <Loading />
            ) : approvals.isError ? (
              <ErrorState error={approvals.error} onRetry={() => void approvals.refetch()} />
            ) : (approvals.data?.approvals ?? []).length === 0 ? (
              <EmptyState title="No approvals for this run" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Risk</th>
                    <th>Status</th>
                    <th>Decided</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {(approvals.data?.approvals ?? []).map((approval) => (
                    <tr key={approval.id}>
                      <td className="small">{approval.title}</td>
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
                      <td className="muted small">{approval.decidedBy ?? EM_DASH}</td>
                      <td className="muted small nowrap" title={approval.createdAt}>
                        {formatRelative(approval.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        ) : null}

        {tab === 'verification' ? (
          <div className="stack">
            {run.verifications.length === 0 ? (
              <Card>
                <EmptyState
                  title="No verifications"
                  hint="A verification row is written when a check is scheduled, and completed when it runs."
                />
              </Card>
            ) : (
              run.verifications.map((verification) => (
                <Card
                  key={verification.id}
                  title={
                    <span className="row" style={{ gap: 6 }}>
                      <span>{verification.type}</span>
                      <Badge>{verification.scope}</Badge>
                      <StatusBadge status={verification.status} />
                      {verification.passed === true ? <Badge tone="ok">passed</Badge> : null}
                      {verification.passed === false ? (
                        <Badge tone="failed">failed</Badge>
                      ) : null}
                    </span>
                  }
                  actions={
                    <span className="muted small">
                      {formatDateTime(verification.completedAt ?? verification.createdAt)}
                    </span>
                  }
                >
                  <div className="stack-sm">
                    <div className="muted small">Config</div>
                    <Code>{prettyJson(verification.config)}</Code>
                    <div className="muted small">Evidence</div>
                    <Code>{prettyJson(verification.evidence)}</Code>
                    <div>
                      <CopyButton text={prettyJson(verification.evidence)} label="Copy evidence" />
                    </div>
                  </div>
                </Card>
              ))
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}
