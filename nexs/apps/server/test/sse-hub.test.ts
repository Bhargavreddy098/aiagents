import { describe, expect, it } from 'vitest';
import pino from 'pino';
import type { SseFrame, SSEEventName, SsePayload } from '@nexs/shared';
import { createSseHub, type SseHub, type SseSink } from '../src/services/sse/sse-hub.js';

/**
 * The live transport.
 *
 * The hub is the one place where a mistake leaks one tenant's run output into another
 * tenant's browser, so the tenancy test is the important one here — the rest are about the
 * two failure modes that make SSE rot in production: connections that are never removed, and
 * a single dead socket that breaks the fan-out for everybody.
 */

const logger = pino({ level: 'silent' });
const TENANT_A = 'tnt_a';
const TENANT_B = 'tnt_b';

/** A sink that records what it was written, and can be made to fail on demand. */
class RecordingSink implements SseSink {
  readonly chunks: string[] = [];
  ended = false;
  /** When set, every `write` throws — a socket that died without firing `close`. */
  failWrites = false;

  write(chunk: string): void {
    if (this.failWrites) throw new Error('socket is gone');
    this.chunks.push(chunk);
  }

  end(): void {
    this.ended = true;
  }

  /** Every frame name written, in order — heartbeats and comments excluded. */
  get events(): string[] {
    return this.chunks
      .map((c) => /^event: (.+)$/m.exec(c)?.[1])
      .filter((name): name is string => name !== undefined);
  }

  get ids(): string[] {
    return this.chunks
      .map((c) => /^id: (.+)$/m.exec(c)?.[1])
      .filter((id): id is string => id !== undefined);
  }
}

function makeHub(overrides: Partial<Parameters<typeof createSseHub>[0]> = {}): {
  hub: SseHub;
  unwatched: Array<{ tenantId: string; runId: string }>;
} {
  const unwatched: Array<{ tenantId: string; runId: string }> = [];
  let counter = 0;

  const hub = createSseHub({
    logger,
    maxConnectionsPerIp: 3,
    // Deterministic ids so the "same id for every client" assertion is readable.
    newEventId: () => `evt_${(counter += 1)}`,
    onRunUnwatched: (tenantId, runId) => unwatched.push({ tenantId, runId }),
    ...overrides,
  });

  return { hub, unwatched };
}

const frame = <N extends SSEEventName>(name: N, payload: SsePayload<N>): SseFrame<N> => ({
  name,
  payload,
});

describe('SseHub — tenant isolation', () => {
  it('delivers a frame only to clients of the publishing tenant', () => {
    const { hub } = makeHub();
    const a = new RecordingSink();
    const b = new RecordingSink();

    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, a);
    hub.attach({ tenantId: TENANT_B, userId: 'u2', ip: '10.0.0.2' }, b);

    hub.publish(frame('run.started', { runId: 'run_1' }), TENANT_A);

    expect(a.events).toEqual(['run.started']);
    // The whole point: B must see nothing, even though it is connected to the same hub.
    expect(b.events).toEqual([]);
    expect(b.chunks).toEqual([]);
  });

  it('delivers to every client of the tenant, not just the first', () => {
    const { hub } = makeHub();
    const one = new RecordingSink();
    const two = new RecordingSink();

    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, one);
    hub.attach({ tenantId: TENANT_A, userId: 'u2', ip: '10.0.0.2' }, two);

    hub.publish(frame('run.started', { runId: 'run_1' }), TENANT_A);

    expect(one.events).toEqual(['run.started']);
    expect(two.events).toEqual(['run.started']);
  });

  it('stops delivering to a tenant after closeTenant', () => {
    const { hub } = makeHub();
    const a = new RecordingSink();
    const b = new RecordingSink();

    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, a);
    hub.attach({ tenantId: TENANT_B, userId: 'u2', ip: '10.0.0.2' }, b);

    hub.closeTenant(TENANT_A, 'session_revoked');

    expect(a.ended).toBe(true);
    expect(a.events).toEqual(['stream.closing']);
    // Closing one tenant must not touch another — the failure here would be a global outage
    // caused by one tenant's session being revoked.
    expect(b.ended).toBe(false);
    expect(b.events).toEqual([]);
    expect(hub.connectionCount()).toBe(1);
  });
});

describe('SseHub — event ids', () => {
  it('writes an id on every frame', () => {
    const { hub } = makeHub();
    const sink = new RecordingSink();
    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, sink);

    hub.publish(frame('run.started', { runId: 'run_1' }), TENANT_A);
    hub.publish(frame('run.completed', { runId: 'run_1' }), TENANT_A);

    expect(sink.ids).toEqual(['evt_1', 'evt_2']);
  });

  it('gives every client of a tenant the SAME id for one frame', () => {
    // This is what makes the id usable as a resume token. Minting per-client ids would mean
    // two clients disagreeing about the identity of the same event, so neither could use it
    // to say "I have seen up to here".
    const { hub } = makeHub();
    const one = new RecordingSink();
    const two = new RecordingSink();

    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, one);
    hub.attach({ tenantId: TENANT_A, userId: 'u2', ip: '10.0.0.2' }, two);

    hub.publish(frame('run.started', { runId: 'run_1' }), TENANT_A);

    expect(one.ids).toEqual(['evt_1']);
    expect(two.ids).toEqual(['evt_1']);
  });
});

describe('SseHub — heartbeats', () => {
  it('writes a ping comment to every client regardless of tenant', () => {
    const { hub } = makeHub();
    const a = new RecordingSink();
    const b = new RecordingSink();

    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, a);
    hub.attach({ tenantId: TENANT_B, userId: 'u2', ip: '10.0.0.2' }, b);

    hub.beat();

    expect(a.chunks).toEqual([': ping\n\n']);
    expect(b.chunks).toEqual([': ping\n\n']);
    // A heartbeat is a comment, not an event: it must not appear as one, or a client's
    // event dispatch would fire on every ping.
    expect(a.events).toEqual([]);
  });
});

describe('SseHub — dead clients', () => {
  it('drops a client whose write throws, without breaking the others', () => {
    const { hub } = makeHub();
    const dead = new RecordingSink();
    const alive = new RecordingSink();

    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, dead);
    hub.attach({ tenantId: TENANT_A, userId: 'u2', ip: '10.0.0.2' }, alive);

    dead.failWrites = true;
    hub.publish(frame('run.started', { runId: 'run_1' }), TENANT_A);

    expect(hub.connectionCount()).toBe(1);
    expect(alive.events).toEqual(['run.started']);

    // And the next publish does not even try the dead one.
    hub.publish(frame('run.completed', { runId: 'run_1' }), TENANT_A);
    expect(alive.events).toEqual(['run.started', 'run.completed']);
  });

  it('frees the IP slot when a failing client is dropped', () => {
    // Without this the cap would be a slow leak: every dead socket would hold its slot
    // forever and the address would eventually be locked out of reconnecting.
    const { hub } = makeHub({ maxConnectionsPerIp: 1 });
    const dead = new RecordingSink();

    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, dead);
    dead.failWrites = true;
    hub.publish(frame('run.started', { runId: 'run_1' }), TENANT_A);

    const fresh = new RecordingSink();
    expect(() =>
      hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, fresh),
    ).not.toThrow();
  });
});

describe('SseHub — detach', () => {
  it('is idempotent', () => {
    const { hub } = makeHub({ maxConnectionsPerIp: 1 });
    const sink = new RecordingSink();

    const { detach } = hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, sink);
    detach();
    detach(); // `res.on('close')` firing after an explicit detach

    expect(hub.connectionCount()).toBe(0);

    // If the second detach decremented again, the count would go negative and this would
    // still succeed — so assert the positive direction too: a *new* connection fits, and
    // then the cap applies again.
    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, new RecordingSink());
    expect(() =>
      hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, new RecordingSink()),
    ).toThrow(/Too many open streams/);
  });

  it('stops delivering after detach', () => {
    const { hub } = makeHub();
    const sink = new RecordingSink();

    const { detach } = hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, sink);
    detach();
    hub.publish(frame('run.started', { runId: 'run_1' }), TENANT_A);

    expect(sink.events).toEqual([]);
  });
});

describe('SseHub — connection cap', () => {
  it('refuses the connection past the cap with RATE_LIMITED', () => {
    const { hub } = makeHub({ maxConnectionsPerIp: 2 });
    const ip = '10.0.0.9';

    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip }, new RecordingSink());
    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip }, new RecordingSink());

    expect(() => hub.attach({ tenantId: TENANT_A, userId: 'u1', ip }, new RecordingSink())).toThrow(
      /Too many open streams/,
    );
  });

  it('carries the RATE_LIMITED code so the route can answer 429', () => {
    const { hub } = makeHub({ maxConnectionsPerIp: 1 });
    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.9' }, new RecordingSink());

    let caught: unknown;
    try {
      hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.9' }, new RecordingSink());
    } catch (err) {
      caught = err;
    }

    // The route maps this code to 429, so the code itself is the contract — not the message.
    expect((caught as { code?: string } | undefined)?.code).toBe('RATE_LIMITED');
  });

  it('counts per address, not globally', () => {
    const { hub } = makeHub({ maxConnectionsPerIp: 1 });

    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, new RecordingSink());
    // A second address must be unaffected: a global cap would turn one busy client into an
    // outage for everyone else.
    expect(() =>
      hub.attach({ tenantId: TENANT_A, userId: 'u2', ip: '10.0.0.2' }, new RecordingSink()),
    ).not.toThrow();
  });
});

describe('SseHub — run watchers', () => {
  it('counts only the clients of the given tenant', () => {
    const { hub } = makeHub();

    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1', runId: 'run_1' }, new RecordingSink());
    hub.attach({ tenantId: TENANT_A, userId: 'u2', ip: '10.0.0.2', runId: 'run_1' }, new RecordingSink());

    expect(hub.subscriberCount(TENANT_A, 'run_1')).toBe(2);
    // A different tenant cannot even ask about this run meaningfully.
    expect(hub.subscriberCount(TENANT_B, 'run_1')).toBe(0);
    expect(hub.subscriberCount(TENANT_A, 'run_other')).toBe(0);
  });

  it('does not count a client that is not tailing a run', () => {
    const { hub } = makeHub();
    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, new RecordingSink());

    expect(hub.subscriberCount(TENANT_A, 'run_1')).toBe(0);
  });

  it('fires onRunUnwatched only when the LAST watcher leaves', () => {
    const { hub, unwatched } = makeHub();

    const one = hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1', runId: 'run_1' }, new RecordingSink());
    const two = hub.attach({ tenantId: TENANT_A, userId: 'u2', ip: '10.0.0.2', runId: 'run_1' }, new RecordingSink());

    one.detach();
    // One watcher remains, so the run is still being watched — aborting here would cut off
    // the answer of a user who is still looking at it.
    expect(unwatched).toEqual([]);

    two.detach();
    expect(unwatched).toEqual([{ tenantId: TENANT_A, runId: 'run_1' }]);
  });

  it('does not fire for a client that was never tailing a run', () => {
    const { hub, unwatched } = makeHub();
    const { detach } = hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, new RecordingSink());

    detach();
    expect(unwatched).toEqual([]);
  });

  it('does not fire twice for a repeated detach', () => {
    const { hub, unwatched } = makeHub();
    const { detach } = hub.attach(
      { tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1', runId: 'run_1' },
      new RecordingSink(),
    );

    detach();
    detach();
    expect(unwatched).toHaveLength(1);
  });

  it('fires again when a new watcher arrives and then leaves', () => {
    // A user who reconnects and then closes the tab a second time must abort the second
    // generation too. A `Set` that was never cleaned up would swallow this.
    const { hub, unwatched } = makeHub();

    const first = hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1', runId: 'run_1' }, new RecordingSink());
    first.detach();

    const second = hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1', runId: 'run_1' }, new RecordingSink());
    second.detach();

    expect(unwatched).toEqual([
      { tenantId: TENANT_A, runId: 'run_1' },
      { tenantId: TENANT_A, runId: 'run_1' },
    ]);
  });

  it('treats two different runs as independent', () => {
    const { hub, unwatched } = makeHub();

    const one = hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1', runId: 'run_1' }, new RecordingSink());
    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1', runId: 'run_2' }, new RecordingSink());

    one.detach();
    expect(unwatched).toEqual([{ tenantId: TENANT_A, runId: 'run_1' }]);
    expect(hub.subscriberCount(TENANT_A, 'run_2')).toBe(1);
  });
});

describe('SseHub — shutdown', () => {
  it('emits stream.closing to every client and empties the registry', () => {
    const { hub } = makeHub();
    const a = new RecordingSink();
    const b = new RecordingSink();

    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1' }, a);
    hub.attach({ tenantId: TENANT_B, userId: 'u2', ip: '10.0.0.2' }, b);

    hub.closeAll('server_shutdown');

    expect(a.events).toEqual(['stream.closing']);
    expect(b.events).toEqual(['stream.closing']);
    expect(a.ended).toBe(true);
    expect(b.ended).toBe(true);
    expect(hub.connectionCount()).toBe(0);
  });

  it('fires onRunUnwatched for a run whose watcher is closed by shutdown', () => {
    // Otherwise a chat run whose client was disconnected by a deploy would never be
    // finalized, and would sit `running` until the reaper found it.
    const { hub, unwatched } = makeHub();
    hub.attach({ tenantId: TENANT_A, userId: 'u1', ip: '10.0.0.1', runId: 'run_1' }, new RecordingSink());

    hub.closeAll('server_shutdown');
    expect(unwatched).toEqual([{ tenantId: TENANT_A, runId: 'run_1' }]);
  });
});
