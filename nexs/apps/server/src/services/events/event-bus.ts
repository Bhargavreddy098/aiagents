import type { SSEEventName } from '@nexs/shared';
import type { Logger } from '../../logger.js';

/**
 * The event bridge (§1.2) — the single publish/subscribe seam every emitter writes to.
 *
 * ## Why this exists rather than emitters holding the SSE hub
 *
 * Before this module, each service was handed an `emit` callback and the composition root was
 * supposed to point it at the hub. It never did, and the reason is structural rather than an
 * oversight: the hub is built *late* (it needs the chat runner for its `onRunUnwatched` edge)
 * while the engine, the approval service and the notification service are built *early*, so
 * there was no moment at which the callback could have been bound. The result was that in
 * production every `emit?.()` was a no-op and `GET /api/stream` carried nothing but chat
 * frames and the connect-time replay — a live tail that was not live.
 *
 * A bus breaks that ordering problem instead of working around it. It is constructed first,
 * before anything that emits, and the hub *subscribes* to it later. Neither side has to know
 * when the other was built, and the emitters stop depending on the transport entirely — which
 * is what the spec means by "the single publish/subscribe seam".
 *
 * ## What the tenant argument is for
 *
 * `publish` takes a `tenantId` because fan-out is per tenant, and the emitter is the only
 * component that knows which tenant it is acting for. The alternative — deriving the tenant
 * from the payload's `runId` — would put a database read on the path of every frame.
 *
 * ## PgNotifyBus
 *
 * The spec pairs this with a `PgNotifyBus` (`SELECT pg_notify('nexs_events', …)` plus a
 * `LISTEN` connection in the API process) for a deployment where the worker runs as a separate
 * process. **It is not implemented here, deliberately.** It needs the `pg` driver as a direct
 * dependency and a live Postgres to test against, and this machine has neither — so writing it
 * would produce code that cannot be exercised at all, in the one area where a silent failure
 * looks exactly like "nothing happened". The seam above is what makes it a drop-in later: a
 * `PgNotifyBus` implements the same two methods, and nothing that emits has to change.
 */
export interface EventBus {
  /** Publish to every subscriber of `tenantId`. A no-op when nobody is listening. */
  publish(tenantId: string, name: SSEEventName, payload: unknown): void;
  /**
   * Subscribe to a tenant's events. Returns an unsubscribe function.
   *
   * The unsubscribe is returned rather than exposed as a method so a subscriber cannot
   * unsubscribe a handler it does not own.
   */
  subscribe(
    tenantId: string,
    handler: (event: { name: SSEEventName; payload: unknown }) => void,
  ): () => void;
}

export interface InMemoryBusDeps {
  logger: Logger;
}

/**
 * The bus for a single-process deployment — `WORKER_ENABLED=true`, which is how this build
 * runs. `Map<tenantId, Set<handler>>`, exactly as the spec describes it.
 */
export function createInMemoryBus(deps: InMemoryBusDeps): EventBus {
  const handlers = new Map<string, Set<(event: { name: SSEEventName; payload: unknown }) => void>>();

  return {
    publish(tenantId, name, payload) {
      const set = handlers.get(tenantId);
      if (set === undefined || set.size === 0) return;

      const event = { name, payload };

      // Iterating a copy, because a handler is allowed to unsubscribe while it is being
      // called — the hub does exactly that when the last client of a tenant disconnects — and
      // mutating the set being iterated would skip whichever handler happened to follow it.
      for (const handler of [...set]) {
        try {
          handler(event);
        } catch (err) {
          // One misbehaving subscriber must not stop the others. The same rule the hub applies
          // to a dead client, for the same reason: a frame that fails to reach one listener is
          // not a reason for it to reach nobody.
          deps.logger.warn({ err, tenantId, event: name }, 'event bus subscriber threw');
        }
      }
    },

    subscribe(tenantId, handler) {
      const set = handlers.get(tenantId) ?? new Set();
      set.add(handler);
      handlers.set(tenantId, set);

      let done = false;
      return () => {
        // Idempotent: the hub detaches on `close`, and a second call must not remove some
        // other subscriber's handler by mistake.
        if (done) return;
        done = true;

        const current = handlers.get(tenantId);
        if (current === undefined) return;
        current.delete(handler);
        // Deleting the empty set keeps `handlers` proportional to the number of tenants with
        // a live subscriber rather than to every tenant that has ever had one.
        if (current.size === 0) handlers.delete(tenantId);
      };
    },
  };
}
