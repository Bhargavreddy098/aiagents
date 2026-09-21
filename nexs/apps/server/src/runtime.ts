import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createDb } from './db.js';
import { createContainer, type Container } from './container.js';
import { QueueService } from './services/queue/queue.service.js';
import { createBoss } from './services/queue/boss.js';
import type { RunQueueJob } from './services/queue/run-queue.js';
import type { Logger } from './logger.js';
import type { Config } from './config.js';
import type { Db } from './db.js';

/**
 * Build the container and connect the queue.
 *
 * Shared by both entrypoints because the API and the worker must agree about *what* a
 * `run.execute` job does. If each built its own engine, a run started by one and executed
 * by the other would be driven by two objects with two ideas of the run's checkpoint.
 *
 * ## The construction order, and why it looks circular but is not
 *
 * Three things reference each other:
 *
 *   - `createContainer` needs a `BossLike` (for its `PgBossRunQueue`) and an
 *     `ApprovalExpiryScheduler` (so a new approval gets a delayed expiry job).
 *   - `QueueService` needs the container, because its consumers call the engine and the
 *     approval sweep.
 *
 * The apparent cycle is broken by recognising that **the boss is not connected until
 * `start()` is called**. `new PgBoss(...)` parses a connection string and opens nothing, so
 * the boss is safe to create first and hand downwards. The queue *service* is built first
 * too, and handed to the container as a scheduler — but it registers no consumers and sends
 * nothing until `start()`, by which time the container exists. Every callback the service
 * holds reads `container` through a closure that is only *called* after the assignment.
 *
 * ## A queue that will not connect must not stop the API from booting
 *
 * `queue.start()` is attempted and its failure is **logged, not thrown**. The health
 * endpoint's whole design assumes this: it reports `queue: 'down'`, marks itself degraded
 * and returns 503 — which is only possible if the server is listening to answer at all.
 * Letting the throw escape would mean a queue outage is indistinguishable from a crash,
 * with no endpoint left to say which. The consequence is honest rather than hidden: with
 * `WORKER_ENABLED=true` no `run.execute` consumer exists, so runs sit queued until the
 * connection is restored, and `/api/health` says `queue: down` the entire time.
 *
 * `stop()` is safe on a queue that never started, so a failed boot still shuts down cleanly.
 */
export interface Runtime {
  container: Container;
  queue: QueueService;
  config: Config;
  logger: Logger;
  db: Db;
  stop: () => Promise<void>;
}

export async function wireRuntime(): Promise<Runtime> {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = createDb(config, logger);

  const boss = createBoss({
    connectionString: config.DATABASE_URL,
    schema: config.PGBOSS_SCHEMA,
    logger,
  });

  // Construction is linear now, and the one circular edge is bound explicitly.
  //
  // The container needs the queue (as its approval-expiry scheduler) and the queue needs
  // the container (its consumers call the engine). So: build the queue first with nothing
  // bound, build the container with the queue as its scheduler, then `bind` the queue to
  // the container. Same shape as `ApprovalService.bindEngine`, for the same reason — one of
  // two mutually-referring edges has to be attached after both objects exist, and doing it
  // with an explicit call is clearer than a mutable cell a reordering could read too early.
  const queue = new QueueService({
    boss,
    logger,
    consumeRuns: config.WORKER_ENABLED,
  });

  const container = createContainer({
    config,
    logger,
    db,
    boss,
    approvalExpiry: queue,
  });

  queue.bind({
    onRun: async (job: RunQueueJob) => {
      // The run's `kind` decides the executor, and there is exactly one split.
      //
      // A research run is a run with a *protocol*, not a run with a plan. The protocol's later
      // stages write `ResearchSource` / `ResearchFinding` rows, and no tool may write those — a
      // model-callable "record a finding" tool would let a model invent findings, which is the
      // exact failure provenance exists to prevent. So the protocol is code, and the engine is not
      // the thing that runs it.
      //
      // The engine is still what runs everything else, including the plan/act/observe/verify loop
      // for every ordinary run, and the research run is a real run row either way: it is created,
      // claimed with the same compare-and-swap, and moves through the same statuses.
      if (job.kind === 'research') {
        return container.researchRunner.execute(job.tenantId, job.runId);
      }

      // The engine's own claim decides whether a delivery does anything. A run that is
      // already terminal is not claimable and comes back `not_claimed`.
      //
      // A run that is `running` **is** claimable, and has to be: handing an orphaned run
      // back to a worker is the whole of crash recovery, and an orphan's row says `running`.
      // So a duplicate delivery of a *live* run is not caught here — it is caught by the
      // queue's singleton key, which is what keeps two jobs for one run from existing. The
      // residual exposure is a run whose heartbeat went stale while its worker was still
      // alive, which the reaper's window (`RUN_STALE_AFTER_MS`) is sized to make unlikely
      // rather than impossible. See `RunRepository.claim` for the full note.
      return container.engine.executeRun(job.tenantId, job.runId);
    },
    onExpireApprovals: async () => {
      const expired = await container.approvalService.expireDue();
      if (expired.length > 0) {
        logger.info({ count: expired.length, approvalIds: expired }, 'expired lapsed approvals');
      }
    },
    onFireSchedule: async (job, jobId) => {
      // `jobId` is the occurrence identity, and it is what makes a redelivered fire collapse
      // into the run it already created rather than starting a second one.
      const result = await container.scheduleService.fire({
        scheduleId: job.scheduleId,
        tenantId: job.tenantId,
        occurrenceId: jobId,
      });
      if (result.outcome === 'skipped') {
        logger.warn(
          { scheduleId: job.scheduleId, reason: result.reason },
          'schedule occurrence skipped',
        );
      }
    },
    onRecoverRuns: async () => {
      // Also the schedule-consumer reconcile: registering a consumer for a schedule created
      // after this process booted is a recovery concern, and folding it in here is what
      // keeps the queue set exactly the four singletons the spec names plus `schedule:<id>`
      // rather than adding a fifth maintenance queue that the spec does not have.
      await reconcileSchedules();
      await container.recoveryService.scan();
    },
    onCheckProviderHealth: async () => {
      await container.providerHealthService.checkAll();
    },
  });

  /**
   * Register a consumer for every enabled schedule, and heal their transport registrations.
   *
   * Called at boot and on every recovery sweep. A failure is logged rather than thrown: a
   * schedule that could not be registered is a schedule that will not fire, which the next
   * sweep will retry — and taking down a worker over one bad row would stop every other
   * schedule from being reconciled too.
   */
  const reconcileSchedules = async (): Promise<void> => {
    try {
      await container.scheduleService.syncRegistrations();
      const registered = await queue.ensureScheduleConsumers(
        await container.scheduleService.listForConsumer(),
      );
      if (registered > 0) logger.info({ registered }, 'schedule consumers reconciled');
    } catch (err) {
      logger.warn({ err }, 'could not reconcile schedule consumers; continuing');
    }
  };

  // Awaited before the caller listens on its port, because `start()` migrates pg-boss's
  // schema and a `send` to an undeclared queue is refused — so a run enqueued during the
  // gap would be lost rather than queued. A failure here is downgraded to a warning.
  await queue.start().catch((err: unknown) => {
    logger.error(
      { err },
      'could not connect the queue; the API will serve with queue: down until it is restored',
    );
  });

  if (queue.connected) {
    await queue.scheduleRecurringSweeps().catch((err: unknown) => {
      // A cron that could not be registered must not stop the server booting: the
      // per-approval delayed job is the precise mechanism, and this is only the backstop.
      logger.warn({ err }, 'could not schedule the recurring approval sweep; continuing');
    });

    /**
     * The boot reconcile, in this order and for a reason.
     *
     * Schedules first: a run recovered below may belong to a schedule, and more
     * importantly the crash being recovered from may have been the one that was about to
     * fire a schedule. Recovery second, enqueued rather than called, so the work happens in
     * whichever process consumes `recovery.scan` — in a production deployment that is the
     * worker, and running it inline here would put a full orphan sweep on the API's boot
     * path.
     */
    await reconcileSchedules();
    await queue.enqueueRecoveryScan('boot').catch((err: unknown) => {
      logger.warn({ err }, 'could not enqueue the boot recovery scan; continuing');
    });
  }

  return {
    container,
    queue,
    config,
    logger,
    db,
    stop: async () => {
      await queue.stop().catch((err: unknown) => {
        logger.warn({ err }, 'queue did not stop cleanly');
      });
    },
  };
}
