/**
 * The composer (§3.3).
 *
 * Three completions share one text box, and only one can be open at a time:
 *
 *  - **`/`** at the start of a word → the command menu, over `SLASH_COMMANDS`.
 *  - **`@`** at the start of a word → the entity picker, over `GET /chat/mentions`.
 *  - **the attachment button** → the workspace's chat-scoped files, with their permission flags.
 *
 * Plus the two §3.3 mechanics that are not completions: a **stash stack** on `Ctrl+S`, and a
 * **paste-collapse pill** over a long `paste` event.
 *
 * ## Which completion wins when two match
 *
 * The later one. `/x @y` has a slash range starting at 0 and a mention range starting at 3, and
 * the user is typing the mention. Comparing `start` rather than checking the modes in a fixed
 * order is what makes that work without a rule about precedence.
 *
 * ## Enter is overloaded, and that is deliberate
 *
 * With a menu open, `Enter` selects the highlighted entry; with no menu, it sends. That is what
 * every chat client does and the alternative — `Tab` to complete, `Enter` to send — means a user
 * who types `/ag` and hits Enter sends the literal text `/ag`. `Escape` closes the menu first,
 * and `Shift+Enter` is always a newline.
 *
 * ## The mention popup says what a mention is
 *
 * It inserts the entity's **name as text**. Nothing server-side resolves `@` in a message body
 * — see `mentions.ts` for the evidence — so a user who believed they had attached a live
 * reference would be wrong. One muted line under the list says so, which is cheaper than the
 * confusion of finding out later.
 *
 * ## The `!` prefix is refused, not executed
 *
 * §3.3 lists `!command` as "run a shell command without an LLM turn". This deployment has no
 * shell: the only code execution it can reach is a **sandbox session**, which is a run-scoped
 * worker with its own container rather than the operator's machine. Sending `!rm -rf /` to the
 * model instead would be worse than refusing — the model would treat it as prose and might
 * try to satisfy it. So a leading `!` is caught **before** the send and answered with the
 * reason plus where to go instead. The row is in `lib/keybindings.ts` with the same sentence,
 * so the help overlay and the refusal cannot drift apart.
 *
 * ## Where the honest limits are
 *
 * `Ctrl+G` (external editor) has no browser equivalent, and `/expand` is not a command the
 * server registers — the pill lifts the collapse by **clicking it**, which is the affordance
 * the spec names second. Both are stated in the UI rather than silently missing.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { MentionItem, MentionKind } from '@nexs/shared';
import { Badge, Button, Checkbox, Modal } from '../../../components/ui';
import { formatRelative } from '../../../lib/format';
// The keybinding table is the single source for what a key does and what it cannot do.
import { PRIMARY_MODIFIER, unsupportedReasonFor } from '../../../lib/keybindings';
import {
  pasteLabel,
  regionsForCaret,
  registerPaste,
  type PasteRegion,
} from '../../../lib/paste';
import {
  discardStash,
  popStash,
  stash,
  stashIntent,
  takeStash,
  STASH_LIMIT,
  type StashedPrompt,
} from '../../../lib/stash';
// `catalog` is a sibling under `features/`, not a top-level `src/` directory.
import { useModels } from '../../catalog/queries';
import { activeMentionQuery, applyCompletion, groupByKind, mentionInsertion } from '../mentions';
import { useChatAttachments, useMentions } from '../queries';
import { activeSlashQuery, completeCommand, filterCommands, type ComposerCommand } from '../slash';
import type { TurnStatus } from '../useChatTurn';

/**
 * The kinds the resolver actually reads.
 *
 * `MENTION_KINDS` in `@nexs/shared` is a ten-entry list, and `MentionResolver` implements
 * **seven** of them: agent, model, tool, mcp, goal, workflow, run. Nothing reads `skill`,
 * `connector` or `file` — those have no source method, so a filter offering them would return
 * an empty list every time and look like a broken search rather than a kind with no data.
 *
 * The filter is therefore the implemented set. When a source for the other three lands, it
 * belongs in both places, and this comment is the reminder.
 */
const RESOLVED_KINDS: readonly MentionKind[] = [
  'agent',
  'model',
  'tool',
  'mcp',
  'goal',
  'workflow',
  'run',
];

/** A small debounce, so a fast typist does not issue a request per keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export interface ComposerProps {
  /**
   * True when the conversation has no agent, which makes `modelId` **required** on every
   * message. `sendChatMessageSchema` carries it and the service refuses the turn without one.
   */
  requiresModel: boolean;
  status: TurnStatus;
  onSend: (input: { content: string; modelId?: string; attachmentIds?: string[] }) => void;
  onStop: () => void;
  /**
   * How many drafts are currently stashed.
   *
   * Reported upward because the status bar prints `📌 N` and the composer is the only thing that
   * owns the stack. The alternative — lifting the stack into the page — would put draft state
   * above the component whose textarea it belongs to, and every restore would be a prop round
   * trip. A count is the whole of what the status bar needs.
   */
  onStashCountChange?: (count: number) => void;
  /**
   * What the empty textarea says.
   *
   * A prop rather than a constant because the page has two states that are genuinely different
   * questions: a draft is asking for a goal, and an open conversation is asking for a reply. The
   * default is the open-conversation wording, so a caller that does not care gets the long one.
   */
  placeholder?: string;
}

/** The open-conversation placeholder. */
const DEFAULT_PLACEHOLDER = 'Ask anything, or type / for commands and @ to reference something.';

/**
 * The composer takes no session id.
 *
 * Sending is the page's job — it owns the turn, the URL and the refetch that follows — so the
 * composer's contract is "here is a message", not "here is a message and where to put it".
 * Passing an id it never used was the shape of a second send path waiting to be written.
 */
export function Composer({
  requiresModel,
  status,
  onSend,
  onStop,
  onStashCountChange,
  placeholder = DEFAULT_PLACEHOLDER,
}: ComposerProps): ReactNode {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [kindFilter, setKindFilter] = useState<MentionKind | null>(null);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [modelId, setModelId] = useState('');
  /** Applied to the textarea after the state that produced it has rendered. */
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  /** Set by Escape, cleared by the next keystroke — see `onKeyDown` and `onChange`. */
  const [dismissed, setDismissed] = useState(false);

  /** The §3.3 draft stack, newest last. Owned here; only its length is reported upward. */
  const [stashStack, setStashStack] = useState<StashedPrompt[]>([]);
  /** The browse overlay's cursor, or `null` when it is closed. */
  const [stashCursor, setStashCursor] = useState<number | null>(null);
  /** A refusal the composer is showing instead of sending — currently only the `!` prefix. */
  const [notice, setNotice] = useState<string | null>(null);
  /** Regions of `text` that came from a long paste and are drawn as pills. */
  const [pasteRegions_, setPasteRegions] = useState<PasteRegion[]>([]);

  const textarea = useRef<HTMLTextAreaElement | null>(null);

  const slash = activeSlashQuery(text, caret);
  const mention = activeMentionQuery(text, caret);

  // The later range wins — see the file header.
  let mode: 'slash' | 'mention' | null = null;
  if (dismissed) mode = null;
  else if (slash !== null && (mention === null || slash.start >= mention.start)) mode = 'slash';
  else if (mention !== null) mode = 'mention';

  const slashQuery = mode === 'slash' && slash !== null ? slash.query : '';
  const mentionQuery = mode === 'mention' && mention !== null ? mention.query : '';

  const debouncedMentionQuery = useDebounced(mentionQuery, 150);
  const mentions = useMentions(debouncedMentionQuery, kindFilter, mode === 'mention');
  // The attachment list is read by the picker below, which owns its own query. Reading it here
  // as well would be a second subscription to the same cache entry and nothing to show for it.
  const models = useModels({ enabledOnly: true, type: 'chat' });

  // When model is required (ad-hoc conversation without agent) and none is selected,
  // pick the first available chat model, preferring flash / reliable models.
  useEffect(() => {
    if (!requiresModel || modelId !== '') return;
    const available = models.data ?? [];
    if (available.length === 0) return;
    const preferred =
      available.find((m) => m.externalModelId === 'gemini-3.5-flash') ??
      available.find((m) => m.externalModelId.includes('3.5-flash')) ??
      available.find((m) => m.externalModelId.includes('flash') && !m.externalModelId.includes('live')) ??
      available[0];
    if (preferred !== undefined) {
      setModelId(preferred.id);
    }
  }, [requiresModel, modelId, models.data]);

  const commands = mode === 'slash' ? filterCommands(slashQuery) : [];
  const items: MentionItem[] = mode === 'mention' ? (mentions.data ?? []) : [];

  const optionCount = mode === 'slash' ? commands.length : items.length;

  // A highlight left over from a longer list would select the wrong entry, or none.
  useEffect(() => {
    setHighlight(0);
  }, [slashQuery, mentionQuery, kindFilter, mode]);

  useEffect(() => {
    if (pendingCaret === null) return;
    const node = textarea.current;
    if (node !== null) {
      node.focus();
      node.setSelectionRange(pendingCaret, pendingCaret);
      setCaret(pendingCaret);
    }
    setPendingCaret(null);
  }, [pendingCaret]);

  // The status bar's `📌 N`. In an effect rather than inside each mutation so the count cannot
  // be reported twice for one change, or missed when a restore happens from the overlay.
  useEffect(() => {
    onStashCountChange?.(stashStack.length);
  }, [stashStack.length, onStashCountChange]);

  const streaming = status === 'streaming';
  const canSend = text.trim().length > 0 && !streaming && (!requiresModel || modelId !== '');

  /** The regions that should currently be drawn as pills — the caret's own region is lifted. */
  const visibleRegions = regionsForCaret(pasteRegions_, caret);

  function syncCaret(): void {
    setCaret(textarea.current?.selectionStart ?? 0);
  }

  function applyInsertion(insertion: string): void {
    const range =
      mode === 'slash' && slash !== null
        ? slash
        : mode === 'mention' && mention !== null
          ? mention
          : null;
    if (range === null) return;

    const next = applyCompletion(text, range, insertion);
    setText(next.text);
    setPendingCaret(next.caret);
  }

  function chooseSlashCommand(command: ComposerCommand): void {
    // `/clear` is the one command §9.1 marks as client-side. Handling it here rather than
    // inserting it would be a second implementation; handling it by *inserting* it and letting
    // the user press Enter would send it to the server, which has no such command. So it clears
    // the box and says so — and the server is not asked.
    if (command.name === 'clear') {
      setText('');
      setPasteRegions([]);
      setNotice('Cleared the composer. Nothing was sent.');
      textarea.current?.focus();
      return;
    }
    applyInsertion(completeCommand(command));
  }

  function chooseMention(item: MentionItem): void {
    applyInsertion(mentionInsertion(item));
  }

  function submit(): void {
    if (!canSend) return;

    // The `!` prefix. Checked before the send rather than after, because after is too late —
    // the text would already be a turn. See the file header for why this refuses rather than
    // forwarding.
    if (text.trimStart().startsWith('!')) {
      setNotice(
        `${unsupportedReasonFor('!command') ?? 'Shell commands are not available here.'} — the text was not sent.`,
      );
      return;
    }

    setNotice(null);
    onSend({
      content: text.trim(),
      ...(requiresModel ? { modelId } : {}),
      ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
    });
    setText('');
    setAttachmentIds([]);
    setPasteRegions([]);
  }

  /**
   * `Ctrl+S` — the §3.3 stash gesture.
   *
   * The decision lives in `lib/stash.ts` (`stashIntent`) rather than here, because the rule has
   * the one subtle case — empty composer with exactly one stash pops, with more than one opens
   * the browser — and a rule that lives in a keydown handler is a rule nothing tests.
   */
  function handleStashKey(): void {
    const intent = stashIntent(text, stashStack);
    if (intent.kind === 'stash') {
      setStashStack((previous) => stash(previous, intent.text, intent.caret));
      setText('');
      setPasteRegions([]);
      setStashCursor(null);
      setNotice(
        stashStack.length + 1 >= STASH_LIMIT_HINT
          ? `Stashed. ${stashStack.length + 1} drafts kept — older ones are dropped past ${STASH_LIMIT_HINT}.`
          : 'Stashed the draft. Press it again to bring it back.',
      );
      return;
    }
    if (intent.kind === 'pop') {
      const { stack, item } = popStash(stashStack);
      setStashStack(stack);
      if (item !== null) {
        setText(item.text);
        setPasteRegions([]);
        setPendingCaret(item.caret);
        setNotice(null);
      }
      return;
    }
    if (intent.kind === 'browse') {
      // Newest first in the list, so the cursor starts on what a pop would have returned.
      setStashCursor(0);
      return;
    }
    setNotice('Nothing is stashed yet — type a draft and use this key to keep it.');
  }

  /** The browse overlay's `Enter`. Restores the *selected* draft, not the newest. */
  function restoreStashed(item: StashedPrompt): void {
    const { stack } = takeStash(stashStack, item.id);
    setStashStack(stack);
    setStashCursor(null);
    setText(item.text);
    setPasteRegions([]);
    setPendingCaret(item.caret);
    setNotice(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Plain (and `Ctrl`-less) keys are the browser's. Only the two modifiers this composer owns
    // are intercepted, so a user who meant to save the page or select all still can.
    const modified = event.ctrlKey || event.metaKey;
    if (modified && !event.shiftKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 's') {
        // `Ctrl+S` is Save in every browser, and this composer is not a document. Intercepting
        // it is the whole point of the §3.3 row.
        event.preventDefault();
        handleStashKey();
        return;
      }
      // `Ctrl+J` is the terminal-safe newline (spec §8). In a textarea the browser already
      // inserts one, but only on some platforms; handling it makes the key behave the same
      // everywhere, and `preventDefault` stops the browser's own "downloads" or "search"
      // binding where it has one.
      if (key === 'j' || (key === 'enter' && event.altKey)) {
        event.preventDefault();
        insertNewline();
        return;
      }
    }

    if (event.key === 'Escape') {
      if (pickerOpen) {
        setPickerOpen(false);
        event.preventDefault();
        return;
      }
      if (notice !== null) {
        setNotice(null);
        event.preventDefault();
        return;
      }
      if (mode !== null) {
        // Dismiss the completion without inserting anything. This is a flag rather than a caret
        // trick: moving the caret is not a way to close a menu — the range is derived from the
        // text, and any caret position inside the word keeps the menu open.
        setDismissed(true);
        event.preventDefault();
      }
      return;
    }

    if (mode !== null && optionCount > 0) {
      if (event.key === 'ArrowDown') {
        setHighlight((value) => (value + 1) % optionCount);
        event.preventDefault();
        return;
      }
      if (event.key === 'ArrowUp') {
        setHighlight((value) => (value - 1 + optionCount) % optionCount);
        event.preventDefault();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (mode === 'slash') {
          const command = commands[highlight];
          if (command !== undefined) chooseSlashCommand(command);
        } else {
          const item = items[highlight];
          if (item !== undefined) chooseMention(item);
        }
        event.preventDefault();
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  /** `Ctrl+J` / `Alt+Enter`, inserted at the caret so the caret can stay where it was. */
  function insertNewline(): void {
    const node = textarea.current;
    const at = node?.selectionStart ?? text.length;
    const end = node?.selectionEnd ?? at;
    const next = `${text.slice(0, at)}\n${text.slice(end)}`;
    setText(next);
    setPasteRegions([]);
    setPendingCaret(at + 1);
  }

  return (
    <div className="composer">
      {pickerOpen ? (
        <AttachmentPicker
          selected={attachmentIds}
          onToggle={(id) =>
            setAttachmentIds((previous) =>
              previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id],
            )
          }
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      {stashCursor !== null ? (
        <StashBrowser
          stack={stashStack}
          cursor={stashCursor}
          onCursor={setStashCursor}
          onRestore={restoreStashed}
          onDiscard={(item) => {
            const next = discardStash(stashStack, item.id);
            setStashStack(next);
            // Keep the cursor on something real: the list just got shorter, and a cursor past
            // the end would render a highlight on no row.
            setStashCursor(next.length === 0 ? null : Math.min(stashCursor, next.length - 1));
          }}
          onClose={() => setStashCursor(null)}
        />
      ) : null}

      {notice !== null ? (
        <div className="banner" role="status">
          <div className="banner-head">
            <span className="banner-title">{notice}</span>
            <Button size="sm" variant="ghost" onClick={() => setNotice(null)} title="Dismiss">
              ✕
            </Button>
          </div>
        </div>
      ) : null}

      {mode !== null && optionCount > 0 ? (
        <div className="completion" role="listbox" aria-label={mode === 'slash' ? 'Commands' : 'Mentions'}>
          {mode === 'mention' ? (
            <div className="completion-filter">
              <button
                type="button"
                className={kindFilter === null ? 'chip chip-on' : 'chip'}
                onClick={() => setKindFilter(null)}
              >
                All
              </button>
              {RESOLVED_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={kindFilter === kind ? 'chip chip-on' : 'chip'}
                  onClick={() => setKindFilter(kind)}
                >
                  {kind}
                </button>
              ))}
            </div>
          ) : null}

          <div className="completion-list">
            {mode === 'slash'
              ? commands.map((command, index) => (
                  <button
                    key={command.name}
                    type="button"
                    role="option"
                    aria-selected={index === highlight}
                    className={index === highlight ? 'completion-row is-active' : 'completion-row'}
                    onMouseEnter={() => setHighlight(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      chooseSlashCommand(command);
                    }}
                  >
                    <code className="completion-name">{command.usage}</code>
                    <span className="completion-desc">{command.description}</span>
                    {command.adminOnly ? <Badge tone="waiting">owner</Badge> : null}
                    {command.available ? null : <Badge tone="neutral">not yet</Badge>}
                  </button>
                ))
              : groupByKind(items).map((group) => (
                  <div key={group.kind} className="completion-group">
                    <div className="completion-group-head">{group.kind}</div>
                    {group.items.map((item) => {
                      const index = items.indexOf(item);
                      return (
                        <button
                          key={`${item.kind}:${item.id}`}
                          type="button"
                          role="option"
                          aria-selected={index === highlight}
                          className={index === highlight ? 'completion-row is-active' : 'completion-row'}
                          onMouseEnter={() => setHighlight(index)}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            chooseMention(item);
                          }}
                        >
                          <span className="completion-name">{item.name}</span>
                          {item.subtitle !== undefined ? (
                            <span className="completion-desc">{item.subtitle}</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
          </div>

          {mode === 'mention' ? (
            <p className="completion-note">
              Inserts the name as text. This build does not resolve <code>@</code> references on
              the server — the agent reads it as a word.
            </p>
          ) : null}

          {mode === 'slash' && slashQuery !== '' ? (
            <p className="completion-note">
              <code>/{slashQuery}</code> is not in this list? Send it anyway — the server is the
              authority on which commands exist, and it will answer with the real ones.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="composer-input-wrap">
        <textarea
          ref={textarea}
          className="input composer-input"
          rows={3}
          value={text}
          placeholder={placeholder}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            // Typing re-opens a menu that Escape closed. Without this, dismissing a completion
            // once would disable it for the rest of the message.
            setDismissed(false);
            // A refusal is about the text it was raised for; the first keystroke that changes
            // that text makes it stale, and a stale refusal is a lie about what is on screen.
            setNotice(null);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onPaste={(event) => {
            // The paste is read from `clipboardData`, but the **text** stays the browser's to
            // insert — the composer never rewrites `text` here. All this records is where the
            // pasted range landed, so the backdrop can draw a pill over it. Letting the default
            // happen is what keeps undo, IME and the caret behaving.
            const pasted = event.clipboardData.getData('text/plain');
            if (pasted === '') return;
            const node = textarea.current;
            const start = node?.selectionStart ?? text.length;
            // The default insertion replaces the selection, so the end is measured from
            // `start`, not from the caret the browser has not produced yet.
            const end = start + pasted.length;
            setPasteRegions((previous) => registerPaste(pasted, start, end, previous));
          }}
          disabled={streaming}
        />

        {/*
          The paste pill.

          It is a **backdrop**, not a value. The textarea above still holds all 512 lines — that
          is the rule the whole feature is built around — and this strip is what the user reads
          to know they are there. Clicking it scrolls to the start of the region and drops the
          caret there, which lifts the collapse through `regionsForCaret` and shows the real
          lines. `/expand` is the spec's other affordance and is not a command this server
          registers, so it is not offered.
        */}
        {visibleRegions.length > 0 ? (
          <div className="composer-hints">
            {visibleRegions.map((region) => {
              const slice = text.slice(region.start, region.end);
              return (
                <button
                  key={`${region.start}:${region.end}`}
                  type="button"
                  className="paste-pill"
                  title="Show the pasted lines — the full text is already in the box"
                  onClick={() => {
                    setCaret(region.start);
                    setPendingCaret(region.start);
                  }}
                >
                  ▤ {pasteLabel(slice)}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="composer-bar">
        <div className="row">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPickerOpen((open) => !open)}
            title="Attach a file from the workspace"
          >
            Attach{attachmentIds.length > 0 ? ` (${attachmentIds.length})` : ''}
          </Button>

          {requiresModel ? (
            <label className="row small" style={{ gap: 6 }}>
              <span className="muted">Model</span>
              <select
                className="select select-sm"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                title="This conversation has no agent, so every message must name a model."
              >
                <option value="">Choose one…</option>
                {(models.data ?? []).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {/*
            The hint rail (§3.3).

            Three keys, chosen because they are the ones with a *consequence*: the stash (which
            hides a draft), the switcher (which leaves this conversation) and the palette. The
            `!` row is drawn struck through rather than omitted — see the file header.
          */}
          <span className="composer-hints">
            <span className="composer-hint">
              <kbd>{PRIMARY_MODIFIER}</kbd>
              <kbd>S</kbd> {text.trim() === '' ? 'restore' : 'stash'}
              {stashStack.length > 0 ? ` (${stashStack.length})` : ''}
            </span>
            <span className="composer-hint">
              <kbd>{PRIMARY_MODIFIER}</kbd>
              <kbd>X</kbd> sessions
            </span>
            <span className="composer-hint">
              <kbd>{PRIMARY_MODIFIER}</kbd>
              <kbd>K</kbd> palette
            </span>
            <span
              className="composer-hint"
              title={unsupportedReasonFor('!command') ?? undefined}
              style={{ textDecoration: 'line-through' }}
            >
              <kbd>!</kbd> shell
            </span>
          </span>
        </div>

        <div className="row">
          <span className="muted small">Enter sends · Shift+Enter is a newline</span>
          {streaming ? (
            <Button size="sm" variant="danger" onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={submit} disabled={!canSend}>
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The stash browser (§3.3).
 *
 * Arrow keys move, `Enter` restores the **selected** one, `D` discards it. The letters are
 * suppressed while a pointer is over a row's button — not a text field, so the only risk is a
 * stray `d` while mousing, which is handled by requiring a keypress *and* the overlay's own
 * focus.
 *
 * The list is rendered newest-first, matching what a pop would have returned, so the cursor
 * opens on the draft the user most likely wants.
 */
function StashBrowser({
  stack,
  cursor,
  onCursor,
  onRestore,
  onDiscard,
  onClose,
}: {
  stack: readonly StashedPrompt[];
  cursor: number;
  onCursor: (index: number) => void;
  onRestore: (item: StashedPrompt) => void;
  onDiscard: (item: StashedPrompt) => void;
  onClose: () => void;
}): ReactNode {
  const ordered = [...stack].reverse();
  const active = ordered[cursor];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'ArrowDown') {
      onCursor(Math.min(cursor + 1, ordered.length - 1));
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowUp') {
      onCursor(Math.max(cursor - 1, 0));
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && active !== undefined) {
      onRestore(active);
      event.preventDefault();
      return;
    }
    if ((event.key === 'd' || event.key === 'D') && active !== undefined) {
      onDiscard(active);
      event.preventDefault();
    }
  }

  return (
    <Modal
      title={`Stashed drafts (${stack.length})`}
      onClose={onClose}
      footer={
        <span className="row small">
          <span className="muted">
            ↑↓ move · Enter restores the selected draft · D discards it · Esc closes
          </span>
        </span>
      }
    >
      <div onKeyDown={onKeyDown} tabIndex={-1}>
        <p className="stash-note">
          Drafts are held in this tab only — they are not saved anywhere, and closing the page
          loses them. Up to {STASH_LIMIT} are kept; older ones are dropped.        </p>
        <div className="stack-sm">
          {ordered.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={index === cursor ? 'stash-row is-active' : 'stash-row'}
              onMouseEnter={() => onCursor(index)}
              onClick={() => onRestore(item)}
            >
              <span className="stash-row-body">
                <span className="stash-row-text">{firstLine(item.text)}</span>
                <span className="stash-row-meta">
                  {item.text.split('\n').length} line
                  {item.text.split('\n').length === 1 ? '' : 's'} · stashed{' '}
                  {formatRelative(new Date(item.stashedAt).toISOString())}
                </span>
              </span>
              <span
                className="muted small"
                role="button"
                tabIndex={0}
                title="Discard this draft"
                onClick={(event) => {
                  event.stopPropagation();
                  onDiscard(item);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    onDiscard(item);
                  }
                }}
              >
                D
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** The first non-empty line of a draft, for the browser's one-line preview. */
function firstLine(text: string): string {
  const line = text.split('\n').find((entry) => entry.trim() !== '');
  if (line === undefined) return '(whitespace)';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/**
 * The threshold at which the stash's own notice stops being reassuring.
 *
 * A separate constant from `STASH_LIMIT` because the message should land *before* the oldest
 * draft is dropped, not after — a user told "20 kept" only once the 20th is gone has already
 * lost the 1st without being warned.
 */
const STASH_LIMIT_HINT = 18;

/**
 * The attachment picker.
 *
 * The permission flags are the row's own `readAccess`/`writeAccess` — rendered, not inferred.
 * §PHASE13.2 asks for "permission badges", and the only honest source for them is the column
 * the server wrote when the file was attached.
 */
function AttachmentPicker({
  selected,
  onToggle,
  onClose,
}: {
  selected: readonly string[];
  onToggle: (id: string) => void;
  onClose: () => void;
}): ReactNode {
  const attachments = useChatAttachments();
  const rows = attachments.data ?? [];

  return (
    <div className="picker">
      <div className="picker-head">
        <span className="label">Chat attachments</span>
        <Button size="sm" variant="ghost" onClick={onClose} title="Close">
          ✕
        </Button>
      </div>

      {attachments.isPending ? (
        <p className="muted small">Loading…</p>
      ) : attachments.isError ? (
        <p className="field-error">Could not read the file list.</p>
      ) : rows.length === 0 ? (
        <p className="muted small">
          No chat-scoped files yet. Upload one from the Files surface and it appears here.
        </p>
      ) : (
        <div className="picker-list">
          {rows.map((file) => (
            <div key={file.id} className="picker-row">
              <Checkbox
                checked={selected.includes(file.id)}
                onChange={() => onToggle(file.id)}
                label={file.name}
                hint={`${file.kind} · read${file.writeAccess ? ' + write' : ''}`}
              />
              <Badge tone={file.writeAccess ? 'waiting' : 'neutral'}>
                {file.writeAccess ? 'read/write' : 'read'}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
