/**
 * The transcript.
 *
 * ## There is no "Assistant", and there is no clock
 *
 * Every assistant turn used to be headed `Assistant` and a timestamp. The label names the one
 * thing the reader already knows — who else would be answering — and the clock is a fact about
 * the row rather than about the answer. Neither is worth a line above every message, and between
 * them they made a two-line answer look like a three-line one.
 *
 * In their place: **Thinking**. The header of an assistant turn is a disclosure that expands to
 * show what the turn actually did — the tool calls it made, in order, with what it asked for and
 * what came back. Collapsed by default, so the transcript reads as answers.
 *
 * ## "Thinking" means real activity, and nothing else
 *
 * This is not a chain of thought and must not look like one. The engine's own contract
 * (`engine.ts`) is explicit that the human-readable intent is what the UI renders and never raw
 * reasoning; a chat turn has no reasoning field at all, so there is nothing of that kind to show
 * even if it were wanted.
 *
 * What is left is the part that is real: the tool calls, which are persisted rows, and — while a
 * turn is in flight — the frames as they arrive. When a turn called no tool, the disclosure says
 * exactly that rather than inventing a step. A fabricated `Searching the web…` would be the most
 * convincing wrong answer in the product, because it is the line a reader is least equipped to
 * check.
 *
 * ## Tool calls are disclosures, not cards
 *
 * §PHASE13.2 asks for tool calls "rendered inline (collapsible: name, args, result, duration)".
 * They are `<details>` elements rather than a state-managed accordion: the browser already
 * implements "expanded or not" accessibly, with keyboard support and without a line of
 * JavaScript. A hand-rolled version of this is one of the most reliably broken components in
 * any chat UI.
 *
 * The summary line is the part that is always visible — tool name, a one-line preview of the
 * arguments, and the duration. That is enough to follow what the agent is doing without
 * expanding anything, which is the point: a transcript where every tool call is collapsed to
 * "tool call" tells the user nothing.
 *
 * ## Duration is measured on the wire, and labelled as such
 *
 * The frames carry no call id and no timestamps, so a duration can only be the gap between
 * `chat.tool_call` and `chat.tool_result` arriving *here*. It is a real measurement — of the
 * round trip, not of the tool's own runtime — and the tooltip says so. Presenting it as the
 * tool's execution time would be a number that traces to no row.
 *
 * ## The streaming bubble is not a message
 *
 * Text arriving as deltas is rendered in a bubble that is visibly provisional: it carries a
 * caret and no timestamp, because it has no `createdAt` — it is not a row yet. Its Thinking
 * disclosure is open while the turn runs, so the reader watches the activity rather than a
 * spinner. When the turn completes, the hook refetches and drops the buffer, and the durable
 * message takes its place with the same disclosure, collapsed.
 */

import type { ReactNode } from 'react';
import type { ChatMessageDto } from '@nexs/shared';
import { formatDateTime, formatDuration, inlineJson, prettyJson } from '../../../lib/format';
import { Badge, Button, CopyButton, EmptyState } from '../../../components/ui';
import type { LiveToolCall, TurnStatus } from '../useChatTurn';

/**
 * The shape both a durable and a live tool call satisfy.
 *
 * `startedAt`/`endedAt` are absent on a persisted call: `ChatToolCall` stores name, args, result
 * and ok, and deliberately not timing — the audit record lives in `ToolCall` and
 * `ExecutionReceipt`. So a reloaded conversation shows the calls without durations, and that
 * asymmetry is the data model's, not a rendering choice.
 */
interface DisclosureCall {
  name: string;
  args: unknown;
  result?: unknown;
  ok: boolean;
  startedAt?: number;
  endedAt?: number;
}

/**
 * The role label, for the roles that need one.
 *
 * `null` for an assistant turn, which is headed by its Thinking disclosure instead. Returning
 * `'Assistant'` here and hiding it at the call site would leave the string in the codebase
 * waiting to come back.
 */
function roleLabel(role: string): string | null {
  if (role === 'user') return 'You';
  if (role === 'tool') return 'Tool';
  return null;
}

/**
 * One tool call, as a §6.1 box: `[⚙] [✓] [✕] [▾]`.
 *
 * ## The three states, and why "running" is not "ok"
 *
 * A call that has not finished is neither outcome. The old rendering drew `ok: false` for a
 * still-running call — because `LiveToolCall.ok` starts `false` — which put a red dot and a
 * failure border on a call that was working perfectly. So the state is derived from **whether a
 * result has arrived**, not from the boolean:
 *
 *  - no `result` and no `endedAt` → `is-running`, `⚙`
 *  - a result and `ok` → `is-ok`, `✓`
 *  - a result and not `ok` → `is-failed`, `✕`
 *
 * The `▾` is the disclosure triangle, which the `<details>` element already provides; the glyph
 * in the status slot is the *state*, so a reader can tell at a glance which of the three a row is
 * in without expanding anything.
 *
 * A persisted call has no `startedAt`/`endedAt` — `ChatToolCall` stores name, args, result and ok
 * and deliberately not timing — so a reloaded conversation judges its state from `result` and
 * `ok` alone, which is enough for all three: a reloaded call is never mid-flight.
 */
function ToolCallDisclosure({ call, index }: { call: DisclosureCall; index: number }): ReactNode {
  const durationMs =
    call.startedAt !== undefined && call.endedAt !== undefined ? call.endedAt - call.startedAt : null;

  const state: 'running' | 'ok' | 'failed' =
    call.result === undefined && call.endedAt === undefined
      ? 'running'
      : call.ok
        ? 'ok'
        : 'failed';

  const glyph = state === 'running' ? '⚙' : state === 'ok' ? '✓' : '✕';
  const stateLabel = state === 'running' ? 'Running' : state === 'ok' ? 'Succeeded' : 'Failed';

  return (
    <details className={`tool-call tool-call-box is-${state}`} key={index}>
      <summary className="tool-call-summary">
        <span className={`tool-call-status is-${state}`} aria-hidden="true" title={stateLabel}>
          {glyph}
        </span>
        <span
          className={
            state === 'running' ? 'dot dot-running' : state === 'ok' ? 'dot dot-ok' : 'dot dot-failed'
          }
          aria-hidden="true"
        />
        <code className="tool-call-name">{call.name}</code>
        <span className="muted small tool-call-args">{inlineJson(call.args, 60)}</span>
        <span className="visually-hidden">{stateLabel}</span>
        {durationMs === null ? null : (
          <span
            className="muted small"
            title="Measured from the tool-call frame to the tool-result frame arriving at this browser — the round trip, not the tool's own runtime."
          >
            {formatDuration(durationMs)}
          </span>
        )}
      </summary>
      <div className="tool-call-body">
        <div className="stack-sm">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="label">Arguments</span>
            <CopyButton text={prettyJson(call.args)} label="Copy" />
          </div>
          <pre className="code code-sm">{prettyJson(call.args)}</pre>
        </div>
        {call.result === undefined ? (
          <p className="muted small">
            {call.endedAt === undefined ? 'Still running…' : 'Finished with no result payload.'}
          </p>
        ) : (
          <div className="stack-sm">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="label">Result</span>
              <CopyButton text={prettyJson(call.result)} label="Copy" />
            </div>
            <pre className="code code-sm">{prettyJson(call.result)}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

/**
 * The one-line description of a turn's activity, next to the word "Thinking".
 *
 * Every branch is a fact about what happened. There is no branch that guesses, and none that
 * describes a step the server did not report.
 */
function thinkingSummary(toolCalls: number, interrupted: boolean): string {
  if (interrupted) return 'stopped early';
  if (toolCalls === 0) return 'no tools called';
  return toolCalls === 1 ? '1 tool call' : `${toolCalls} tool calls`;
}

/**
 * The disclosure body for a durable assistant turn.
 *
 * The tool calls *are* the trace, so they live here rather than under the answer — that is the
 * whole point of the header being a disclosure.
 */
function DurableThinking({ message }: { message: ChatMessageDto }): ReactNode {
  return (
    <details className="message-thinking">
      <summary className="message-head thinking-summary">
        <span className="thinking-caret" aria-hidden="true" />
        <span className="message-role">Thinking</span>
        <span className="muted small">
          {thinkingSummary(message.toolCalls.length, message.interrupted)}
        </span>
        {message.interrupted ? <Badge tone="waiting">interrupted</Badge> : null}
        {message.attachmentIds.length > 0 ? (
          <span className="muted small">
            {message.attachmentIds.length} attachment{message.attachmentIds.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </summary>

      <div className="thinking-body">
        {message.toolCalls.length === 0 ? (
          <p className="muted small">
            {message.interrupted
              ? 'This turn was stopped before it called a tool.'
              : 'Answered directly, without calling a tool.'}
          </p>
        ) : (
          <div className="tool-calls">
            {message.toolCalls.map((call, index) => (
              <ToolCallDisclosure key={index} call={call} index={index} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function MessageRow({ message }: { message: ChatMessageDto }): ReactNode {
  const label = roleLabel(message.role);

  return (
    // The clock did not disappear, it moved: the row carries the exact time as a tooltip, so a
    // reader who wants it has it and a reader who does not is not shown it on every message.
    <article className={`message message-${message.role}`} title={formatDateTime(message.createdAt)}>
      {message.role === 'assistant' ? (
        <DurableThinking message={message} />
      ) : (
        <header className="message-head">
          {label === null ? null : <span className="message-role">{label}</span>}
          {message.interrupted ? <Badge tone="waiting">interrupted</Badge> : null}
          {message.attachmentIds.length > 0 ? (
            <span className="muted small">
              {message.attachmentIds.length} attachment
              {message.attachmentIds.length === 1 ? '' : 's'}
            </span>
          ) : null}
        </header>
      )}

      {message.content.length > 0 ? <div className="message-body">{message.content}</div> : null}
    </article>
  );
}

export interface MessageListProps {
  messages: readonly ChatMessageDto[];
  /** The in-flight turn's provisional text and tool calls — see `useChatTurn`. */
  live: {
    content: string;
    toolCalls: readonly LiveToolCall[];
    status: TurnStatus;
    limit: string | null;
  };
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}

export function MessageList({
  messages,
  live,
  hasMore,
  loadingOlder,
  onLoadOlder,
}: MessageListProps): ReactNode {
  const streaming = live.status === 'streaming';
  const showLiveBubble = streaming || live.content.length > 0 || live.toolCalls.length > 0;

  if (messages.length === 0 && !showLiveBubble) {
    return (
      <EmptyState
        title="No messages yet"
        hint="Ask a question, or type / for the command list."
      />
    );
  }

  return (
    <div className="transcript">
      {hasMore ? (
        <div className="transcript-older">
          <Button size="sm" onClick={onLoadOlder} loading={loadingOlder}>
            Load older messages
          </Button>
        </div>
      ) : null}

      {messages.map((message) => (
        <MessageRow key={message.id} message={message} />
      ))}

      {showLiveBubble ? (
        <article className="message message-assistant message-live">
          {/*
            Open while the turn runs, so the reader watches the activity rather than a spinner —
            "show how they think" is the whole reason this disclosure exists. `undefined` rather
            than `false` once it stops, which hands the control back to the browser instead of
            forcing it shut under someone who opened it.
          */}
          <details className="message-thinking" open={streaming ? true : undefined}>
            <summary className="message-head thinking-summary">
              <span className="thinking-caret" aria-hidden="true" />
              <span className="message-role">Thinking</span>
              <span className="muted small">
                {live.toolCalls.length === 0
                  ? 'reading your message'
                  : thinkingSummary(live.toolCalls.length, false)}
              </span>
            </summary>

            <div className="thinking-body">
              {live.toolCalls.length > 0 ? (
                <div className="tool-calls">
                  {live.toolCalls.map((call, index) => (
                    <ToolCallDisclosure key={call.key} call={call} index={index} />
                  ))}
                </div>
              ) : (
                <p className="muted small">Waiting for the model to answer.</p>
              )}

              {live.limit !== null ? (
                <p className="muted small">
                  The provider reported a limit: <code>{live.limit}</code>. The turn continued, but
                  the answer may be cut short.
                </p>
              ) : null}
            </div>
          </details>

          {live.content.length > 0 ? (
            <div className="message-body">
              {live.content}
              {streaming ? <span className="caret" aria-hidden="true" /> : null}
            </div>
          ) : null}
        </article>
      ) : null}
    </div>
  );
}
