import { ApiError } from '@nexs/shared';

/**
 * [gap #22 / C1] The stdio concurrency cap.
 *
 * Every stdio MCP server is a child process. A tenant that registers forty of them must not
 * be able to start forty processes at once — the box would swap, and a single tenant's
 * misconfiguration would take every other tenant's runs down with it. The documented policy
 * is "cap concurrent stdio servers (e.g. 10) + queue the rest", so the eleventh `connect`
 * waits rather than fails: a queue is recoverable, a rejection is a support ticket.
 *
 * HTTP servers are deliberately not counted. They hold a socket, not a pid, and the thing
 * this bounds is process count.
 */
export class Semaphore {
  private permits: number;
  private held = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new ApiError('VALIDATION_ERROR', 'Semaphore capacity must be a positive integer', {
        capacity,
      });
    }
    this.permits = capacity;
  }

  get total(): number {
    return this.capacity;
  }

  /** Permits currently handed out, i.e. stdio servers running. */
  get inUse(): number {
    return this.held;
  }

  /** Callers parked waiting for a permit. */
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Take a permit, waiting if necessary. Resolves with the release function.
   *
   * The release is idempotent on purpose: `openSession` releases from a `catch` *and* from
   * a crash handler, and a double release would silently inflate the permit count, letting
   * the cap drift upwards one leak at a time until it stops bounding anything.
   */
  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits -= 1;
      this.held += 1;
      return this.makeRelease();
    }

    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        // The permit is transferred, not re-created: `release` decided to hand this slot
        // straight to the next waiter instead of returning it to the pool, so `permits`
        // is already correct and only the bookkeeping changes.
        this.held += 1;
        resolve(this.makeRelease());
      });
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held -= 1;

      const next = this.waiters.shift();
      if (next === undefined) {
        this.permits += 1;
        return;
      }
      next();
    };
  }
}
