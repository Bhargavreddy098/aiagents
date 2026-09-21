import {
  ApiError,
  describeCron,
  isApiError,
  nextCronFire,
  type CreateScheduleInput,
  type ListSchedulesQuery,
  type ScheduleDetail,
  type ScheduleFireResult,
  type ScheduleListResult,
  type ScheduleTargetKind,
  type UpdateScheduleInput,
} from '@nexs/shared';
import type { ScheduleRepository } from '../../repositories/schedule.repo.js';
import type { EventRepository } from '../../repositories/event.repo.js';
import type { TaskRepository } from '../../repositories/task.repo.js';
import type { WorkflowRepository } from '../../repositories/workflow.repo.js';
import type { OccurrenceStarter } from '../automation/occurrence.js';
import type { ScheduleQueue, ScheduleRegistration } from '../queue/schedule-queue.js';
import type { Logger } from '../../logger.js';
import type { EngineEmitter } from '../engine/execution-engine.js';
import { toScheduleDetail, toScheduleSummary } from '../../mappers/automation.js';

/**
 * Schedules: create, edit, enable, delete, and fire.
 *
 * ## `nextFireAt` is computed here, not by the transport
 *
 * The column is what makes `GET /api/schedules` a single query with a real answer. pg-boss
 * will fire a cron but never says when it will next fire, so the value comes from this
 * package's own cron evaluator (`@nexs/shared/cron`) — the same evaluator the tests exercise
 * directly. Storing it rather than deriving it on read is what keeps the list endpoint from
 * evaluating a cron expression per row.
 *
 * ## Firing is idempotent per occurrence, not per schedule
 *
 * The occurrence key is `schedule:<id>:<occurrenceId>`, where `occurrenceId` is the
 * transport's job id. A redelivered job therefore produces no second run, while the *next*
 * occurrence — a different job — produces a new one. A key scoped to the schedule alone
 * would make a recurring schedule fire exactly once, ever, and a key derived from the clock
 * would make a redelivery fire twice. Both are the failure this design exists to avoid.
 *
 * ## A schedule that cannot fire is skipped, not failed
 *
 * A disabled schedule, a target that has since been deleted, a workflow that has been
 * disabled: all of these are permanent conditions, and throwing would make the queue retry
 * a job that can never succeed — burning the retry budget and filling the logs with the same
 * error. `fire` therefore reports `{ outcome: 'skipped', reason }` for anything it can
 * recognise as permanent, and lets a genuine transient failure propagate so the queue does
 * retry it.
 */

export interface ScheduleServiceDeps {
  schedules: ScheduleRepository;
  subscriptions: EventRepository;
  tasks: TaskRepository;
  workflows: WorkflowRepository;
  occurrences: OccurrenceStarter;
  queue: ScheduleQueue;
  logger: Logger;
  emit?: EngineEmitter;
  /** Injected so `nextFireAt` is not bound to the wall clock in tests. */
  now?: () => number;
}

export interface FireRequest {
  scheduleId: string;
  tenantId: string;
  /** Stable per occurrence — the queue job id. See the file header. */
  occurrenceId: string;
}

export class ScheduleService {
  constructor(private readonly deps: ScheduleServiceDeps) {}

  async create(tenantId: string, input: CreateScheduleInput): Promise<ScheduleDetail> {
    const targetKind = input.targetKind as ScheduleTargetKind;
    await this.assertTargetExists(tenantId, targetKind, input.targetId);
    assertUtcTimezone(input.timezone);

    if (input.kind === 'event') {
      await this.assertSubscriptionExists(tenantId, input.eventSubscriptionId ?? null);
    }

    const now = new Date(this.now());
    const nextFireAt = this.computeNextFire({
      kind: input.kind,
      cron: input.cron ?? null,
      runAt: input.runAt ?? null,
      from: now,
    });

    const row = await this.deps.schedules.create({
      tenantId,
      name: input.name,
      kind: input.kind,
      cron: input.cron ?? null,
      timezone: input.timezone ?? 'UTC',
      runAt: input.runAt ?? null,
      eventSubscriptionId: input.eventSubscriptionId ?? null,
      targetKind,
      targetId: input.targetId,
      enabled: input.enabled ?? true,
      nextFireAt,
      deliveryTarget: input.deliveryTarget ?? null,
    });

    if (row.enabled) {
      await this.register(row);
    }

    this.deps.logger.info(
      {
        tenantId,
        scheduleId: row.id,
        kind: row.kind,
        targetKind: row.targetKind,
        targetId: row.targetId,
        nextFireAt: nextFireAt === null ? null : nextFireAt.toISOString(),
        detail: row.cron === null ? null : describeCron(row.cron),
      },
      'schedule created',
    );

    this.deps.emit?.(tenantId, { name: 'schedule.created', payload: { scheduleId: row.id, kind: row.kind } });

    return toScheduleDetail(row);
  }

  async list(tenantId: string, query: ListSchedulesQuery = {}): Promise<ScheduleListResult> {
    const rows = await this.deps.schedules.list(tenantId, {
      ...(query.enabled === undefined ? {} : { enabled: query.enabled }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.targetKind === undefined ? {} : { targetKind: query.targetKind }),
      ...(query.targetId === undefined ? {} : { targetId: query.targetId }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return { schedules: rows.map(toScheduleSummary) };
  }

  async get(tenantId: string, id: string): Promise<ScheduleDetail> {
    return toScheduleDetail(await this.requireSchedule(tenantId, id));
  }

  /**
   * Edit a schedule.
   *
   * `nextFireAt` is recomputed whenever the timing changed, and the transport registration
   * is rewritten unconditionally. Doing it unconditionally is deliberate: an edit that
   * changed only the name does not need a re-registration, but the cost of one is a single
   * idempotent upsert, and the cost of getting the condition wrong is a schedule whose
   * registered cron no longer matches its row.
   */
  async update(
    tenantId: string,
    id: string,
    input: UpdateScheduleInput,
  ): Promise<ScheduleDetail> {
    const existing = await this.requireSchedule(tenantId, id);
    assertUtcTimezone(input.timezone);

    const timingChanged =
      (input.cron !== undefined && input.cron !== existing.cron) ||
      (input.runAt !== undefined &&
        input.runAt.toISOString() !== (existing.runAt?.toISOString() ?? null));

    const updated = await this.deps.schedules.update(tenantId, id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.cron === undefined ? {} : { cron: input.cron }),
      ...(input.runAt === undefined ? {} : { runAt: input.runAt }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      ...(input.deliveryTarget === undefined ? {} : { deliveryTarget: input.deliveryTarget }),
    });
    if (updated === null) throw notFound(id);

    if (timingChanged) {
      const nextFireAt = this.computeNextFire({
        kind: updated.kind,
        cron: updated.cron,
        runAt: updated.runAt,
        from: new Date(this.now()),
      });
      await this.deps.schedules.setNextFireAt(tenantId, id, nextFireAt);
    }

    const reread = await this.requireSchedule(tenantId, id);
    if (reread.enabled) await this.register(reread);

    this.deps.logger.info({ tenantId, scheduleId: id, timingChanged }, 'schedule updated');
    this.deps.emit?.(tenantId, { name: 'schedule.updated', payload: { scheduleId: id } });

    return toScheduleDetail(reread);
  }

  /**
   * Turn a schedule on or off.
   *
   * Enabling recomputes `nextFireAt` from now rather than restoring the old value: a
   * schedule that was disabled for a week would otherwise come back with a next-fire time in
   * the past and fire immediately, which is not what "enable" means.
   */
  async setEnabled(tenantId: string, id: string, enabled: boolean): Promise<ScheduleDetail> {
    await this.requireSchedule(tenantId, id);

    const updated = await this.deps.schedules.setEnabled(tenantId, id, enabled);
    if (updated === null) throw notFound(id);

    if (enabled) {
      const nextFireAt = this.computeNextFire({
        kind: updated.kind,
        cron: updated.cron,
        runAt: updated.runAt,
        from: new Date(this.now()),
      });
      await this.deps.schedules.setNextFireAt(tenantId, id, nextFireAt);
      await this.register(updated);
    } else {
      await this.deps.queue.remove(id);
    }

    this.deps.logger.info({ tenantId, scheduleId: id, enabled }, 'schedule toggled');
    this.deps.emit?.(tenantId, { name: 'schedule.updated', payload: { scheduleId: id } });

    return toScheduleDetail(await this.requireSchedule(tenantId, id));
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.requireSchedule(tenantId, id);

    const deleted = await this.deps.schedules.delete(tenantId, id);
    if (!deleted) throw notFound(id);

    // Best-effort: a pending delayed job that has already been written cannot be recalled by
    // name, so the fire handler re-reads the schedule and finds nothing to do. Removing the
    // cron stops *new* jobs.
    await this.deps.queue.remove(id);

    this.deps.logger.info({ tenantId, scheduleId: id }, 'schedule deleted');
    this.deps.emit?.(tenantId, { name: 'schedule.deleted', payload: { scheduleId: id } });
  }

  /**
   * Fire a schedule. The queue consumer's entry point.
   *
   * See the file header for the skip-versus-throw rule and the occurrence key.
   */
  async fire(request: FireRequest): Promise<ScheduleFireResult> {
    const schedule = await this.deps.schedules.findById(request.tenantId, request.scheduleId);
    if (schedule === null) {
      return { scheduleId: request.scheduleId, outcome: 'skipped', reason: 'schedule no longer exists', nextFireAt: null };
    }
    if (!schedule.enabled) {
      return { scheduleId: schedule.id, outcome: 'skipped', reason: 'schedule is disabled', nextFireAt: null };
    }

    const now = new Date(this.now());
    const occurrenceKey = `schedule:${schedule.id}:${request.occurrenceId}`;

    let started: { runId: string; taskId: string | null };
    try {
      const result = await this.deps.occurrences.start({
        tenantId: request.tenantId,
        target: {
          kind: schedule.targetKind as 'task' | 'workflow',
          id: schedule.targetId,
        },
        occurrenceKey,
      });
      started = { runId: result.runId, taskId: result.taskId };
    } catch (err) {
      if (!isPermanent(err)) throw err;

      // A permanent failure still advances the schedule's timing, so a broken target does
      // not wedge the schedule's clock. The reason is reported rather than logged only,
      // because the caller is a queue consumer whose outcome is otherwise invisible.
      const nextFireAt = this.nextFireAfterFiring(schedule, now);
      await this.deps.schedules.recordFired(request.tenantId, schedule.id, {
        lastFiredAt: now,
        nextFireAt,
        ...(schedule.kind === 'one_time' ? { enabled: false } : {}),
      });

      const reason = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(
        { tenantId: request.tenantId, scheduleId: schedule.id, reason },
        'schedule could not start its target; skipping this occurrence',
      );
      return {
        scheduleId: schedule.id,
        outcome: 'skipped',
        reason,
        nextFireAt: nextFireAt === null ? null : nextFireAt.toISOString(),
      };
    }

    const nextFireAt = this.nextFireAfterFiring(schedule, now);

    await this.deps.schedules.recordFired(request.tenantId, schedule.id, {
      lastFiredAt: now,
      nextFireAt,
      // A one-time schedule is spent by firing. Recorded in the same statement as the
      // timestamp, so there is no window in which it has fired but is still enabled — which
      // the boot reconcile would otherwise re-register, firing it a second time.
      ...(schedule.kind === 'one_time' ? { enabled: false } : {}),
    });

    this.deps.logger.info(
      { tenantId: request.tenantId, scheduleId: schedule.id, runId: started.runId },
      'schedule fired',
    );

    this.deps.emit?.(request.tenantId, {
      name: 'schedule.fired',
      payload: {
        scheduleId: schedule.id,
        runId: started.runId,
        ...(started.taskId === null ? {} : { taskId: started.taskId }),
        nextFireAt: nextFireAt === null ? null : nextFireAt.toISOString(),
      },
    });

    return {
      scheduleId: schedule.id,
      outcome: 'fired',
      runId: started.runId,
      ...(started.taskId === null ? {} : { taskId: started.taskId }),
      nextFireAt: nextFireAt === null ? null : nextFireAt.toISOString(),
    };
  }

  /**
   * Every enabled schedule, as the registration the transport needs.
   *
   * The reconcile's source. See `QueueService.ensureScheduleConsumers` for why a consumer
   * per schedule has to be reconciled rather than registered once.
   */
  async listForConsumer(): Promise<ScheduleRegistration[]> {
    const rows = await this.deps.schedules.listAllEnabled();
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      kind: row.kind,
      cron: row.cron,
      runAt: row.runAt,
      timezone: row.timezone,
    }));
  }

  /**
   * Re-assert every enabled schedule's registration with the transport.
   *
   * The boot heal. pg-boss keeps cron entries in its own schema, so this is usually a
   * no-op — but a schedule created while the queue was unreachable has no entry at all, and
   * without this it would never fire and nothing would report why.
   */
  async syncRegistrations(): Promise<number> {
    const registrations = await this.listForConsumer();
    for (const registration of registrations) {
      await this.deps.queue.upsert(registration);
    }
    this.deps.logger.info({ count: registrations.length }, 'schedule registrations synchronised');
    return registrations.length;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async register(row: {
    id: string;
    tenantId: string;
    kind: string;
    cron: string | null;
    runAt: Date | null;
    timezone: string;
  }): Promise<void> {
    await this.deps.queue.upsert({
      id: row.id,
      tenantId: row.tenantId,
      kind: row.kind,
      cron: row.cron,
      runAt: row.runAt,
      timezone: row.timezone,
    });
  }

  /**
   * When this schedule next fires, or `null` when it has no next time.
   *
   * `null` for an `event` schedule is correct rather than a gap: it fires when its
   * subscription matches, which is not a time. `null` for a recurring schedule means the
   * expression never fires — a well-formed but unsatisfiable cron such as "30 February" —
   * and the schedule is stored and visibly never due rather than refused.
   */
  private computeNextFire(input: {
    kind: string;
    cron: string | null;
    runAt: Date | null;
    from: Date;
  }): Date | null {
    if (input.kind === 'one_time') return input.runAt;
    if (input.kind === 'recurring' && input.cron !== null) {
      return nextCronFire(input.cron, input.from);
    }
    return null;
  }

  /**
   * When the schedule next fires *after* an occurrence has been handled.
   *
   * Differs from `computeNextFire` in exactly one case, and it is the case that matters: a
   * one-time schedule is **spent** by firing. Returning its `runAt` again — which is now in
   * the past — would make the list endpoint show a schedule that has already run as
   * permanently overdue, and an operator reading "next fire: 40 minutes ago" has no way to
   * tell that from a schedule whose worker is wedged. `null` is the honest answer: there is
   * no next time, and the row is disabled in the same statement.
   */
  private nextFireAfterFiring(
    schedule: { kind: string; cron: string | null; runAt: Date | null },
    from: Date,
  ): Date | null {
    if (schedule.kind === 'one_time') return null;
    return this.computeNextFire({
      kind: schedule.kind,
      cron: schedule.cron,
      runAt: schedule.runAt,
      from,
    });
  }

  private async requireSchedule(tenantId: string, id: string) {
    const row = await this.deps.schedules.findById(tenantId, id);
    if (row === null) throw notFound(id);
    return row;
  }

  /**
   * A schedule must point at something that exists.
   *
   * Checked at creation because the alternative is a schedule that fires, fails to find its
   * target, and reports nothing — a silent no-op that looks identical to a schedule that has
   * simply not come due yet.
   */
  private async assertTargetExists(
    tenantId: string,
    targetKind: ScheduleTargetKind,
    targetId: string,
  ): Promise<void> {
    if (targetKind === 'task') {
      if ((await this.deps.tasks.findById(tenantId, targetId)) === null) {
        throw new ApiError('VALIDATION_ERROR', 'The task this schedule points at does not exist', {
          field: 'targetId',
          targetId,
        });
      }
      return;
    }

    if ((await this.deps.workflows.findById(tenantId, targetId)) === null) {
      throw new ApiError('VALIDATION_ERROR', 'The workflow this schedule points at does not exist', {
        field: 'targetId',
        targetId,
      });
    }
  }

  private async assertSubscriptionExists(
    tenantId: string,
    subscriptionId: string | null,
  ): Promise<void> {
    if (subscriptionId === null) {
      throw new ApiError('VALIDATION_ERROR', 'An event schedule requires "eventSubscriptionId"', {
        field: 'eventSubscriptionId',
      });
    }
    if ((await this.deps.subscriptions.findSubscriptionById(tenantId, subscriptionId)) === null) {
      throw new ApiError('VALIDATION_ERROR', 'The event subscription does not exist', {
        field: 'eventSubscriptionId',
        eventSubscriptionId: subscriptionId,
      });
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/**
 * Whether a failure will fail the same way next time.
 *
 * The queue retries a handler that throws, which is right for a database that was briefly
 * unreachable and wrong for a target that has been deleted. The recognisable permanent
 * conditions are exactly the `ApiError`s this layer raises for a bad request, a missing row,
 * or a state the target cannot be run in.
 *
 * Deliberately conservative: anything not recognised propagates, because a wrong "permanent"
 * verdict silently drops an occurrence, while a wrong "transient" one merely retries.
 */
function isPermanent(err: unknown): boolean {
  if (!isApiError(err)) return false;
  return (
    err.code === 'NOT_FOUND' ||
    err.code === 'VALIDATION_ERROR' ||
    err.code === 'CONFLICT' ||
    err.code === 'FEATURE_DISABLED' ||
    err.code === 'UNSUPPORTED_CAPABILITY'
  );
}

function notFound(id: string): ApiError {
  return new ApiError('NOT_FOUND', 'The schedule does not exist', { scheduleId: id });
}

/**
 * Refuse a timezone whose next-fire time this package cannot compute.
 *
 * `createScheduleSchema` already rejects a non-UTC zone, so the HTTP boundary is safe. This
 * repeats the check in the service because the service is reachable without the schema — the
 * container, a seed script, an internal caller — and the consequence of storing one is
 * silent rather than loud: `nextFireAt` is computed by `@nexs/shared/cron` in UTC, so the
 * row would claim `Asia/Tokyo` and the list endpoint would report a next fire wrong by nine
 * hours. A schedule list that lies about when things run is worse than one that cannot be
 * created in a foreign zone yet, so the two layers agree rather than one relying on the
 * other being in the path.
 */
function assertUtcTimezone(timezone: string | undefined): void {
  if (timezone === undefined) return;
  if (timezone.toUpperCase() === 'UTC') return;
  throw new ApiError(
    'VALIDATION_ERROR',
    'only the "UTC" timezone is supported today (non-UTC next-fire times are not computed)',
    { field: 'timezone', timezone },
  );
}
