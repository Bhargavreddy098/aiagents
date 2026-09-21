/**
 * Tools — §4-PHASE13.10: *"registry table (type filter, search); details with schema viewer +
 * test-invocation panel (real invocation, real result)."*
 *
 * ## The test panel is a real invocation, and it says so
 *
 * `invokeToolSchema` exists, in its own words, because *"this is the one place the API can
 * send an email from a button that says Test"*. A side-effecting tool therefore requires
 * `confirmSideEffects: true`, and this panel will not send it until the operator ticks a box
 * that names the capability. `sideEffect` comes back on the result, so the outcome is
 * labelled rather than assumed.
 *
 * The tool's `capabilities` are the same set the approval policy reads, so a tool that shows
 * `external_side_effect` here is one that will require approval in a run.
 */

import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ToolDetail, ToolSummary } from '@nexs/shared';
import {
  Badge,
  Button,
  Card,
  Code,
  EmptyState,
  ErrorState,
  Field,
  KeyValue,
  Loading,
  PageHead,
  QueryBoundary,
  StatusBadge,
} from '../../components/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiOf } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import { EM_DASH, formatDateTime, formatDuration, prettyJson } from '../../lib/format';
import { hasSideEffects } from '@nexs/shared';
import { useTools } from '../catalog/queries';

const TOOL_TYPES = ['native', 'mcp', 'connector', 'browser', 'sandbox', 'plugin'] as const;

interface ToolInvocationView {
  toolId: string;
  name: string;
  ok: boolean;
  content: string;
  truncated: boolean;
  originalBytes: number;
  ref?: string;
  capabilities: string[];
  sideEffect: boolean;
  durationMs: number;
}

export function ToolsPage(): ReactNode {
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');

  const query = useTools({
    ...(type !== '' ? { type } : {}),
    // `q` is the server's name for the text filter (`listToolsSchema`). Sending `search` was a
    // 400, not a filter that matched nothing — see the header of `catalog/queries.ts`.
    ...(search.trim().length > 0 ? { q: search.trim() } : {}),
  });

  return (
    <>
      <PageHead
        title="Tools"
        subtitle="Everything an agent can be granted. A tool not registered here cannot be used."
      />

      <div className="toolbar">
        <input
          className="input"
          placeholder="Search tools…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search tools"
        />
        <select
          className="select"
          value={type}
          onChange={(event) => setType(event.target.value)}
          aria-label="Filter by type"
        >
          <option value="">Any type</option>
          {TOOL_TYPES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      <Card flush>
        <QueryBoundary
          query={query}
          loadingLabel="Loading tools…"
          isEmpty={(rows) => rows.length === 0}
          empty={<EmptyState title="No tools match" />}
        >
          {(rows) => (
            <table className="table table-clickable">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Capabilities</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((tool: ToolSummary) => (
                  <tr key={tool.id}>
                    <td>
                      <Link to={`/tools/${tool.id}`}>{tool.name}</Link>
                      {tool.description !== null ? (
                        <div className="muted small truncate">{tool.description}</div>
                      ) : null}
                    </td>
                    <td>
                      <Badge>{tool.type}</Badge>
                    </td>
                    <td className="mono small truncate">{tool.source}</td>
                    <td>
                      <div className="row-wrap" style={{ gap: 4 }}>
                        {tool.capabilities.length === 0 ? (
                          <span className="muted small">{EM_DASH}</span>
                        ) : (
                          tool.capabilities.map((capability) => (
                            <Badge
                              key={capability}
                              tone={
                                capability === 'read_only'
                                  ? 'ok'
                                  : hasSideEffects([capability])
                                    ? 'failed'
                                    : undefined
                              }
                            >
                              {capability}
                            </Badge>
                          ))
                        )}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={tool.status} />
                    </td>
                    <td className="muted small nowrap">{formatDateTime(tool.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </QueryBoundary>
      </Card>
    </>
  );
}

export function ToolDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const toolId = id ?? '';
  const client = useQueryClient();

  const [argsText, setArgsText] = useState('{}');
  const [confirm, setConfirm] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: queryKeys.tools.one(toolId),
    queryFn: () => apiOf<ToolDetail>(`/tools/${toolId}`, 'tool'),
    enabled: toolId !== '',
  });

  const invoke = useMutation({
    mutationFn: (args: Record<string, unknown>) =>
      apiOf<ToolInvocationView>(`/tools/${toolId}/invoke`, 'invocation', {
        method: 'POST',
        body: { args, confirmSideEffects: confirm },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.tools.all }),
  });

  if (query.isPending) return <Loading label="Loading tool…" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const tool = query.data;
  const sideEffecting = hasSideEffects(tool.capabilities);
  const result = invoke.data;

  const run = (): void => {
    setParseError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsText);
    } catch {
      setParseError('Arguments are not valid JSON.');
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setParseError('Arguments must be a JSON object.');
      return;
    }
    invoke.mutate(parsed as Record<string, unknown>);
  };

  return (
    <>
      <PageHead
        title={
          <span className="row" style={{ gap: 8 }}>
            {tool.name}
            <Badge>{tool.type}</Badge>
            <StatusBadge status={tool.status} />
          </span>
        }
        subtitle={tool.description ?? 'No description.'}
        actions={
          <>
            {tool.mcpServerId !== null ? (
              <Link className="btn btn-sm" to={`/mcp/${tool.mcpServerId}`}>
                MCP server
              </Link>
            ) : null}
            {tool.connectorAccountId !== null ? (
              <Link className="btn btn-sm" to={`/connectors/${tool.connectorAccountId}`}>
                Connector
              </Link>
            ) : null}
          </>
        }
      />

      <div className="grid-2">
        <Card title="Details">
          <KeyValue
            entries={[
              ['Id', <span className="mono">{tool.id}</span>],
              ['Source', <span className="mono">{tool.source}</span>],
              ['Type', <Badge>{tool.type}</Badge>],
              ['Provider', tool.provider ?? EM_DASH],
              ['MCP server', tool.mcpServerId ?? EM_DASH],
              ['Connector account', tool.connectorAccountId ?? EM_DASH],
              ['Created', formatDateTime(tool.createdAt)],
              ['Updated', formatDateTime(tool.updatedAt)],
            ]}
          />
          <div className="row-wrap" style={{ marginTop: 8 }}>
            {tool.capabilities.length === 0 ? (
              <span className="muted small">No declared capabilities.</span>
            ) : (
              tool.capabilities.map((capability) => (
                <Badge key={capability}>{capability}</Badge>
              ))
            )}
          </div>
        </Card>

        <Card title="Input schema">
          <Code>{prettyJson(tool.inputSchema)}</Code>
        </Card>

        <Card title="Test invocation">
          <div className="stack">
            <p className="muted small">
              This runs the tool for real. A tool with a side-effecting capability writes what it
              writes — the confirmation below is what the engine's approval policy would have asked
              for.
            </p>

            <Field label="Arguments (JSON)">
              <textarea
                className="textarea"
                value={argsText}
                onChange={(event) => setArgsText(event.target.value)}
              />
            </Field>

            {parseError !== null ? <div className="field-error">{parseError}</div> : null}

            {sideEffecting ? (
              <label className="row" style={{ alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={confirm}
                  onChange={(event) => setConfirm(event.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span className="small">
                  I understand this tool has side effects (
                  {tool.capabilities.filter((capability) => hasSideEffects([capability])).join(', ')}
                  ) and want to run it anyway.
                </span>
              </label>
            ) : null}

            <div>
              <Button
                variant="primary"
                loading={invoke.isPending}
                disabled={sideEffecting && !confirm}
                onClick={run}
              >
                Invoke
              </Button>
            </div>

            {invoke.isError ? (
              <div className="error-box">
                {invoke.error instanceof Error ? invoke.error.message : 'The invocation failed.'}
              </div>
            ) : null}
          </div>
        </Card>

        <Card
          title={
            result === undefined ? (
              'Result'
            ) : (
              <span className="row" style={{ gap: 6 }}>
                Result
                <Badge tone={result.ok ? 'ok' : 'failed'}>{result.ok ? 'ok' : 'error'}</Badge>
                {result.sideEffect ? <Badge tone="failed">side effect</Badge> : null}
                {result.truncated ? <Badge tone="waiting">truncated</Badge> : null}
                <span className="muted small">{formatDuration(result.durationMs)}</span>
              </span>
            )
          }
        >
          {result === undefined ? (
            <EmptyState title="Not invoked yet" hint="Run the tool to see its real output." />
          ) : (
            <div className="stack-sm">
              <div className="muted small">
                {result.originalBytes} bytes original
                {result.ref !== undefined ? ` · ref ${result.ref}` : ''}
              </div>
              <Code>{result.content}</Code>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
