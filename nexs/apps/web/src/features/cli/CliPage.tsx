/**
 * The terminal — `/cli`.
 *
 * ## What it is, in one sentence
 *
 * A real command surface that really executes: a line typed here is evaluated by the same
 * sandbox provider, under the same timeout ceiling and output cap, that an agent's tool call
 * goes through. There is no privileged path and no second implementation.
 *
 * ## What it is not
 *
 * **It is not a shell, and it does not act like one.** The only execution route this product has
 * is `POST /sandbox/:id/exec`, whose provider evaluates JavaScript. So `ls` is a `ReferenceError`
 * here — a real one, from the engine, with a real message — and not a directory listing that
 * this page invented. That distinction is the whole reason the file reads the way it does: a
 * terminal that faked `ls` would be the most convincing wrong answer in the product.
 *
 * The banner says so on the first line, before it says anything about how to use the thing,
 * because the first command anyone types is `ls`.
 *
 * ## Why the session is created on demand
 *
 * A sandbox session is a server row with a workdir and a provider, and opening one is a write.
 * Opening it when the page mounts would mean that merely *looking* at the terminal created a
 * row — and an operator who navigated past it would leave a scratch session behind for every
 * visit. So the session is opened on the first line that needs one, and `/new` opens another
 * deliberately.
 *
 * ## The transcript is state, not a log file
 *
 * Lines live in React state and are gone on reload. That is honest rather than lazy: the durable
 * record of everything that ran is the session's execution log on the Sandbox page, which is
 * where `GET /sandbox/:id/executions` reads from. A terminal scrollback that claimed to be a
 * history would be a second, weaker copy of a table that already exists.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button } from '../../components/ui';
import { formatRelative, shortId } from '../../lib/format';
import {
  CLI_BANNER,
  CLI_COMMANDS,
  historyAt,
  parseCommand,
  prepareCode,
  promptFor,
  pushHistory,
  stepHistory,
} from '../../lib/cli';
import { providerNote } from '../sandbox/provider-notes';
import {
  useCreateSandboxSession,
  useRunSandboxCode,
  useSandboxSessions,
  type SandboxExecOutcome,
} from '../sandbox/queries';

/** How the transcript draws a line. `input` is what was typed, everything else is a reply. */
type LineTone = 'input' | 'out' | 'err' | 'note' | 'ok';

interface CliLine {
  id: number;
  tone: LineTone;
  text: string;
}

/** How many sessions `/sessions` prints before it stops listing. */
const SESSION_PREVIEW = 20;

/** A thrown value as something a person can read. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `/help` body, rendered from the same table the parser matches against. */
function helpLines(): { tone: LineTone; text: string }[] {
  return [
    { tone: 'note' as const, text: 'Commands:' },
    ...CLI_COMMANDS.map((spec) => ({
      tone: 'out' as const,
      // Padded so the summaries line up; a help screen that is hard to scan is half a help screen.
      text: `  ${spec.usage.padEnd(20)}${spec.summary}`,
    })),
    { tone: 'note' as const, text: '' },
    { tone: 'note' as const, text: 'Anything else is JavaScript, evaluated in the sandbox session.' },
    { tone: 'note' as const, text: 'A line that is a single expression is returned for you.' },
    { tone: 'note' as const, text: 'A statement is not — write `return` to see its value.' },
  ];
}

export function CliPage(): ReactNode {
  const sessionsQuery = useSandboxSessions();
  const create = useCreateSandboxSession();
  const run = useRunSandboxCode();

  const [sessionId, setSessionId] = useState<string | null>(null);
  /**
   * The transcript, opened with the banner already in it.
   *
   * The banner is **initial state**, not an effect. An effect runs twice under React's
   * development double-invoke, which printed the whole banner twice — and a lazy initialiser
   * cannot, because React keeps one result even when it calls the initialiser twice. The ids
   * are assigned here by hand and `nextId` starts above them, so the two never collide.
   */
  const [lines, setLines] = useState<CliLine[]>(() => [
    ...CLI_BANNER.map((text, index) => ({ id: index + 1, tone: 'note' as const, text })),
    { id: CLI_BANNER.length + 1, tone: 'note' as const, text: '' },
  ]);
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<readonly string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  /**
   * The half-typed line, parked while the history is being browsed.
   *
   * It is separate state rather than a read of `draft` because the two are only the same thing
   * while you are *at* the draft slot. See the arrow-key handlers.
   */
  const [stashed, setStashed] = useState('');
  const [busy, setBusy] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // A monotonic id rather than an index: the list is appended to from async continuations, and
  // an index-based key would collide the moment two lines landed in the same batch. It starts
  // past the banner, whose ids are handed out in the initial state above.
  const nextId = useRef(CLI_BANNER.length + 1);

  const line = useCallback((tone: LineTone, text: string): CliLine => {
    nextId.current += 1;
    return { id: nextId.current, tone, text };
  }, []);

  const append = useCallback(
    (tone: LineTone, text: string): void => {
      setLines((current) => [...current, line(tone, text)]);
    },
    [line],
  );

  const appendAll = useCallback(
    (entries: { tone: LineTone; text: string }[]): void => {
      setLines((current) => [...current, ...entries.map((entry) => line(entry.tone, entry.text))]);
    },
    [line],
  );

  // Follow the output. A terminal that stops scrolling is a terminal you have to scroll.
  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [lines, busy]);

  /** Print one execution's result. */
  const report = useCallback(
    (outcome: SandboxExecOutcome): void => {
      const { execution, value, durationMs, outputTruncated, terminatedReason } = outcome;

      if (execution.stdout !== null && execution.stdout.trim() !== '') {
        append('out', execution.stdout.replace(/\n$/, ''));
      }
      if (execution.stderr !== null && execution.stderr.trim() !== '') {
        append('err', execution.stderr.replace(/\n$/, ''));
      }

      // The evaluated result, marked so it cannot be confused with what the code printed.
      if (value !== undefined && value !== null) {
        append('ok', `⇒ ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);
      }

      const meta = [
        execution.status,
        `${durationMs} ms`,
        execution.exitCode === null ? null : `exit ${execution.exitCode}`,
        outputTruncated ? 'output truncated' : null,
        terminatedReason === undefined || terminatedReason === null
          ? null
          : `stopped: ${terminatedReason}`,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ');

      append('note', meta);
    },
    [append],
  );

  /** The current session, opening one if there is not one yet. */
  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionId !== null) return sessionId;
    const session = await create.mutateAsync({});
    setSessionId(session.id);
    append('note', `Opened session ${session.id} · ${providerNote(session.provider)}`);
    return session.id;
  }, [sessionId, create, append]);

  const submit = useCallback(async (): Promise<void> => {
    const raw = draft;
    const command = parseCommand(raw);

    setDraft('');
    setStashed('');
    const nextHistory = pushHistory(history, raw);
    setHistory(nextHistory);
    // The draft slot is `length`, which is where `↓` should land next.
    setHistoryIndex(nextHistory.length);

    if (command.kind === 'empty') return;
    append('input', `${promptFor(sessionId)} ${raw.trim()}`);

    if (command.kind === 'clear') {
      setLines([]);
      return;
    }
    if (command.kind === 'help') {
      appendAll(helpLines());
      return;
    }
    if (command.kind === 'unknown') {
      append('err', `No such command: /${command.word}. Type /help for the ones that exist.`);
      return;
    }
    if (command.kind === 'usage') {
      append(
        'err',
        command.arg === 'no arguments'
          ? `/${command.verb} takes no arguments.`
          : `Usage: /${command.verb} <${command.arg}>`,
      );
      return;
    }

    setBusy(true);
    try {
      if (command.kind === 'new') {
        const session = await create.mutateAsync({});
        setSessionId(session.id);
        append('ok', `Opened session ${session.id}`);
        append('note', providerNote(session.provider));
        return;
      }

      if (command.kind === 'sessions') {
        if (sessionsQuery.isPending) {
          append('note', 'Still loading the session list — try again in a moment.');
          return;
        }
        if (sessionsQuery.isError) {
          append('err', 'Could not read the session list.');
          return;
        }
        const rows = sessionsQuery.data ?? [];
        if (rows.length === 0) {
          append('note', 'No sandbox sessions yet. /new opens one.');
          return;
        }
        appendAll(
          rows.slice(0, SESSION_PREVIEW).map((row) => ({
            tone: 'out' as const,
            text: `${shortId(row.id).padEnd(10)}${row.provider.padEnd(16)}${row.status.padEnd(10)}${formatRelative(row.updatedAt)}`,
          })),
        );
        if (rows.length > SESSION_PREVIEW) {
          append('note', `… and ${rows.length - SESSION_PREVIEW} more. See the Sandbox page.`);
        }
        return;
      }

      if (command.kind === 'use') {
        const loaded = sessionsQuery.data;
        // Refused only when the list has loaded *and* does not contain it. Before the list
        // arrives there is nothing to check against, and the server is the authority anyway —
        // it will reject an execution on a session that does not exist.
        if (loaded !== undefined && !loaded.some((row) => row.id === command.id)) {
          append('err', `No sandbox session ${command.id} in this workspace. /sessions lists them.`);
          return;
        }
        setSessionId(command.id);
        append('ok', `Running in ${command.id}.`);
        return;
      }

      const id = await ensureSession();
      // A single expression is wrapped so the engine returns it; anything else goes verbatim.
      // `prepareCode` documents the check and why it is a compile rather than a guess.
      const prepared = prepareCode(command.code);
      const outcome = await run.mutateAsync({ sessionId: id, code: prepared.code });
      report(outcome);
    } catch (error) {
      // The engine's own message, not a rewritten one. A failed evaluation has a real reason and
      // paraphrasing it here would be a worse answer than the one the runtime already wrote.
      append('err', messageOf(error));
    } finally {
      setBusy(false);
    }
  }, [
    draft,
    history,
    sessionId,
    append,
    appendAll,
    create,
    ensureSession,
    run,
    report,
    sessionsQuery,
  ]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void submit();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        // Leaving the draft slot: keep whatever was half-typed, because `↓` has to be able to
        // bring it back. Reading the draft at *return* time instead — which is the obvious way
        // to write this — hands back the line that was just recalled, so the half-typed line is
        // lost the moment you look at your history.
        if (historyIndex >= history.length) setStashed(draft);
        const next = stepHistory(historyIndex, -1, history.length);
        setHistoryIndex(next);
        setDraft(historyAt(history, next, stashed));
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = stepHistory(historyIndex, 1, history.length);
        setHistoryIndex(next);
        setDraft(historyAt(history, next, stashed));
        return;
      }
      // The shell convention, and the one key that is safe to take: `Ctrl+L` is not a browser
      // shortcut and is not in the composer's table either.
      if (event.key === 'l' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setLines([]);
      }
    },
    [submit, historyIndex, history, draft, stashed],
  );

  const current = useMemo(
    () => (sessionsQuery.data ?? []).find((row) => row.id === sessionId) ?? null,
    [sessionsQuery.data, sessionId],
  );

  return (
    <div className="cli">
      <header className="cli-head">
        <span className="cli-head-title">Terminal</span>
        <span className="cli-head-note">
          Evaluates JavaScript in a sandbox session — not a POSIX shell.
        </span>
        <span className="grow" />
        {sessionId === null ? (
          <Badge>no session yet</Badge>
        ) : (
          // `Badge` takes only a tone and its children, so the full id rides on a wrapper — the
          // chip is the short form, and the title is where the real id can be read.
          <span className="cli-session" title={sessionId}>
            <Badge tone="accent">{shortId(sessionId)}</Badge>
          </span>
        )}
        <Link className="cli-head-link" to="/sandbox">
          Execution log
        </Link>
      </header>

      <div className="cli-screen" ref={scrollRef} onClick={() => inputRef.current?.focus()}>
        {lines.map((entry) => (
          <pre className="cli-line" data-tone={entry.tone} key={entry.id}>
            {entry.text}
          </pre>
        ))}

        {busy ? (
          <pre className="cli-line" data-tone="note">
            …
          </pre>
        ) : null}
      </div>

      <div className="cli-prompt">
        <span className="cli-prompt-mark" aria-hidden="true">
          {promptFor(sessionId)}
        </span>
        <textarea
          ref={inputRef}
          className="cli-input"
          rows={1}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-label="Terminal input"
          placeholder="1 + 1"
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={busy || draft.trim() === ''}
          onClick={() => void submit()}
        >
          Run
        </Button>
      </div>

      <footer className="cli-foot">
        <span>
          {current === null
            ? 'A session is opened the first time you run something.'
            : `${current.provider} · ${current.status} · ${current.workdir}`}
        </span>
        <span className="grow" />
        <span className="cli-foot-hint">↑ ↓ history · Ctrl+L clear · Shift+Enter newline</span>
      </footer>
    </div>
  );
}
