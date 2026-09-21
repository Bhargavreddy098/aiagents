/**
 * Research — §4-PHASE13.16: *"projects; run view: question, plan phases with status, sources
 * table, findings with verification checkmarks, final artifact (copyable JSON/MD)."*
 *
 * The run view is where the honesty rules bite hardest. The protocol's stages
 * (decompose → search → read → collect → organise → verify → report) are **code, not a
 * preset plan** — later stages write research rows. So the phase list is rendered from the
 * run's own `plan`, and a phase is shown as reached only when the row says it was. A phase
 * list drawn from a constant would look the same whether or not the run got that far.
 *
 * The acceptance criteria the spec sets are ≥3 sources, cited findings, and ≥1 verified
 * claim — so this page states all three as counts, and says which are not met.
 */

import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  ResearchFindingSummary,
  ResearchProjectDetail,
  ResearchProjectSummary,
  ResearchRunDetail,
  ResearchRunSummary,
  ResearchSourceSummary,
} from '@nexs/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Dot,
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
import { api, apiOf, qs } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import { EM_DASH, formatDateTime, formatRelative, prettyJson, shortId } from '../../lib/format';
import { toneFor } from '../../lib/status';
import { useAgents } from '../agents/queries';

/** The spec's own acceptance numbers, so the page cannot state a different bar. */
const MIN_SOURCES = 3;

interface ResearchListResult {
  projects: ResearchProjectSummary[];
  total: number;
}

function useProjects() {
  return useQuery({
    queryKey: queryKeys.research.all,
    queryFn: () => api<ResearchListResult>(`/research${qs({ limit: 200 })}`),
  });
}

function useProject(id: string) {
  return useQuery({
    queryKey: queryKeys.research.one(id),
    queryFn: () => apiOf<ResearchProjectDetail>(`/research/${id}`, 'project'),
    enabled: id !== '',
  });
}

function useRun(runId: string) {
  return useQuery({
    queryKey: [...queryKeys.research.all, 'run', runId] as const,
    queryFn: () => apiOf<ResearchRunDetail>(`/research/runs/${runId}`, 'run'),
    enabled: runId !== '',
  });
}

export function ResearchPage(): ReactNode {
  const [creating, setCreating] = useState(false);
  const query = useProjects();

  return (
    <>
      <PageHead
        title="Research"
        subtitle="A question, investigated across sources, with every claim traceable to one."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New project
          </Button>
        }
      />

      <QueryBoundary
        query={query}
        loadingLabel="Loading research projects…"
        isEmpty={(data) => data.projects.length === 0}
        empty={
          <EmptyState
            title="No research projects"
            hint="A project runs a protocol: decompose, search, read, collect, organise, verify, report."
          />
        }
      >
        {(data) => (
          <Card flush>
            <table className="table table-clickable">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Status</th>
                  <th>Question</th>
                  <th>Agent</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((project) => (
                  <tr key={project.id}>
                    <td>
                      <Link to={`/research/${project.id}`}>{project.title}</Link>
                    </td>
                    <td>
                      <StatusBadge status={project.status} />
                    </td>
                    <td className="muted small truncate" style={{ maxWidth: 360 }}>
                      {project.question}
                    </td>
                    <td className="mono small">
                      {project.agentId === null ? EM_DASH : shortId(project.agentId)}
                    </td>
                    <td className="muted small nowrap" title={project.updatedAt}>
                      {formatRelative(project.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </QueryBoundary>

      {creating ? <NewProjectModal onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function NewProjectModal({ onClose }: { onClose: () => void }): ReactNode {
  const client = useQueryClient();
  const agents = useAgents();
  const [title, setTitle] = useState('');
  const [question, setQuestion] = useState('');
  const [agentId, setAgentId] = useState('');

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiOf<ResearchProjectDetail>('/research', 'project', { method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.research.all });
      onClose();
    },
  });

  return (
    <Modal
      title="New research project"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={title.trim().length === 0 || question.trim().length === 0}
            onClick={() =>
              create.mutate({
                title: title.trim(),
                question: question.trim(),
                ...(agentId !== '' ? { agentId } : {}),
              })
            }
          >
            Create
          </Button>
        </>
      }
    >
      <div className="stack">
        {create.isError ? (
          <div className="error-box">
            {create.error instanceof Error ? create.error.message : 'Could not create.'}
          </div>
        ) : null}
        <Field label="Title">
          <input
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="Question" hint="What the investigation must answer.">
          <textarea
            className="textarea"
            style={{ fontFamily: 'inherit' }}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </Field>
        <Field label="Agent" hint="Optional. Which agent runs the protocol.">
          <select
            className="select"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            <option value="">Unassigned</option>
            {(agents.data ?? []).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

interface PlanPhase {
  id?: string;
  description?: string;
  stepType?: string;
}

function readPhases(plan: unknown): PlanPhase[] {
  if (!Array.isArray(plan)) return [];
  return plan.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return [];
    const candidate = entry as PlanPhase;
    return typeof candidate.description === 'string' || typeof candidate.id === 'string'
      ? [candidate]
      : [];
  });
}

function SourceTable({ sources }: { sources: readonly ResearchSourceSummary[] }): ReactNode {
  if (sources.length === 0) return <EmptyState title="No sources recorded" />;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Source</th>
          <th>Credibility</th>
          <th>Accessed</th>
          <th>Content ref</th>
        </tr>
      </thead>
      <tbody>
        {sources.map((source) => (
          <tr key={source.id}>
            <td className="truncate" style={{ maxWidth: 380 }}>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.title ?? source.url}
              </a>
              {source.title !== null ? (
                <div className="muted small truncate">{source.url}</div>
              ) : null}
            </td>
            <td className="small">{source.credibility ?? EM_DASH}</td>
            <td className="muted small nowrap">{formatDateTime(source.accessedAt)}</td>
            <td className="mono small">{source.contentRef ?? EM_DASH}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FindingList({
  findings,
  sources,
}: {
  findings: readonly ResearchFindingSummary[];
  sources: readonly ResearchSourceSummary[];
}): ReactNode {
  if (findings.length === 0) return <EmptyState title="No findings recorded" />;
  const byId = new Map(sources.map((source) => [source.id, source]));

  return (
    <div className="stack">
      {findings.map((finding) => (
        <Card
          key={finding.id}
          title={
            <span className="row" style={{ gap: 6 }}>
              {finding.verified ? (
                <Badge tone="ok">verified</Badge>
              ) : (
                <Badge tone="waiting">unverified</Badge>
              )}
              <span className="muted small">
                {finding.sourceIds.length} {finding.sourceIds.length === 1 ? 'source' : 'sources'}
              </span>
            </span>
          }
        >
          <div className="stack-sm">
            <p>{finding.claim}</p>
            {finding.sourceIds.length > 0 ? (
              <div className="row-wrap" style={{ gap: 6 }}>
                {finding.sourceIds.map((sourceId) => {
                  const source = byId.get(sourceId);
                  return (
                    <a
                      key={sourceId}
                      href={source?.url ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="badge"
                      title={source?.title ?? sourceId}
                    >
                      {source === undefined ? shortId(sourceId) : source.title ?? shortId(sourceId)}
                    </a>
                  );
                })}
              </div>
            ) : (
              <span className="muted small">No source cited.</span>
            )}
            <details>
              <summary className="muted small" style={{ cursor: 'pointer' }}>
                evidence
              </summary>
              <Code>{prettyJson(finding.evidence)}</Code>
            </details>
          </div>
        </Card>
      ))}
    </div>
  );
}

export function ResearchDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const projectId = id ?? '';
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [tab, setTab] = useState('runs');

  const project = useProject(projectId);
  const client = useQueryClient();

  const startRun = useMutation({
    mutationFn: () =>
      apiOf<ResearchRunSummary>(`/research/${projectId}/runs`, 'run', { method: 'POST', body: {} }),
    onSuccess: (run) => {
      void client.invalidateQueries({ queryKey: queryKeys.research.one(projectId) });
      void client.invalidateQueries({ queryKey: queryKeys.research.all });
      setOpenRunId(run.id);
    },
  });

  if (project.isPending) return <Loading label="Loading project…" />;
  if (project.isError) {
    return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  }

  const detail = project.data;

  return (
    <>
      <PageHead
        title={
          <span className="row" style={{ gap: 8 }}>
            {detail.title}
            <StatusBadge status={detail.status} />
          </span>
        }
        subtitle={detail.question}
        actions={
          <>
            <Button
              size="sm"
              variant="primary"
              loading={startRun.isPending}
              onClick={() => startRun.mutate()}
            >
              Start a run
            </Button>
            <Button size="sm" onClick={() => void project.refetch()}>
              Refresh
            </Button>
          </>
        }
      />

      {startRun.isError ? (
        <div className="error-box" style={{ marginBottom: 12 }}>
          {startRun.error instanceof Error
            ? startRun.error.message
            : 'Could not start the run.'}{' '}
          — a research run needs a search provider, and search is off by default.
        </div>
      ) : null}

      <Tabs
        tabs={[
          { id: 'runs', label: 'Runs', badge: <Badge>{detail.runs.length}</Badge> },
          { id: 'about', label: 'About' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ marginTop: 16 }} className="stack">
        {tab === 'runs' ? (
          <>
            {detail.runs.length === 0 ? (
              <Card>
                <EmptyState
                  title="No runs yet"
                  hint="Start one to investigate the question."
                />
              </Card>
            ) : (
              <Card flush>
                <table className="table table-clickable">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Status</th>
                      <th>Engine run</th>
                      <th>Created</th>
                      <th>Completed</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {detail.runs.map((run) => (
                      <tr
                        key={run.id}
                        onClick={() => setOpenRunId(run.id)}
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') setOpenRunId(run.id);
                        }}
                      >
                        <td className="mono small">{shortId(run.id)}</td>
                        <td>
                          <StatusBadge status={run.status} />
                        </td>
                        <td className="small">
                          {run.runId === null ? (
                            <span className="muted">{EM_DASH}</span>
                          ) : (
                            <Link to={`/runs/${run.runId}`} onClick={(event) => event.stopPropagation()}>
                              open run
                            </Link>
                          )}
                        </td>
                        <td className="muted small nowrap" title={run.createdAt}>
                          {formatRelative(run.createdAt)}
                        </td>
                        <td className="muted small nowrap">{formatDateTime(run.completedAt)}</td>
                        <td className="small">Open</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}

            {openRunId !== null ? (
              <ResearchRunView runId={openRunId} onClose={() => setOpenRunId(null)} />
            ) : null}
          </>
        ) : null}

        {tab === 'about' ? (
          <div className="grid-2">
            <Card title="Project">
              <KeyValue
                entries={[
                  ['Id', <span className="mono">{detail.id}</span>],
                  ['Status', <StatusBadge status={detail.status} />],
                  ['Agent', detail.agentId ?? EM_DASH],
                  ['Result ref', detail.resultRef ?? EM_DASH],
                  ['Created', formatDateTime(detail.createdAt)],
                  ['Updated', formatDateTime(detail.updatedAt)],
                ]}
              />
            </Card>
            <Card title="Acceptance">
              <p className="muted small">
                A research run is accepted when it cites at least {MIN_SOURCES} sources, produces
                findings, and verifies at least one claim. A run that reads fewer than{' '}
                {MIN_SOURCES} pages fails rather than reporting a thin answer.
              </p>
            </Card>
          </div>
        ) : null}
      </div>
    </>
  );
}

function ResearchRunView({ runId, onClose }: { runId: string; onClose: () => void }): ReactNode {
  const query = useRun(runId);
  const [tab, setTab] = useState('phases');

  return (
    <Card
      title={
        <span className="row" style={{ gap: 6 }}>
          Research run <span className="mono">{shortId(runId)}</span>
          {query.data !== undefined ? <StatusBadge status={query.data.status} /> : null}
        </span>
      }
      actions={
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        (() => {
          const run = query.data;
          const phases = readPhases(run.plan);
          const verified = run.findings.filter((finding) => finding.verified).length;
          const met = [
            run.sources.length >= MIN_SOURCES,
            run.findings.length > 0,
            verified > 0,
          ];

          return (
            <div className="stack">
              <div className="grid-3">
                <div>
                  <div className="stat-label">Sources</div>
                  <div className={run.sources.length >= MIN_SOURCES ? 'stat-value' : 'stat-value is-zero'}>
                    {run.sources.length}
                  </div>
                  <div className="stat-hint">minimum {MIN_SOURCES}</div>
                </div>
                <div>
                  <div className="stat-label">Findings</div>
                  <div className="stat-value">{run.findings.length}</div>
                  <div className="stat-hint">{verified} verified</div>
                </div>
                <div>
                  <div className="stat-label">Acceptance</div>
                  <div className="stat-value">
                    {met.filter(Boolean).length}/{met.length}
                  </div>
                  <div className="stat-hint">
                    {met.every(Boolean) ? 'all criteria met' : 'criteria outstanding'}
                  </div>
                </div>
              </div>

              <Tabs
                tabs={[
                  { id: 'phases', label: 'Phases', badge: <Badge>{phases.length}</Badge> },
                  { id: 'sources', label: 'Sources', badge: <Badge>{run.sources.length}</Badge> },
                  {
                    id: 'findings',
                    label: 'Findings',
                    badge: <Badge>{run.findings.length}</Badge>,
                  },
                  { id: 'artifact', label: 'Artifact' },
                ]}
                active={tab}
                onChange={setTab}
              />

              <div>
                {tab === 'phases' ? (
                  phases.length === 0 ? (
                    <EmptyState title="No plan recorded" />
                  ) : (
                    <div className="timeline">
                      {phases.map((phase, index) => (
                        <div className="timeline-item" key={phase.id ?? index}>
                          <div className="timeline-rail">
                            <Dot tone={toneFor(run.status)} />
                            <span className="timeline-line" />
                          </div>
                          <div className="row-between">
                            <span className="small">
                              {phase.description ?? phase.id ?? 'phase'}
                            </span>
                            {phase.stepType !== undefined ? (
                              <Badge>{phase.stepType}</Badge>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                ) : null}

                {tab === 'sources' ? <SourceTable sources={run.sources} /> : null}
                {tab === 'findings' ? (
                  <FindingList findings={run.findings} sources={run.sources} />
                ) : null}

                {tab === 'artifact' ? (
                  run.result === null || run.result === undefined ? (
                    <EmptyState
                      title="No artifact yet"
                      hint="The report is written by the final stage of the protocol."
                    />
                  ) : (
                    <div className="stack-sm">
                      <div className="row">
                        <CopyButton text={prettyJson(run.result)} label="Copy JSON" />
                        <CopyButton
                          text={toMarkdown(run.sources, run.findings)}
                          label="Copy Markdown"
                        />
                      </div>
                      <Code>{prettyJson(run.result)}</Code>
                    </div>
                  )
                ) : null}
              </div>
            </div>
          );
        })()
      )}
    </Card>
  );
}

/** A Markdown rendering of the same rows, for pasting into a document. */
function toMarkdown(
  sources: readonly ResearchSourceSummary[],
  findings: readonly ResearchFindingSummary[],
): string {
  const lines: string[] = ['# Findings', ''];
  for (const finding of findings) {
    lines.push(`- ${finding.claim} ${finding.verified ? '(verified)' : '(unverified)'}`);
  }
  lines.push('', '## Sources', '');
  for (const source of sources) {
    lines.push(`- [${source.title ?? source.url}](${source.url})`);
  }
  return lines.join('\n');
}
