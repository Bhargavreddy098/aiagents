import type { Logger } from '../../logger.js';
import { RUN_EXECUTE_QUEUE, type RunQueueJob } from './run-queue.js';
import {
  scheduleQueueName,
  type ScheduleJob,
  type ScheduleRegistration,
} from './schedule-queue.js';

/**
 * The queue registry the spec fixes (§4-PHASE11). Named here as constants rather than at the
 * call sites, because a typo in a queue name is not a type error: the job is accepted into a
 * queue nobody consumes and the work sits there forever with nothing in the logs.
 *
 * ## The fifth name is not a constant, and that is the point
 *
 * `run.execute`, `approval.expire`, `recovery.scan` and `provider.health` are singletons.
 * The spec's fifth entry is `schedule:<id>` — one queue per schedule, because pg-boss
 * registers cron entries by queue name, so a second cron under one name has nowhere to live.
 * Its name is built by `scheduleQueueName` in `schedule-queue.ts` rather than being a
 * constant here, so the prefix exists exactly once.
 *
 * `recovery.scan` replaces the earlier `run.recover` constant. That name never matched the
 * spec's table, and nothing consumed it — renaming a constant with no references is free,
 * whereas leaving two names for one queue is how a producer and a consumer end up on
 * different queues with no error anywhere.
 */
export const APPROVAL_EXPIRE_QUEUE = 'approval.expire';
export const RECOVERY_SCAN_QUEUE = 'recovery.scan';
export const PROVIDER_HEALTH_QUEUE = 'provider.health';

/**
 * What the queue's consumers do, supplied after construction.
 *
 * A port rather than callbacks in the constructor, because the work the queue performs is
 * exactly the work the container owns — and the container needs the queue object before it
 * can hand it one. `bind` breaks that edge the same way `ApprovalService.bindEngine` breaks
 * the equivalent one between the engine and the approval gate.
 *
 * Every member is **required**. An optional member would let a composition root wire a
 * consumer that acknowledges jobs and does nothing, which is precisely the silent success
 * this codebase is built to avoid.
 */
export interface QueueExecutor {
  /** Execute one run. Called once per delivered `run.execute` job. */
  onRun(job: RunQueueJob): Promise<unknown>;
  /** Sweep lapsed approvals. Called with no arguments — the sweep finds its own work. */
  onExpireApprovals(): Promise<unknown>;
  /**
   * Fire one schedule.
   *
   * `jobId` is the occurrence identity and is not optional: it is what makes a redelivered
   * job collapse into the run it already created. See `ScheduleService.fire`.
   */
  onFireSchedule(job: ScheduleJob, jobId: string): Promise<unknown>;
  /** Find runs whose worker died and hand them back to `run.execute`. */
  onRecoverRuns(): Promise<unknown>;
  /** Probe every enabled provider's reachability. */
  onCheckProviderHealth(): Promise<unknown>;
}

/**
 * The subset of pg-boss this service uses.
 *
 * Structural, like `BossLike`, and for the same reason: a service that declares exactly the
 * methods it calls cannot quietly start depending on more of the transport than it says.
 *
 * `send` is re-declared rather than inherited from `BossLike` because this service needs
 * `startAfter` — pg-boss's way of scheduling a *delayed* job, which is the whole mechanism
 * behind `approval.expire`. `BossLike` deliberately does not declare it: `PgBossRunQueue` is
 * the producer for `run.execute`, which is immediate, and widening the shared port to carry
 * an option only one caller uses would invite every caller to use it.
 */
export interface QueueClient {
  start(): Promise<unknown>;
  stop(options?: { graceful?: boolean }): Promise<void>;
  createQueue(name: string, options?: { retryLimit?: number; expireInSeconds?: number }): Promise<void>;
  work<T>(name: string, handler: (jobs: Array<{ id: string; data: T }>) => Promise<void>): Promise<string>;
  send(
    name: string,
    data: object,
    options?: { startAfter?: number | Date; singletonKey?: string },
  ): Promise<string | null>;
  schedule(name: string, cron: string, data?: object): Promise<void>;
  unschedule(name: string): Promise<void>;
}

/**
 * Owns the pg-boss lifecycle: connecting, declaring queues, registering consumers, and
 * draining on shutdown.
 *
 * ## Why this exists at all
 *
 * Phase 7 shipped approval expiry with a working `expireDue()` and **nothing calling it**.
 * A sweep that only ever runs when a human types a command is not a sweep — an unanswered
 * approval would sit `pending` past its deadline forever, and a run would stay parked for
 * someone who was already given a deadline. The spec is explicit that this is a *delayed
 * job* (§4-PHASE11: `approval.expire` | delayed (`startAfter`)), not a cron, because the
 * deadline is per-approval rather than a wall-clock schedule.
 *
 * ## Why `start()` is separate from the constructor
 *
 * `new PgBoss(...)` parses a connection string and starts nothing. Calling `start()` runs
 * migrations against the `PGBOSS_SCHEMA` and opens a pool — a side effect that must be
 * *awaited before the server accepts traffic*, or the first few runs enqueued after boot
 * land in a schema that does not exist yet. Keeping them apart lets the composition root
 * sequence that properly, and lets a test construct the service without a database.
 *
 * ## The two-phase enqueue the rest of the app depends on
 *
 * `createQueue` is idempotent and cheap, and pg-boss `send` to an undeclared queue is
 * refused — so every queue this app sends to is declared here, once, before any producer
 * runs. A queue that is only ever *consumed* on the worker side is declared there too,
 * through the same method, so the API and the worker cannot disagree about the set.
 */
export class QueueService {
  /** The transport may hold resources (a pool, a migration lock). Set by `start()`. */
  private opened = false;
  /** Connected *and* fully set up: declared queues, registered consumers. Set by `start()`. */
  private started = false;
  private executor: QueueExecutor | undefined;

  /**
   * Schedule ids this process has already registered a consumer for.
   *
   * The reconcile runs on a timer, so without this every pass would call `work()` again for
   * every schedule — pg-boss would accept each call and this process would accumulate
   * duplicate consumers for the same queue, each fetching the same jobs. The set is
   * in-process because a consumer registration is an in-process thing: another process
   * having its own set is correct, not a bug.
   */
  private readonly registeredScheduleIds = new Set<string>();

  constructor(
    private readonly deps: {
      boss: QueueClient;
      logger: Logger;
      /** Consume `run.execute` in this process. The spec's `WORKER_ENABLED` (dev default). */
      consumeRuns: boolean;
    },
  ) {}

  /**
   * Hand the service the work its consumers should do, after both exist.
   *
   * The same late-binding shape `ApprovalService.bindEngine` uses, for the same reason: the
   * queue's consumers call the engine, and the engine's container needs the queue as its
   * approval-expiry scheduler. One of the two edges has to be bound after construction, and
   * binding it explicitly is clearer than a mutable cell that some future reordering could
   * read too early.
   */
  bind(executor: QueueExecutor): void {
    if (this.executor !== undefined) {
      throw new Error('QueueService.bind was called twice; the executor was already set');
    }
    this.executor = executor;
  }

  private requireExecutor(): QueueExecutor {
    if (this.executor === undefined) {
      // Only reachable if `consume()` ran without `bind`, which means the composition root
      // wired the queue without giving it anything to do. Failing loudly beats starting a
      // consumer that acknowledges jobs and executes nothing.
      throw new Error('QueueService has no executor bound; call bind() before start()');
    }
    return this.executor;
  }

  /**
   * Whether a connection was established and not yet torn down.
   *
   * Read by the health endpoint. It is a statement about this object's own lifecycle, not a
   * live probe — `start()` resolves only after pg-boss has migrated its schema, so "started
   * and not stopped" is exactly the claim the endpoint wants to make and can substantiate. A
   * live ping would be more precise and would also mean the health check can fail under
   * load, which is the opposite of what a liveness probe should do.
   */
  get connected(): boolean {
    return this.started;
  }

  /**
   * Connect, declare every queue, and register consumers.
   *
   * Must be awaited before the app serves traffic: `boss.start()` runs pg-boss's schema
   * migrations, and `send` to an undeclared queue is refused — so a job enqueued in the gap
   * would be lost rather than queued.
   *
   * `started` is set **last**, and only if every step succeeded. Setting it right after
   * `boss.start()` would make `connected` report `up` for a connection that has no declared
   * queues and no consumers — a false claim, and the health endpoint's `queue` field is
   * specifically the thing that must not be false. A partial failure leaves `connected`
   * false, which is the honest reading: the queue is not usable.
   */
  async start(): Promise<void> {
    await this.deps.boss.start();
    // Recorded before anything that can throw, so a later failure still closes the pool.
    this.opened = true;

    // Declared unconditionally, even when this process does not consume them. `send` to an
    // undeclared queue fails, and the API process is a producer for `run.execute` and
    // `approval.expire` even when the worker owns the consumers.
    await this.deps.boss.createQueue(RUN_EXECUTE_QUEUE, { retryLimit: 3, expireInSeconds: 900 });
    await this.deps.boss.createQueue(APPROVAL_EXPIRE_QUEUE, { retryLimit: 3, expireInSeconds: 300 });
    await this.deps.boss.createQueue(RECOVERY_SCAN_QUEUE, { retryLimit: 2, expireInSeconds: 900 });
    await this.deps.boss.createQueue(PROVIDER_HEALTH_QUEUE, { retryLimit: 2, expireInSeconds: 600 });

    if (this.deps.consumeRuns) {
      await this.consume();
    }

    this.started = true;

    this.deps.logger.info(
      { consumeRuns: this.deps.consumeRuns },
      'queue connected and queues declared',
    );
  }

  /** Register this process's consumers. Separated so a worker-only process is trivial. */
  async consume(): Promise<void> {
    const executor = this.requireExecutor();

    // A batch handler, because pg-boss hands over an array and a one-at-a-time loop inside
    // the handler would serialise a batch that the transport already sized for concurrency.
    await this.deps.boss.work<RunQueueJob>(RUN_EXECUTE_QUEUE, async (jobs) => {
      for (const job of jobs) {
        try {
          await executor.onRun(job.data);
        } catch (err) {
          // Rethrown on purpose: pg-boss retries a job whose handler throws, and swallowing
          // here would convert a run that failed to *start* into a silent loss. The engine's
          // own claim is idempotent, so a redelivery is safe.
          this.deps.logger.error(
            { runId: job.data.runId, jobId: job.id, err: describe(err) },
            'run.execute job failed; letting the queue retry',
          );
          throw err;
        }
      }
    });

    // A sweep rather than a per-approval job, for the same reason the expiry job is itself
    // delayed: the consumer is stateless, so a redelivery or a restart simply sweeps again.
    await this.deps.boss.work<{ reason?: string }>(APPROVAL_EXPIRE_QUEUE, async () => {
      await executor.onExpireApprovals();
    });

    /**
     * Recovery is also a sweep, and deliberately so.
     *
     * A job per orphaned run would need a producer that can see orphans, which is the scan
     * itself — so the scan is the job. It is safe to run concurrently in two workers for the
     * same reason the engine is: the claim is a compare-and-swap, so whichever worker gets
     * there first wins and the other's delivery is a no-op.
     */
    await this.deps.boss.work<{ reason?: string }>(RECOVERY_SCAN_QUEUE, async () => {
      await executor.onRecoverRuns();
    });

    await this.deps.boss.work<{ reason?: string }>(PROVIDER_HEALTH_QUEUE, async () => {
      await executor.onCheckProviderHealth();
    });

    this.deps.logger.info('queue consumers registered');
  }

  /**
   * Register a consumer for every schedule that does not have one yet.
   *
   * **This is the piece the spec's per-schedule queue design makes necessary.** pg-boss
   * registers cron entries by queue name, so each schedule is its own queue, so each needs
   * its own `work()`. A schedule created after this process booted therefore has its jobs
   * produced (the cron is in pg-boss's own table, written by whichever process created it)
   * but nothing consuming them until this runs. That is why it is called at boot *and* on a
   * timer, and why the interval is the bound on how late a newly created schedule's first
   * occurrence can be.
   *
   * Idempotent in-process via `registeredScheduleIds`. A schedule that has since been
   * disabled keeps its consumer: pg-boss has no `unwork`, and the handler is harmless
   * because `ScheduleService.fire` re-reads the row and skips a disabled schedule. Removing
   * a consumer would be the only way to make that check unnecessary, and it is not available.
   */
  async ensureScheduleConsumers(schedules: readonly ScheduleRegistration[]): Promise<number> {
    if (!this.deps.consumeRuns || !this.started) return 0;
    const executor = this.requireExecutor();

    let added = 0;
    for (const schedule of schedules) {
      if (this.registeredScheduleIds.has(schedule.id)) continue;

      const name = scheduleQueueName(schedule.id);
      await this.deps.boss.createQueue(name, { retryLimit: 2, expireInSeconds: 900 });
      await this.deps.boss.work<ScheduleJob>(name, async (jobs) => {
        for (const job of jobs) {
          try {
            await executor.onFireSchedule(job.data, job.id);
          } catch (err) {
            // Same reasoning as `run.execute`: a transient failure should be retried, and
            // the occurrence key is derived from the job id, so the retry cannot double-fire.
            this.deps.logger.error(
              { scheduleId: job.data.scheduleId, jobId: job.id, err: describe(err) },
              'schedule fire failed; letting the queue retry',
            );
            throw err;
          }
        }
      });

      this.registeredScheduleIds.add(schedule.id);
      added += 1;
    }

    if (added > 0) {
      this.deps.logger.info(
        { added, total: this.registeredScheduleIds.size },
        'schedule consumers registered',
      );
    }
    return added;
  }

  /**
   * Schedule the recurring sweeps, used as the backstop for the per-approval job.
   *
   * `approval.expire` is enqueued per approval at creation time (the spec's `startAfter`),
   * which is the precise mechanism. This periodic cheap re-sweep exists because a single
   * delayed job can be lost with the database it lives in — a restore from backup, or a
   * worker that was down across the deadline. `expireDue()` is idempotent (it is a
   * compare-and-swap), so running it more often than strictly needed costs one indexed query
   * and changes nothing.
   *
   * The other two crons are the spec's own: `provider.health` every ten minutes, and
   * `recovery.scan` hourly on top of its one-time run at boot.
   */
  async scheduleRecurringSweeps(): Promise<void> {
    await this.deps.boss.schedule(APPROVAL_EXPIRE_QUEUE, '*/5 * * * *', { reason: 'cron' });
    await this.deps.boss.schedule(PROVIDER_HEALTH_QUEUE, '*/10 * * * *', { reason: 'cron' });
    await this.deps.boss.schedule(RECOVERY_SCAN_QUEUE, '0 * * * *', { reason: 'cron' });
    this.deps.logger.info(
      'recurring sweeps scheduled: approvals every 5 min, provider health every 10 min, recovery hourly',
    );
  }

  /**
   * Enqueue one delayed expiry for a specific approval.
   *
   * `startAfter` takes the approval's own deadline, so the job fires when that approval is
   * due rather than at the next cron tick. `singletonKey` keyed on the approval id makes a
   * double-enqueue (a retried request, two workers) collapse to one job.
   */
  async scheduleApprovalExpiry(approvalId: string, expiresAt: Date): Promise<void> {
    if (!this.started) {
      // Not an error: an approval created before the queue connected is still swept by the
      // cron and by `expireDue()` on demand. Logged at debug so the common case is quiet.
      this.deps.logger.debug(
        { approvalId },
        'queue not connected; the approval will be caught by the periodic sweep',
      );
      return;
    }

    await this.deps.boss.send(
      APPROVAL_EXPIRE_QUEUE,
      { approvalId },
      { startAfter: expiresAt, singletonKey: approvalId },
    );
  }

  /**
   * Enqueue a one-time recovery scan.
   *
   * Called once at boot by the runtime, before the server accepts traffic: a process that
   * crashed left runs `running`, and recovering them is the first useful thing a fresh
   * process can do. Enqueued rather than called directly so the work happens in whichever
   * process consumes `recovery.scan`, which in a production deployment is the worker and not
   * the API.
   */
  async enqueueRecoveryScan(reason: string): Promise<void> {
    if (!this.started) {
      this.deps.logger.debug({ reason }, 'queue not connected; skipping the boot recovery scan');
      return;
    }
    await this.deps.boss.send(RECOVERY_SCAN_QUEUE, { reason });
  }

  /**
   * Stop consuming and close the pool.
   *
   * Guarded on `opened` rather than `started`, and the distinction matters: `boss.start()`
   * can succeed — opening a pool — and then `createQueue` can fail, so a queue can be
   * *connected but not ready*. Guarding on `started` would skip the close and leak the pool
   * for the life of a process that is already reporting `queue: down`. `opened` records "the
   * transport may hold resources", which is the question shutdown actually asks.
   */
  async stop(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    this.started = false;
    this.registeredScheduleIds.clear();
    // `graceful: false` on shutdown: a job in flight holds a run claim that the next process
    // will find and resume from its checkpoint, so waiting for it buys nothing — and waiting
    // is what makes a SIGTERM exceed its timeout and force an exit.
    await this.deps.boss.stop({ graceful: false });
    this.deps.logger.info('queue stopped');
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
