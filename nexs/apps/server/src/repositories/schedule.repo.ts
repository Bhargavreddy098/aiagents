import type { PrismaClient, Schedule } from '@prisma/client';
import { toOptionalJson } from './json.js';

/**
 * Schedules — the timetable half of "work that starts by itself".
 *
 * ## Isolation
 *
 * `Schedule` carries its own `tenantId`, so this is an ordinary tenant-owned repository:
 * `tenantId` is the first argument of every method and appears in every `where`. The one
 * exception is `listAllEnabled`, marked and justified below — it is the worker's boot-time
 * registration read and has no request context to derive a tenant from.
 *
 * ## Why updates go through `updateMany`
 *
 * `update({ where: { id } })` would let a caller holding a schedule id from another tenant
 * rewrite that row: the id is the only thing in the `where`, and ids are guessable enough
 * that "you would have to know it" is not a control. Every mutation here is
 * `updateMany({ where: { id, tenantId } })` followed by a re-read, so a cross-tenant write
 * is a `count: 0` rather than a success. This is the same shape the rest of the codebase
 * uses, and it is what makes the isolation tests meaningful.
 */

export interface ScheduleCreateInput {
  tenantId: string;
  name: string;
  kind: string;
  cron: string | null;
  timezone: string;
  runAt: Date | null;
  eventSubscriptionId: string | null;
  targetKind: string;
  targetId: string;
  enabled: boolean;
  nextFireAt: Date | null;
  deliveryTarget?: unknown;
}

export interface ScheduleListFilters {
  enabled?: boolean;
  kind?: string;
  targetKind?: string;
  targetId?: string;
  /**
   * Only schedules that have a next fire time.
   *
   * The dashboard asks for "the next five to fire", and the answer has to exclude a schedule
   * whose `nextFireAt` is `null` — a spent one-time schedule, or one whose transport
   * registration failed. Filtering here rather than fetching and slicing in the service is
   * what makes the limit mean "five that will actually fire": a `take: 5` applied before the
   * filter would return an arbitrary subset of a differently-shaped list, and the dashboard
   * would show fewer rows than it has schedules to show.
   */
  hasNextFire?: boolean;
  limit?: number;
}

/**
 * A partial edit. Every field is optional *and* the two nullable ones are explicit about
 * the difference between "leave alone" and "clear".
 *
 * `cron: null` and `cron: undefined` mean different things — clearing a cron is how a
 * schedule becomes one-time — so the caller passes `undefined` to skip a field and `null`
 * to clear it. Collapsing the two would make "edit the name" also require restating the
 * schedule's entire timing configuration.
 */
export interface ScheduleUpdateInput {
  name?: string;
  cron?: string | null;
  runAt?: Date | null;
  timezone?: string;
  deliveryTarget?: unknown;
}

export class ScheduleRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: ScheduleCreateInput): Promise<Schedule> {
    return this.db.schedule.create({
      data: {
        tenantId: data.tenantId,
        name: data.name,
        kind: data.kind,
        cron: data.cron,
        timezone: data.timezone,
        runAt: data.runAt,
        eventSubscriptionId: data.eventSubscriptionId,
        targetKind: data.targetKind,
        targetId: data.targetId,
        enabled: data.enabled,
        nextFireAt: data.nextFireAt,
        deliveryTarget: toOptionalJson(data.deliveryTarget),
      },
    });
  }

  async findById(tenantId: string, id: string): Promise<Schedule | null> {
    return this.db.schedule.findFirst({ where: { id, tenantId } });
  }

  async list(tenantId: string, filters: ScheduleListFilters = {}): Promise<Schedule[]> {
    return this.db.schedule.findMany({
      where: {
        tenantId,
        ...(filters.enabled === undefined ? {} : { enabled: filters.enabled }),
        ...(filters.kind === undefined ? {} : { kind: filters.kind }),
        ...(filters.targetKind === undefined ? {} : { targetKind: filters.targetKind }),
        ...(filters.targetId === undefined ? {} : { targetId: filters.targetId }),
        ...(filters.hasNextFire === true ? { nextFireAt: { not: null } } : {}),
      },
      // Soonest first, with the never-firing ones last. A schedule list is read to answer
      // "what is about to happen", so the ordering is the question.
      orderBy: [{ nextFireAt: 'asc' }, { createdAt: 'asc' }],
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
    });
  }

  /** How many schedules point at a given target — used to refuse deleting a target in use. */
  async countForTarget(tenantId: string, targetKind: string, targetId: string): Promise<number> {
    return this.db.schedule.count({ where: { tenantId, targetKind, targetId } });
  }

  async update(
    tenantId: string,
    id: string,
    data: ScheduleUpdateInput,
  ): Promise<Schedule | null> {
    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch['name'] = data.name;
    if (data.cron !== undefined) patch['cron'] = data.cron;
    if (data.runAt !== undefined) patch['runAt'] = data.runAt;
    if (data.timezone !== undefined) patch['timezone'] = data.timezone;
    if (data.deliveryTarget !== undefined) patch['deliveryTarget'] = toOptionalJson(data.deliveryTarget);

    // An edit that names no field is a no-op, not an error: the row is re-read and returned
    // so the caller gets the current state either way. Writing an empty `data` object would
    // still bump `updatedAt`, which would be a change nobody asked for.
    if (Object.keys(patch).length > 0) {
      const { count } = await this.db.schedule.updateMany({ where: { id, tenantId }, data: patch });
      if (count !== 1) return null;
    }

    return this.findById(tenantId, id);
  }

  /**
   * Turn a schedule on or off.
   *
   * Returns the updated row, or `null` when it does not exist for this tenant. Separate
   * from `update` because it is not an edit to a field the caller supplies — it is a state
   * change with a queue side effect the service performs around it.
   */
  async setEnabled(tenantId: string, id: string, enabled: boolean): Promise<Schedule | null> {
    const { count } = await this.db.schedule.updateMany({
      where: { id, tenantId },
      data: { enabled },
    });
    if (count !== 1) return null;
    return this.findById(tenantId, id);
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const { count } = await this.db.schedule.deleteMany({ where: { id, tenantId } });
    return count === 1;
  }

  /**
   * Record that a schedule fired, and when it will fire next.
   *
   * `enabled` is passed as `undefined` for the common case (leave it alone) and `false` for
   * a one-time schedule, which is spent by firing. Doing it in the same statement as the
   * timestamp is deliberate: a one-time schedule that recorded its fire and then failed to
   * disable would be re-registered on the next boot and fire a second time.
   *
   * Scoped by tenant like every other write. The caller is a queue consumer that already
   * read the schedule through this tenant, so a mismatch here means the row moved under it
   * — in which case not firing is the right answer.
   */
  async recordFired(
    tenantId: string,
    id: string,
    data: { lastFiredAt: Date; nextFireAt: Date | null; enabled?: boolean },
  ): Promise<number> {
    const patch: Record<string, unknown> = {
      lastFiredAt: data.lastFiredAt,
      nextFireAt: data.nextFireAt,
    };
    if (data.enabled !== undefined) patch['enabled'] = data.enabled;

    const { count } = await this.db.schedule.updateMany({ where: { id, tenantId }, data: patch });
    return count;
  }

  /** Set only `nextFireAt` — used when an edit changes the cron but not the history. */
  async setNextFireAt(tenantId: string, id: string, nextFireAt: Date | null): Promise<number> {
    const { count } = await this.db.schedule.updateMany({
      where: { id, tenantId },
      data: { nextFireAt },
    });
    return count;
  }

  /**
   * Every enabled schedule, across all tenants.
   *
   * **The one unscoped read here**, and the same documented exception as
   * `RunRepository.listStale` and `McpServerRepository.listAllWithPids`. Its caller is the
   * worker's boot-time registration: pg-boss keeps cron schedules in its own schema, but a
   * schedule created while the queue was unreachable has no job behind it, so the worker
   * reconciles from this table on every start. That read has no request context and must
   * see every tenant or it would miss exactly the schedules it exists to register.
   *
   * It is not reachable from any HTTP route.
   */
  async listAllEnabled(): Promise<Schedule[]> {
    return this.db.schedule.findMany({ where: { enabled: true } });
  }
}
