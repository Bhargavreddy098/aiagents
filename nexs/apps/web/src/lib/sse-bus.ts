/**
 * The in-tab SSE fan-out.
 *
 * §6.5 requires **a single global connection per tab**. Chat needs `chat.delta` frames as
 * they arrive, the run workspace needs `step.*`, and the notification bell needs
 * `notification.created` — but three `EventSource` objects would mean three server-side
 * connections, three sets of replays on connect, and three chances to disagree about
 * whether the stream is up.
 *
 * So `useSSE` owns the one connection and publishes every frame here; components subscribe
 * through `useSseEvents` and filter to the names they care about. The connection does not
 * know who is listening, and a component that mounts mid-stream misses only the frames that
 * already went by — which is the documented contract, because every frame echoes durable
 * state that a REST refetch can re-read.
 */

import type { SSEEventName, SsePayload } from '@nexs/shared';

export interface SseEnvelope<N extends SSEEventName = SSEEventName> {
  name: N;
  payload: SsePayload<N>;
  /** When the client received it — not when the server emitted it. */
  receivedAt: number;
}

type Listener = (frame: SseEnvelope) => void;

const listeners = new Set<Listener>();

/** Subscribe to every frame. Returns the unsubscribe function. */
export function subscribeSse(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Deliver one frame to every subscriber.
 *
 * A throwing subscriber is isolated: one broken handler must not stop the others from
 * receiving a frame, and — more importantly — must not tear down the connection, which is
 * what an exception propagating into the `EventSource` callback would eventually do.
 */
export function publishSse(frame: SseEnvelope): void {
  for (const listener of listeners) {
    try {
      listener(frame);
    } catch (err) {
      // `no-console` allows `error`, so this needs no suppression — the directive that used to
      // be here was suppressing nothing and eslint reported it as unused.
      console.error('SSE subscriber threw', err);
    }
  }
}

/** The connection state, for a status indicator. */
export type SseStatus = 'connecting' | 'open' | 'closed';

type StatusListener = (status: SseStatus) => void;

const statusListeners = new Set<StatusListener>();
let currentStatus: SseStatus = 'closed';

export function subscribeSseStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  listener(currentStatus);
  return () => {
    statusListeners.delete(listener);
  };
}

export function setSseStatus(status: SseStatus): void {
  if (currentStatus === status) return;
  currentStatus = status;
  for (const listener of statusListeners) listener(status);
}

export function getSseStatus(): SseStatus {
  return currentStatus;
}
