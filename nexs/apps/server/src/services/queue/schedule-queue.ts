import type { Logger } from '../../logger.js';

/**
 * The per-schedule queues the spec's Phase 11 table fixes.
 *
 * ## Why a queue per schedule
 *
 * The spec names the queue `schedule:<id>` and gives the reason: **the unique job name is
 * the schedule id, which is what dedupes it.** pg-boss registers cron entries by queue name
 * (`schedule(name, cron, …)` / `unschedule(name)`), so one cron per queue is the transport's
 * own model rather than a choice imposed here. A single shared queue with the schedule id in
 * the job data would need the *cron* to be registered per schedule anyway, and pg-boss has
 * nowhere to put a second cron under one name.
 *
 * ## The consequence that has to be handled, not hidden
 *
 * A queue per schedule means a **consumer per schedule**, and `work(name)` needs the exact
 * name. So a schedule created after the worker booted has its jobs produced (the cron is in
 * pg-boss's own table) but nothing consuming them until the worker learns the id. The worker
 * therefore reconciles consumers from the database at boot and on a short timer; see
 * `QueueService.reconcileScheduleConsumers`. The window is the timer's interval, and it is
 * stated here rather than left for someone to discover as "my schedule fired late once".
 *
 * ## Why `upsert` rather than `create`
 *
 * Creating a schedule, enabling one, and editing one's cron all end in the same place: the
 * queue must exist and the registration must reflect the current row. Three methods would be
 * three chances to forget one, and they would all need the same "cancel whatever was there
 * before" step. `upsert` is the one operation, and it is idempotent — which is what makes it
 * safe to call from a reconcile loop.
 */

/** Queue-name prefix. A typo here is not a type error, so it is written once. */
export const SCHEDULE_QUEUE_PREFIX = 'schedule:';

export function scheduleQueueName(scheduleId: string): string {
  return `${SCHEDULE_QUEUE_PREFIX}${scheduleId}`;
}

/** Whether a queue name belongs to a schedule — used by the reconcile to skip foreign names. */
export function isScheduleQueueName(name: string): boolean {
  return name.startsWith(SCHEDULE_QUEUE_PREFIX);
}

export interface ScheduleJob {
  scheduleId: string;
  tenantId: string;
}

/** The schedule facts the registration needs. A projection, not the whole row. */
export interface ScheduleRegistration {
  id: string;
  tenantId: string;
  kind: string;
  cron: string | null;
  runAt: Date | null;
  timezone: string;
}

/**
 * The subset of pg-boss this module uses.
 *
 * Structural, like `BossLike` and `QueueClient`, and for the same reason: a module that
 * declares exactly the methods it calls cannot quietly start depending on more of the
 * transport than it says.
 */
export interface ScheduleQueueClient {
  createQueue(name: string, options?: { retryLimit?: number; expireInSeconds?: number }): Promise<void>;
  work<T>(name: string, handler: (jobs: Array<{ id: string; data: T }>) => Promise<void>): Promise<string>;
  send(
    name: string,
    data: object,
    options?: { startAfter?: number | Date; singletonKey?: string },
  ): Promise<string | null>;
  schedule(
    name: string,
    cron: string,
    data?: object,
    options?: { tz?: string },
  ): Promise<void>;
  unschedule(name: string): Promise<void>;
}

export interface ScheduleQueue {
  /** Make the transport's registration match this schedule. Idempotent. */
  upsert(schedule: ScheduleRegistration): Promise<void>;
  /**
   * Stop the schedule firing.
   *
   * Best-effort by design: a pending delayed job that has already been written cannot be
   * recalled by name, so the fire handler re-reads the schedule and does nothing when it is
   * disabled or gone. Removing the cron here is what stops *new* jobs; the handler is what
   * makes the already-queued one harmless.
   */
  remove(scheduleId: string): Promise<void>;
}

export class PgBossScheduleQueue implements ScheduleQueue {
  constructor(
    private readonly boss: ScheduleQueueClient,
    private readonly logger: Logger,
  ) {}

  async upsert(schedule: ScheduleRegistration): Promise<void> {
    const name = scheduleQueueName(schedule.id);
    await this.boss.createQueue(name, { retryLimit: 2, expireInSeconds: 900 });

    // A previous registration must be cleared first. `schedule()` on a name that already has
    // a cron **replaces** it in pg-boss, but switching a schedule from recurring to one-time
    // (or the reverse) leaves the other mechanism's entry behind — so both are cleared and
    // exactly one is written.
    await this.boss.unschedule(name).catch((err: unknown) => {
      // `unschedule` on a name with no cron is not an error worth surfacing, and pg-boss's
      // behaviour there has changed across versions. Logged at debug so a real failure is
      // still visible without a first-time upsert looking like a fault.
      this.logger.debug({ scheduleId: schedule.id, err: describe(err) }, 'no prior cron to clear');
    });

    if (schedule.kind === 'recurring' && schedule.cron !== null) {
      await this.boss.schedule(name, schedule.cron, this.jobData(schedule), {
        tz: schedule.timezone,
      });
      this.logger.debug(
        { scheduleId: schedule.id, cron: schedule.cron, timezone: schedule.timezone },
        'schedule registered as a cron',
      );
      return;
    }

    if (schedule.kind === 'one_time' && schedule.runAt !== null) {
      await this.boss.send(name, this.jobData(schedule), {
        startAfter: schedule.runAt,
        // Keyed on the schedule id so a re-registration — the boot reconcile running twice,
        // or an edit — cannot queue a second occurrence of a one-time schedule.
        singletonKey: schedule.id,
      });
      this.logger.debug(
        { scheduleId: schedule.id, runAt: schedule.runAt.toISOString() },
        'schedule registered as a delayed one-time job',
      );
      return;
    }

    // An `event` schedule has no time of its own: it is fired by the event matcher, which
    // calls the schedule service directly. Registering nothing is correct — but it is worth
    // a debug line, because "I created an event schedule and no queue appeared" is otherwise
    // indistinguishable from a bug.
    this.logger.debug(
      { scheduleId: schedule.id, kind: schedule.kind },
      'schedule has no time of its own; it is fired by its event subscription',
    );
  }

  async remove(scheduleId: string): Promise<void> {
    const name = scheduleQueueName(scheduleId);
    await this.boss.unschedule(name).catch((err: unknown) => {
      this.logger.warn({ scheduleId, err: describe(err) }, 'could not unschedule; continuing');
    });
  }

  private jobData(schedule: ScheduleRegistration): ScheduleJob {
    return { scheduleId: schedule.id, tenantId: schedule.tenantId };
  }
}

/**
 * A registration recorder for tests.
 *
 * Makes "was the cron registered for this schedule, and was it removed when the schedule was
 * disabled?" an assertion rather than a hope — which is the only part of this module that can
 * be verified on a machine with no Postgres, since the actual firing is the transport's job.
 */
export class RecordingScheduleQueue implements ScheduleQueue {
  readonly upserts: ScheduleRegistration[] = [];
  readonly removals: string[] = [];

  async upsert(schedule: ScheduleRegistration): Promise<void> {
    this.upserts.push(schedule);
  }

  async remove(scheduleId: string): Promise<void> {
    this.removals.push(scheduleId);
  }
}

/**
 * What a schedule registration becomes when there is no transport.
 *
 * `deps.boss` is optional on the container, so a deployment (or a test) can be wired with no
 * pg-boss connection at all. The tempting alternative — casting `undefined` to the client
 * interface — compiles and then fails at the first `upsert` with a message about reading a
 * property of undefined, somewhere far from the cause.
 *
 * So the honest degradation is explicit: schedules are still created, listed and given a
 * `nextFireAt`, and **nothing fires**, with a warning each time a registration is dropped.
 * That is the same trade the health endpoint makes when the queue is down — the feature is
 * visibly unavailable rather than silently broken — and it is why this class says "warn" and
 * not "noop".
 */
export class UnavailableScheduleQueue implements ScheduleQueue {
  constructor(private readonly logger: Logger) {}

  async upsert(schedule: ScheduleRegistration): Promise<void> {
    this.logger.warn(
      { scheduleId: schedule.id, kind: schedule.kind },
      'no queue transport is configured; this schedule will be stored but will never fire',
    );
  }

  async remove(scheduleId: string): Promise<void> {
    this.logger.debug(
      { scheduleId },
      'no queue transport is configured; there is no registration to remove',
    );
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
