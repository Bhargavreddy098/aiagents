/**
 * Subscribing to frames from the one connection.
 *
 * `useSseEvents` takes the names a component cares about and calls back for those only.
 * The names are matched as a set, so a component that lists `['run.completed',
 * 'run.failed']` is not woken by `step.started` — with a run emitting a step pair per step,
 * that difference is the whole point.
 *
 * The handler is held in a ref and read at call time. Without that, a component passing an
 * inline arrow would resubscribe on every render, and a frame arriving between the
 * unsubscribe and the resubscribe would be lost — a real gap, since the subscribe happens in
 * an effect *after* the render that produced the new handler.
 */

import { useEffect, useRef, useState } from 'react';
import type { SSEEventName, SsePayload } from '@nexs/shared';
import {
  getSseStatus,
  subscribeSse,
  subscribeSseStatus,
  type SseEnvelope,
  type SseStatus,
} from '../lib/sse-bus';

/** The connection state, re-rendering the caller when it changes. */
export function useSseStatus(): SseStatus {
  const [status, setStatus] = useState<SseStatus>(getSseStatus);
  useEffect(() => subscribeSseStatus(setStatus), []);
  return status;
}

/** A frame narrowed to the names the caller subscribed to. */
export interface SseEvent<N extends SSEEventName = SSEEventName> extends SseEnvelope<N> {
  name: N;
  payload: SsePayload<N>;
}

export function useSseEvents<N extends SSEEventName>(
  names: readonly N[],
  handler: (frame: SseEvent<N>) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  // The name list is compared by content, not identity: `['run.completed']` written inline
  // is a new array every render, and keying the effect on the array itself would resubscribe
  // forever. Joining is safe because the names are a closed set of literals with no commas.
  const key = names.join('|');

  useEffect(() => {
    const wanted = new Set<string>(key.length > 0 ? key.split('|') : []);
    if (wanted.size === 0) return undefined;

    return subscribeSse((frame) => {
      if (!wanted.has(frame.name)) return;
      handlerRef.current(frame as SseEvent<N>);
    });
  }, [key]);
}
