/**
 * The worker's reconnect backoff.
 *
 * Only the delay curve is tested here, and that is a deliberate boundary rather than a gap.
 * The worker's *cancellation* path cannot be exercised on this machine: on win32, Git Bash
 * `kill -TERM`/`-INT` does not deliver a POSIX signal to a Node process at all, so a
 * SIGTERM handler never fires. Verified directly — a script with both handlers ran on
 * unbothered. Asserting a passing shutdown test here would be asserting something that was
 * never executed, so the shutdown is verified by inspection against `server.ts`, which
 * already ships the same pattern.
 *
 * What *is* verifiable is the curve, and it is worth testing: an off-by-one makes the first
 * retry instantaneous (hammering a database that is still coming up), and a missing cap
 * turns a long outage into a hot loop against a server that is refusing connections.
 */
import { describe, expect, it } from 'vitest';
import { RETRY_BASE_MS, RETRY_CAP_MS, retryDelayMs } from '../src/worker/index.js';

describe('worker: reconnect backoff', () => {
  it('starts at the base interval and doubles', () => {
    expect(retryDelayMs(1)).toBe(1_000);
    expect(retryDelayMs(2)).toBe(2_000);
    expect(retryDelayMs(3)).toBe(4_000);
    expect(retryDelayMs(4)).toBe(8_000);
    expect(retryDelayMs(5)).toBe(16_000);
  });

  it('never fires a retry with no delay', () => {
    // The 1-based indexing is the whole point: a first retry of zero would make the loop
    // spin against a database that has not finished starting.
    expect(retryDelayMs(1)).toBeGreaterThan(0);
  });

  it('caps at the ceiling instead of growing without bound', () => {
    expect(retryDelayMs(6)).toBe(RETRY_CAP_MS);
    expect(retryDelayMs(50)).toBe(RETRY_CAP_MS);
    expect(retryDelayMs(1_000)).toBe(RETRY_CAP_MS);
  });

  it('keeps the cap at or above the base', () => {
    // A cap below the base would make `min` return the cap for every attempt, silently
    // flattening the curve into a fixed interval.
    expect(RETRY_CAP_MS).toBeGreaterThanOrEqual(RETRY_BASE_MS);
  });
});
