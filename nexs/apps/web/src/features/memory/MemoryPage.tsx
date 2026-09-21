/**
 * Memory — §4-PHASE13.15: *"scope/agent filters, semantic search box, CRUD."*
 *
 * ## The search endpoint is a `GET`, not the spec's `POST`
 *
 * §5's API table lists `POST /search` under `/api/memory`. The route that exists is
 * `GET /memory/search` — `routes/memory.ts` declares `router.get('/search', ...)`, and its
 * schema takes the query from the query string. This page calls the route that is actually
 * mounted; calling the documented one would 404.
 *
 * ## Two filters that cannot both apply
 *
 * `listMemoriesSchema` has both `agentId` and `workspace`, and the service **rejects** the
 * pair with a validation error: they select different pools. The UI therefore treats them as
 * one choice — All / Workspace only / a specific agent — so the impossible combination is
 * unreachable rather than merely refused.
 */

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MEMORY_SCOPES, type MemorySummary } from '@nexs/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  PageHead,
  QueryBoundary,
  Tabs,
} from '../../components/ui';
import { api, apiOf, qs, request } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import { EM_DASH, formatRelative, prettyJson, shortId } from '../../lib/format';
import { labelForStatus } from '../../lib/status';
import { useAgents } from '../agents/queries';

interface MemoryListResult {
  memories: MemorySummary[];
  total: number;
}

interface MemorySearchResult {
  memories: (MemorySummary & { score: number | null })[];
  mode: string;
}

/** The three mutually exclusive pool selections. */
type Pool = 'all' | 'workspace' | 'agent';

export function MemoryPage(): ReactNode {
  const [tab, setTab] = useState('browse');
  const [pool, setPool] = useState<Pool>('all');
  const [agentId, setAgentId] = useState('');
  const [scope, setScope] = useState('');
  const [searchText, setSearchText] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const client = useQueryClient();
  const agents = useAgents();

  const list = useQuery({
    queryKey: [
      ...queryKeys.memory,
      { pool, agentId, scope },
    ] as const,
    queryFn: () =>
      api<MemoryListResult>(
        `/memory${qs({
          ...(pool === 'workspace' ? { workspace: true } : {}),
          ...(pool === 'agent' && agentId !== '' ? { agentId } : {}),
          ...(scope !== '' ? { scope } : {}),
          limit: 200,
        })}`,
      ),
    enabled: tab === 'browse',
  });

  const search = useQuery({
    queryKey: [...queryKeys.memory, 'search', { submittedQuery, agentId, scope }] as const,
    queryFn: () =>
      api<MemorySearchResult>(
        `/memory/search${qs({
          q: submittedQuery,
          ...(agentId !== '' ? { agentId } : {}),
          includeWorkspace: true,
          ...(scope !== '' ? { scope } : {}),
          limit: 50,
        })}`,
      ),
    enabled: tab === 'search' && submittedQuery !== '',
  });

  const remove = useMutation({
    mutationFn: (id: string) => request(`/memory/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.memory }),
  });

  return (
    <>
      <PageHead
        title="Memory"
        subtitle="Stored facts. Scoped to an agent, a goal, a task, or the whole workspace."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            Add memory
          </Button>
        }
      />

      <Tabs
        tabs={[
          { id: 'browse', label: 'Browse' },
          { id: 'search', label: 'Search' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div className="toolbar" style={{ marginTop: 16 }}>
        <select
          className="select"
          value={pool}
          onChange={(event) => setPool(event.target.value as Pool)}
          aria-label="Memory pool"
        >
          <option value="all">All memory</option>
          <option value="workspace">Workspace only</option>
          <option value="agent">A specific agent</option>
        </select>

        {pool === 'agent' ? (
          <select
            className="select"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            aria-label="Agent"
          >
            <option value="">Select an agent…</option>
            {(agents.data ?? []).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        ) : null}

        <select
          className="select"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          aria-label="Scope"
        >
          <option value="">Any scope</option>
          {MEMORY_SCOPES.map((value) => (
            <option key={value} value={value}>
              {labelForStatus(value)}
            </option>
          ))}
        </select>

        {tab === 'search' ? (
          <>
            <input
              className="input"
              placeholder="Search memory…"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && searchText.trim().length > 0) {
                  setSubmittedQuery(searchText.trim());
                }
              }}
              aria-label="Search memory"
            />
            <Button
              disabled={searchText.trim().length === 0}
              onClick={() => setSubmittedQuery(searchText.trim())}
            >
              Search
            </Button>
          </>
        ) : null}
      </div>

      {tab === 'browse' ? (
        <Card flush>
          <QueryBoundary
            query={list}
            loadingLabel="Loading memory…"
            isEmpty={(data) => data.memories.length === 0}
            empty={
              <EmptyState
                title="No memory matches"
                hint="An agent writes memory during a run, or you can add one above."
              />
            }
          >
            {(data) => (
              <>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Content</th>
                      <th>Scope</th>
                      <th>Owner</th>
                      <th>Embedding</th>
                      <th>Updated</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.memories.map((memory) => (
                      <tr key={memory.id}>
                        <td className="truncate" style={{ maxWidth: 420 }}>
                          {memory.content}
                        </td>
                        <td>
                          <Badge>{memory.scope}</Badge>
                        </td>
                        <td className="muted small">
                          {memory.agentId !== null ? (
                            <Link to={`/agents/${memory.agentId}`}>
                              agent {shortId(memory.agentId)}
                            </Link>
                          ) : memory.goalId !== null ? (
                            <Link to={`/goals/${memory.goalId}`}>goal {shortId(memory.goalId)}</Link>
                          ) : memory.taskId !== null ? (
                            <Link to={`/tasks/${memory.taskId}`}>task {shortId(memory.taskId)}</Link>
                          ) : (
                            'workspace'
                          )}
                        </td>
                        <td>
                          {memory.hasEmbedding ? (
                            <Badge tone="ok">yes</Badge>
                          ) : (
                            <Badge tone="waiting">no</Badge>
                          )}
                        </td>
                        <td className="muted small nowrap" title={memory.updatedAt}>
                          {formatRelative(memory.updatedAt)}
                        </td>
                        <td>
                          <Button
                            size="sm"
                            variant="danger"
                            loading={remove.isPending}
                            onClick={() => remove.mutate(memory.id)}
                          >
                            Delete
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="pager">
                  <span className="muted small grow">
                    {data.memories.length} of {data.total}
                  </span>
                </div>
              </>
            )}
          </QueryBoundary>
        </Card>
      ) : (
        <Card
          title={
            search.data === undefined ? 'Search' : `Results · mode ${search.data.mode}`
          }
          flush
        >
          {submittedQuery === '' ? (
            <EmptyState
              title="Type a query"
              hint="Search is semantic where embeddings exist, and keyword otherwise — the mode used is reported above."
            />
          ) : (
            <QueryBoundary
              query={search}
              loadingLabel="Searching…"
              isEmpty={(data) => data.memories.length === 0}
              empty={<EmptyState title={`Nothing matches "${submittedQuery}"`} />}
            >
              {(data) => (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Content</th>
                      <th>Scope</th>
                      <th className="right">Score</th>
                      <th>Metadata</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.memories.map((memory) => (
                      <tr key={memory.id}>
                        <td style={{ maxWidth: 420 }}>{memory.content}</td>
                        <td>
                          <Badge>{memory.scope}</Badge>
                        </td>
                        <td className="right small">
                          {memory.score === null ? EM_DASH : memory.score.toFixed(3)}
                        </td>
                        <td className="mono small truncate">
                          {memory.metadata === null ? EM_DASH : prettyJson(memory.metadata)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </QueryBoundary>
          )}
        </Card>
      )}

      {creating ? <AddMemoryModal onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function AddMemoryModal({ onClose }: { onClose: () => void }): ReactNode {
  const client = useQueryClient();
  const agents = useAgents();
  const [content, setContent] = useState('');
  const [scope, setScope] = useState('');
  const [agentId, setAgentId] = useState('');
  const [metadataText, setMetadataText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiOf<MemorySummary>('/memory', 'memory', { method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.memory });
      onClose();
    },
  });

  const submit = (): void => {
    setError(null);
    let metadata: Record<string, unknown> | undefined;
    if (metadataText.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(metadataText);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setError('Metadata must be a JSON object.');
          return;
        }
        metadata = parsed as Record<string, unknown>;
      } catch {
        setError('Metadata is not valid JSON.');
        return;
      }
    }

    create.mutate({
      content: content.trim(),
      ...(scope !== '' ? { scope } : {}),
      // Omitted means workspace memory, which is the right default for something a person
      // typed — the schema says so, and scoping it to an arbitrary agent would hide it.
      ...(agentId !== '' ? { agentId } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  };

  return (
    <Modal
      title="Add memory"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={content.trim().length === 0}
            onClick={submit}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        {error !== null ? <div className="error-box">{error}</div> : null}
        {create.isError ? (
          <div className="error-box">
            {create.error instanceof Error ? create.error.message : 'Could not save.'}
          </div>
        ) : null}

        <Field label="Content">
          <textarea
            className="textarea"
            style={{ fontFamily: 'inherit' }}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>

        <Field label="Scope" hint="Leave unset for the default.">
          <select
            className="select"
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          >
            <option value="">Default</option>
            {MEMORY_SCOPES.map((value) => (
              <option key={value} value={value}>
                {labelForStatus(value)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Agent" hint="Leave empty for workspace memory.">
          <select
            className="select"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            <option value="">Workspace</option>
            {(agents.data ?? []).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Metadata (JSON)" hint="Optional.">
          <textarea
            className="textarea"
            value={metadataText}
            onChange={(event) => setMetadataText(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
