import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@nexs/shared';
import { CircuitBreaker } from '../src/services/gateway/circuit-breaker.js';
import {
  DEFAULT_RETRY_POLICY,
  backoffDelay,
  nextDelay,
  parseRetryAfter,
} from '../src/services/gateway/retry.js';
import {
  createHarness,
  jsonResponse,
  openAiChatBody,
  type Harness,
} from './helpers/gateway-harness.js';

/**
 * Retry timing and provider health.
 *
 * These are the two mechanisms that decide whether a provider outage costs one slow
 * request or takes the whole worker pool down with it, so the assertions are about
 * exact numbers rather than "it eventually worked".
 */

const A = 'https://a.test/v1';
const B = 'https://b.test/v1';

let harness: Harness;

beforeEach(() => {
  harness = createHarness({ failureThreshold: 3, openMs: 30_000 });
});

function ask(modelId: string): Promise<unknown> {
  return harness.gateway
    .chat({ tenantId: 'tnt_test', modelId, messages: [{ role: 'user', content: 'hi' }] })
    .catch((e: unknown) => e);
}

function hits(base: string): number {
  return harness.calls.filter((call) => call.url.startsWith(base)).length;
}

// ── Retry-After parsing ───────────────────────────────────────────────────────

describe('parseRetryAfter', () => {
  const at = Date.parse('2026-01-01T00:00:00.000Z');

  it('reads the delta-seconds form', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter(' 5 ')).toBe(5_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('reads the HTTP-date form relative to now', () => {
    const header = new Date(at + 12_000).toUTCString();
    expect(parseRetryAfter(header, at)).toBe(12_000);
  });

  it('clamps a date that is already in the past to zero', () => {
    const header = new Date(at - 60_000).toUTCString();
    expect(parseRetryAfter(header, at)).toBe(0);
  });

  it('caps an absurd value so one bad header cannot park a worker forever', () => {
    expect(parseRetryAfter('999999')).toBe(60_000);
    const farFuture = new Date(at + 3_600_000).toUTCString();
    expect(parseRetryAfter(farFuture, at)).toBe(60_000);
  });

  it('returns null when there is nothing usable', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

// ── backoff ───────────────────────────────────────────────────────────────────

describe('backoffDelay', () => {
  it('doubles with each attempt and never exceeds the ceiling', () => {
    const mid = (): number => 0.5;
    // Half the window is the floor, so the midpoint is three quarters of it.
    expect(backoffDelay(1, 100, 10_000, mid)).toBe(75);
    expect(backoffDelay(2, 100, 10_000, mid)).toBe(150);
    expect(backoffDelay(3, 100, 10_000, mid)).toBe(300);
    expect(backoffDelay(9, 100, 10_000, mid)).toBe(7_500);
  });

  it('keeps a floor so a batch of workers does not retry in the same millisecond', () => {
    // Even with the most unfavourable jitter the delay is never near zero.
    expect(backoffDelay(3, 100, 10_000, () => 0)).toBe(200);
    expect(backoffDelay(3, 100, 10_000, () => 0.999)).toBeLessThanOrEqual(400);
  });
});

describe('nextDelay', () => {
  it('gives up once the attempts are spent', () => {
    const policy = { maxAttempts: 3, baseMs: 100, maxMs: 1_000 };
    expect(nextDelay(policy, { attempt: 3, retryAfterMs: null, waitedMs: 0 })).toBeNull();
    expect(nextDelay(policy, { attempt: 4, retryAfterMs: null, waitedMs: 0 })).toBeNull();
  });

  it('honours Retry-After over the computed backoff, unclamped by maxMs', () => {
    // This is the whole point: retrying before the provider asked just earns another
    // 429 and burns an attempt. The 1 s ceiling must not win over a 30 s instruction.
    const policy = { maxAttempts: 3, baseMs: 100, maxMs: 1_000 };

    expect(nextDelay(policy, { attempt: 1, retryAfterMs: 30_000, waitedMs: 0 }, () => 0.5)).toBe(
      30_000,
    );
    expect(30_000).toBeGreaterThan(policy.maxMs);
  });

  it('falls back to exponential backoff when the provider said nothing', () => {
    expect(
      nextDelay(DEFAULT_RETRY_POLICY, { attempt: 1, retryAfterMs: null, waitedMs: 0 }),
    ).toBeGreaterThan(0);
  });
});

// ── the gateway's use of them ─────────────────────────────────────────────────

async function seedSolo(): Promise<{ providerId: string; modelId: string }> {
  const provider = await harness.seedProvider({ slug: 'a', type: 'openai', baseUrl: A });
  const model = await harness.seedModel({ providerId: provider.id, externalModelId: 'gpt-4o' });
  return { providerId: provider.id, modelId: model.id };
}

describe('retrying a provider call', () => {
  it('retries a 429 after exactly the delay the provider asked for', async () => {
    const { modelId } = await seedSolo();

    let attempt = 0;
    harness.onFetch(() => {
      attempt += 1;
      if (attempt === 1) {
        return jsonResponse(
          { error: { message: 'rate limited' } },
          { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' } },
        );
      }
      return jsonResponse(openAiChatBody({ content: 'served on the second try' }));
    });

    const result = (await ask(modelId)) as { content: string };

    expect(result.content).toBe('served on the second try');
    expect(harness.calls).toHaveLength(2);
    // 30 000, not the 1 000 ms ceiling the harness configured.
    expect(harness.sleeps).toEqual([30_000]);
  });

  it('uses exponential backoff when no Retry-After is offered', async () => {
    const { modelId } = await seedSolo();
    harness.onFetch(() => jsonResponse({}, { status: 503 }));

    const error = (await ask(modelId)) as ApiError;

    expect(error.code).toBe('GATEWAY_FALLBACK_EXHAUSTED');
    // maxAttempts 3 → three calls, two waits: 100 ms and 200 ms windows at the midpoint.
    expect(harness.calls).toHaveLength(3);
    expect(harness.sleeps).toEqual([75, 150]);
  });

  it('does not retry a request the provider rejected as malformed', async () => {
    const { modelId } = await seedSolo();
    harness.onFetch(() =>
      jsonResponse({ error: { message: 'unknown parameter "foo"' } }, { status: 400 }),
    );

    await ask(modelId);

    // A 400 will be a 400 again; retrying it only delays the error the caller needs.
    expect(harness.calls).toHaveLength(1);
    expect(harness.sleeps).toEqual([]);
  });

  it('does not retry a bad credential', async () => {
    const { modelId } = await seedSolo();
    harness.onFetch(() => jsonResponse({ error: 'invalid api key' }, { status: 401 }));

    await ask(modelId);

    expect(harness.calls).toHaveLength(1);
    expect(harness.sleeps).toEqual([]);
  });

  it('gives up after maxAttempts and lets the chain move on', async () => {
    const pA = await harness.seedProvider({ slug: 'a', type: 'openai', baseUrl: A });
    const pB = await harness.seedProvider({ slug: 'b', type: 'groq', baseUrl: B });
    const a = await harness.seedModel({ providerId: pA.id, externalModelId: 'm-a' });
    await harness.seedModel({ providerId: pB.id, externalModelId: 'm-b', fallbackOf: a.id });

    harness.onFetch((call) =>
      call.url.startsWith(A)
        ? jsonResponse({}, { status: 503 })
        : jsonResponse(openAiChatBody({ content: 'fallback' })),
    );

    const result = (await ask(a.id)) as { content: string; attempted: string[] };

    expect(result.content).toBe('fallback');
    // Three attempts on A, then one on B.
    expect(hits(A)).toBe(3);
    expect(hits(B)).toBe(1);
    expect(result.attempted).toHaveLength(2);
  });

  it('honours a Retry-After longer than the backoff ceiling every time it is offered', async () => {
    const { modelId } = await seedSolo();

    let attempt = 0;
    harness.onFetch(() => {
      attempt += 1;
      return attempt <= 2
        ? jsonResponse({}, { status: 429, headers: { 'retry-after': '45' } })
        : jsonResponse(openAiChatBody({ content: 'third' }));
    });

    const result = (await ask(modelId)) as { content: string };

    expect(result.content).toBe('third');
    expect(harness.sleeps).toEqual([45_000, 45_000]);
  });
});

// ── circuit breaker, in isolation ─────────────────────────────────────────────

describe('CircuitBreaker', () => {
  /** A breaker plus the only handle on its clock, so tests can move time forward. */
  function make(): { cb: CircuitBreaker; advance: (ms: number) => void } {
    let clock = 0;
    return {
      cb: new CircuitBreaker({ failureThreshold: 3, openMs: 30_000, now: () => clock }),
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it('stays closed below the threshold and opens at it', () => {
    const { cb } = make();
    expect(cb.state('p')).toBe('closed');

    cb.onFailure('p');
    cb.onFailure('p');
    expect(cb.state('p')).toBe('closed');

    cb.onFailure('p');
    expect(cb.state('p')).toBe('open');
  });

  it('refuses every request while open', () => {
    const { cb } = make();
    for (let i = 0; i < 3; i += 1) cb.onFailure('p');

    expect(cb.tryAcquire('p')).toBe(false);
    expect(cb.tryAcquire('p')).toBe(false);
  });

  it('lets exactly one trial through once the cooldown elapses', () => {
    const { cb, advance } = make();
    for (let i = 0; i < 3; i += 1) cb.onFailure('p');

    advance(30_000);
    expect(cb.state('p')).toBe('half_open');

    // One probe, not a stampede — otherwise a recovering provider is hit by every queued
    // request at once and falls over again.
    expect(cb.tryAcquire('p')).toBe(true);
    expect(cb.tryAcquire('p')).toBe(false);
  });

  it('closes on a successful trial', () => {
    const { cb, advance } = make();
    for (let i = 0; i < 3; i += 1) cb.onFailure('p');
    advance(30_000);

    cb.tryAcquire('p');
    cb.onSuccess('p');

    expect(cb.state('p')).toBe('closed');
    expect(cb.tryAcquire('p')).toBe(true);
  });

  it('re-opens immediately when the trial fails, and restarts the cooldown', () => {
    const { cb, advance } = make();
    for (let i = 0; i < 3; i += 1) cb.onFailure('p');
    advance(30_000);

    cb.tryAcquire('p');
    cb.onFailure('p');

    // Waiting for three more failures would probe a still-broken provider every request.
    expect(cb.state('p')).toBe('open');
    advance(29_999);
    expect(cb.state('p')).toBe('open');
    advance(1);
    expect(cb.state('p')).toBe('half_open');
  });

  it('tracks each provider separately', () => {
    const { cb } = make();
    for (let i = 0; i < 3; i += 1) cb.onFailure('a');

    expect(cb.state('a')).toBe('open');
    expect(cb.state('b')).toBe('closed');
    expect(cb.tryAcquire('b')).toBe(true);
  });

  it('reports a snapshot for the health dashboard', () => {
    const { cb } = make();
    cb.onFailure('a');
    expect(cb.snapshot()).toEqual({ a: { state: 'closed', failures: 1 } });
  });
});

// ── circuit breaker, driven by real calls ─────────────────────────────────────

describe('ModelGateway and the circuit breaker', () => {
  it('opens after N consecutive failing calls and then fails fast', async () => {
    const { providerId, modelId } = await seedSolo();
    harness.onFetch(() => jsonResponse({}, { status: 503 }));

    for (let i = 0; i < 3; i += 1) await ask(modelId);

    expect(harness.breaker.state(providerId)).toBe('open');
    // Three calls, three retry attempts each.
    const callsWhileOpen = harness.calls.length;
    expect(callsWhileOpen).toBe(9);

    const error = (await ask(modelId)) as ApiError;

    // The candidate was skipped without touching the network...
    expect(harness.calls).toHaveLength(callsWhileOpen);
    // ...and the caller is told the model is unavailable, not that the chain ran out.
    expect(error.code).toBe('MODEL_UNAVAILABLE');
  });

  it('probes once after the cooldown and closes when the provider recovers', async () => {
    const { providerId, modelId } = await seedSolo();

    let healthy = false;
    harness.onFetch(() =>
      healthy
        ? jsonResponse(openAiChatBody({ content: 'recovered' }))
        : jsonResponse({}, { status: 503 }),
    );

    for (let i = 0; i < 3; i += 1) await ask(modelId);
    expect(harness.breaker.state(providerId)).toBe('open');

    healthy = true;
    harness.advance(30_000);
    expect(harness.breaker.state(providerId)).toBe('half_open');

    const result = (await ask(modelId)) as { content: string };

    expect(result.content).toBe('recovered');
    expect(harness.breaker.state(providerId)).toBe('closed');
  });

  it('re-opens when the probe fails', async () => {
    const { providerId, modelId } = await seedSolo();
    harness.onFetch(() => jsonResponse({}, { status: 503 }));

    for (let i = 0; i < 3; i += 1) await ask(modelId);

    harness.advance(30_000);
    await ask(modelId);

    expect(harness.breaker.state(providerId)).toBe('open');
  });

  it('does not open the circuit for a request the provider rejected on its merits', async () => {
    const { providerId, modelId } = await seedSolo();
    harness.onFetch(() => jsonResponse({ error: { message: 'bad schema' } }, { status: 400 }));

    for (let i = 0; i < 5; i += 1) await ask(modelId);

    // A malformed request from one caller must not take the provider away from everyone
    // else in the tenant.
    expect(harness.breaker.state(providerId)).toBe('closed');
    expect(harness.breaker.snapshot()[providerId]!.failures).toBe(0);
  });

  it('counts an auth failure toward the circuit even though it is never retried', async () => {
    const { providerId, modelId } = await seedSolo();
    harness.onFetch(() => jsonResponse({ error: 'bad key' }, { status: 401 }));

    for (let i = 0; i < 3; i += 1) await ask(modelId);

    // One call per attempt — not retried — but the credential is plainly wrong, so the
    // provider is unhealthy and the breaker should say so.
    expect(harness.calls).toHaveLength(3);
    expect(harness.breaker.state(providerId)).toBe('open');
  });
});
