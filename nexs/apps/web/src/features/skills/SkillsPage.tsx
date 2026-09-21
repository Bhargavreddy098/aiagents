/**
 * Skills — the `/api/skills` prefix.
 *
 * ## Why this page did not exist, and why it does now
 *
 * `SLASH_COMMANDS` has listed `/skills` as available since the catalog was written, and the
 * server has mounted `/api/skills` with six routes and a repository behind them. What was
 * missing was any client for them: the command's reply was the only way to see a skill, and a
 * reply is not a page. So the route existed, the command answered, and nothing could be created,
 * versioned or deleted from the UI.
 *
 * ## A skill is a prompt template, not a tool
 *
 * There is no invoke button here and there should not be one. A tool *does* something; a skill
 * changes **what the model is asked to do**. The only way to use one is to point a run at it, so
 * the page says that rather than leaving the missing button to be read as a missing feature.
 * `argsSchema` is raw JSON Schema for the template's arguments and is passed through unchanged.
 *
 * ## Versions are immutable, and the version body *is* on the wire
 *
 * `SkillVersionSummary` carries `promptTemplate`, so the detail page can show what a version
 * actually said rather than only its number. That matters: a run that used version 3 must still
 * be able to show what version 3 said, which is the whole reason version rows are never
 * rewritten. Editing means publishing N+1.
 *
 * `latestVersion` is not a column — it is the highest `version` among the rows, computed on
 * read, and it is `null` (not `0`) for a skill whose first version has not been published.
 */

import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { SkillSummary } from '@nexs/shared';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  PageHead,
  QueryBoundary,
  StatusBadge,
  Tabs,
} from '../../components/ui';
import { EM_DASH, formatRelative, shortId } from '../../lib/format';
import { jsonErrorFor } from '../../lib/validation';
import {
  useCreateSkill,
  useDeleteSkill,
  usePublishSkillVersion,
  useSkill,
  useSkillVersions,
  useSkills,
  useUpdateSkill,
} from './queries';

export function SkillsPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const openId = params.get('skill');
  const [tab, setTab] = useState('all');

  const query = useSkills({});

  if (openId !== null) {
    return <SkillDetail id={openId} onClose={() => setParams({}, { replace: true })} />;
  }

  return (
    <>
      <PageHead
        title="Skills"
        subtitle="Versioned prompt templates an agent can be pointed at. A skill changes what the model is asked to do — it does not do anything itself."
      />

      <QueryBoundary query={query} loadingLabel="Loading skills…">
        {(skills) => {
          const active = skills.filter((skill) => skill.status === 'active');
          const disabled = skills.filter((skill) => skill.status !== 'active');
          const rows = tab === 'active' ? active : tab === 'disabled' ? disabled : skills;

          return (
            <>
              <Tabs
                tabs={[
                  { id: 'all', label: 'All', badge: <Badge>{skills.length}</Badge> },
                  { id: 'active', label: 'Active', badge: <Badge>{active.length}</Badge> },
                  { id: 'disabled', label: 'Disabled', badge: <Badge>{disabled.length}</Badge> },
                ]}
                active={tab}
                onChange={setTab}
              />

              <div style={{ marginTop: 16 }}>
                <Card flush>
                  {rows.length === 0 ? (
                    <EmptyState
                      title="No skills"
                      hint="Create one below, then publish a version — a skill with no version has nothing to hand an agent."
                    />
                  ) : (
                    <table className="table table-clickable">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Status</th>
                          <th>Versions</th>
                          <th>Latest</th>
                          <th>Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((skill) => (
                          <tr
                            key={skill.id}
                            onClick={() => setParams({ skill: skill.id }, { replace: true })}
                            tabIndex={0}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                setParams({ skill: skill.id }, { replace: true });
                              }
                            }}
                          >
                            <td>
                              <div>{skill.name}</div>
                              {skill.description !== null && skill.description !== '' ? (
                                <div className="muted small truncate" style={{ maxWidth: 420 }}>
                                  {skill.description}
                                </div>
                              ) : null}
                            </td>
                            <td>
                              <StatusBadge status={skill.status} />
                            </td>
                            <td className="small">
                              {skill.versionCount === 0 ? (
                                <span className="muted" title="No version published yet">
                                  none
                                </span>
                              ) : (
                                skill.versionCount
                              )}
                            </td>
                            <td className="mono small">
                              {/* `null` is reachable and is not `0` — version numbers start at 1. */}
                              {skill.latestVersion === null ? EM_DASH : `v${skill.latestVersion}`}
                            </td>
                            <td className="muted small nowrap" title={skill.updatedAt}>
                              {formatRelative(skill.updatedAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
              </div>

              <div style={{ marginTop: 16 }}>
                <CreateSkillCard />
              </div>

              <div style={{ marginTop: 16 }}>
                <Card title="What the statuses mean">
                  <p className="muted small">
                    There are two: <code>active</code> and <code>disabled</code>. There is no
                    draft, review or archived state. Disabling is a soft stop — the versions stay,
                    runs that referenced them stay readable, and the skill simply stops being
                    offered. Use it for a decision; delete for a mistake.
                  </p>
                </Card>
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}

/** The detail view. It lives in this file because the list navigates into it by id. */
function SkillDetail({ id, onClose }: { id: string; onClose: () => void }): ReactNode {
  const skill = useSkill(id);
  const versions = useSkillVersions(id);
  const update = useUpdateSkill();
  const remove = useDeleteSkill();

  /** Which version's template is expanded. The latest by default once the list lands. */
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);

  if (skill.isPending) return <Loading label="Loading skill…" />;
  if (skill.isError) return <ErrorBox message="Could not load this skill." />;

  const row: SkillSummary = skill.data;
  // Controlled locally once edited, so a refetch does not wipe what is being typed.
  const nameValue = name ?? row.name;
  const descriptionValue = description ?? row.description ?? '';

  const versionRows = versions.data ?? [];

  return (
    <>
      <PageHead
        title={
          <span className="row" style={{ gap: 6 }}>
            {row.name}
            <StatusBadge status={row.status} />
          </span>
        }
        subtitle={
          row.latestVersion === null
            ? 'No version has been published, so there is nothing for an agent to be handed yet.'
            : `Latest version v${row.latestVersion}, of ${row.versionCount} published.`
        }
        actions={
          <span className="row">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                update.mutate({ id, status: row.status === 'active' ? 'disabled' : 'active' })
              }
              loading={update.isPending}
              title={
                row.status === 'active'
                  ? 'Stop agents from being handed this skill'
                  : 'Make this skill available again'
              }
            >
              {row.status === 'active' ? 'Disable' : 'Enable'}
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={remove.isPending}
              onClick={() => remove.mutate(id, { onSuccess: onClose })}
              title="Delete this skill and every version of it"
            >
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Back
            </Button>
          </span>
        }
      />

      <Card title="Identity">
        <div className="stack-sm">
          <Field label="Name">
            <input
              className="input"
              value={nameValue}
              onChange={(event) => setName(event.target.value)}
              disabled={update.isPending}
            />
          </Field>
          <Field label="Description" hint="Optional. One line about what the template is for.">
            <input
              className="input"
              value={descriptionValue}
              onChange={(event) => setDescription(event.target.value)}
              disabled={update.isPending}
            />
          </Field>
          <div className="row">
            <Button
              size="sm"
              variant="primary"
              loading={update.isPending}
              disabled={nameValue.trim() === '' || (name === null && description === null)}
              onClick={() =>
                update.mutate(
                  {
                    id,
                    name: nameValue.trim(),
                    ...(description === null ? {} : { description: descriptionValue }),
                  },
                  {
                    onSuccess: () => {
                      setName(null);
                      setDescription(null);
                    },
                  },
                )
              }
            >
              Save
            </Button>
            <span className="muted small mono">
              {shortId(row.id)} · created {formatRelative(row.createdAt)}
            </span>
          </div>
          {update.isError ? (
            <ErrorBox
              message={update.error instanceof Error ? update.error.message : 'The update failed.'}
            />
          ) : null}
        </div>
      </Card>

      <div style={{ marginTop: 16 }}>
        <PublishVersionCard skillId={id} nextVersion={(row.latestVersion ?? 0) + 1} />
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title="Versions">
          {versions.isPending ? (
            <Loading label="Loading versions…" />
          ) : versions.isError ? (
            <ErrorBox message="Could not read this skill's versions." />
          ) : versionRows.length === 0 ? (
            <p className="muted small">
              No versions. A skill with no version cannot be handed to an agent — publish one
              above.
            </p>
          ) : (
            <div className="stack-sm">
              {versionRows.map((version) => {
                const isLatest = version.version === row.latestVersion;
                const open = openVersion === version.version;
                return (
                  <div className="card" key={version.id}>
                    <div className="card-head">
                      <span className="row" style={{ gap: 6 }}>
                        <span className="mono">v{version.version}</span>
                        {isLatest ? <Badge tone="ok">latest</Badge> : null}
                        <span className="muted small">{formatRelative(version.createdAt)}</span>
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpenVersion(open ? null : version.version)}
                      >
                        {open ? 'Hide template' : 'Show template'}
                      </Button>
                    </div>
                    {open ? (
                      <div className="card-body stack-sm">
                        <Code>{version.promptTemplate}</Code>
                        {version.argsSchema === null || version.argsSchema === undefined ? (
                          <p className="muted small">
                            No argument schema — this template takes no arguments.
                          </p>
                        ) : (
                          <details>
                            <summary className="muted small" style={{ cursor: 'pointer' }}>
                              argument schema
                            </summary>
                            <Code>{JSON.stringify(version.argsSchema, null, 2)}</Code>
                          </details>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

/**
 * Publishing a version.
 *
 * `promptTemplate` is required and the schema is not, because the server's own input says so —
 * an empty template is a skill with nothing to hand over. Version numbers are the client's
 * *suggestion* of the next one and the server's to assign: the field is pre-filled with
 * `latest + 1` because that is what makes the form usable, and the server remains authoritative
 * about what it accepts. Nothing here pre-checks uniqueness against a list that might be stale.
 */
function PublishVersionCard({
  skillId,
  nextVersion,
}: {
  skillId: string;
  nextVersion: number;
}): ReactNode {
  const publish = usePublishSkillVersion();
  const [template, setTemplate] = useState('');
  const [schema, setSchema] = useState('');

  // The sentence is the *skills* one: the same validator serves both pages, and each supplies
  // the wording that tells its own user what the field is for.
  const schemaError = jsonErrorFor(
    schema,
    'That is not valid JSON. The server takes the schema as JSON, so it must parse here first.',
  );

  return (
    <Card title={`Publish version ${nextVersion}`}>
      <form
        className="stack-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (template.trim() === '' || schemaError !== null) return;
          let parsed: unknown;
          try {
            parsed = schema.trim() === '' ? undefined : JSON.parse(schema);
          } catch {
            // Unreachable — `jsonErrorFor` already refused it — but parsing twice is cheaper
            // than a non-null assertion, and an assertion here would be a lie if the helper
            // ever grew a case this branch did not.
            return;
          }
          publish.mutate(
            {
              id: skillId,
              promptTemplate: template,
              ...(parsed === undefined ? {} : { argsSchema: parsed }),
            },
            {
              onSuccess: () => {
                setTemplate('');
                setSchema('');
              },
            },
          );
        }}
      >
        <Field
          label="Prompt template"
          hint="The skill's body — what the model is asked to do. This is the version's whole value; nothing is inferred from the skill's name."
        >
          <textarea
            className="input mono"
            rows={9}
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            placeholder="Describe the procedure, step by step."
            disabled={publish.isPending}
          />
        </Field>

        <Field
          label="Argument schema (JSON)"
          hint="Optional. Raw JSON Schema for the template's arguments — passed through unchanged, not validated here beyond being JSON."
        >
          <textarea
            className="input mono"
            rows={4}
            value={schema}
            onChange={(event) => setSchema(event.target.value)}
            placeholder={'{ "type": "object", "properties": {} }'}
            disabled={publish.isPending}
          />
        </Field>
        {schemaError !== null ? <span className="field-error">{schemaError}</span> : null}

        <div className="row">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={publish.isPending}
            disabled={template.trim() === '' || schemaError !== null}
          >
            Publish
          </Button>
          <span className="muted small">
            A published version is immutable — correct a mistake by publishing the next one.
          </span>
        </div>
      </form>

      {publish.isError ? (
        <ErrorBox
          message={publish.error instanceof Error ? publish.error.message : 'Could not publish.'}
        />
      ) : null}
    </Card>
  );
}

/**
 * Why the schema field is refused, or `null` when it is fine.
 *
 * A pure function so the rule is one readable expression rather than a `try`/`catch` buried in a
 * submit handler. An empty field is fine — the schema is optional — and so is any valid JSON.
 */
function CreateSkillCard(): ReactNode {
  const create = useCreateSkill();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState('');
  const [active, setActive] = useState(true);

  return (
    <Card title="New skill">
      <form
        className="stack-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === '' || template.trim() === '') return;
          create.mutate(
            {
              name: name.trim(),
              promptTemplate: template,
              ...(description.trim() === '' ? {} : { description: description.trim() }),
              // The create schema carries no status field, so a skill is created in the
              // server's default state. The checkbox below only decides what the page says
              // afterwards — and if the server's default is not `active`, the note under the
              // form is what tells the operator to go and change it.
            },
            {
              onSuccess: () => {
                setName('');
                setDescription('');
                setTemplate('');
              },
            },
          );
        }}
      >
        <Field label="Name">
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Deploy a release"
            disabled={create.isPending}
          />
        </Field>
        <Field label="Description" hint="Optional. One line about what it does.">
          <input
            className="input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={create.isPending}
          />
        </Field>
        <Field
          label="First version's prompt template"
          hint="Required — the skill row and its first version are created together, so the skill is usable the moment it exists."
        >
          <textarea
            className="input mono"
            rows={7}
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            placeholder="Describe the procedure, step by step."
            disabled={create.isPending}
          />
        </Field>
        <Checkbox
          checked={active}
          onChange={setActive}
          label="Intended to be active"
          hint="A disabled skill still exists and still keeps its versions; it is simply not offered."
          disabled
        />
        <p className="muted small">
          The create endpoint takes no status, so a new skill lands in the server's own default
          state — the checkbox above states the intent rather than setting it. Use the skill's
          page to change it.
        </p>
        <div className="row">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={create.isPending}
            disabled={name.trim() === '' || template.trim() === ''}
          >
            Create
          </Button>
        </div>
      </form>

      {create.isError ? (
        <ErrorBox
          message={create.error instanceof Error ? create.error.message : 'Could not create.'}
        />
      ) : null}
    </Card>
  );
}
