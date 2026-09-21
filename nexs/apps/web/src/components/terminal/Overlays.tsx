/**
 * §6.2 — the approval overlay, and §5.1 — the session switcher.
 *
 * Two modals that the spec draws as side-by-side ASCII boxes and that are, structurally, the same
 * shape: a bordered panel listing rows with a numbered choice beneath. They live in one file for
 * that reason and for one more: both have a **number-key shortcut** (`[1]`/`[2]`/`[3]` here,
 * `[N]`/`[R]`/`[D]`/`[B]` there), and one implementation of "a modal whose digit keys map to the
 * buttons" is better than two that can disagree about whether the keys also work while a search
 * field has focus.
 *
 * ## What the approval overlay's three answers map onto, exactly
 *
 * The spec's `[1] Allow Once`, `[2] Allow Always`, `[3] Deny` is the **exec** vocabulary —
 * `EXEC_DECISION_OPTIONS` is literally `['allow_once', 'allow_always', 'deny']`, and
 * `allow_always` writes a standing allowlist rule. That is why this overlay is only used for
 * `kind: 'exec'` approvals: a plan-step approval takes `approve`/`reject`, and offering it
 * "Allow always" would be asking the API a question it refuses.
 *
 * So the same panel has two vocabularies, and which one it renders is decided by the approval's
 * own kind rather than by a prop — a caller cannot pass the wrong one.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type {
  ApprovalDetail,
  ChatSessionSummary,
  ExecAllowlistRuleSummary,
  ExecDecisionOption,
} from '@nexs/shared';
import { Badge, Button, Modal, StatusBadge } from '../ui';
import { EM_DASH, formatDateTime, formatRelative, inlineJson } from '../../lib/format';
import { isExecApproval } from '../../features/approvals/exec-queries';

/** §6.2's three answers, in the spec's order. */
const EXEC_CHOICES: readonly { decision: ExecDecisionOption; label: string; note: string }[] = [
  {
    decision: 'allow_once',
    label: 'Allow once',
    note: 'Runs this command one time. Nothing is remembered.',
  },
  {
    decision: 'allow_always',
    label: 'Allow always',
    note: 'Writes a standing rule for this exact command, directory and argument prefix.',
  },
  { decision: 'deny', label: 'Deny', note: 'Aborts the call and reports the refusal to the agent.' },
];

export interface ApprovalOverlayProps {
  approval: ApprovalDetail | null;
  /** The exec rules that already cover this command, for the "already permitted" note. */
  matchingRule: ExecAllowlistRuleSummary | null;
  busy: boolean;
  error: string | null;
  onDecideTool: (decision: 'approved' | 'rejected') => void;
  onDecideExec: (decision: ExecDecisionOption) => void;
  onClose: () => void;
}

/**
 * The overlay.
 *
 * Digit keys are wired to the same handlers as the buttons, and the reason they are worth having
 * is the spec's: an operator often reaches an approval with one hand on a shell, and `3` is
 * faster than aiming at a button. The keys are inert when the modal is closed.
 */
export function ApprovalOverlay({
  approval,
  matchingRule,
  busy,
  error,
  onDecideTool,
  onDecideExec,
  onClose,
}: ApprovalOverlayProps): ReactNode {
  const exec = approval !== null && isExecApproval(approval);

  const choices = useMemo(
    () => (exec ? EXEC_CHOICES.map((choice) => choice.decision) : (['approved', 'rejected'] as const)),
    [exec],
  );

  useEffect(() => {
    if (approval === null) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (busy) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= choices.length) return;
      event.preventDefault();
      const choice = choices[index];
      if (choice === undefined) return;
      if (choice === 'approved' || choice === 'rejected') onDecideTool(choice);
      else onDecideExec(choice);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [approval, busy, choices, onDecideTool, onDecideExec]);

  if (approval === null) return null;

  return (
    <Modal
      onClose={onClose}
      title={exec ? 'Command approval required' : 'Tool execution approval required'}
    >
      <div className="approval">
        <dl className="approval-kv">
          <dt>Status</dt>
          <dd>
            <StatusBadge status={approval.status} />
            {approval.isExpired ? (
              <span className="muted small"> · past its deadline; a decision will be refused</span>
            ) : null}
          </dd>

          <dt>Title</dt>
          <dd>{approval.title}</dd>

          <dt>Risk</dt>
          <dd>
            <Badge
              tone={
                approval.risk.level === 'high'
                  ? 'failed'
                  : approval.risk.level === 'medium'
                    ? 'waiting'
                    : 'ok'
              }
            >
              {approval.risk.level}
            </Badge>
            {approval.risk.reasons.length > 0 ? (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {approval.risk.reasons.map((reason) => (
                  <li className="small" key={reason}>
                    {reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </dd>

          <dt>Action</dt>
          <dd>
            <span className="mono">{approval.action.kind}</span>{' '}
            <span className="muted small">{approval.action.title}</span>
          </dd>

          {exec ? <ExecCommand detail={approval} /> : null}

          {matchingRule !== null ? (
            <>
              <dt>Existing rule</dt>
              <dd>
                Already permitted by a rule for{' '}
                <span className="mono">
                  {matchingRule.command} {matchingRule.args.join(' ')}
                </span>{' '}
                in <span className="mono">{matchingRule.cwd}</span>. Denying here does not revoke it.
              </dd>
            </>
          ) : null}

          {approval.run !== null ? (
            <>
              <dt>Run</dt>
              <dd>
                <Link to={`/runs/${approval.run.id}`}>{approval.run.id}</Link>{' '}
                <StatusBadge status={approval.run.status} />
              </dd>
            </>
          ) : null}

          <dt>Requested</dt>
          <dd className="small" title={approval.createdAt}>
            {formatDateTime(approval.createdAt)} ({formatRelative(approval.createdAt)})
          </dd>

          <dt>Expires</dt>
          <dd className="small">
            {approval.expiresAt === null ? EM_DASH : formatDateTime(approval.expiresAt)}
          </dd>
        </dl>

        {!exec ? (
          /*
            A plan-step approval has no command to show, so the raw action payload is the only
            evidence of what would happen. It is rendered rather than summarised: the payload's
            schema belongs to whichever tool produced it, and paraphrasing it here would be a
            second, weaker description of a decision the operator has to make.
          */
          <details>
            <summary className="small muted" style={{ cursor: 'pointer' }}>
              Requested action (raw)
            </summary>
            <pre className="banner-pre" style={{ marginTop: 6 }}>
              {inlineJson(approval.requestedAction, 4000)}
            </pre>
          </details>
        ) : null}

        {error !== null ? <div className="error-box small">{error}</div> : null}

        <div className="approval-options">
          {exec
            ? EXEC_CHOICES.map((choice, index) => (
                <button
                  key={choice.decision}
                  type="button"
                  className="approval-option"
                  disabled={busy || approval.isExpired}
                  onClick={() => onDecideExec(choice.decision)}
                >
                  <span className="approval-option-num">[{index + 1}]</span>
                  <span>
                    <span className="approval-option-label">{choice.label}</span>{' '}
                    <span className="approval-option-note">({choice.note})</span>
                  </span>
                </button>
              ))
            : (
                <>
                  <button
                    type="button"
                    className="approval-option"
                    disabled={busy || approval.isExpired}
                    onClick={() => onDecideTool('approved')}
                  >
                    <span className="approval-option-num">[1]</span>
                    <span>
                      <span className="approval-option-label">Approve</span>{' '}
                      <span className="approval-option-note">(resumes the parked step)</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="approval-option"
                    disabled={busy || approval.isExpired}
                    onClick={() => onDecideTool('rejected')}
                  >
                    <span className="approval-option-num">[2]</span>
                    <span>
                      <span className="approval-option-label">Reject</span>{' '}
                      <span className="approval-option-note">(fails the step and tells the agent)</span>
                    </span>
                  </button>
                </>
              )}
        </div>

        <p className="muted small">
          {busy ? 'Submitting…' : <>Choice <kbd>1</kbd>–<kbd>{choices.length}</kbd>, or <kbd>Esc</kbd> to cancel.</>}
        </p>
      </div>
    </Modal>
  );
}

/** The command an exec approval is about — the three fields that make it specific. */
function ExecCommand({ detail }: { detail: ApprovalDetail }): ReactNode {
  // The payload is `unknown` on the contract (it belongs to whichever producer made it), so it is
  // read defensively here and a shape that does not match is reported rather than rendered as an
  // empty box — an approval with no visible command is an approval nobody can evaluate.
  const action = detail.requestedAction;
  if (typeof action !== 'object' || action === null) {
    return (
      <>
        <dt>Command</dt>
        <dd className="muted small">The request carries no readable command payload.</dd>
      </>
    );
  }
  const record = action as Record<string, unknown>;
  const command = typeof record.command === 'string' ? record.command : null;
  const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === 'string') : [];
  const cwd = typeof record.cwd === 'string' ? record.cwd : null;

  if (command === null) {
    return (
      <>
        <dt>Command</dt>
        <dd className="muted small">The request carries no readable command payload.</dd>
      </>
    );
  }

  return (
    <>
      <dt>Command</dt>
      <dd>
        <div className="approval-command">
          {[command, ...args].join(' ')}
          {'\n'}
          <span className="muted">in {cwd ?? '(no directory given)'}</span>
        </div>
      </dd>
      <dt>Args</dt>
      <dd className="mono small">{args.length === 0 ? '(none)' : args.join(' ')}</dd>
    </>
  );
}

// ── §5.1 the session switcher ───────────────────────────────────────────────

export interface SessionSwitcherProps {
  open: boolean;
  onClose: () => void;
  sessions: readonly ChatSessionSummary[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}

/**
 * The interactive session switcher.
 *
 * ## The keyboard model
 *
 * `↑`/`↓` move the cursor, `Enter` switches, `N` creates, `R` renames, `D` deletes. The spec also
 * lists `B` (branch) — there is no branch endpoint, so `B` is not bound and the footer says so
 * rather than leaving a reader to wonder whether they pressed it wrong.
 *
 * ## Why `N`/`R`/`D` are not bound while the search field has focus
 *
 * They are letters. A search for "refactor" contains an `r` and a `d`, and a modal whose action
 * keys fire mid-word would delete a session while the user was typing. So the letters are only
 * live once focus has left the search box — which is also why the search field is not autofocused
 * beyond the modal's own focus handling.
 */
export function SessionSwitcher({
  open,
  onClose,
  sessions,
  activeId,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
}: SessionSwitcherProps): ReactNode {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return [...sessions];
    return sessions.filter((session) =>
      `${session.title ?? ''} ${session.id}`.toLowerCase().includes(needle),
    );
  }, [sessions, query]);

  const clamped = Math.min(cursor, Math.max(0, filtered.length - 1));
  const selected = filtered[clamped] ?? null;

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((current) => Math.min(current + 1, filtered.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        if (typing) return;
        event.preventDefault();
        if (selected !== null) onSwitch(selected.id);
        return;
      }
      if (typing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        onCreate();
      } else if (key === 'r') {
        if (selected === null) return;
        event.preventDefault();
        onRename(selected.id);
      } else if (key === 'd') {
        if (selected === null) return;
        event.preventDefault();
        onDelete(selected.id);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, filtered.length, selected, onClose, onSwitch, onCreate, onRename, onDelete]);

  // Reset the search when the modal opens, so it does not reopen filtered by a query from last
  // time — a picker that shows nothing until you clear a box you cannot see is a bug report.
  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
    }
  }, [open]);

  if (!open) return null;

  return (
    <Modal onClose={onClose} title="Sessions">
      <div className="roster">
        <div className="roster-search">
          <label className="small muted" htmlFor="session-search">
            Search
          </label>
          <input
            id="session-search"
            className="input grow"
            value={query}
            placeholder="Filter by title or id…"
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
          />
        </div>

        {filtered.length === 0 ? (
          <div className="roster-empty">
            {sessions.length === 0
              ? 'No conversations yet.'
              : `Nothing matches “${query}”. ${sessions.length} total.`}
          </div>
        ) : (
          <table className="roster-table">
            <thead>
              <tr>
                <th style={{ width: 34 }} />
                <th>Title</th>
                <th className="is-mono">ID</th>
                <th>Updated</th>
                <th className="is-mono right">Messages</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((session, index) => (
                <tr
                  key={session.id}
                  className={index === clamped ? 'is-active' : undefined}
                  onClick={() => setCursor(index)}
                  onDoubleClick={() => onSwitch(session.id)}
                >
                  <td className="is-mono">{session.id === activeId ? '▶' : ''}</td>
                  <td>{session.title ?? <span className="muted">Untitled</span>}</td>
                  <td className="is-mono small">{session.id.slice(0, 12)}</td>
                  <td className="small" title={session.updatedAt}>
                    {formatRelative(session.lastMessageAt ?? session.updatedAt)}
                  </td>
                  <td className="is-mono right">{session.messageCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="roster-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> switch
          </span>
          <span>
            <kbd>N</kbd> new
          </span>
          <span>
            <kbd>R</kbd> rename
          </span>
          <span>
            <kbd>D</kbd> delete
          </span>
          <span title="There is no branch endpoint: a conversation is not forkable in this build">
            <kbd>B</kbd> branch — not available
          </span>
          <span style={{ marginLeft: 'auto' }}>
            {selected === null ? null : <Link to={`/chat?session=${selected.id}`}>Open in Chat</Link>}
          </span>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button
            size="sm"
            onClick={() => {
              if (selected !== null) onRename(selected.id);
            }}
            disabled={selected === null}
          >
            Rename
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              if (selected !== null) onDelete(selected.id);
            }}
            disabled={selected === null}
          >
            Delete
          </Button>
          <Button size="sm" variant="primary" onClick={onCreate}>
            New session
          </Button>
        </div>
      </div>
    </Modal>
  );
}
