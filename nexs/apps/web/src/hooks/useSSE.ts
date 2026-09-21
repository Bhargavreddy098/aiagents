/**
 * The single SSE connection, and the §6.4 invalidation map.
 *
 * ## Why this does not use `onmessage`
 *
 * §6.5 sketches the hook as *"`onmessage`: parse `{ name, payload }` → dispatch per §6.4"*.
 * That cannot work, and the reason is a one-line detail of the server's encoder:
 * `encodeSseFrame` writes an **`event: <name>`** line before the `data:` line.
 *
 * An `EventSource` routes a frame with an `event:` line to listeners registered for *that
 * name*, and never to `onmessage` — `onmessage` is only the default for frames with no
 * `event:` field. So the sketch as written would open a healthy stream, receive every
 * frame, and dispatch none of them: no error, no reconnect, just a UI that never updates.
 * That is the same failure shape as the double-prefixed chat router — the code and the
 * comment describing it disagree, and only the comment is wrong.
 *
 * The fix is to enumerate the catalog and register a listener per name. `SSE_EVENTS` is
 * imported rather than a hand-written list, so an event added to the server is subscribed
 * to without a change here — and a hand-written list is exactly the thing that would go
 * stale silently.
 *
 * ## Why the backoff is ours and not the browser's
 *
 * `EventSource` reconnects on its own, immediately and forever. The spec asks for
 * 1 s → 30 s exponential backoff, and the browser will not do that — and it will happily
 * retry a stream the server has deliberately closed. So on any error the connection is
 * closed and re-opened on our own timer. `readyState` is checked first: a stream the server
 * ended is `CLOSED` and must be rebuilt, while one the browser is mid-retry is `CONNECTING`
 * and is already doing what we would.
 */

import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { SSE_EVENTS, isSseEventName, type SSEEventName } from '@nexs/shared';
import { publishSse, setSseStatus } from '../lib/sse-bus';
import { queryKeys } from '../lib/query-keys';

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** Every catalog name, resolved once at module load. */
const EVENT_NAMES = Object.keys(SSE_EVENTS) as SSEEventName[];

type QueryKey = readonly unknown[];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Which queries a frame invalidates — §6.4, plus the catalog's later additions.
 *
 * Returning keys rather than mutating means this is a pure function a test can assert on,
 * and it keeps the "what does this event mean for the cache" decision in one readable place
 * instead of scattered through listeners.
 */
export function invalidationTargets(name: SSEEventName, payload: unknown): QueryKey[] {
  const data = asRecord(payload);
  const runId = readString(data, 'runId');
  const targets: QueryKey[] = [];

  const runsAndDashboard = (): void => {
    targets.push(queryKeys.runs.all, queryKeys.dashboard);
    if (runId !== null) targets.push(queryKeys.runs.one(runId));
  };

  if (name.startsWith('run.')) {
    runsAndDashboard();
    return targets;
  }

  if (name.startsWith('step.') || name.startsWith('tool.')) {
    // A step or tool event is evidence the run's own row changed too, so the list and the
    // dashboard tile are stale even though the event does not name them.
    runsAndDashboard();
    return targets;
  }

  if (name.startsWith('chat.')) {
    targets.push(queryKeys.chat.messages);
    if (runId !== null) targets.push(queryKeys.runs.one(runId), queryKeys.runs.all);
    return targets;
  }

  if (name.startsWith('approval.')) {
    targets.push(queryKeys.approvals.all, queryKeys.dashboard);
    // An approval is a run parked mid-flight: resolving it moves the run, so the run view
    // must not sit on a stale `waiting_approval`.
    if (runId !== null) targets.push(queryKeys.runs.one(runId));
    return targets;
  }

  if (name.startsWith('agent.')) {
    targets.push(queryKeys.agents.all);
    const agentId = readString(data, 'agentId');
    if (agentId !== null) targets.push(queryKeys.agents.one(agentId));
    return targets;
  }

  if (name.startsWith('goal.')) {
    targets.push(queryKeys.goals.all);
    const goalId = readString(data, 'goalId');
    if (goalId !== null) targets.push(queryKeys.goals.one(goalId));
    return targets;
  }

  if (name.startsWith('task.')) {
    targets.push(queryKeys.tasks.all);
    const taskId = readString(data, 'taskId');
    if (taskId !== null) targets.push(queryKeys.tasks.one(taskId));
    return targets;
  }

  if (name.startsWith('provider.')) {
    targets.push(queryKeys.providers, queryKeys.models);
    return targets;
  }

  if (name === 'mcp.connected') {
    targets.push(queryKeys.mcp.all, queryKeys.tools.all, queryKeys.dashboard);
    return targets;
  }

  if (name === 'connector.connected') {
    targets.push(queryKeys.connectors.all, queryKeys.tools.all, queryKeys.dashboard);
    return targets;
  }

  if (name.startsWith('browser.')) {
    targets.push(queryKeys.browser.sessions);
    return targets;
  }

  if (name.startsWith('sandbox.')) {
    targets.push(queryKeys.sandbox.sessions);
    return targets;
  }

  if (name.startsWith('schedule.')) {
    targets.push(queryKeys.schedules, queryKeys.dashboard);
    return targets;
  }

  if (name === 'notification.created') {
    targets.push(queryKeys.notifications);
    return targets;
  }

  // `event.received` / `event.processed` have no cached list yet, and `stream.closing` is
  // handled by the connection itself. Returning empty is the honest answer: invalidating
  // everything would refetch the whole app on every webhook.
  return targets;
}

/**
 * Invalidate every key a frame touches.
 *
 * `invalidateQueries({ queryKey })` matches by **prefix**, so `['runs']` also refreshes
 * `['runs', id]` — the run detail. That is why `runsAndDashboard` can push the broad key
 * and the narrow one without causing two requests for the same query: TanStack dedupes the
 * second match.
 */
export function applyInvalidations(client: QueryClient, name: SSEEventName, payload: unknown): void {
  for (const queryKey of invalidationTargets(name, payload)) {
    void client.invalidateQueries({ queryKey });
  }
}

/**
 * Open the one stream. Mount exactly once, at the app root.
 *
 * Mounting it twice would open two connections and double every invalidation; the module
 * bus would then deliver every frame twice. Nothing enforces the single mount, so the
 * contract is stated here and the root is the only caller.
 */
export function useSSE(): void {
  const client = useQueryClient();

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: number | null = null;
    let attempt = 0;
    let disposed = false;

    const clearRetry = (): void => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const scheduleReconnect = (): void => {
      if (disposed) return;
      clearRetry();
      // 1s, 2s, 4s … capped at 30s. Capped rather than unbounded because a laptop that
      // slept for an hour should reconnect promptly on wake, not after an hour of backoff.
      const delay = Math.min(BACKOFF_START_MS * 2 ** attempt, BACKOFF_MAX_MS);
      attempt += 1;
      setSseStatus('connecting');
      retryTimer = window.setTimeout(open, delay);
    };

    const handleFrame = (listenerName: SSEEventName, event: Event): void => {
      const raw = (event as MessageEvent<string>).data;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A frame we cannot parse is not recoverable here, and every frame echoes durable
        // state — so dropping it loses nothing that a refetch will not restore.
        return;
      }

      const body = asRecord(parsed);
      const declared = body.name;
      // The encoder always writes both the `event:` line and the `name` inside the payload,
      // so a disagreement means one of them is wrong. Trusting the listener name is the
      // safe half: it is the name the server actually routed on.
      const name = isSseEventName(declared) ? declared : listenerName;
      const payload = isSseEventName(declared) ? body.payload : body;

      publishSse({ name, payload: payload as never, receivedAt: Date.now() });
      applyInvalidations(client, name, payload);
    };

    const open = (): void => {
      if (disposed) return;
      clearRetry();

      source = new EventSource('/api/stream', { withCredentials: true });

      source.onopen = () => {
        attempt = 0;
        setSseStatus('open');
      };

      for (const name of EVENT_NAMES) {
        source.addEventListener(name, (event) => {
          handleFrame(name, event);
        });
      }

      source.onerror = () => {
        setSseStatus('closed');
        // Close unconditionally. Left open, the browser keeps its own retry alive and we
        // would end up with two connections racing once our timer also fires.
        source?.close();
        source = null;
        scheduleReconnect();
      };
    };

    // A tab that was hidden or offline reconnects at once rather than waiting out a backoff
    // it accrued while nothing was listening.
    const resume = (): void => {
      if (disposed) return;
      if (document.visibilityState === 'hidden') return;
      if (source !== null) return;
      attempt = 0;
      open();
    };

    open();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);

    return () => {
      disposed = true;
      clearRetry();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      source?.close();
      source = null;
      setSseStatus('closed');
    };
  }, [client]);
}
