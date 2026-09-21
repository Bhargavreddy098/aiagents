/**
 * Browser sessions — §4-PHASE13.13: *"active sessions (live URL/title/screenshot), history,
 * action log."*
 *
 * ## Where the "action log" actually lives
 *
 * There is no `GET /browser/:id/actions`. The browser router exposes `POST /:id/actions` and
 * nothing to list them, because an action *is* a tool call: it goes through the invoker,
 * lands on a `ToolCall` row and shows up in the run's Tools tab. So this page links to the
 * run rather than inventing a second, thinner log of the same events — a list assembled from
 * anything else would be a different answer to the same question.
 *
 * Live updates arrive as `browser.started`, `browser.updated` and `browser.closed`, which
 * invalidate `['browser','sessions']`.
 *
 * ## This page can now drive a session, and that changes what it is
 *
 * `POST /browser` and `POST /browser/:id/actions` are real routes, so the read-only list this
 * page used to be was half the surface. The action composer added here is the **operator's**
 * hand on a session — the same `browserActionSchema` the agent's tool goes through, so nothing
 * an operator can do from here is outside what the engine could do.
 *
 * ## Why the action form is a `navigate`/`close` pair and not all eleven action types
 *
 * `browserActionSchema` is a discriminated union of eleven types (navigate, click, type, select,
 * extract, upload, download, screenshot, wait, inspect, close), and several of them take
 * coordinates or selectors that only mean anything relative to what is on the page — which the
 * operator cannot see, because the screenshot is an artifact reference rather than an inline
 * image. Offering `click` with a hand-typed selector would be a form that fails more often than
 * it works.
 *
 * So the free-form action this page offers is `navigate` (which needs only a URL) plus `close`.
 * The other nine are reached the way they are meant to be: by the agent, through its tool, where
 * they have a page to act on. `/api/browser/:id/actions` is a general endpoint and the types are
 * exported from `queries.ts` — this is a deliberate limit on the *form*, not on the API.
 */

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  Dot,
  EmptyState,
  ErrorBox,
  Field,
  PageHead,
  QueryBoundary,
  StatusBadge,
  Tabs,
} from '../../components/ui';
import { EM_DASH, formatDateTime, formatRelative, shortId } from '../../lib/format';
import { useSseStatus } from '../../hooks/useSseEvents';
import {
  useBrowserSessions,
  useBrowserSession,
  useCloseBrowserSession,
  useCreateBrowserSession,
  useRunBrowserAction,
} from './queries';

export function BrowserPage(): ReactNode {
  const [tab, setTab] = useState('active');
  const query = useBrowserSessions();
  const stream = useSseStatus();
  /** The session whose detail panel is open below the table. */
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <>
      <PageHead
        title="Browser"
        subtitle="Sessions an agent is driving, and the ones it has finished with."
        actions={
          <span className="row small muted" title={`Event stream: ${stream}`}>
            <Dot tone={stream === 'open' ? 'ok' : stream === 'connecting' ? 'waiting' : 'failed'} />
            {stream === 'open' ? 'Live' : stream === 'connecting' ? 'Reconnecting' : 'Offline'}
          </span>
        }
      />

      <QueryBoundary query={query} loadingLabel="Loading browser sessions…">
        {(sessions) => {
          const active = sessions.filter(
            (session) => session.status === 'active' || session.status === 'idle',
          );
          const history = sessions.filter(
            (session) => session.status !== 'active' && session.status !== 'idle',
          );
          const rows = tab === 'active' ? active : history;

          return (
            <>
              <Tabs
                tabs={[
                  { id: 'active', label: 'Active', badge: <Badge>{active.length}</Badge> },
                  { id: 'history', label: 'History', badge: <Badge>{history.length}</Badge> },
                ]}
                active={tab}
                onChange={setTab}
              />

              <div style={{ marginTop: 16 }}>
                <Card flush>
                  {rows.length === 0 ? (
                    <EmptyState
                      title={tab === 'active' ? 'No live sessions' : 'No closed sessions'}
                      hint={
                        tab === 'active'
                          ? 'A session appears while an agent is driving a browser.'
                          : undefined
                      }
                    />
                  ) : (
                    <table className="table table-clickable">
                      <thead>
                        <tr>
                          <th>Session</th>
                          <th>Status</th>
                          <th>Current page</th>
                          <th>Screenshot</th>
                          <th>Run</th>
                          <th>Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((session) => (
                          <tr
                            key={session.id}
                            onClick={() => setOpenId(session.id === openId ? null : session.id)}
                            tabIndex={0}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                setOpenId(session.id === openId ? null : session.id);
                              }
                            }}
                          >
                            <td className="mono small">{shortId(session.id)}</td>
                            <td>
                              <StatusBadge status={session.status} />
                            </td>
                            <td className="truncate" style={{ maxWidth: 280 }}>
                              {session.currentUrl === null ? (
                                <span className="muted">{EM_DASH}</span>
                              ) : (
                                <a
                                  href={session.currentUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="small"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  {session.currentUrl}
                                </a>
                              )}
                              {session.title !== null ? (
                                <div className="muted small truncate">{session.title}</div>
                              ) : null}
                            </td>
                            <td className="small">
                              {session.screenshotRef === null ? (
                                <span className="muted">{EM_DASH}</span>
                              ) : (
                                // The ref is an artifact pointer, not an image URL. Linking it
                                // through the file preview route is the only way to view it, and
                                // if it is not an attachment the route answers 404 — which is a
                                // truthful failure rather than a broken image.
                                <a
                                  href={`/api/files/${encodeURIComponent(session.screenshotRef)}/preview`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mono"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  {shortId(session.screenshotRef, 12)}
                                </a>
                              )}
                            </td>
                            <td className="small">
                              {session.runId === null ? (
                                <span className="muted">{EM_DASH}</span>
                              ) : (
                                <Link
                                  to={`/runs/${session.runId}`}
                                  onClick={(event) => event.stopPropagation()}
                                >
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
              </div>

              {openId !== null ? (
                <div style={{ marginTop: 16 }}>
                  <SessionPanel sessionId={openId} onClose={() => setOpenId(null)} />
                </div>
              ) : null}

              <div style={{ marginTop: 16 }}>
                <NewSessionCard />
              </div>

              <div style={{ marginTop: 16 }}>
                <Card title="Where the action log is">
                  <p className="muted small">
                    Browser actions are tool calls. Each one is on the run's Tools tab, with its
                    arguments, result and duration — open the run above rather than reading a
                    separate log that would be a second, thinner record of the same events.
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

/**
 * One session's detail, and the operator's hand on it.
 *
 * The URL field is the only action offered, for the reason in the file header: it is the one
 * action whose argument is self-describing. `close` is offered alongside because it needs no
 * argument at all and is the operation an operator actually wants when a session is stuck.
 */
function SessionPanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}): ReactNode {
  const detail = useBrowserSession(sessionId);
  const navigate = useRunBrowserAction();
  const close = useCloseBrowserSession();
  const [url, setUrl] = useState('');

  const session = detail.data;

  return (
    <Card
      title={
        <span className="row" style={{ gap: 6 }}>
          <span className="mono">{shortId(sessionId)}</span>
          {session !== undefined ? <StatusBadge status={session.status} /> : null}
        </span>
      }
      actions={
        <span className="row">
          <Button
            size="sm"
            variant="danger"
            loading={close.isPending}
            onClick={() => close.mutate(sessionId, { onSuccess: onClose })}
            title="Close this browser session"
          >
            Close session
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Hide
          </Button>
        </span>
      }
    >
      {detail.isPending ? (
        <p className="muted small">Loading…</p>
      ) : detail.isError ? (
        <ErrorBox message="Could not load this session." />
      ) : session === undefined ? null : (
        <div className="stack-sm">
          <dl className="kv">
            <dt>Current URL</dt>
            <dd className="mono small truncate">{session.currentUrl ?? EM_DASH}</dd>
            <dt>Title</dt>
            <dd className="small">{session.title ?? EM_DASH}</dd>
            <dt>Started</dt>
            <dd className="small">{formatDateTime(session.createdAt)}</dd>
            <dt>Updated</dt>
            <dd className="small">{formatDateTime(session.updatedAt)}</dd>
          </dl>

          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              const target = url.trim();
              if (target === '') return;
              navigate.mutate(
                { id: sessionId, action: { type: 'navigate', url: target } },
                { onSuccess: () => setUrl('') },
              );
            }}
          >
            <Field
              label="Navigate this session to"
              hint="The same `navigate` action the agent's tool sends. Other action types need a page the operator cannot see here — the agent drives those."
            >
              <input
                className="input mono"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com"
                disabled={navigate.isPending}
              />
            </Field>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              loading={navigate.isPending}
              disabled={url.trim() === ''}
            >
              Navigate
            </Button>
          </form>

          {navigate.isError ? (
            <ErrorBox
              message={
                navigate.error instanceof Error
                  ? navigate.error.message
                  : 'The action was refused.'
              }
            />
          ) : null}

          {navigate.isSuccess ? (
            <p className="muted small">
              The action ran. Its outcome is a tool result — it is on the run's Tools tab, not
              here, because the shape varies by action type and a JSON blob beside the form would
              be a second, thinner rendering of the same row.
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/**
 * Opening a session by hand.
 *
 * The page used to say "this page does not create one, because a session with no agent driving
 * it has nothing to do" — and that was right about the *old* page, which had no way to act on
 * one. Now that the panel above can send `navigate`, a hand-opened session is usable, so the
 * card is here. The run id is optional: a session with no run is one an operator is driving.
 */
function NewSessionCard(): ReactNode {
  const create = useCreateBrowserSession();
  const [url, setUrl] = useState('');

  return (
    <Card title="Open a session">
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            url.trim() === '' ? {} : { url: url.trim() },
            { onSuccess: () => setUrl('') },
          );
        }}
      >
        <Field
          label="Start URL"
          hint="Optional. A session with no run is one you are driving; the agent is not involved until a run adopts it."
        >
          <input
            className="input mono"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com"
            disabled={create.isPending}
          />
        </Field>
        <Button type="submit" size="sm" variant="primary" loading={create.isPending}>
          Open session
        </Button>
      </form>

      {create.isError ? (
        <ErrorBox
          message={create.error instanceof Error ? create.error.message : 'Could not open a session.'}
        />
      ) : null}
    </Card>
  );
}
