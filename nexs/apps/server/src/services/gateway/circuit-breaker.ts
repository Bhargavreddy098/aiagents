export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker. */
  failureThreshold: number;
  /** How long the breaker stays open before one trial request is allowed through. */
  openMs: number;
  /** Injectable clock so tests do not have to sleep. */
  now?: () => number;
}

interface Entry {
  failures: number;
  openedAt: number | null;
  trialInFlight: boolean;
}

/**
 * A per-provider circuit breaker.
 *
 * Without one, a provider that is down turns every request in the tenant's queue into
 * a slow failure plus its retries — the outage spreads to the whole worker pool. With
 * one, the first few failures trip the breaker and subsequent requests fail fast and
 * move straight to the fallback.
 *
 * One key per provider (not per model): a provider is down for all its models at once,
 * and per-model keys would let N models each rediscover the same outage.
 */
export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  private entry(key: string): Entry {
    let found = this.entries.get(key);
    if (found === undefined) {
      found = { failures: 0, openedAt: null, trialInFlight: false };
      this.entries.set(key, found);
    }
    return found;
  }

  state(key: string): CircuitState {
    const entry = this.entry(key);
    if (entry.openedAt === null) return 'closed';
    return this.now() - entry.openedAt >= this.options.openMs ? 'half_open' : 'open';
  }

  /**
   * Reserve the right to make one request. Returns false when the call must not be
   * attempted at all — the caller should go straight to the fallback.
   */
  tryAcquire(key: string): boolean {
    const entry = this.entry(key);

    if (entry.openedAt === null) return true;
    if (this.now() - entry.openedAt < this.options.openMs) return false;

    // Half-open: exactly one trial gets through, so a recovering provider is probed
    // rather than hammered.
    if (entry.trialInFlight) return false;
    entry.trialInFlight = true;
    return true;
  }

  onSuccess(key: string): void {
    const entry = this.entry(key);
    entry.failures = 0;
    entry.openedAt = null;
    entry.trialInFlight = false;
  }

  onFailure(key: string): void {
    const entry = this.entry(key);
    entry.trialInFlight = false;
    entry.failures += 1;

    // A failed trial re-opens immediately and restarts the cooldown. Waiting for the
    // threshold again would mean probing a still-broken provider on every request.
    if (entry.openedAt !== null || entry.failures >= this.options.failureThreshold) {
      entry.openedAt = this.now();
    }
  }

  /** For the health dashboard and for tests. */
  snapshot(): Record<string, { state: CircuitState; failures: number }> {
    const out: Record<string, { state: CircuitState; failures: number }> = {};
    for (const [key, entry] of this.entries) {
      out[key] = { state: this.state(key), failures: entry.failures };
    }
    return out;
  }

  reset(key?: string): void {
    if (key === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(key);
  }
}
