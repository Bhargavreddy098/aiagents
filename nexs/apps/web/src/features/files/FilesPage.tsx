/**
 * Files — the folder grants an agent may read and write.
 *
 * ## The rule this page is built around
 *
 * **A host path never crosses the boundary.** `FolderGrant.resolvedPath` is the realpath every
 * containment check compares against, and returning it would hand a client the exact string that
 * makes a directory traversal writable. So this page shows `rootPath` — what the operator typed,
 * which they already know — and never a realpath. There is no realpath to show, and the page says
 * so rather than rendering an empty column.
 *
 * The same rule shapes the browser below: `GrantedEntry.path` is **relative** to the grant's
 * root, so walking a folder reveals its shape without revealing where it lives on the machine.
 *
 * ## What was missing, and what this closes
 *
 * `/api/files` had an attachment half wired into the chat picker and a **grant** half with no
 * client at all: five routes, none called. A grant is the more dangerous of the two resources
 * because it is the one that widens an agent's reach on the host — so the half with no UI was
 * also the half that could not be audited, which is the wrong way round.
 *
 * ## The file reader is a link, not a query
 *
 * `GET /grants/:id/file` returns bytes, not JSON. So it is a link target for a `read`-only
 * affordance — and it is only offered when the grant actually carries `read`, because a link the
 * server will refuse is worse than no link. There is no write path from this page at all: an
 * operator grants the capability here, and the agent uses it during a run. Adding an upload form
 * would be a second, unaudited way to put bytes on disk.
 */

import { useState, type ReactNode } from 'react';
import type { FolderGrantSummary } from '@nexs/shared';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  PageHead,
  QueryBoundary,
  Tabs,
} from '../../components/ui';
import { EM_DASH, formatBytes, formatRelative, shortId } from '../../lib/format';
import { parentOf } from '../../lib/validation';
import { useCreateGrant, useFolderGrants, useGrantEntries, useRevokeGrant } from './queries';

export function FilesPage(): ReactNode {
  const [tab, setTab] = useState('grants');
  const [openId, setOpenId] = useState<string | null>(null);
  const grants = useFolderGrants();

  return (
    <>
      <PageHead
        title="Files"
        subtitle="Directories you have approved for an agent. A grant is the boundary the engine checks every file access against."
      />

      <Tabs
        tabs={[
          { id: 'grants', label: 'Folder grants' },
          { id: 'attachments', label: 'Attachments' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ marginTop: 16 }} className="stack">
        {tab === 'grants' ? (
          <>
            <QueryBoundary query={grants} loadingLabel="Loading grants…">
              {(rows) => (
                <Card flush>
                  {rows.length === 0 ? (
                    <EmptyState
                      title="No folders approved"
                      hint="An agent has no filesystem reach until you grant it a directory. Add one below."
                    />
                  ) : (
                    <table className="table table-clickable">
                      <thead>
                        <tr>
                          <th>Root</th>
                          <th>Permissions</th>
                          <th>Granted to</th>
                          <th>Created</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((grant) => (
                          <tr
                            key={grant.id}
                            onClick={() => setOpenId(grant.id === openId ? null : grant.id)}
                            tabIndex={0}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                setOpenId(grant.id === openId ? null : grant.id);
                              }
                            }}
                          >
                            <td className="mono small truncate" style={{ maxWidth: 340 }}>
                              {grant.rootPath}
                            </td>
                            <td>
                              <PermissionBadges grant={grant} />
                            </td>
                            <td className="small">
                              <GrantScope grant={grant} />
                            </td>
                            <td className="muted small nowrap" title={grant.createdAt}>
                              {formatRelative(grant.createdAt)}
                            </td>
                            <td>
                              <span className="muted small mono">{shortId(grant.id)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
              )}
            </QueryBoundary>

            {openId !== null ? (
              <GrantBrowser grantId={openId} onClose={() => setOpenId(null)} />
            ) : null}

            <CreateGrantCard />
          </>
        ) : (
          <AttachmentsNote />
        )}

        <Card title="Why no absolute path is shown">
          <p className="muted small">
            A grant stores the realpath it was resolved to, and that value is deliberately never
            returned: it is the exact string every containment check is compared against, so
            knowing it is half of escaping it. This page shows what you typed, and the browser
            below lists entries relative to it — enough to audit what an agent can reach, without
            publishing where the machine keeps it.
          </p>
        </Card>
      </div>
    </>
  );
}

/** The permission indicator, from the grant row's own columns rather than inferred. */
function PermissionBadges({ grant }: { grant: FolderGrantSummary }): ReactNode {
  if (!grant.read && !grant.write) {
    // Reachable: a grant with neither permission is a row that exists and does nothing. Saying
    // so is better than two greyed badges that look like a rendering fault.
    return (
      <Badge tone="failed" >
        no access
      </Badge>
    );
  }
  return (
    <span className="row" style={{ gap: 4 }}>
      {grant.read ? <Badge tone="ok">read</Badge> : null}
      {grant.write ? <Badge tone="waiting">write</Badge> : null}
    </span>
  );
}

function GrantScope({ grant }: { grant: FolderGrantSummary }): ReactNode {
  if (grant.agentId === null && grant.taskId === null) {
    return (
      <span className="muted" title="Not bound to an agent or task — reachable by any run in this tenant's workdir">
        unbound
      </span>
    );
  }
  return (
    <span className="row small" style={{ gap: 5 }}>
      {grant.agentId === null ? null : (
        <span className="mono" title={grant.agentId}>
          agent {shortId(grant.agentId)}
        </span>
      )}
      {grant.taskId === null ? null : (
        <span className="mono" title={grant.taskId}>
          task {shortId(grant.taskId)}
        </span>
      )}
    </span>
  );
}

/**
 * The file browser.
 *
 * A walk rather than a scroll: `path` is relative to the grant's root and is what produces the
 * next listing, so each directory is a query of its own and the breadcrumb is the query key. That
 * is why the cursor here is a path and not an offset — there is no flat list to paginate.
 *
 * Directories descend; files link to the read route when the grant carries `read`. Both halves of
 * that rule are stated: an entry that cannot be opened says why rather than being a dead link.
 */
function GrantBrowser({ grantId, onClose }: { grantId: string; onClose: () => void }): ReactNode {
  const grants = useFolderGrants();
  const grant = (grants.data ?? []).find((row) => row.id === grantId) ?? null;
  const [path, setPath] = useState('');
  const entries = useGrantEntries(grantId, path);

  const canRead = grant?.read ?? false;

  return (
    <Card
      title={
        <span className="row" style={{ gap: 6 }}>
          <span className="mono">{grant === null ? shortId(grantId) : grant.rootPath}</span>
          {path === '' ? null : <span className="muted small">/{path}</span>}
        </span>
      }
      actions={
        <span className="row">
          {path === '' ? null : (
            <Button size="sm" variant="ghost" onClick={() => setPath(parentOf(path))}>
              Up
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            Hide
          </Button>
        </span>
      }
    >
      {grant !== null && !canRead ? (
        <p className="muted small">
          This grant carries <span className="mono">write</span> only, so its contents are not
          listed and files are not openable here. Add <span className="mono">read</span> in a new
          grant if an operator needs to see them — the engine still checks every access against the
          permissions that are set.
        </p>
      ) : entries.isPending ? (
        <Loading label="Listing…" />
      ) : entries.isError ? (
        <ErrorBox message="That directory could not be listed. It may have been removed since the grant was made." />
      ) : (entries.data ?? []).length === 0 ? (
        <EmptyState title="Empty directory" hint="Nothing inside." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Size</th>
              <th>Modified</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(entries.data ?? []).map((entry) => (
              <tr key={entry.path}>
                <td className="mono small truncate" style={{ maxWidth: 360 }}>
                  {entry.kind === 'directory' ? '📁' : '📄'} {entry.name}
                </td>
                <td className="small">{entry.kind}</td>
                <td className="small nowrap">
                  {entry.kind === 'directory' ? EM_DASH : formatBytes(entry.sizeBytes)}
                </td>
                <td className="muted small nowrap" title={entry.modifiedAt}>
                  {formatRelative(entry.modifiedAt)}
                </td>
                <td>
                  {entry.kind === 'directory' ? (
                    <Button size="sm" variant="ghost" onClick={() => setPath(entry.path)}>
                      Open
                    </Button>
                  ) : (
                    // The read route answers bytes, so it is a link rather than a query. Offered
                    // only when the grant carries `read` — see the guard above.
                    <a
                      className="btn btn-sm"
                      href={`/api/files/grants/${encodeURIComponent(grantId)}/file${`?path=${encodeURIComponent(entry.path)}`}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/**
 * Granting a directory.
 *
 * Two checkboxes, and the form refuses neither combination — a write-only grant is legitimate and
 * the browser above handles it. What the form *does* do is refuse a grant with neither permission,
 * because a row that can do nothing is a mistake rather than a decision.
 *
 * `agentId` and `taskId` are free-text ids for the same reason the event subscription's target is:
 * a picker would load every agent and task to fill a field most operators copy from a URL.
 */
function CreateGrantCard(): ReactNode {
  const create = useCreateGrant();
  const [rootPath, setRootPath] = useState('');
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [taskId, setTaskId] = useState('');

  const usable = read || write;

  return (
    <Card title="Grant a folder">
      <form
        className="stack-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (rootPath.trim() === '' || !usable) return;
          create.mutate(
            {
              rootPath: rootPath.trim(),
              read,
              write,
              ...(agentId.trim() === '' ? {} : { agentId: agentId.trim() }),
              ...(taskId.trim() === '' ? {} : { taskId: taskId.trim() }),
            },
            {
              onSuccess: () => {
                setRootPath('');
                setAgentId('');
                setTaskId('');
                setRead(true);
                setWrite(false);
              },
            },
          );
        }}
      >
        <Field
          label="Directory"
          hint="What you would type in a shell. The server resolves it and stores the realpath itself — the resolution is not repeated here, and the result is never sent back."
        >
          <input
            className="input mono"
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
            placeholder="/home/me/project"
            disabled={create.isPending}
          />
        </Field>

        <div className="row">
          <Checkbox
            checked={read}
            onChange={setRead}
            label="Read"
            hint="List the directory and read files inside it."
          />
          <Checkbox
            checked={write}
            onChange={setWrite}
            label="Write"
            hint="Create and modify files inside it. Meaningful on its own — an agent that only writes is a real case."
          />
        </div>
        {!usable ? (
          <span className="field-error">
            A grant with neither permission is a row that can do nothing. Pick at least one.
          </span>
        ) : null}

        <div className="row">
          <Field
            label="Agent id"
            hint="Optional. Bind the grant to one agent; leave empty for any run in the workdir."
          >
            <input
              className="input mono"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              disabled={create.isPending}
            />
          </Field>
          <Field label="Task id" hint="Optional. Bind the grant to one task instead.">
            <input
              className="input mono"
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
              disabled={create.isPending}
            />
          </Field>
        </div>

        <div className="row">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={create.isPending}
            disabled={rootPath.trim() === '' || !usable}
          >
            Grant
          </Button>
          <span className="muted small">
            Grants are never edited — revoke one and add another, so the permission an agent
            actually held stays recoverable.
          </span>
        </div>
      </form>

      {create.isError ? (
        <ErrorBox
          message={create.error instanceof Error ? create.error.message : 'The grant was refused.'}
        />
      ) : null}

      <RevokePicker />
    </Card>
  );
}

/**
 * Revoke.
 *
 * A small select rather than a button per row, because the browser above owns the table and two
 * places to revoke the same grant is two places to get it wrong. It is also the honest shape:
 * revoking is destructive, so it takes choosing the grant explicitly rather than a stray click on
 * a row that was being inspected.
 */
function RevokePicker(): ReactNode {
  const grants = useFolderGrants();
  const revoke = useRevokeGrant();
  const [selected, setSelected] = useState('');
  const rows = grants.data ?? [];

  if (rows.length === 0) return null;

  return (
    <div className="row" style={{ marginTop: 10 }}>
      <select
        className="select select-sm"
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
      >
        <option value="">Choose a grant to revoke…</option>
        {rows.map((grant) => (
          <option key={grant.id} value={grant.id}>
            {grant.rootPath} ({grant.read ? 'r' : ''}
            {grant.write ? 'w' : ''})
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="danger"
        disabled={selected === ''}
        loading={revoke.isPending}
        onClick={() =>
          revoke.mutate(selected, {
            onSuccess: () => setSelected(''),
          })
        }
      >
        Revoke
      </Button>
      {revoke.isError ? (
        <span className="field-error">The grant could not be revoked.</span>
      ) : null}
    </div>
  );
}

/**
 * The attachments tab.
 *
 * Attachments are read by the chat composer's picker — `GET /files` and
 * `GET /files?scope=chat` — and there is no endpoint that lists all of them across scopes in a
 * way this page could paginate. Rather than a table that would show one scope and call itself
 * "attachments", this tab states where they live.
 */
function AttachmentsNote(): ReactNode {
  return (
    <Card title="Attachments">
      <p className="muted small">
        An attachment is a file uploaded *for* something — a chat message, an agent or a task — and
        it is created and read in that context. The chat composer's Attach button lists the
        chat-scoped ones, and an attachment's preview is at{' '}
        <span className="mono">/api/files/:id/preview</span>.
      </p>
      <p className="muted small">
        There is no page that lists every attachment in the tenant: the file routes filter by
        scope, so a combined list would either be one scope presented as all of them or N queries
        pretending to be one. Use the surface the attachment belongs to.
      </p>
    </Card>
  );
}

/** A stable, readable label for a grant, so a row can be recognised without its id. */
export function grantLabel(grant: Pick<FolderGrantSummary, 'rootPath'>): string {
  return grant.rootPath === '' ? '(empty path)' : grant.rootPath;
}
