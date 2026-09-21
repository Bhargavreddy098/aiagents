/**
 * MCP — §4-PHASE13.11: *"servers list (status, tool count, last connected); add form (stdio:
 * command/args/env; http: url/headers); tools/resources/prompts tables; reconnect/delete."*
 *
 * ## The add form asks for what the transport actually needs
 *
 * `createMcpServerSchema` uses a `superRefine`: a `stdio` server needs a `command`, and a
 * `streamable-http` server needs a `url`. The form switches its fields on the transport for
 * the same reason — asking for a command when the server is remote produces a validation
 * error the operator cannot act on.
 *
 * ## The `env` block refuses newlines, and the form says why
 *
 * `envBlock` rejects a newline in a value. That is not fussiness: the block is passed to a
 * spawned process, and a newline is how an environment entry is terminated — so a value
 * containing one can inject a second variable. The hint below states the rule rather than
 * letting the server's error be the first the operator hears of it.
 */

import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { McpServerDetail, McpServerSummary } from '@nexs/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
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
import { apiOf } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import { EM_DASH, formatDateTime, formatRelative, prettyJson } from '../../lib/format';
import { toneFor } from '../../lib/status';
import { useMcpServers } from '../catalog/queries';

interface McpToolRow {
  externalId: string;
  name: string;
  description: string | null;
  inputSchema: unknown;
  enabled: boolean;
  toolId: string | null;
  capabilities: string[];
}

/** `env` as a `KEY=value` block, one per line — the shape an operator already knows. */
function parseEnvBlock(text: string): Record<string, string> | null {
  const env: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) return null;
    env[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  return env;
}

function AddServerForm({ onClose }: { onClose: () => void }): ReactNode {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'streamable-http'>('stdio');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [url, setUrl] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [envText, setEnvText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiOf<McpServerDetail>('/mcp', 'server', { method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.mcp.all });
      void client.invalidateQueries({ queryKey: queryKeys.tools.all });
      onClose();
    },
  });

  const submit = (): void => {
    setError(null);

    const args = argsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    let headers: Record<string, string> | undefined;
    if (headersText.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(headersText);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setError('Headers must be a JSON object.');
          return;
        }
        headers = parsed as Record<string, string>;
      } catch {
        setError('Headers are not valid JSON.');
        return;
      }
    }

    let env: Record<string, string> | undefined;
    if (envText.trim().length > 0) {
      const parsed = parseEnvBlock(envText);
      if (parsed === null) {
        setError('Each environment line must read KEY=value.');
        return;
      }
      env = parsed;
    }

    create.mutate({
      name: name.trim(),
      transport,
      connect: true,
      ...(transport === 'stdio'
        ? {
            command: command.trim(),
            ...(args.length > 0 ? { args } : {}),
            ...(env !== undefined ? { env } : {}),
          }
        : {
            url: url.trim(),
            ...(headers !== undefined ? { headers } : {}),
          }),
    });
  };

  return (
    <Modal
      title="Add an MCP server"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={name.trim().length === 0}
            onClick={submit}
          >
            Add and connect
          </Button>
        </>
      }
    >
      <div className="stack">
        {error !== null ? <div className="error-box">{error}</div> : null}
        {create.isError ? (
          <div className="error-box">
            {create.error instanceof Error ? create.error.message : 'Could not add the server.'}
          </div>
        ) : null}

        <Field label="Name">
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="Transport">
          <select
            className="select"
            value={transport}
            onChange={(event) => setTransport(event.target.value as 'stdio' | 'streamable-http')}
          >
            <option value="stdio">stdio — a local process</option>
            <option value="streamable-http">streamable-http — a remote endpoint</option>
          </select>
        </Field>

        {transport === 'stdio' ? (
          <>
            <Field label="Command" hint="The executable to launch.">
              <input
                className="input"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
              />
            </Field>
            <Field label="Arguments" hint="One per line.">
              <textarea
                className="textarea"
                value={argsText}
                onChange={(event) => setArgsText(event.target.value)}
              />
            </Field>
            <Field
              label="Environment"
              hint="One KEY=value per line. A value cannot contain a newline — that is how an entry ends, and allowing one would let a value inject a second variable."
            >
              <textarea
                className="textarea"
                value={envText}
                onChange={(event) => setEnvText(event.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="URL">
              <input
                className="input"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </Field>
            <Field label="Headers" hint="A JSON object. Values are stored encrypted.">
              <textarea
                className="textarea"
                value={headersText}
                onChange={(event) => setHeadersText(event.target.value)}
              />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

export function McpPage(): ReactNode {
  const [adding, setAdding] = useState(false);
  const query = useMcpServers();
  const client = useQueryClient();

  const reconnect = useMutation({
    mutationFn: (id: string) =>
      apiOf<McpServerDetail>(`/mcp/${id}/reconnect`, 'server', { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.mcp.all });
      void client.invalidateQueries({ queryKey: queryKeys.tools.all });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiOf<McpServerDetail>(`/mcp/${id}`, 'server', { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.mcp.all }),
  });

  return (
    <>
      <PageHead
        title="MCP"
        subtitle="Model Context Protocol servers. Their tools become tool rows an agent can be granted."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add server
          </Button>
        }
      />

      <QueryBoundary
        query={query}
        loadingLabel="Loading MCP servers…"
        isEmpty={(rows) => rows.length === 0}
        empty={
          <EmptyState
            title="No MCP servers"
            hint="A stdio server runs as a child process; a streamable-http server is remote."
          />
        }
      >
        {(rows) => (
          <div className="grid-2">
            {rows.map((server: McpServerSummary) => (
              <Card
                key={server.id}
                title={
                  <span className="row" style={{ gap: 6 }}>
                    <Dot tone={toneFor(server.status)} title={server.status} />
                    <Link to={`/mcp/${server.id}`}>{server.name}</Link>
                    <Badge>{server.transport}</Badge>
                  </span>
                }
                actions={<StatusBadge status={server.status} />}
              >
                <div className="stack-sm">
                  <div className="muted small">
                    {server.toolCount} tools
                    {server.pid !== null ? ` · pid ${server.pid}` : ''}
                    {' · last connected '}
                    {server.lastConnectedAt === null
                      ? 'never'
                      : formatRelative(server.lastConnectedAt)}
                  </div>

                  {server.lastError !== null ? (
                    <div className="error-box small">{server.lastError}</div>
                  ) : null}

                  <div className="row-wrap">
                    <Button
                      size="sm"
                      loading={reconnect.isPending}
                      onClick={() => reconnect.mutate(server.id)}
                    >
                      Reconnect
                    </Button>
                    <Link className="btn btn-sm" to={`/mcp/${server.id}`}>
                      Open
                    </Link>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={remove.isPending}
                      onClick={() => remove.mutate(server.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryBoundary>

      {adding ? <AddServerForm onClose={() => setAdding(false)} /> : null}
    </>
  );
}

export function McpDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const serverId = id ?? '';
  const [tab, setTab] = useState('tools');

  const server = useQuery({
    queryKey: queryKeys.mcp.one(serverId),
    queryFn: () => apiOf<McpServerDetail>(`/mcp/${serverId}`, 'server'),
    enabled: serverId !== '',
  });

  const tools = useQuery({
    queryKey: [...queryKeys.mcp.one(serverId), 'tools'] as const,
    queryFn: () => apiOf<McpToolRow[]>(`/mcp/${serverId}/tools`, 'tools'),
    enabled: serverId !== '' && tab === 'tools',
  });

  const resources = useQuery({
    queryKey: queryKeys.mcp.resources(serverId),
    queryFn: () => apiOf<unknown[]>(`/mcp/${serverId}/resources`, 'resources'),
    enabled: serverId !== '' && tab === 'resources',
  });

  const prompts = useQuery({
    queryKey: queryKeys.mcp.prompts(serverId),
    queryFn: () => apiOf<unknown[]>(`/mcp/${serverId}/prompts`, 'prompts'),
    enabled: serverId !== '' && tab === 'prompts',
  });

  if (server.isPending) return <Loading label="Loading server…" />;
  if (server.isError) {
    return <ErrorState error={server.error} onRetry={() => void server.refetch()} />;
  }

  const detail = server.data;

  return (
    <>
      <PageHead
        title={
          <span className="row" style={{ gap: 8 }}>
            {detail.name}
            <Badge>{detail.transport}</Badge>
            <StatusBadge status={detail.status} />
          </span>
        }
        subtitle={`${detail.toolCount} tools contributed.`}
      />

      <Tabs
        tabs={[
          { id: 'tools', label: 'Tools', badge: <Badge>{detail.toolCount}</Badge> },
          { id: 'resources', label: 'Resources' },
          { id: 'prompts', label: 'Prompts' },
          { id: 'config', label: 'Config' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ marginTop: 16 }} className="stack">
        {tab === 'tools' ? (
          <Card flush>
            <QueryBoundary
              query={tools}
              isEmpty={(rows) => rows.length === 0}
              empty={<EmptyState title="No tools" />}
            >
              {(rows) => (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th>Capabilities</th>
                      <th>Registered</th>
                      <th>Enabled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((tool) => (
                      <tr key={tool.externalId}>
                        <td>
                          {tool.toolId === null ? (
                            tool.name
                          ) : (
                            <Link to={`/tools/${tool.toolId}`}>{tool.name}</Link>
                          )}
                          <div className="muted mono small">{tool.externalId}</div>
                        </td>
                        <td>
                          <div className="row-wrap" style={{ gap: 4 }}>
                            {tool.capabilities.map((capability) => (
                              <Badge key={capability}>{capability}</Badge>
                            ))}
                          </div>
                        </td>
                        <td>
                          {tool.toolId === null ? (
                            <Badge tone="waiting">no row</Badge>
                          ) : (
                            <Badge tone="ok">yes</Badge>
                          )}
                        </td>
                        <td>{tool.enabled ? 'yes' : 'no'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </QueryBoundary>
          </Card>
        ) : null}

        {tab === 'resources' ? (
          <Card flush>
            <QueryBoundary
              query={resources}
              isEmpty={(rows) => rows.length === 0}
              empty={<EmptyState title="No resources" hint="This server exposes none." />}
            >
              {(rows) => (
                <table className="table">
                  <tbody>
                    {rows.map((resource, index) => (
                      <tr key={index}>
                        <td className="mono small">{prettyJson(resource)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </QueryBoundary>
          </Card>
        ) : null}

        {tab === 'prompts' ? (
          <Card flush>
            <QueryBoundary
              query={prompts}
              isEmpty={(rows) => rows.length === 0}
              empty={<EmptyState title="No prompts" hint="This server exposes none." />}
            >
              {(rows) => (
                <table className="table">
                  <tbody>
                    {rows.map((prompt, index) => (
                      <tr key={index}>
                        <td className="mono small">{prettyJson(prompt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </QueryBoundary>
          </Card>
        ) : null}

        {tab === 'config' ? (
          <div className="grid-2">
            <Card title="Connection">
              <KeyValue
                entries={[
                  ['Id', <span className="mono">{detail.id}</span>],
                  ['Transport', <Badge>{detail.transport}</Badge>],
                  ['Status', <StatusBadge status={detail.status} />],
                  ['PID', detail.pid === null ? EM_DASH : String(detail.pid)],
                  ['Command', detail.command ?? EM_DASH],
                  ['Arguments', detail.args.length === 0 ? EM_DASH : detail.args.join(' ')],
                  ['URL', detail.url ?? EM_DASH],
                  ['Header names', detail.headerNames.length === 0 ? EM_DASH : detail.headerNames.join(', ')],
                  ['Has env', detail.hasEnv ? 'yes' : 'no'],
                  ['Created', formatDateTime(detail.createdAt)],
                  ['Last connected', formatDateTime(detail.lastConnectedAt)],
                ]}
              />
              {detail.lastError !== null ? (
                <div className="error-box" style={{ marginTop: 8 }}>
                  {detail.lastError}
                </div>
              ) : null}
            </Card>
            <Card title="Note on secrets">
              <p className="muted small">
                Header values and environment values are stored encrypted and are never returned by
                the API — this page can list the header <em>names</em> because that is what an
                operator needs to confirm a configuration, and nothing more is available to show.
              </p>
            </Card>
          </div>
        ) : null}
      </div>
    </>
  );
}
