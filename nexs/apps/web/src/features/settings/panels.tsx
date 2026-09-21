/**
 * The Settings panels that are about *you*, rather than about a page you can go to.
 *
 * ## What moved here, and from where
 *
 * Two surfaces used to hold these, and both are gone:
 *
 *  - **`SettingsPage`** held Profile, Password, Command owner, Notifications and the danger zone,
 *    stacked on one long scrolling document. It is a master-detail view now — the sections are
 *    unchanged in substance, they are just not all on screen at once.
 *  - **`SettingsCard`** held the account block, the notification list with mark-all-read, and the
 *    theme switch. That card also held the entire product's navigation, which was the actual
 *    problem with it; the navigation is in the sidebar and the directory now, and these three
 *    panels survived the move intact.
 *
 * Nothing was dropped. What was dropped is the duplication: the account block said name, email
 * and workspace, and the Profile panel said email, workspace and user id. They are one panel now,
 * and the identity block at the top of it carries the name.
 *
 * ## The honesty rule, restated because this is where it is easiest to break
 *
 * The spec asks this page for "profile, security (change password, sessions), key rotation,
 * notification prefs, danger zone". Three of those five have no backend. Each panel says so in
 * words rather than rendering a control that saves nothing, and each one says *why* — a user who
 * came here to "sign out everywhere" leaves knowing how that is actually done.
 *
 * A panel that renders a form with no endpoint behind it is worse than a panel that admits the
 * gap: it teaches the operator that this product lies about what it can do.
 */

import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PASSWORD_MIN_LENGTH } from '@nexs/shared';
import { Badge, Button, Card, ErrorBox, Field, KeyValue } from '../../components/ui';
import { describeError } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { THEMES, useTheme } from '../../lib/theme';
import { useAuth } from '../auth/auth-context';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '../notifications/queries';
import {
  useConfirmPasswordReset,
  useRequestPasswordReset,
  useSetOwner,
  useUpdateProfile,
} from './queries';

// ── profile ───────────────────────────────────────────────────────────────────

export function ProfilePanel(): ReactNode {
  const { user } = useAuth();
  const update = useUpdateProfile();
  const [name, setName] = useState(user?.name ?? '');

  if (user === null) return null;

  return (
    <Card>
      <div className="stack">
        {/*
          The identity block, kept from the settings card. It is the only place the signed-in
          account is stated as a fact rather than as a form field, and the workspace name in
          particular appears nowhere else in the shell.
        */}
        <div className="work-account">
          <span className="brand-mark work-account-mark" aria-hidden="true">
            {user.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="work-account-text">
            <span className="work-account-name">{user.name}</span>
            <span className="work-account-mail" title={user.email}>
              {user.email}
            </span>
            <span className="work-account-org" title={user.tenantName}>
              {user.tenantName}
            </span>
          </span>
        </div>

        <hr className="rule" />

        <Field label="Display name" hint="Shown in the sidebar and on approvals you decide.">
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
          />
        </Field>

        {/* Read-only because nothing can write them. An editable box here would be a promise
            no endpoint keeps. */}
        <KeyValue entries={[['User id', <code key="id">{user.id}</code>]]} />

        {update.isError ? <ErrorBox message={describeError(update.error).message} /> : null}
        {update.isSuccess ? <p className="muted small">Saved.</p> : null}

        <div className="row">
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={name.trim().length === 0 || name.trim() === user.name}
            onClick={() => update.mutate(name.trim())}
          >
            Save name
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ── password ──────────────────────────────────────────────────────────────────

type ResetStage = 'start' | 'awaiting-token' | 'done';

export function PasswordPanel(): ReactNode {
  const { user } = useAuth();
  const request = useRequestPasswordReset();
  const confirm = useConfirmPasswordReset();

  const [newPassword, setNewPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [token, setToken] = useState('');
  const [stage, setStage] = useState<ResetStage>('start');

  if (user === null) return null;

  const tooShort = newPassword.length > 0 && newPassword.length < PASSWORD_MIN_LENGTH;
  const mismatch = repeat.length > 0 && newPassword !== repeat;
  const canSubmit = newPassword.length >= PASSWORD_MIN_LENGTH && newPassword === repeat;

  async function begin(): Promise<void> {
    const result = await request.mutateAsync(user?.email ?? '');
    if (result.token !== undefined) {
      // Outside production the token comes straight back, so the change completes here. This is
      // the branch that makes the section a working password change rather than a mail round
      // trip that cannot be finished locally.
      setToken(result.token);
      await finish(result.token);
      return;
    }
    // Production: the token was emailed and must be typed in.
    setStage('awaiting-token');
  }

  async function finish(usedToken: string): Promise<void> {
    await confirm.mutateAsync({ token: usedToken, newPassword });
    setStage('done');
    setNewPassword('');
    setRepeat('');
    setToken('');
  }

  return (
    <Card>
      <div className="stack">
        {stage === 'done' ? (
          <div className="stack-sm">
            <p>
              <Badge tone="ok">changed</Badge>{' '}
              The password was changed and every existing access token was invalidated — including
              this browser&rsquo;s.
            </p>
            <p className="muted small">
              Reload the page and you will be asked to sign in again. That is the change working,
              not a fault.
            </p>
            <div className="row">
              <Button size="sm" onClick={() => setStage('start')}>
                Change it again
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Field
              label="New password"
              hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
              error={tooShort ? `Too short — ${PASSWORD_MIN_LENGTH} characters minimum.` : undefined}
            >
              <input
                className="input"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
              />
            </Field>

            <Field
              label="Repeat it"
              error={mismatch ? 'The two entries do not match.' : undefined}
            >
              <input
                className="input"
                type="password"
                value={repeat}
                onChange={(event) => setRepeat(event.target.value)}
                autoComplete="new-password"
              />
            </Field>

            {stage === 'awaiting-token' ? (
              <Field
                label="Reset token"
                hint="No mail provider is configured, so the token was not sent anywhere. Paste it from the server log, or from your email in production."
              >
                <input
                  className="input"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </Field>
            ) : null}

            {request.isError ? <ErrorBox message={describeError(request.error).message} /> : null}
            {confirm.isError ? <ErrorBox message={describeError(confirm.error).message} /> : null}

            <div className="row">
              {stage === 'awaiting-token' ? (
                <Button
                  variant="primary"
                  loading={confirm.isPending}
                  disabled={token.trim().length === 0 || !canSubmit}
                  onClick={() => void finish(token.trim())}
                >
                  Confirm change
                </Button>
              ) : (
                <Button
                  variant="primary"
                  loading={request.isPending || confirm.isPending}
                  disabled={!canSubmit}
                  onClick={() => void begin()}
                >
                  Change password
                </Button>
              )}
            </div>
          </>
        )}

        <hr className="rule" />

        {/*
          Sessions are described rather than listed, and the reason is a design fact rather than
          a missing feature. Stating it is more useful than an empty table: a user who came here
          to "sign out everywhere" leaves knowing how to actually do it.
        */}
        <div className="stack-sm">
          <span className="label">Sessions</span>
          <p className="muted small">
            There is no device or session list, because there is no session table to list. Access
            is a signed token carrying a version number, and changing your password increments
            it — which invalidates every token issued before the change, on every device. That is
            how &ldquo;sign out everywhere&rdquo; is done here.
          </p>
        </div>
      </div>
    </Card>
  );
}

// ── appearance ────────────────────────────────────────────────────────────────

export function AppearancePanel(): ReactNode {
  const { theme, setTheme } = useTheme();

  return (
    <Card>
      <div className="stack">
        <div className="work-theme" role="group" aria-label="Colour theme">
          {THEMES.map((entry) => (
            <button
              key={entry}
              type="button"
              className={theme === entry ? 'chip chip-on' : 'chip'}
              aria-pressed={theme === entry}
              onClick={() => setTheme(entry)}
            >
              {entry === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
        <p className="muted small">
          The theme is stored in this browser, so it does not change what anyone else sees.
        </p>
      </div>
    </Card>
  );
}

// ── notifications ─────────────────────────────────────────────────────────────

/**
 * The bell, relocated.
 *
 * It used to be a strip across the top of the task — the wrong place for something about you
 * rather than about what you are reading. It is the real `Notification` table either way: the
 * rows below are server rows, the unread count is the server's, and mark-read writes through.
 *
 * The panel also states the part that does not exist, because a reader who came looking for
 * "which events reach me, and where" would otherwise assume the absence of a form meant the
 * absence of the feature.
 */
export function NotificationsPanel(): ReactNode {
  const navigate = useNavigate();
  const query = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const unread = query.data?.unreadCount ?? 0;
  const items = query.data?.notifications ?? [];

  return (
    <Card>
      <div className="stack">
        <div className="row-between">
          <span className="muted small">
            {unread > 0 ? `${unread} unread.` : 'Nothing unread.'}
          </span>
          <button
            type="button"
            className="work-section-action work-section-action-wide"
            title="Mark all as read"
            aria-label="Mark all notifications as read"
            disabled={unread === 0 || markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            ✓ Mark all read
          </button>
        </div>

        {query.isPending ? (
          <p className="muted small">Loading…</p>
        ) : query.isError ? (
          // Not an empty list — the same rule the conversation list follows. A failed read
          // rendered as "nothing yet" is the one failure this codebase refuses everywhere.
          <p className="muted small">Could not load notifications.</p>
        ) : items.length === 0 ? (
          <p className="muted small">
            Nothing yet. Notifications are written by the server as things happen — a run failing,
            an approval being requested.
          </p>
        ) : (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="work-notif"
              data-unread={item.isRead ? undefined : 'true'}
              onClick={() => {
                if (!item.isRead) markRead.mutate(item.id);
                // `linkRoute` is what the notification is *about*. A notification you cannot act
                // on is a dead end, so the row navigates rather than only marking read.
                if (item.linkRoute !== null) navigate(item.linkRoute);
              }}
            >
              <span className="work-notif-title">{item.title}</span>
              <span className="work-notif-age" title={item.createdAt}>
                {formatRelative(item.createdAt)}
              </span>
              {item.body === null ? null : <span className="work-notif-body">{item.body}</span>}
            </button>
          ))
        )}

        <hr className="rule" />

        <p className="muted small">
          There is no notification preference endpoint, so there is nothing here to configure.
          The preference model that would sit here — which events reach you, and on which channel
          — is part of the v2 channel work, which is not built.
        </p>
      </div>
    </Card>
  );
}

// ── this session ──────────────────────────────────────────────────────────────

export function SessionPanel(): ReactNode {
  const { logout } = useAuth();

  return (
    <Card>
      <div className="row-between">
        <span className="muted small">
          Signing out clears every cached row in this browser as well as the cookies.
        </span>
        <Button onClick={() => void logout()}>Sign out</Button>
      </div>
    </Card>
  );
}

// ── command owner ─────────────────────────────────────────────────────────────

export function OwnerPanel(): ReactNode {
  const { user } = useAuth();
  const setOwner = useSetOwner();

  if (user === null) return null;

  const result = setOwner.data;

  return (
    <Card>
      <div className="stack">
        <p className="muted small">
          The owner is the account allowed to run owner-only commands. A workspace with no owner
          may be claimed by any member; once an owner exists, only that owner can transfer or
          clear it.
        </p>

        <p className="muted small">
          This page cannot show you who the owner is today: the owner is a column on the
          workspace record and no endpoint projects it. What it can do is tell you the result of
          a change you just made.
        </p>

        {setOwner.isError ? <ErrorBox message={describeError(setOwner.error).message} /> : null}

        {result !== undefined ? (
          <KeyValue
            entries={[
              [
                'Owner now',
                result.ownerUserId === null ? 'Nobody' : <code key="o">{result.ownerUserId}</code>,
              ],
              ['How', result.claimed ? 'Claimed — the workspace had no owner' : 'Transferred'],
            ]}
          />
        ) : null}

        <div className="row">
          <Button
            variant="primary"
            loading={setOwner.isPending}
            onClick={() => setOwner.mutate(user.id)}
          >
            Make me the owner
          </Button>
        </div>

        <hr className="rule" />

        <div className="stack-sm">
          <span className="label">Clear the owner</span>
          <p className="muted small">
            This removes ownership entirely and, with it, the exec gate that owner-only commands
            are subject to. It is reversible only by claiming ownership again.
          </p>
          <div className="row">
            <Button
              variant="danger"
              loading={setOwner.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    'Clear the command owner? Owner-only commands lose their gate until someone claims it again.',
                  )
                ) {
                  setOwner.mutate(null);
                }
              }}
            >
              Clear owner
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── danger zone ───────────────────────────────────────────────────────────────

export function DangerPanel(): ReactNode {
  return (
    <Card>
      <div className="stack">
        <p className="muted small">
          There is no account or workspace deletion endpoint, so this is not a delete button. It
          is a list of the destructive operations that do exist, each on the page that owns it —
          so the one place someone looks for &ldquo;how do I get rid of this&rdquo; has an answer
          rather than a dead control.
        </p>

        <ul className="danger-list">
          <li>
            <strong>Delete a provider key</strong> — removes the provider and every model synced
            from it. <Link to="/models">Models</Link>
          </li>
          <li>
            <strong>Delete an MCP server</strong> — removes its tools from the registry.{' '}
            <Link to="/mcp">MCP</Link>
          </li>
          <li>
            <strong>Archive an agent</strong> — hidden from lists and unusable for new runs; its
            history is kept. <Link to="/agents">Agents</Link>
          </li>
          <li>
            <strong>Remove a connector</strong> — revokes its account and stops its tools
            resolving. <Link to="/connectors">Connectors</Link>
          </li>
          <li>
            <strong>Delete a conversation</strong> — from the conversation list in the sidebar,
            which is <Link to="/chat">Chat</Link>.
          </li>
        </ul>
      </div>
    </Card>
  );
}
