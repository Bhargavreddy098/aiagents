/**
 * One streaming turn.
 *
 * ## Provisional text, and the rule that keeps it honest
 *
 * Deltas are rendered as they arrive, so the user sees the answer being written. That text is
 * **provisional** — it is not yet a row, and the honest thing is for it to stop existing the
 * moment the durable version does.
 *
 * So `chat.completed` does not simply flip a flag. It refetches the conversation, waits for the
 * refetch, and only then drops the buffer. The controller persists the assistant message
 * *before* it writes that frame, so the row is guaranteed to be there when the refetch runs —
 * which is what makes clearing the buffer safe rather than a race that loses the last message.
 *
 * ## Why the abort is real
 *
 * `stop()` aborts the fetch, and the controller listens for the response closing and aborts the
 * provider call in turn (gap #21). So stopping is not "stop rendering" — it stops the
 * generation, and the message row is written with `interrupted: true`. That is why `stop` also
 * refetches: the durable fact is "this text is a fragment", and the row is where that lives.
 *
 * ## What the frames do not carry
 *
 * A tool call arrives as `{ runId, toolName, args }` and its result as
 * `{ runId, toolName, ok, result? }`. There is **no call id** on either, so pairing them is
 * positional: the oldest unfinished call with the same name. Two concurrent calls to the same
 * tool are therefore indistinguishable, and the duration shown is the gap between the two
 * frames arriving at this client — a real measurement, but of the wire, not of the tool.
 *
 * `chat.started` carries only `runId`. If a turn is sent with no `sessionId` the server opens a
 * session and **never reports its id in any frame**, so this hook cannot discover it. The page
 * avoids that by always creating the session first; a client that did not would have to guess
 * from the session list.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatToolCall, ErrorPayload } from '@nexs/shared';
import { qs } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import { openEventStream, type AnyStreamFrame } from '../../lib/sse-stream';

export interface LiveToolCall extends ChatToolCall {
  /** Stable within the turn, for React's list key. Positional — see the file header. */
  key: string;
  /** When `chat.tool_call` arrived. Client-observed. */
  startedAt: number;
  /** When `chat.tool_result` arrived, or undefined while it is still running. */
  endedAt?: number;
}

export type TurnStatus = 'idle' | 'streaming' | 'done' | 'error';

export interface ChatTurn {
  status: TurnStatus;
  /** Set from `chat.started`. */
  runId: string | null;
  /** Provisional assistant text — see the file header. */
  content: string;
  toolCalls: LiveToolCall[];
  error: ErrorPayload | null;
  /** Set by `chat.limit.reached`. The turn continues; this is a warning, not a failure. */
  limit: string | null;
  send: (input: SendTurnInput) => Promise<void>;
  /** Abort the stream — which also stops the generation server-side. */
  stop: () => void;
  reset: () => void;
}

export interface SendTurnInput {
  content: string;
  /** Required when the session has no agent; the server refuses the turn without one. */
  sessionId: string;
  modelId?: string;
  attachmentIds?: string[];
}

export function useChatTurn(): ChatTurn {
  const client = useQueryClient();
  const [status, setStatus] = useState<TurnStatus>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [toolCalls, setToolCalls] = useState<LiveToolCall[]>([]);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [limit, setLimit] = useState<string | null>(null);

  // One controller per in-flight turn. Kept in a ref because aborting is an imperative act,
  // not a render input — storing it in state would re-render the composer on every send.
  const controller = useRef<AbortController | null>(null);

  const reset = useCallback((): void => {
    setStatus('idle');
    setRunId(null);
    setContent('');
    setToolCalls([]);
    setError(null);
    setLimit(null);
  }, []);

  const stop = useCallback((): void => {
    controller.current?.abort();
    controller.current = null;
    setStatus('idle');
  }, []);

  /**
   * Abort on unmount.
   *
   * Navigating away from the chat page must not leave a generation running against a socket
   * nobody reads. The controller already listens for the response closing, so aborting here is
   * what actually stops the provider call rather than merely hiding its output.
   */
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
    },
    [],
  );

  const send = useCallback(
    async (input: SendTurnInput): Promise<void> => {
      // A second send while one is in flight would interleave two turns' deltas into one
      // buffer. The composer disables itself during a turn; this is the backstop.
      if (controller.current !== null) return;

      const abort = new AbortController();
      controller.current = abort;

      setStatus('streaming');
      setContent('');
      setToolCalls([]);
      setError(null);
      setLimit(null);
      setRunId(null);

      const handle = (frame: AnyStreamFrame): void => {
        switch (frame.name) {
          case 'chat.started':
            setRunId(frame.payload.runId);
            return;

          case 'chat.delta':
            setContent((previous) => previous + frame.payload.delta);
            return;

          case 'chat.tool_call':
            setToolCalls((previous) => [
              ...previous,
              {
                key: `${frame.payload.toolName}:${previous.length}`,
                name: frame.payload.toolName,
                args: frame.payload.args,
                ok: false,
                startedAt: Date.now(),
              },
            ]);
            return;

          case 'chat.tool_result':
            setToolCalls((previous) => {
              // The oldest call with this name that has not finished. Positional pairing —
              // see the file header on why there is nothing better available.
              const index = previous.findIndex(
                (call) => call.name === frame.payload.toolName && call.endedAt === undefined,
              );
              if (index === -1) return previous;
              const next = [...previous];
              const call = next[index];
              if (call === undefined) return previous;
              next[index] = {
                ...call,
                ok: frame.payload.ok,
                endedAt: Date.now(),
                ...(frame.payload.result === undefined ? {} : { result: frame.payload.result }),
              };
              return next;
            });
            return;

          case 'chat.limit.reached':
            // A warning the turn survives. Recorded rather than swallowed, because a silently
            // truncated answer is the kind of thing a user should be told about.
            setLimit(frame.payload.limit);
            return;

          case 'chat.error':
            setError(frame.payload.error);
            setStatus('error');
            return;

          case 'chat.completed':
            setStatus('done');
            return;

          default:
            // Every other frame on this connection — `step.*`, `run.*`, `notification.*` — is
            // published by the hub and delivered to the same tab by `useSSE`. They are not this
            // turn's business and are ignored here rather than stored.
            return;
        }
      };

      try {
        await openEventStream({
          path: `/chat${qs({ sessionId: input.sessionId })}`,
          body: {
            content: input.content,
            ...(input.attachmentIds === undefined || input.attachmentIds.length === 0
              ? {}
              : { attachmentIds: input.attachmentIds }),
            ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
          },
          signal: abort.signal,
          onFrame: handle,
        });
      } catch (err) {
        // An abort is a user action, not a failure. The durable rows are refetched below so
        // the interrupted message shows as what it is.
        if (!abort.signal.aborted) {
          setError(
            err instanceof Error && 'code' in err
              ? { code: String((err as { code: unknown }).code), message: err.message }
              : { code: 'CHAT_STREAM_FAILED', message: err instanceof Error ? err.message : String(err) },
          );
          setStatus('error');
        }
      } finally {
        controller.current = null;

        // The refetch that makes the provisional buffer safe to drop. `invalidateQueries`
        // resolves once the refetch has completed, so awaiting it is the whole mechanism.
        await client.invalidateQueries({ queryKey: queryKeys.chat.messages }).catch(() => undefined);

        // Dropped unconditionally, including after an abort: the message row now exists and
        // says whether it was interrupted, so keeping the buffer would render the same text
        // twice — once provisional, once durable.
        setContent('');
        setToolCalls([]);
        setStatus((current) => (current === 'streaming' ? 'done' : current));
      }
    },
    [client],
  );

  return { status, runId, content, toolCalls, error, limit, send, stop, reset };
}
