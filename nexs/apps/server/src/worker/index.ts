/**
 * Worker entrypoint — the spec's second process (§2: "one codebase, two entrypoints").
 *
 * Runs the pg-boss consumers and nothing else: no HTTP listener, no SSE hub. In
 * development `WORKER_ENABLED=true` makes the API process consume too, so this file is
 * optional; in production it is the process that scales independently of request traffic.
 *
 * ## Why a run that arrives here is safe to execute
 *
 * The engine claims a run with a compare-and-swap on its status, so a job delivered twice
 * — by a retry, or by a duplicate producer — is a no-op rather than a second execution.
 * That is what makes it correct for *both* entrypoints to consume the same queue, which is
 * exactly what `WORKER_ENABLED=true` does.
 *
 * ## Why this worker retries instead of exiting when the queue is unavailable
 *
 * A worker has **no HTTP listener and, in a degraded state, no consumer** — so it holds no
 * handle that keeps Node's event loop alive. When the queue connection fails, the process
 * simply runs out of work and exits *cleanly*, with nothing in the logs but the startup
 * error. That is the worst possible failure for a background process: a transient database
 * restart permanently kills the worker until a human notices and restarts it, and the
 * spec's own crash-recovery test ("kill worker, restart, assert resume") depends on a
 * worker that comes back on its own.
 *
 * So the connection is retried with exponential backoff, and the retry timer itself is the
 * handle that keeps the process alive. Shutdown cancels the wait — a SIGTERM during a
 * backoff pause must not be held for the full delay.
 *
 * ## Shutdown
 *
 * The queue stops without waiting for in-flight jobs (`graceful: false`). A run
 * interrupted mid-step is recovered from its checkpoint by the next process, and waiting
 * is what makes a SIGTERM miss its deadline and force an exit. The engine's own
 * crash-recovery contract is what makes this the safe direction.
 */
import { wireRuntime } from '../runtime.js';

/** First retry waits one interval; each subsequent one doubles. */
export const RETRY_BASE_MS = 1_000;
/** Ceiling, so a long outage does not become a hot loop against a refusing server. */
export const RETRY_CAP_MS = 30_000;

/**
 * Backoff for the `attempt`-th retry — 1s, 2s, 4s, 8s, 16s, then 30s forever.
 *
 * Exported because it is the one part of this entrypoint that can be verified on a machine
 * where POSIX signals do not reach Node (see the note on platform limits in the project
 * memory): the loop's *shape* is testable even though its cancellation is not.
 *
 * `attempt` is 1-based, so the first retry waits one base interval rather than firing
 * immediately — a zero-delay first retry would hammer a database that is still starting up.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
}

async function main(): Promise<void> {
  const runtime = await wireRuntime();
  const { logger, config, db, queue } = runtime;

  logger.info(
    { workerEnabled: config.WORKER_ENABLED, schema: config.PGBOSS_SCHEMA },
    'nexs worker started',
  );

  let shuttingDown = false;
  let retryTimer: NodeJS.Timeout | undefined;

  /**
   * Re-attempt the queue connection until it succeeds or the process is shutting down.
   *
   * `wireRuntime` already made one attempt; this is the recovery path for when that one
   * failed while the rest of the composition succeeded.
   */
  const reconnectUntilUp = async (): Promise<void> => {
    let attempt = 1;
    while (!shuttingDown && !queue.connected) {
      await new Promise<void>((resolve) => {
        retryTimer = setTimeout(resolve, retryDelayMs(attempt));
        // Deliberately NOT unref'd: while the queue is down this timer is the only handle
        // keeping the process alive. Unref'ing it would let Node exit — the exact bug this
        // loop exists to prevent.
      });
      if (shuttingDown) return;

      try {
        await queue.start();
        await queue.scheduleRecurringSweeps().catch((err: unknown) => {
          logger.warn({ err }, 'could not schedule the recurring approval sweep; continuing');
        });
        logger.info({ attempt }, 'worker reconnected to the queue');
        return;
      } catch (err) {
        // `stop()` is a no-op when nothing opened, and closes a half-open pool from a
        // partial start, so a failed retry does not accumulate connections.
        await queue.stop().catch(() => {
          // Nothing to add: the attempt already failed, and the next iteration re-runs
          // `start()`, which is the only path that can make progress.
        });
        logger.error(
          { err, attempt, retryInMs: retryDelayMs(attempt + 1) },
          'queue still unavailable; the worker will keep retrying',
        );
        attempt += 1;
      }
    }
  };

  if (!queue.connected) {
    logger.warn('worker started without a queue connection; retrying in the background');
    void reconnectUntilUp();
  }

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');

    const force = setTimeout(() => {
      logger.error('worker shutdown timed out, forcing exit');
      process.exit(1);
    }, 30_000);
    force.unref();

    // Released so a SIGTERM during a backoff pause does not wait out the full delay.
    if (retryTimer !== undefined) clearTimeout(retryTimer);

    await runtime.stop();
    await runtime.container.mcp.shutdown().catch((err: unknown) => {
      logger.warn({ err }, 'mcp shutdown did not complete cleanly');
    });
    await runtime.container.browser.shutdown().catch((err: unknown) => {
      logger.warn({ err }, 'browser shutdown did not complete cleanly');
    });
    await runtime.container.sandbox.dispose().catch((err: unknown) => {
      logger.warn({ err }, 'sandbox workers did not all stop');
    });

    await db.$disconnect();
    clearTimeout(force);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const fatal = (err: unknown): void => {
    logger.fatal({ err }, 'worker fatal error');
    process.exit(1);
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
}

main().catch((err: unknown) => {
  // Config and connection failures happen before the logger is usable.
  console.error('failed to start worker:', err);
  process.exit(1);
});
