/**
 * Small async helpers shared by the service test harnesses.
 *
 * `flush` is the one that matters: several of the manager tests assert on what has *not*
 * happened yet — an action still queued, a child not yet spawned — and a bare
 * `await Promise.resolve()` only drains one microtask, which is not enough to prove that
 * something will not happen.
 */

/** A promise plus its resolver, for tests that need to hold a step open. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every pending microtask and one macrotask settle. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
