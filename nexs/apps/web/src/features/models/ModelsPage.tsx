/**
 * Models — §4-PHASE13.9: *"Providers tab (cards: status dot, model count, last sync; Test
 * Connection / Sync Models / Edit) + Models table (capabilities chips, context window,
 * enabled toggle). Provider form: type → dynamic fields → key entry (show-once, then
 * masked)."*
 *
 * ## "Show-once, then masked" is enforced by the server, and the form has to say so
 *
 * `createProviderSchema.apiKey` is documented as *"write-only, never echoed back, never
 * logged"*, and `ProviderSummary` carries only `keyPrefix` and `hasCredential`. So there is
 * nothing for a form to re-display — the honest UI is a key field that clears on save and a
 * confirmation that names the stored prefix. A field that appeared to hold the key would be
 * a lie the next page load would expose.
 *
 * The dynamic fields come from the provider type, because `baseUrl` is mandatory for a
 * self-hosted endpoint and meaningless for a hosted one — asking for it always would train
 * people to paste something wrong.
 */

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PROVIDER_TYPES, type ModelSummary, type ProviderSummary } from '@nexs/shared';
import {
  Badge,
  Button,
  Card,
  Dot,
  EmptyState,
  Field,
  Modal,
  PageHead,
  QueryBoundary,
  StatusBadge,
  Tabs,
} from '../../components/ui';
import { EM_DASH, formatDateTime, formatNumber, formatRelative } from '../../lib/format';
import { labelForStatus, toneFor } from '../../lib/status';
import {
  useCreateProvider,
  useModelList,
  useProviders,
  useSyncProvider,
  useTestProvider,
  useUpdateModel,
  useUpdateProvider,
} from './queries';

/** Types where a self-hosted base URL is the only way to reach the service. */
const NEEDS_BASE_URL: ReadonlySet<string> = new Set([
  'local',
  'ollama',
  'openai-compatible',
  'azure-openai',
]);

/** Types that use Azure's deployment addressing. */
const NEEDS_AZURE_IDS: ReadonlySet<string> = new Set(['azure-openai']);

interface ProviderFormState {
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  organizationId: string;
  projectId: string;
  verify: boolean;
}

const BLANK_FORM: ProviderFormState = {
  name: '',
  type: 'openai',
  baseUrl: '',
  apiKey: '',
  organizationId: '',
  projectId: '',
  verify: true,
};

function ProviderForm({
  onClose,
  editing,
}: {
  onClose: () => void;
  editing: ProviderSummary | null;
}): ReactNode {
  const [form, setForm] = useState<ProviderFormState>(
    editing === null
      ? BLANK_FORM
      : {
          ...BLANK_FORM,
          name: editing.name,
          type: editing.type,
          baseUrl: editing.baseUrl ?? '',
        },
  );
  const [savedPrefix, setSavedPrefix] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useCreateProvider();
  const update = useUpdateProvider(editing?.id ?? '');
  const patch = (changes: Partial<ProviderFormState>): void =>
    setForm((current) => ({ ...current, ...changes }));

  const submit = async (): Promise<void> => {
    setError(null);
    const body = {
      name: form.name.trim(),
      ...(form.baseUrl.trim().length > 0 ? { baseUrl: form.baseUrl.trim() } : {}),
      // Only sent when typed. An empty string would be a rotation to nothing.
      ...(form.apiKey.trim().length > 0 ? { apiKey: form.apiKey.trim() } : {}),
      ...(form.organizationId.trim().length > 0
        ? { organizationId: form.organizationId.trim() }
        : {}),
      ...(form.projectId.trim().length > 0 ? { projectId: form.projectId.trim() } : {}),
    };

    try {
      if (editing === null) {
        const created = await create.mutateAsync({ ...body, type: form.type, verify: form.verify });
        setSavedPrefix(created.keyPrefix);
        patch({ apiKey: '' });
      } else {
        const updated = await update.mutateAsync(body);
        setSavedPrefix(updated.keyPrefix);
        patch({ apiKey: '' });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the provider.');
    }
  };

  const busy = create.isPending || update.isPending;

  return (
    <Modal
      title={editing === null ? 'Add a provider' : `Edit ${editing.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {savedPrefix === null ? 'Cancel' : 'Done'}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {editing === null ? 'Add provider' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {error !== null ? <div className="error-box">{error}</div> : null}

        {savedPrefix !== null ? (
          <div className="card">
            <div className="card-body stack-sm">
              <strong className="small">Credential stored.</strong>
              <span className="muted small">
                The key is never returned again. The stored credential shows as{' '}
                <span className="mono">{savedPrefix ?? '(no prefix)'}</span>.
              </span>
            </div>
          </div>
        ) : null}

        <Field label="Name" hint="How this provider appears in the workspace.">
          <input
            className="input"
            value={form.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </Field>

        <Field label="Type">
          <select
            className="select"
            value={form.type}
            disabled={editing !== null}
            onChange={(event) => patch({ type: event.target.value })}
          >
            {PROVIDER_TYPES.map((type) => (
              <option key={type} value={type}>
                {labelForStatus(type)}
              </option>
            ))}
          </select>
        </Field>

        {NEEDS_BASE_URL.has(form.type) ? (
          <Field
            label="Base URL"
            hint={
              form.type === 'azure-openai'
                ? 'Your Azure endpoint, e.g. https://<resource>.openai.azure.com'
                : 'Where the endpoint lives.'
            }
          >
            <input
              className="input"
              value={form.baseUrl}
              onChange={(event) => patch({ baseUrl: event.target.value })}
            />
          </Field>
        ) : null}

        {NEEDS_AZURE_IDS.has(form.type) ? (
          <>
            <Field label="Organization id" hint="Optional.">
              <input
                className="input"
                value={form.organizationId}
                onChange={(event) => patch({ organizationId: event.target.value })}
              />
            </Field>
            <Field label="Project id" hint="Optional.">
              <input
                className="input"
                value={form.projectId}
                onChange={(event) => patch({ projectId: event.target.value })}
              />
            </Field>
          </>
        ) : null}

        <Field
          label="API key"
          hint={
            editing === null
              ? 'Stored encrypted. It will not be shown again.'
              : 'Leave blank to keep the existing credential. Filling it in rotates the key.'
          }
        >
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={form.apiKey}
            onChange={(event) => patch({ apiKey: event.target.value })}
          />
        </Field>

        {editing === null ? (
          <Field label="Verify on save" hint="Probes the endpoint and syncs its model list.">
            <input
              type="checkbox"
              checked={form.verify}
              onChange={(event) => patch({ verify: event.target.checked })}
            />
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}

function ProviderCard({
  provider,
  onEdit,
}: {
  provider: ProviderSummary;
  onEdit: () => void;
}): ReactNode {
  const test = useTestProvider();
  const sync = useSyncProvider();

  const result = test.data;

  return (
    <Card
      title={
        <span className="row" style={{ gap: 6 }}>
          <Dot tone={toneFor(provider.status)} title={provider.status} />
          {provider.name}
          {!provider.enabled ? <Badge>disabled</Badge> : null}
        </span>
      }
      actions={<Badge>{provider.type}</Badge>}
    >
      <div className="stack-sm">
        <div className="row-wrap small">
          <StatusBadge status={provider.status} />
          <span className="muted">{formatNumber(provider.modelCount)} models</span>
          <span className="muted" title={provider.lastModelSync ?? ''}>
            synced {provider.lastModelSync === null ? 'never' : formatRelative(provider.lastModelSync)}
          </span>
        </div>

        <div className="muted small">
          Credential:{' '}
          {provider.hasCredential ? (
            <span className="mono">{provider.keyPrefix ?? 'stored'}</span>
          ) : (
            'none'
          )}
          {provider.baseUrl !== null ? (
            <>
              {' · '}
              <span className="mono truncate">{provider.baseUrl}</span>
            </>
          ) : null}
        </div>

        {result !== undefined ? (
          <div className={result.status === 'healthy' ? 'badge badge-ok' : 'badge badge-failed'}>
            {result.status}
            {result.httpStatus !== null ? ` · HTTP ${result.httpStatus}` : ''}
            {result.reason !== null ? ` · ${result.reason}` : ''}
          </div>
        ) : null}

        {sync.data !== undefined ? (
          <div className="muted small">
            Synced: {sync.data.created} new, {sync.data.existing} existing, {sync.data.total} total.
            {sync.data.warning !== null ? ` ${sync.data.warning}` : ''}
          </div>
        ) : null}

        <div className="row-wrap">
          <Button size="sm" loading={test.isPending} onClick={() => test.mutate(provider.id)}>
            Test connection
          </Button>
          <Button size="sm" loading={sync.isPending} onClick={() => sync.mutate(provider.id)}>
            Sync models
          </Button>
          <Button size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Link className="small" to={`/models?providerId=${provider.id}`}>
            {provider.modelCount} models
          </Link>
        </div>
      </div>
    </Card>
  );
}

function ModelRow({ model }: { model: ModelSummary }): ReactNode {
  const update = useUpdateModel();
  return (
    <tr>
      <td>
        <div>{model.name}</div>
        <div className="muted mono small">{model.externalModelId}</div>
      </td>
      <td>
        <Badge>{model.type}</Badge>
      </td>
      <td>
        <Badge tone={model.status === 'available' ? 'ok' : 'waiting'}>{model.status}</Badge>
      </td>
      <td>
        <div className="row-wrap" style={{ gap: 4 }}>
          {model.capabilities.length === 0 ? (
            <span className="muted small">{EM_DASH}</span>
          ) : (
            model.capabilities.map((capability) => (
              <Badge key={capability}>{capability}</Badge>
            ))
          )}
        </div>
      </td>
      <td className="right small">
        {model.contextWindow === null ? EM_DASH : formatNumber(model.contextWindow)}
      </td>
      <td className="right small">
        {model.maxOutputTokens === null ? EM_DASH : formatNumber(model.maxOutputTokens)}
      </td>
      <td>
        <input
          type="checkbox"
          checked={model.enabled}
          disabled={update.isPending}
          aria-label={`Enable ${model.name}`}
          onChange={(event) =>
            update.mutate({ id: model.id, enabled: event.target.checked })
          }
        />
      </td>
    </tr>
  );
}

export function ModelsPage(): ReactNode {
  const [tab, setTab] = useState('providers');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderSummary | null>(null);

  const providers = useProviders();
  const models = useModelList();

  return (
    <>
      <PageHead
        title="Models"
        subtitle="Providers hold credentials; models are what an agent is pinned to."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            Add provider
          </Button>
        }
      />

      <Tabs
        tabs={[
          {
            id: 'providers',
            label: 'Providers',
            badge: <Badge>{providers.data?.length ?? 0}</Badge>,
          },
          { id: 'models', label: 'Models', badge: <Badge>{models.data?.length ?? 0}</Badge> },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ marginTop: 16 }}>
        {tab === 'providers' ? (
          <QueryBoundary
            query={providers}
            loadingLabel="Loading providers…"
            isEmpty={(rows) => rows.length === 0}
            empty={
              <EmptyState
                title="No providers"
                hint="Add one so agents have a model to plan with."
              />
            }
          >
            {(rows) => (
              <div className="grid-3">
                {rows.map((provider) => (
                  <ProviderCard
                    key={provider.id}
                    provider={provider}
                    onEdit={() => {
                      setEditing(provider);
                      setFormOpen(true);
                    }}
                  />
                ))}
              </div>
            )}
          </QueryBoundary>
        ) : (
          <Card flush>
            <QueryBoundary
              query={models}
              loadingLabel="Loading models…"
              isEmpty={(rows) => rows.length === 0}
              empty={
                <EmptyState
                  title="No models"
                  hint="Sync a provider to discover its models."
                />
              }
            >
              {(rows) => (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Capabilities</th>
                      <th className="right">Context</th>
                      <th className="right">Max out</th>
                      <th>Enabled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((model) => (
                      <ModelRow key={model.id} model={model} />
                    ))}
                  </tbody>
                </table>
              )}
            </QueryBoundary>
          </Card>
        )}
      </div>

      {formOpen ? (
        <ProviderForm
          editing={editing}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      ) : null}

      <p className="muted small" style={{ marginTop: 16 }}>
        Last provider check:{' '}
        {providers.data === undefined || providers.data.length === 0
          ? EM_DASH
          : formatDateTime(
              providers.data
                .map((provider) => provider.lastHealthCheck)
                .filter((value): value is string => value !== null)
                .sort()
                .at(-1) ?? null,
            )}
      </p>
    </>
  );
}
