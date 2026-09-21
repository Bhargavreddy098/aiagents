/**
 * Sandbox — §4-PHASE13.14: *"sessions, execution log, provider indicator ("in-process worker
 * — development isolation")."*
 *
 * The provider indicator is not decoration. `SandboxSessionSummary.provider` names what
 * actually ran the code, and the spec's own wording is that the in-process worker is
 * **development isolation** — it is not a container and it does not contain a determined
 * escape. Saying so on the page is the difference between a sandbox an operator trusts for
 * the wrong job and one they use knowingly.
 *
 * ## The page can now run code, and the isolation note matters more because of it
 *
 * `POST /sandbox` and `POST /sandbox/:id/exec` were both real and both unwired, so this page
 * could show what an agent had run and nothing else. With the run form added, the code executed
 * from here goes through the **same** `sandboxExecSchema` the agent's tool goes through — the
 * same provider, the same timeout ceiling, the same output truncation. There is no privileged
 * operator path, and the warning above the form says what the worker actually is.
 *
 * ## Executions are the sandbox's own record, unlike browser actions
 *
 * A browser action is a tool call. A sandbox execution is *also* its own row —
 * `SandboxExecutionSummary` with `command`, `stdout`, `stderr` and `exitCode` — and
 * `GET /sandbox/:id/executions` lists them. So this page reads the real log rather than
 * pointing at the run.
 */

import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  Code,
  Dot,
  EmptyState,
  ErrorBox,
  ErrorState,
  Field,
  Loading,
  PageHead,
  QueryBoundary,
  StatusBadge,
  Tabs,
} from '../../components/ui';
import { EM_DASH, formatRelative, formatSpan, shortId } from '../../lib/format';
import { toneFor } from '../../lib/status';
import { providerNote } from './provider-notes';
import {
  useCreateSandboxSession,
  useRunSandboxCode,
  useSandboxExecutions,
  useSandboxSessions,
} from './queries';

function ExecutionList({ sessionId }: { sessionId: string }): ReactNode {
  const query = useSandboxExecutions(sessionId);

  return (
    <QueryBoundary
      query={query}
      loadingLabel="Loading executions…"
      isEmpty={(rows) => rows.length === 0}
      empty={<EmptyState title="No executions in this session" />}
    >
      {(rows) =>
        rows.map((execution) => (
          <div className="card" key={execution.id} style={{ marginBottom: 8 }}>
            <div className="card-head">
              <span className="row" style={{ gap: 6 }}>
                <Dot tone={toneFor(execution.status)} />
                <StatusBadge status={execution.status} />
                {execution.exitCode !== null ? <Badge>exit {execution.exitCode}</Badge> : null}
                <span className="muted small">{formatSpan(execution.startedAt, execution.completedAt)}</span>
              </span>
              <span className="muted small" title={execution.startedAt}>
                {formatRelative(execution.startedAt)}
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
      }
    </QueryBoundary>
  );
}

export function SandboxPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState('sessions');
  const [openSession, setOpenSession] = useState<string | null>(id ?? null);

  const query = useSandboxSessions();

  if (query.isPending) return <Loading label="Loading sandbox sessions…" />;
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const sessions = query.data;
  const running = sessions.filter((session) => session.status === 'running');

  return (
    <>
      <PageHead
        title="Sandbox"
        subtitle="Where an agent executes code. Every execution is recorded with its output and exit code."
      />

      <Tabs
        tabs={[
          {
            id: 'sessions',
            label: 'Sessions',
            badge: <Badge>{sessions.length}</Badge>,
          },
          {
            id: 'running',
            label: 'Running',
            badge: <Badge>{running.length}</Badge>,
          },
        ]}
        active={tab}
        onChange={(next) => {
          setTab(next);
          setOpenSession(null);
        }}
      />

      <div style={{ marginTop: 16 }} className="stack">
        {tab === 'sessions' || tab === 'running' ? (
          <>
            <Card flush>
              {(tab === 'sessions' ? sessions : running).length === 0 ? (
                <EmptyState
                  title={tab === 'sessions' ? 'No sandbox sessions' : 'Nothing running'}
                  hint="A session appears when an agent with sandbox access executes code."
                />
              ) : (
                <table className="table table-clickable">
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>Provider</th>
                      <th>Status</th>
                      <th>Workdir</th>
                      <th>Run</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(tab === 'sessions' ? sessions : running).map((session) => (
                      <tr
                        key={session.id}
                        onClick={() => setOpenSession(session.id)}
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') setOpenSession(session.id);
                        }}
                      >
                        <td className="mono small">{shortId(session.id)}</td>
                        <td>
                          <Badge>{session.provider}</Badge>
                        </td>
                        <td>
                          <StatusBadge status={session.status} />
                        </td>
                        <td className="mono small truncate" title={session.workdir}>
                          {session.workdir}
                        </td>
                        <td className="small">
                          {session.runId === null ? (
                            <span className="muted">{EM_DASH}</span>
                          ) : (
                            <Link to={`/runs/${session.runId}`} onClick={(event) => event.stopPropagation()}>
                              open run
                            </Link>
                          )}
                        </td>
                        <td className="muted small nowrap" title={session.updatedAt}>
                          {formatRelative(session.updatedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            {openSession !== null ? (
              <>
                <Card
                  title={
                    <span className="row" style={{ gap: 6 }}>
                      Executions · <span className="mono">{shortId(openSession)}</span>
                    </span>
                  }
                  actions={
                    <Button size="sm" variant="ghost" onClick={() => setOpenSession(null)}>
                      Hide
                    </Button>
                  }
                >
                  <ExecutionList sessionId={openSession} />
                </Card>

                <RunCodeCard sessionId={openSession} />
              </>
            ) : (
              <Card title="Executions">
                <EmptyState
                  title="Select a session"
                  hint="Pick a row above to read its execution log, or run something in it."
                />
              </Card>
            )}
          </>
        ) : null}

        <NewSessionCard />

        <Card title="Provider isolation">
          <p className="muted small">
            The sandbox runs code in the provider named on each session. In this build that is the
            in-process worker, which is <strong>development isolation</strong> — it bounds time and
            output, and it is not a container. It is not a boundary to run untrusted code across.
          </p>
          <div className="row-wrap" style={{ marginTop: 8 }}>
            {[...new Set(sessions.map((session) => session.provider))].map((provider) => (
              <Badge key={provider} tone="waiting">
                {provider}: {providerNote(provider)}
              </Badge>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

/**
 * Running code in a session, by hand.
 *
 * The limits shown are the schema's own: 200 kB of code, a 120 s timeout ceiling, 4 MB of output.
 * They are stated as the *ceiling* rather than as defaults, because a form that silently picked
 * a timeout for you would make the field look optional when the server treats it as the thing
 * that decides whether the process is killed.
 *
 * The output is rendered from the response's `value`, which is the provider's own return — a
 * string for the in-process worker. When a provider returns a structure the form says so rather
 * than stringifying it into something that looks like output.
 */
function RunCodeCard({ sessionId }: { sessionId: string }): ReactNode {
  const run = useRunSandboxCode();
  const [code, setCode] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('');

  const parsedTimeout = timeoutMs.trim() === '' ? null : Number(timeoutMs);
  const timeoutValid =
    parsedTimeout === null || (Number.isFinite(parsedTimeout) && parsedTimeout > 0 && parsedTimeout <= 120_000);

  return (
    <Card title="Run code in this session">
      <form
        className="stack-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim() === '' || !timeoutValid) return;
          run.mutate(
            {
              sessionId,
              code,
              ...(parsedTimeout === null ? {} : { timeoutMs: parsedTimeout }),
            },
            { onSuccess: () => setCode('') },
          );
        }}
      >
        <Field
          label="Code"
          hint="Executed by the session's provider under the same limits the agent's tool uses — up to 200,000 characters, a 120 s timeout ceiling, 4 MB of output."
        >
          <textarea
            className="input mono"
            rows={7}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="print('hello')"
            disabled={run.isPending}
          />
        </Field>

        <Field
          label="Timeout (ms)"
          hint="Optional. Leave it empty for the provider's default; the ceiling is 120000."
        >
          <input
            className="input mono"
            value={timeoutMs}
            onChange={(event) => setTimeoutMs(event.target.value)}
            placeholder="5000"
            inputMode="numeric"
            disabled={run.isPending}
          />
        </Field>
        {!timeoutValid ? (
          <span className="field-error">A timeout must be a number between 1 and 120000.</span>
        ) : null}

        <div className="row">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={run.isPending}
            disabled={code.trim() === '' || !timeoutValid}
          >
            Run
          </Button>
          <span className="muted small">
            The execution is recorded on this session and appears above once it finishes.
          </span>
        </div>
      </form>

      {run.isError ? (
        <ErrorBox
          message={run.error instanceof Error ? run.error.message : 'The execution was refused.'}
        />
      ) : null}

      {run.data !== undefined ? (
        <div className="stack-sm" style={{ marginTop: 10 }}>
          <div className="row small">
            <Badge tone={run.data.execution.status === 'failed' ? 'failed' : 'ok'}>
              {run.data.execution.status}
            </Badge>
            <span className="muted">
              {run.data.durationMs} ms
              {run.data.terminatedReason === undefined || run.data.terminatedReason === null
                ? ''
                : ` · stopped: ${run.data.terminatedReason}`}
              {run.data.outputTruncated ? ' · output truncated' : ''}
            </span>
          </div>
          {typeof run.data.value === 'string' ? (
            <Code>{run.data.value}</Code>
          ) : run.data.value === undefined || run.data.value === null ? (
            <p className="muted small">
              The provider returned no value. The exit code and streams are on the execution row
              above.
            </p>
          ) : (
            <Code>{JSON.stringify(run.data.value, null, 2)}</Code>
          )}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Opening a session by hand.
 *
 * The page's own empty state says a session appears when an agent executes code, which was true
 * when the page could only read. `POST /sandbox` is a real route, so an operator can open one —
 * and a sandbox with no run is a scratch session, stated as such rather than implied to be
 * agent work.
 */
function NewSessionCard(): ReactNode {
  const create = useCreateSandboxSession();

  return (
    <Card title="Open a session">
      <div className="row">
        <Button size="sm" variant="primary" loading={create.isPending} onClick={() => create.mutate({})}>
          New sandbox session
        </Button>
        <span className="muted small">
          Opens a session with no run attached — a scratch space you drive from the panel above.
          Its executions are recorded the same way an agent's are.
        </span>
      </div>
      {create.isError ? (
        <ErrorBox
          message={create.error instanceof Error ? create.error.message : 'Could not open a session.'}
        />
      ) : null}
    </Card>
  );
}
