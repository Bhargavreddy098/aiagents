/**
 * Connectors — §4-PHASE13.12: *"add flow (type → credentials → account selection → discovery
 * results shown); accounts, capabilities, subscriptions, test action."*
 *
 * ## Why discovery results are shown rather than a success toast
 *
 * `ConnectorTestResult` carries `discovered` and `registered` as **two** numbers, and they
 * can differ: discovery is what the provider says it can do, registration is what became
 * `Tool` rows. A connector that discovers twelve actions and registers zero is broken in a
 * way a green tick would hide — so both numbers are on screen, and a shortfall is called out.
 *
 * ## Why the credential field is a token, not a username/password pair
 *
 * `createConnectorSchema` takes `token`, and it is optional at create time so a row can exist
 * before it is usable. The form follows that: a connector can be added without a token, and
 * the account step is where a credential is actually supplied.
 */

import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CONNECTOR_TYPES, type ConnectorDetail, type ConnectorSummary } from '@nexs/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Code,
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
import { labelForStatus, toneFor } from '../../lib/status';
import { useConnectors } from '../catalog/queries';

interface ConnectorAccountRow {
  id: string;
  connectorId: string;
  label: string;
  accountId: string | null;
  scopes: string[];
  status: string;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ConnectorCapabilityRow {
  action: string;
  name: string;
  description: string | null;
  inputSchema: unknown;
  capabilities: string[];
  toolId: string | null;
}

interface ConnectorTestResult {
  connectorId: string;
  ok: boolean;
  status: string;
  discovered: number;
  registered: number;
  error: string | null;
}

/** Types that need a base URL, mirroring the server's `superRefine`. */
const NEEDS_CONFIG_URL: ReadonlySet<string> = new Set(['rest', 'webhook']);

function AddConnectorForm({ onClose }: { onClose: () => void }): ReactNode {
  const client = useQueryClient();
  const [step, setStep] = useState(1);
  const [type, setType] = useState<string>('rest');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [accountLabel, setAccountLabel] = useState('Default');
  const [result, setResult] = useState<ConnectorTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiOf<ConnectorDetail>('/connectors', 'connector', { method: 'POST', body }),
  });

  const addAccount = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      apiOf<ConnectorAccountRow>(`/connectors/${id}/accounts`, 'account', {
        method: 'POST',
        body,
      }),
  });

  const test = useMutation({
    mutationFn: (id: string) =>
      apiOf<ConnectorTestResult>(`/connectors/${id}/test`, 'test', { method: 'POST' }),
  });

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      let id = createdId;
      if (id === null) {
        const connector = await create.mutateAsync({
          type,
          name: name.trim(),
          ...(token.trim().length > 0 ? { token: token.trim() } : {}),
          ...(NEEDS_CONFIG_URL.has(type) && baseUrl.trim().length > 0
            ? { config: { baseUrl: baseUrl.trim() } }
            : {}),
        });
        id = connector.id;
        setCreatedId(id);
      }

      // The account is what carries a usable credential; a connector row alone is a
      // declaration of intent.
      await addAccount.mutateAsync({
        id,
        body: {
          label: accountLabel.trim(),
          ...(token.trim().length > 0 ? { token: token.trim() } : {}),
        },
      });

      const tested = await test.mutateAsync(id);
      setResult(tested);
      setStep(4);
      void client.invalidateQueries({ queryKey: queryKeys.connectors.all });
      void client.invalidateQueries({ queryKey: queryKeys.tools.all });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the connector.');
    }
  };

  const busy = create.isPending || addAccount.isPending || test.isPending;

  return (
    <Modal
      title={`Add a connector · step ${Math.min(step, 3)} of 3`}
      onClose={onClose}
      footer={
        step === 4 ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={
                step === 1
                  ? name.trim().length === 0
                  : step === 2
                    ? NEEDS_CONFIG_URL.has(type) && baseUrl.trim().length === 0
                    : false
              }
              onClick={() => {
                if (step < 3) {
                  setStep(step + 1);
                  return;
                }
                void submit();
              }}
            >
              {step < 3 ? 'Next' : 'Add and discover'}
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        {error !== null ? <div className="error-box">{error}</div> : null}

        {step === 1 ? (
          <>
            <Field label="Type">
              <select
                className="select"
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                {CONNECTOR_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {labelForStatus(value)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name">
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </>
        ) : null}

        {step === 2 ? (
          <>
            {NEEDS_CONFIG_URL.has(type) ? (
              <Field label="Base URL" hint="Required for this type.">
                <input
                  className="input"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </Field>
            ) : (
              <p className="muted small">
                This connector type uses a fixed vendor endpoint, so no base URL is needed.
              </p>
            )}
            <Field label="Token" hint="Stored encrypted. Optional here — the account step is where it becomes usable.">
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </Field>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <Field label="Account label" hint="How this account is identified in the workspace.">
              <input
                className="input"
                value={accountLabel}
                onChange={(event) => setAccountLabel(event.target.value)}
              />
            </Field>
            <p className="muted small">
              Adding will connect, discover the connector's capabilities and register them as tools.
            </p>
          </>
        ) : null}

        {step === 4 && result !== null ? (
          <div className="stack-sm">
            <div className="row" style={{ gap: 6 }}>
              <Badge tone={result.ok ? 'ok' : 'failed'}>{result.status}</Badge>
              <span className="small">
                {result.discovered} discovered · {result.registered} registered
              </span>
            </div>
            {result.registered < result.discovered ? (
              <div className="error-box small">
                Fewer capabilities were registered than discovered. The difference is usually a
                capability whose type has no adapter — those are refused at registration rather than
                offered and then failing.
              </div>
            ) : null}
            {result.error !== null ? <div className="error-box small">{result.error}</div> : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function ConnectorsPage(): ReactNode {
  const [adding, setAdding] = useState(false);
  const query = useConnectors();

  return (
    <>
      <PageHead
        title="Connectors"
        subtitle="External services. Each account carries the credential; each capability becomes a tool."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add connector
          </Button>
        }
      />

      <QueryBoundary
        query={query}
        loadingLabel="Loading connectors…"
        isEmpty={(rows) => rows.length === 0}
        empty={
          <EmptyState
            title="No connectors"
            hint="A connector needs an account before its actions can be used."
          />
        }
      >
        {(rows) => (
          <div className="grid-2">
            {rows.map((connector: ConnectorSummary) => (
              <Card
                key={connector.id}
                title={
                  <span className="row" style={{ gap: 6 }}>
                    <Dot tone={toneFor(connector.status)} title={connector.status} />
                    <Link to={`/connectors/${connector.id}`}>{connector.name}</Link>
                    <Badge>{connector.type}</Badge>
                  </span>
                }
                actions={<StatusBadge status={connector.status} />}
              >
                <div className="stack-sm">
                  <div className="muted small">
                    {connector.accountCount} accounts · {connector.capabilityCount} capabilities ·
                    updated {formatRelative(connector.updatedAt)}
                  </div>
                  {connector.lastError !== null ? (
                    <div className="error-box small">{connector.lastError}</div>
                  ) : null}
                  <Link className="small" to={`/connectors/${connector.id}`}>
                    Open
                  </Link>
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryBoundary>

      {adding ? <AddConnectorForm onClose={() => setAdding(false)} /> : null}
    </>
  );
}

export function ConnectorDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const connectorId = id ?? '';
  const [tab, setTab] = useState('capabilities');
  const client = useQueryClient();

  const connector = useQuery({
    queryKey: queryKeys.connectors.one(connectorId),
    queryFn: () => apiOf<ConnectorDetail>(`/connectors/${connectorId}`, 'connector'),
    enabled: connectorId !== '',
  });

  const test = useMutation({
    mutationFn: () =>
      apiOf<ConnectorTestResult>(`/connectors/${connectorId}/test`, 'test', { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.connectors.one(connectorId) });
      void client.invalidateQueries({ queryKey: queryKeys.tools.all });
    },
  });

  if (connector.isPending) return <Loading label="Loading connector…" />;
  if (connector.isError) {
    return <ErrorState error={connector.error} onRetry={() => void connector.refetch()} />;
  }

  const detail = connector.data;

  return (
    <>
      <PageHead
        title={
          <span className="row" style={{ gap: 8 }}>
            {detail.name}
            <Badge>{detail.type}</Badge>
            <StatusBadge status={detail.status} />
          </span>
        }
        subtitle={`${detail.accounts.length} accounts · ${detail.capabilities.length} capabilities`}
        actions={
          <Button size="sm" loading={test.isPending} onClick={() => test.mutate()}>
            Test action
          </Button>
        }
      />

      {test.data !== undefined ? (
        <div className={test.data.ok ? 'badge badge-ok' : 'badge badge-failed'} style={{ marginBottom: 12 }}>
          {test.data.status} · {test.data.discovered} discovered · {test.data.registered} registered
          {test.data.error !== null ? ` · ${test.data.error}` : ''}
        </div>
      ) : null}

      <Tabs
        tabs={[
          {
            id: 'capabilities',
            label: 'Capabilities',
            badge: <Badge>{detail.capabilities.length}</Badge>,
          },
          { id: 'accounts', label: 'Accounts', badge: <Badge>{detail.accounts.length}</Badge> },
          { id: 'config', label: 'Config' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ marginTop: 16 }} className="stack">
        {tab === 'capabilities' ? (
          <Card flush>
            {detail.capabilities.length === 0 ? (
              <EmptyState
                title="No capabilities"
                hint="Run a test action to discover what this connector can do."
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Capabilities</th>
                    <th>Tool</th>
                    <th>Schema</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.capabilities.map((capability: ConnectorCapabilityRow) => (
                    <tr key={capability.action}>
                      <td>
                        <div>{capability.name}</div>
                        <div className="muted mono small">{capability.action}</div>
                        {capability.description !== null ? (
                          <div className="muted small truncate">{capability.description}</div>
                        ) : null}
                      </td>
                      <td>
                        <div className="row-wrap" style={{ gap: 4 }}>
                          {capability.capabilities.map((value) => (
                            <Badge key={value}>{value}</Badge>
                          ))}
                        </div>
                      </td>
                      <td>
                        {capability.toolId === null ? (
                          <Badge tone="waiting">not registered</Badge>
                        ) : (
                          <Link to={`/tools/${capability.toolId}`}>open</Link>
                        )}
                      </td>
                      <td>
                        <details>
                          <summary className="muted small" style={{ cursor: 'pointer' }}>
                            schema
                          </summary>
                          <Code>{prettyJson(capability.inputSchema)}</Code>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        ) : null}

        {tab === 'accounts' ? (
          <Card flush>
            {detail.accounts.length === 0 ? (
              <EmptyState
                title="No accounts"
                hint="Without an account this connector has no usable credential."
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Status</th>
                    <th>Account id</th>
                    <th>Scopes</th>
                    <th>Credential</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.accounts.map((account: ConnectorAccountRow) => (
                    <tr key={account.id}>
                      <td>{account.label}</td>
                      <td>
                        <StatusBadge status={account.status} />
                      </td>
                      <td className="mono small">{account.accountId ?? EM_DASH}</td>
                      <td className="muted small">
                        {account.scopes.length === 0 ? EM_DASH : account.scopes.join(', ')}
                      </td>
                      <td className="small">{account.hasCredential ? 'stored' : 'none'}</td>
                      <td className="muted small nowrap" title={account.updatedAt}>
                        {formatRelative(account.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        ) : null}

        {tab === 'config' ? (
          <div className="grid-2">
            <Card title="Identity">
              <KeyValue
                entries={[
                  ['Id', <span className="mono">{detail.id}</span>],
                  ['Type', <Badge>{detail.type}</Badge>],
                  ['Status', <StatusBadge status={detail.status} />],
                  ['Created', formatDateTime(detail.createdAt)],
                  ['Updated', formatDateTime(detail.updatedAt)],
                ]}
              />
              {detail.lastError !== null ? (
                <div className="error-box" style={{ marginTop: 8 }}>
                  {detail.lastError}
                </div>
              ) : null}
            </Card>
            <Card title="Subscriptions">
              <p className="muted small">
                Webhook subscriptions for this connector are managed as event subscriptions, which
                are what route an inbound event to a task or a workflow. They are not part of the
                connector row, so this tab does not invent a list for them.
              </p>
              <Link className="small" to="/research">
                Research
              </Link>
            </Card>
          </div>
        ) : null}
      </div>
    </>
  );
}
