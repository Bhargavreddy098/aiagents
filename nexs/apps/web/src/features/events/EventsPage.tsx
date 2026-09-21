/**
 * Events — the ingest log and the standing subscriptions that react to it.
 *
 * ## Why this page exists at all
 *
 * `/api/events` has been mounted since Phase 11 with five routes and no client. The only way to
 * find out whether a webhook subscription matched was to make the external producer send
 * something — which, for a subscription nobody has tested yet, is exactly the thing that cannot
 * be done. `POST /events` exists to fix that (it is the manual ingest), and this page is what
 * puts it in reach.
 *
 * ## Two questions, two tabs
 *
 * "What arrived?" and "What is listening?" are different questions, and the ingest log answers
 * the first while the subscription table answers the second. They are one page because a
 * subscription that matched nothing and an event that matched nothing are the same bug seen from
 * two sides — and the manual ingest reports `matchedSubscriptions` and `triggered` *separately*,
 * which is what makes "nobody is listening" distinguishable from "the listener failed".
 *
 * ## Three outcomes, not two
 *
 * `EventIngestResult` reports `deduplicated`, `matchedSubscriptions` and `triggered` as separate
 * fields, so an ingest that found a subscription and did not start it is visible as a partial
 * failure with its own reason rather than counted as success. The result panel below renders all
 * three, because collapsing them would be the difference between a broken subscription and a
 * working one that ingested a replay.
 *
 * ## The secret is write-only, and the page says so
 *
 * `EventSubscriptionSummary` carries `hasSecret`, never the key. So the table shows whether one
 * is set rather than an empty field to guess at, and the create form's field says the value
 * cannot be read back — which is the reason to write it down when you set it.
 */

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { EventIngestResult, EventSubscriptionSummary } from '@nexs/shared';
import {
  Badge,
  Button,
  Card,
  Code,
  Dot,
  EmptyState,
  ErrorBox,
  Field,

  PageHead,
  QueryBoundary,
  Tabs,
} from '../../components/ui';
import { EM_DASH, formatDateTime, formatRelative, inlineJson, shortId } from '../../lib/format';
import { jsonErrorFor } from '../../lib/validation';
import {
  useCreateEventSubscription,
  useDeleteEventSubscription,
  useEvents,
  useEventSubscriptions,
  useIngestEvent,
} from './queries';

const TARGET_KINDS = ['task', 'workflow', 'agent'] as const;

export function EventsPage(): ReactNode {
  const [tab, setTab] = useState('subscriptions');

  return (
    <>
      <PageHead
        title="Events"
        subtitle="Webhooks that arrive, and the standing instructions that react to them."
      />

      <Tabs
        tabs={[
          { id: 'subscriptions', label: 'Subscriptions' },
          { id: 'log', label: 'Ingest log' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ marginTop: 16 }} className="stack">
        {tab === 'subscriptions' ? <SubscriptionTab /> : <LogTab />}

        <IngestCard />
      </div>
    </>
  );
}

function SubscriptionTab(): ReactNode {
  const query = useEventSubscriptions();
  const remove = useDeleteEventSubscription();

  return (
    <QueryBoundary query={query} loadingLabel="Loading subscriptions…">
      {(data) => (
        <>
          <Card flush>
            {data.subscriptions.length === 0 ? (
              <EmptyState
                title="Nothing is listening"
                hint="A subscription pairs a topic with a task, workflow or agent. Without one, an inbound event is stored and ignored."
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Topic</th>
                    <th>Filter</th>
                    <th>Target</th>
                    <th>Secret</th>
                    <th>State</th>
                    <th>Created</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.subscriptions.map((subscription) => (
                    <SubscriptionRow
                      key={subscription.id}
                      subscription={subscription}
                      onDelete={() => remove.mutate(subscription.id)}
                      deleting={remove.isPending}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          {remove.isError ? (
            <ErrorBox message="The subscription could not be deleted." />
          ) : null}
          <CreateSubscriptionCard />
        </>
      )}
    </QueryBoundary>
  );
}

function SubscriptionRow({
  subscription,
  onDelete,
  deleting,
}: {
  subscription: EventSubscriptionSummary;
  onDelete: () => void;
  deleting: boolean;
}): ReactNode {
  const filter = subscription.filter;
  const hasFilter = filter.source !== undefined || filter.subject !== undefined;

  return (
    <tr>
      <td className="mono small">{subscription.topic}</td>
      <td className="small">
        {hasFilter ? (
          <span className="mono">
            {filter.source === undefined ? '' : `source=${filter.source}`}
            {filter.source !== undefined && filter.subject !== undefined ? ' · ' : ''}
            {filter.subject === undefined ? '' : `subject=${filter.subject}`}
          </span>
        ) : (
          <span className="muted" title="No filter — every event with this topic matches">
            any
          </span>
        )}
      </td>
      <td className="small">
        <Link to={targetHref(subscription)}>
          {subscription.targetKind} {shortId(subscription.targetId)}
        </Link>
      </td>
      <td className="small">
        {subscription.hasSecret ? (
          <Badge tone="ok">set</Badge>
        ) : (
          <Badge tone="neutral">none</Badge>
        )}
      </td>
      <td>
        <span className="row small" style={{ gap: 5 }}>
          <Dot tone={subscription.enabled ? 'ok' : 'neutral'} />
          {subscription.enabled ? 'enabled' : 'disabled'}
        </span>
      </td>
      <td className="muted small nowrap" title={formatDateTime(subscription.createdAt)}>
        {formatRelative(subscription.createdAt)}
      </td>
      <td>
        <Button size="sm" variant="ghost" loading={deleting} onClick={onDelete}>
          Delete
        </Button>
      </td>
    </tr>
  );
}

/** Where a target kind's own page lives, so "task 3f9a" is clickable rather than a dead id. */
function targetHref(subscription: EventSubscriptionSummary): string {
  if (subscription.targetKind === 'workflow') return `/workflows/${subscription.targetId}`;
  if (subscription.targetKind === 'agent') return `/agents/${subscription.targetId}`;
  return `/tasks/${subscription.targetId}`;
}

function LogTab(): ReactNode {
  const query = useEvents({ limit: 100 });

  return (
    <QueryBoundary query={query} loadingLabel="Loading events…">
      {(data) => (
        <Card flush>
          {data.events.length === 0 ? (
            <EmptyState
              title="No events recorded"
              hint="Use the manual ingest below to send one, or point an external producer at the webhook route."
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Subject</th>
                  <th>Payload</th>
                  <th>Occurred</th>
                  <th>Processed</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event) => (
                  <tr key={event.id}>
                    <td className="mono small">{event.type}</td>
                    <td className="mono small">{event.source}</td>
                    <td className="small truncate" style={{ maxWidth: 200 }}>
                      {event.subject ?? EM_DASH}
                    </td>
                    <td className="mono small truncate" style={{ maxWidth: 320 }}>
                      {inlineJson(event.payload, 60)}
                    </td>
                    <td className="muted small nowrap" title={formatDateTime(event.occurredAt)}>
                      {formatRelative(event.occurredAt)}
                    </td>
                    <td className="small nowrap">
                      {event.processedAt === null ? (
                        // Null means the matcher has not finished with it — not that it failed.
                        <span className="muted" title="The matcher has not finished with it yet">
                          pending
                        </span>
                      ) : (
                        <span title={formatDateTime(event.processedAt)}>
                          {formatRelative(event.processedAt)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </QueryBoundary>
  );
}

/**
 * The manual ingest.
 *
 * `externalId` is the replay-protection key, and leaving it empty is a real choice rather than a
 * missing field: the unique index is on `(tenantId, source, externalId)` and a NULL never
 * collides, so an event with no id is always stored. That makes it the right default for a test
 * ingest — sending the same form twice should produce two events, which is what tells you the
 * subscription is live. Supplying one is how you prove deduplication works.
 */
function IngestCard(): ReactNode {
  const ingest = useIngestEvent();
  const [type, setType] = useState('build.completed');
  const [source, setSource] = useState('manual');
  const [subject, setSubject] = useState('');
  const [externalId, setExternalId] = useState('');
  const [payload, setPayload] = useState('');

  const payloadError = jsonErrorFor(
    payload,
    'That is not valid JSON. The payload is passed to the target as-is, so it must parse first.',
  );

  return (
    <Card
      title="Ingest an event by hand"
      actions={
        <span className="muted small">
          The same path an external producer's webhook takes
        </span>
      }
    >
      <form
        className="stack-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (type.trim() === '' || source.trim() === '' || payloadError !== null) return;
          let parsed: unknown;
          try {
            parsed = payload.trim() === '' ? undefined : JSON.parse(payload);
          } catch {
            return;
          }
          ingest.mutate(
            {
              type: type.trim(),
              source: source.trim(),
              ...(subject.trim() === '' ? {} : { subject: subject.trim() }),
              ...(externalId.trim() === '' ? {} : { externalId: externalId.trim() }),
              ...(parsed === undefined ? {} : { payload: parsed }),
            },
            { onSuccess: () => setPayload('') },
          );
        }}
      >
        <div className="row">
          <Field label="Type" hint="Matched against a subscription's topic.">
            <input
              className="input mono"
              value={type}
              onChange={(event) => setType(event.target.value)}
              disabled={ingest.isPending}
            />
          </Field>
          <Field label="Source" hint="Who sent it. Part of what a filter can match on.">
            <input
              className="input mono"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              disabled={ingest.isPending}
            />
          </Field>
        </div>

        <div className="row">
          <Field label="Subject" hint="Optional. The other half of what a filter can match on.">
            <input
              className="input"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              disabled={ingest.isPending}
            />
          </Field>
          <Field
            label="External id"
            hint="Optional. Supply one to deduplicate; leave it empty and every send is stored, which is what a test ingest usually wants."
          >
            <input
              className="input mono"
              value={externalId}
              onChange={(event) => setExternalId(event.target.value)}
              placeholder="(none — always stored)"
              disabled={ingest.isPending}
            />
          </Field>
        </div>

        <Field label="Payload (JSON)" hint="Optional. Passed to the target unchanged.">
          <textarea
            className="input mono"
            rows={4}
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            placeholder={'{ "ref": "main" }'}
            disabled={ingest.isPending}
          />
        </Field>
        {payloadError !== null ? <span className="field-error">{payloadError}</span> : null}

        <div className="row">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={ingest.isPending}
            disabled={type.trim() === '' || source.trim() === '' || payloadError !== null}
          >
            Send
          </Button>
          <span className="muted small">
            No subscription is required — an unmatched event is stored and ignored, which is a
            normal outcome and not an error.
          </span>
        </div>
      </form>

      {ingest.isError ? (
        <ErrorBox
          message={ingest.error instanceof Error ? ingest.error.message : 'The ingest failed.'}
        />
      ) : null}

      {ingest.data !== undefined ? <IngestResult result={ingest.data} /> : null}
    </Card>
  );
}

/**
 * The three outcomes, stated separately.
 *
 * This is the whole reason the manual ingest is worth having: "nothing matched" and "something
 * matched and it failed" look identical from the outside, and this panel is the only place they
 * are told apart.
 */
function IngestResult({ result }: { result: EventIngestResult }): ReactNode {
  const { event, deduplicated, matchedSubscriptions, triggered, failures } = result;

  return (
    <div className="stack-sm" style={{ marginTop: 12 }}>
      <div className="row-wrap small">
        <Badge tone={deduplicated ? 'waiting' : 'ok'}>
          {deduplicated ? 'duplicate — not stored again' : 'stored'}
        </Badge>
        <Badge tone={matchedSubscriptions > 0 ? 'ok' : 'neutral'}>
          {matchedSubscriptions} subscription{matchedSubscriptions === 1 ? '' : 's'} matched
        </Badge>
        <Badge tone={triggered > 0 ? 'ok' : matchedSubscriptions > 0 ? 'failed' : 'neutral'}>
          {triggered} started
        </Badge>
      </div>

      {matchedSubscriptions === 0 ? (
        <p className="muted small">
          Nothing is listening for <span className="mono">{event.type}</span> from{' '}
          <span className="mono">{event.source}</span>. The event was stored — add a subscription
          above if it should have started something.
        </p>
      ) : triggered < matchedSubscriptions ? (
        <p className="muted small">
          A subscription matched and did not start its target. That is a real failure, not a
          missing listener — the reasons are below.
        </p>
      ) : (
        <p className="muted small">
          Every matching subscription started its target. The runs are on the Runs page.
        </p>
      )}

      {failures.length > 0 ? (
        <div className="stack-sm">
          {failures.map((failure) => (
            <div key={failure.subscriptionId} className="row small">
              <Badge tone="failed">{shortId(failure.subscriptionId)}</Badge>
              <span>{failure.reason}</span>
            </div>
          ))}
        </div>
      ) : null}

      {deduplicated ? (
        <details>
          <summary className="muted small" style={{ cursor: 'pointer' }}>
            The event this matched
          </summary>
          <Code>{JSON.stringify(event, null, 2)}</Code>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Creating a subscription.
 *
 * `targetId` is a free-text id rather than a picker. That is a deliberate limit and not an
 * oversight: the three target kinds live under three different endpoints, and a picker would
 * need three queries on a form most operators fill in from a URL they already have open. The
 * hint on the field says where to find the id, which is cheaper than a picker that has to load
 * every task, workflow and agent to render.
 *
 * The secret is write-only. The field says so, because "I set it and now I cannot see it" is how
 * a webhook silently stops verifying.
 */
function CreateSubscriptionCard(): ReactNode {
  const create = useCreateEventSubscription();
  const [topic, setTopic] = useState('');
  const [source, setSource] = useState('');
  const [subject, setSubject] = useState('');
  const [targetKind, setTargetKind] = useState<(typeof TARGET_KINDS)[number]>('task');
  const [targetId, setTargetId] = useState('');
  const [secret, setSecret] = useState('');

  return (
    <Card title="New subscription">
      <form
        className="stack-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (topic.trim() === '' || targetId.trim() === '') return;
          create.mutate(
            {
              topic: topic.trim(),
              ...(source.trim() === '' && subject.trim() === ''
                ? {}
                : {
                    filter: {
                      ...(source.trim() === '' ? {} : { source: source.trim() }),
                      ...(subject.trim() === '' ? {} : { subject: subject.trim() }),
                    },
                  }),
              targetKind,
              targetId: targetId.trim(),
              enabled: true,
              ...(secret === '' ? {} : { secret }),
            },
            {
              onSuccess: () => {
                setTopic('');
                setSource('');
                setSubject('');
                setTargetId('');
                setSecret('');
              },
            },
          );
        }}
      >
        <div className="row">
          <Field label="Topic" hint="Matched against an event's type.">
            <input
              className="input mono"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="build.completed"
              disabled={create.isPending}
            />
          </Field>
          <Field
            label="Target kind"
            hint="A task carries the input; a workflow runs its steps; an agent needs a task to carry it — so prefer a task."
          >
            <select
              className="select"
              value={targetKind}
              onChange={(event) =>
                setTargetKind(event.target.value as (typeof TARGET_KINDS)[number])
              }
              disabled={create.isPending}
            >
              {TARGET_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field
          label="Target id"
          hint="Copy it from the target's own page URL — /tasks/:id, /workflows/:id or /agents/:id."
        >
          <input
            className="input mono"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            disabled={create.isPending}
          />
        </Field>

        <div className="row">
          <Field label="Filter: source" hint="Optional. Partial match against the event's source.">
            <input
              className="input mono"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              disabled={create.isPending}
            />
          </Field>
          <Field label="Filter: subject" hint="Optional. Partial match against the subject.">
            <input
              className="input mono"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              disabled={create.isPending}
            />
          </Field>
        </div>

        <Field
          label="Webhook secret"
          hint="Optional. An HMAC key for inbound verification. It is never returned by any endpoint — write it down now, because the list can only tell you whether one is set."
        >
          <input
            className="input mono"
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            disabled={create.isPending}
          />
        </Field>

        <div className="row">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={create.isPending}
            disabled={topic.trim() === '' || targetId.trim() === ''}
          >
            Subscribe
          </Button>
          <span className="muted small">
            A subscription is created enabled. Disabling one is not a route this build exposes —
            delete it instead.
          </span>
        </div>
      </form>

      {create.isError ? (
        <ErrorBox
          message={create.error instanceof Error ? create.error.message : 'Could not subscribe.'}
        />
      ) : null}
    </Card>
  );
}

