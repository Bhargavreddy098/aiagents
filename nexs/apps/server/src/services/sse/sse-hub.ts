import { randomUUID } from 'node:crypto';
import { ApiError, encodeSseFrame, SSE_HEARTBEAT, type SseFrame } from '@nexs/shared';
import type { Logger } from '../../logger.js';
import type { EventBus } from '../events/event-bus.js';

/**
 * The live transport behind `GET /api/stream`.
 *
 * ## Why this exists before Phase 12
 *
 * `container.ts` used to say "the SSE hub arrives in Phase 12; until then the engine runs
 * without a subscriber". That was true and harmless while the engine was the only thing
 * emitting — a run that nobody watches still runs, and its result is durable in Postgres.
 *
 * Chat breaks that assumption. A chat answer that nobody is watching has not merely lost its
 * audience, it has lost its *transport*: the deltas have nowhere to go. Phase 7's own
 * acceptance test ("kill the tab mid-response") and its live-tail contract both presuppose a
 * stream, so the transport's substance is pulled forward here. What stays in Phase 12 is the
 * optional part — the per-tenant ring buffer that honors `Last-Event-ID` for cheap replay —
 * which this hub deliberately does not have. Reconnect is a REST refetch, which is the
 * documented contract and the reason a replay buffer is optional rather than required.
 *
 * ## Tenancy
 *
 * Fan-out is keyed by `tenantId` and a frame is only ever written to clients of the tenant
 * that published it. The hub is the one place where a mistake would leak one tenant's run
 * output into another's browser, so the filter is applied at write time rather than trusted
 * to the caller.
 *
 * ## Dead clients
 *
 * A disconnected client is the classic SSE leak: the socket is gone, but the entry stays in
 * the registry and every subsequent `publish` writes into a closed stream. Two defences —
 * `res` emits `close`, which detaches eagerly, and every write is guarded, so a client that
 * dies without firing `close` is detached on the first failed write rather than accumulating.
 */

/** A registered connection. `id` is the hub's, not the client's. */
export interface SseRegistration {
  id: string;
  tenantId: string;
  userId: string;
  ip: string;
  /**
   * The run this client is tailing, or `null` to receive every event for its tenant.
   *
   * Not a filter the hub applies for correctness — it is what makes "the last person
   * watching this run just left" a question the hub can answer, which is how a chat
   * disconnect reaches the provider fetch. See `onRunUnwatched`.
   */
  runId: string | null;
}

/** The writable end. Deliberately structural so a test can supply a plain array. */
export interface SseSink {
  write(chunk: string): void;
  end(): void;
}

export interface SseAttachInput {
  tenantId: string;
  userId: string;
  ip: string;
  runId?: string | null;
}

export interface SseHubDeps {
  logger: Logger;
  /**
   * Cap per source address.
   *
   * Enforced here rather than by a middleware because the limit is about *held connections*,
   * and only the hub knows how many an address currently holds. A request-rate limiter cannot
   * see that an SSE connection is long-lived: one request, held open for an hour.
   */
  maxConnectionsPerIp: number;
  /**
   * Mints the `id:` that goes on the wire for each published frame.
   *
   * Separate from the connection id on purpose. A connection id never leaves the server and
   * exists only to key the registry; an event id is a token handed to the client. Drawing
   * both from one sequence would make them collide, which is confusing to read in a log and
   * makes "every client received the same id" impossible to assert without knowing how many
   * connections happened to be open first.
   */
  newEventId?: () => string;
  /**
   * Fired when the last client tailing `runId` detaches, and never when a client that was
   * not tailing a run leaves.
   *
   * This is the seam gap #21 hangs on: for a chat run, the last watcher leaving is the signal
   * that aborts the provider fetch and finalizes the partial assistant message.
   */
  onRunUnwatched?: (tenantId: string, runId: string) => void;
  /**
   * The event bridge (§1.2). When present, the hub subscribes to it per tenant and every
   * event published on it reaches this tenant's clients.
   *
   * This is how the hub is *fed*. Before the bus existed, the hub was wired to nothing: the
   * composition root had no way to bind the emitters' callback to a hub that is built after
   * them, so `GET /api/stream` carried only chat frames. Optional rather than required so the
   * hub stays testable on its own — a test that calls `publish` directly is testing the
   * transport, and does not need a bus behind it.
   */
  bus?: EventBus;
}

export interface SseHub {
  /** Registers a client and returns its id plus an idempotent detach handle. */
  attach(input: SseAttachInput, sink: SseSink): { id: string; detach: () => void };
  /** Writes a frame to every client of the frame's tenant. No-op when nobody is listening. */
  publish(frame: SseFrame, tenantId: string): void;
  /**
   * Writes a heartbeat comment to every client.
   *
   * Exposed as a method rather than owned as an internal interval so the behaviour is
   * testable without fake timers — the composition root drives it from `SSE_HEARTBEAT_MS`.
   */
  beat(): void;
  /** Emits `stream.closing` and ends every connection. Used on shutdown. */
  closeAll(reason: string): void;
  connectionCount(): number;
  /** How many clients of `tenantId` are currently tailing `runId`. */
  subscriberCount(tenantId: string, runId: string): number;
  /** Closes every connection for one tenant. Used when a session is invalidated. */
  closeTenant(tenantId: string, reason: string): void;
}

export function createSseHub(deps: SseHubDeps): SseHub {
  const clients = new Map<string, { registration: SseRegistration; sink: SseSink }>();
  /** `runId` → ids of the clients tailing it. Kept in step with `clients` on every detach. */
  const watchers = new Map<string, Set<string>>();
  const byIp = new Map<string, number>();
  /** `tenantId` → the unsubscribe for that tenant's bus subscription. See `retainBusSubscription`. */
  const busSubscriptions = new Map<string, () => void>();
  const newEventId = deps.newEventId ?? randomUUID;

  function unwatch(registration: SseRegistration): void {
    if (registration.runId === null) return;

    const set = watchers.get(registration.runId);
    if (set === undefined) return;
    set.delete(registration.id);
    if (set.size > 0) return;

    watchers.delete(registration.runId);
    // Fired after the registry is consistent, so a callback that synchronously asks
    // `subscriberCount` sees zero rather than the client that is on its way out.
    deps.onRunUnwatched?.(registration.tenantId, registration.runId);
  }

  function detach(id: string): void {
    const entry = clients.get(id);
    if (entry === undefined) return; // idempotent: `close` may fire after an explicit detach

    clients.delete(id);
    unwatch(entry.registration);

    const held = byIp.get(entry.registration.ip) ?? 0;
    if (held <= 1) byIp.delete(entry.registration.ip);
    else byIp.set(entry.registration.ip, held - 1);

    // After the decrement, so `releaseBusSubscription` sees the true remaining count and only
    // unsubscribes when this really was the last client of the tenant.
    releaseBusSubscription(entry.registration.tenantId);
  }

  function closeTenant(tenantId: string, reason: string): void {
    const chunk = encodeSseFrame('stream.closing', { reason }, newEventId());

    for (const [id, entry] of clients) {
      if (entry.registration.tenantId !== tenantId) continue;
      try {
        entry.sink.write(chunk);
        entry.sink.end();
      } catch (err) {
        deps.logger.warn({ err, clientId: id }, 'SSE close failed');
      }
      // Detached even when the write threw: the client is being closed either way, and
      // leaving it registered would mean the next `publish` writes into it again.
      detach(id);
    }
  }

  /**
   * Write a frame to every client of `tenantId`.
   *
   * A local function rather than only a method on the returned object, because the bus
   * subscription needs to write frames too — and two copies of "fan out to a tenant" is
   * exactly the shape of duplication where one of them eventually loses the tenant filter.
   */
  function publishTo(tenantId: string, frame: SseFrame): void {
    // The id is minted per published frame, not per client, so every client that receives
    // this frame receives the *same* id — which is what makes it usable as a resume token.
    const chunk = encodeSseFrame(frame.name, frame.payload, newEventId());

    for (const [id, entry] of clients) {
      if (entry.registration.tenantId !== tenantId) continue;
      try {
        entry.sink.write(chunk);
      } catch (err) {
        // A write into a closed socket. Detaching here rather than rethrowing is what keeps
        // one dead browser tab from breaking the fan-out for every other client.
        deps.logger.warn({ err, clientId: id, event: frame.name }, 'SSE write failed; dropping client');
        detach(id);
      }
    }
  }

  /** How many clients this tenant currently holds. */
  function clientsFor(tenantId: string): number {
    let count = 0;
    for (const entry of clients.values()) {
      if (entry.registration.tenantId === tenantId) count += 1;
    }
    return count;
  }

  /**
   * Subscribe to the bus for a tenant, on the first client that arrives.
   *
   * Lazily rather than for every tenant upfront, because the set of tenants with an open
   * stream is exactly the set that can receive anything — subscribing to all of them would
   * keep a handler alive per tenant that has ever been seen, for a `publish` that would
   * immediately find nobody to write to.
   */
  function retainBusSubscription(tenantId: string): void {
    if (deps.bus === undefined) return;
    if (busSubscriptions.has(tenantId)) return;

    busSubscriptions.set(
      tenantId,
      deps.bus.subscribe(tenantId, (event) => {
        // The bus carries `payload: unknown` because it is a transport, not a typed emitter;
        // the catalog in §3.1 is what makes the pairing of name and payload correct at the
        // point of emission. The cast is the seam between those two worlds and is the only
        // one here — and it is a *compile-time* claim only, which is why it is safe to make:
        // `encodeSseFrame` re-checks both the name and the payload at runtime before a byte is
        // written, so a pairing that is wrong in fact rather than merely in type is refused
        // there and reported, instead of reaching a client as a frame it cannot interpret.
        publishTo(tenantId, { name: event.name, payload: event.payload } as SseFrame);
      }),
    );
  }

  /** Drop the subscription once the last client of a tenant has gone. */
  function releaseBusSubscription(tenantId: string): void {
    if (clientsFor(tenantId) > 0) return;

    const unsubscribe = busSubscriptions.get(tenantId);
    if (unsubscribe === undefined) return;
    unsubscribe();
    busSubscriptions.delete(tenantId);
  }

  return {
    attach(input, sink) {
      const held = byIp.get(input.ip) ?? 0;
      if (held >= deps.maxConnectionsPerIp) {
        // Refusing here rather than accepting and dropping keeps the failure visible: a
        // client that is over the cap is told, instead of opening a stream that never
        // speaks. Thrown as an `ApiError` so the route can still answer with a real 429 —
        // which is only possible because the route attaches *before* it flushes headers.
        throw new ApiError(
          'RATE_LIMITED',
          `Too many open streams from this address (limit ${deps.maxConnectionsPerIp})`,
          { limit: deps.maxConnectionsPerIp },
        );
      }

      // Internal only — this id is never serialized, so it does not need to be injectable.
      const id = randomUUID();
      const registration: SseRegistration = {
        id,
        tenantId: input.tenantId,
        userId: input.userId,
        ip: input.ip,
        runId: input.runId ?? null,
      };

      clients.set(id, { registration, sink });
      byIp.set(input.ip, held + 1);

      if (registration.runId !== null) {
        const set = watchers.get(registration.runId) ?? new Set<string>();
        set.add(id);
        watchers.set(registration.runId, set);
      }

      // After the client is registered, so the subscription cannot deliver into a tenant the
      // registry does not yet believe has a listener.
      retainBusSubscription(input.tenantId);

      let detached = false;
      return {
        id,
        detach: () => {
          if (detached) return;
          detached = true;
          detach(id);
        },
      };
    },

    publish(frame, tenantId) {
      publishTo(tenantId, frame);
    },

    beat() {
      for (const [id, entry] of clients) {
        try {
          entry.sink.write(SSE_HEARTBEAT);
        } catch (err) {
          deps.logger.warn({ err, clientId: id }, 'SSE heartbeat failed; dropping client');
          detach(id);
        }
      }
    },

    closeAll(reason) {
      // `stream.closing` is in the closed catalog precisely so a client can tell "the server
      // is going away" apart from "your network died", and stop reconnecting on the former.
      for (const tenantId of new Set([...clients.values()].map((e) => e.registration.tenantId))) {
        closeTenant(tenantId, reason);
      }
    },

    closeTenant,

    connectionCount() {
      return clients.size;
    },

    subscriberCount(tenantId, runId) {
      const set = watchers.get(runId);
      if (set === undefined) return 0;

      let count = 0;
      for (const id of set) {
        if (clients.get(id)?.registration.tenantId === tenantId) count += 1;
      }
      return count;
    },
  };
}
