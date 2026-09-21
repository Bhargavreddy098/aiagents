import type { Prisma, PrismaClient, Task } from '@prisma/client';
import type { TaskStatus, TaskTriggerType } from '@nexs/shared';

/**
 * Tasks, and the run each one starts.
 *
 * A task is the *scheduling* half of a unit of work and a run is the *execution* half. The
 * two are separate rows because they have different lifetimes: a recurring task exists
 * across many runs, and a run exists once. A task's status therefore tracks its current
 * run rather than duplicating it — see `TASK_TRANSITIONS` for why the vocabularies are
 * near-identical but not identical.
 *
 * ## Idempotency (gap #9)
 *
 * `Task` carries `@@unique([tenantId, idempotencyKey])`, so a retried delivery of "create
 * this task" cannot produce two tasks — or, downstream, two runs and two sets of side
 * effects. The key is scoped **per tenant**, not globally: two tenants that happen to use
 * the same key are describing different work, and a global uniqueness constraint would
 * make one tenant's task creation fail because of another's.
 *
 * The column is nullable and the constraint only applies when every column is non-null
 * (Postgres treats `NULL`s as distinct), so tasks created without a key are unconstrained —
 * which is the correct behaviour, because "no key" means "no claim to deduplicate on".
 */

export interface CreateTaskRow {
  tenantId: string;
  title: string;
  description?: string | null;
  goalId: string | null;
  agentId: string | null;
  workflowId: string | null;
  status: TaskStatus;
  priority: number;
  triggerType: TaskTriggerType;
  scheduledAt: Date | null;
  scheduleId: string | null;
  eventSubscriptionId: string | null;
  input: Prisma.InputJsonValue;
  idempotencyKey: string | null;
}

export interface TaskListFilters {
  status?: TaskStatus;
  goalId?: string;
  agentId?: string;
  workflowId?: string;
  limit?: number;
  offset?: number;
}

export class TaskRepository {
  constructor(private readonly db: PrismaClient) {}

  async findById(tenantId: string, id: string): Promise<Task | null> {
    return this.db.task.findFirst({ where: { id, tenantId } });
  }

  /**
   * Look a task up by its idempotency key.
   *
   * The read half of gap #9: a caller that may be retrying asks "did I already create
   * this?" before creating, and this is how it finds out. Tenant-scoped for the same
   * reason the constraint is.
   */
  async findByIdempotencyKey(tenantId: string, key: string): Promise<Task | null> {
    return this.db.task.findFirst({ where: { tenantId, idempotencyKey: key } });
  }

  async list(tenantId: string, filters: TaskListFilters = {}): Promise<Task[]> {
    return this.db.task.findMany({
      where: {
        tenantId,
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.goalId === undefined ? {} : { goalId: filters.goalId }),
        ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
        ...(filters.workflowId === undefined ? {} : { workflowId: filters.workflowId }),
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
      ...(filters.offset === undefined ? {} : { skip: filters.offset }),
    });
  }

  async count(
    tenantId: string,
    filters: { status?: TaskStatus; goalId?: string; agentId?: string; workflowId?: string } = {},
  ) {
    return this.db.task.count({
      where: {
        tenantId,
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.goalId === undefined ? {} : { goalId: filters.goalId }),
        ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
        ...(filters.workflowId === undefined ? {} : { workflowId: filters.workflowId }),
      },
    });
  }

  async create(data: CreateTaskRow): Promise<Task> {
    return this.db.task.create({
      data: {
        tenantId: data.tenantId,
        title: data.title,
        description: data.description ?? null,
        goalId: data.goalId,
        agentId: data.agentId,
        workflowId: data.workflowId,
        status: data.status,
        priority: data.priority,
        triggerType: data.triggerType,
        scheduledAt: data.scheduledAt,
        scheduleId: data.scheduleId,
        eventSubscriptionId: data.eventSubscriptionId,
        input: data.input,
        idempotencyKey: data.idempotencyKey,
      },
    });
  }

  /**
   * Create a task, or return the existing one with the same idempotency key.
   *
   * A read-then-create rather than a Prisma `upsert`, because the natural key is nullable:
   * `upsert` needs a unique selector, and `(tenantId, idempotencyKey)` is not usable as one
   * when the key is null. The race between the read and the create is closed by the unique
   * constraint — the loser gets `P2002` and the service retries the read, which is the same
   * compare-and-swap shape the engine uses for claims.
   */
  async createIdempotent(data: CreateTaskRow): Promise<{ task: Task; created: boolean }> {
    if (data.idempotencyKey === null) {
      return { task: await this.create(data), created: true };
    }

    const existing = await this.findByIdempotencyKey(data.tenantId, data.idempotencyKey);
    if (existing !== null) return { task: existing, created: false };

    try {
      return { task: await this.create(data), created: true };
    } catch (err) {
      // Lost the race: another delivery of the same request created it first. Re-reading
      // is correct — the caller asked for this task to exist, and it now does.
      if (isUniqueViolation(err)) {
        const raced = await this.findByIdempotencyKey(data.tenantId, data.idempotencyKey);
        if (raced !== null) return { task: raced, created: false };
      }
      throw err;
    }
  }

  async update(
    tenantId: string,
    id: string,
    patch: {
      title?: string;
      description?: string | null;
      priority?: number;
      scheduledAt?: Date | null;
      input?: Prisma.InputJsonValue;
    },
  ): Promise<Task | null> {
    const { count } = await this.db.task.updateMany({ where: { id, tenantId }, data: patch });
    if (count !== 1) return null;
    return this.findById(tenantId, id);
  }

  /**
   * Move a task to a new status.
   *
   * `output`, `error` and the timestamps travel with the status because they are all
   * observations about the *same* transition — a task that is `running` has a `startedAt`,
   * and a task that is `failed` has an `error`. Writing them separately would allow a row
   * that is `completed` with no `completedAt`, which is the kind of half-state the run
   * status machine exists to prevent.
   */
  async setStatus(
    tenantId: string,
    id: string,
    status: TaskStatus,
    extra: {
      output?: Prisma.InputJsonValue;
      error?: string | null;
      startedAt?: Date;
      completedAt?: Date;
    } = {},
  ): Promise<Task | null> {
    const { count } = await this.db.task.updateMany({
      where: { id, tenantId },
      data: {
        status,
        ...(extra.output === undefined ? {} : { output: extra.output }),
        ...(extra.error === undefined ? {} : { error: extra.error }),
        ...(extra.startedAt === undefined ? {} : { startedAt: extra.startedAt }),
        ...(extra.completedAt === undefined ? {} : { completedAt: extra.completedAt }),
      },
    });
    if (count !== 1) return null;
    return this.findById(tenantId, id);
  }

  /** How many times this task has been retried, incremented as one write. */
  async incrementRetryCount(tenantId: string, id: string): Promise<number> {
    const current = await this.findById(tenantId, id);
    if (current === null) return 0;
    const next = current.retryCount + 1;
    const { count } = await this.db.task.updateMany({
      where: { id, tenantId },
      data: { retryCount: next },
    });
    return count === 1 ? next : current.retryCount;
  }

  /** Tasks that are due and not yet running, for the scheduler in Phase 9. */
  async listDue(tenantId: string, now: Date, limit = 50): Promise<Task[]> {
    return this.db.task.findMany({
      where: { tenantId, status: 'queued', scheduledAt: { lte: now } },
      orderBy: [{ priority: 'asc' }, { scheduledAt: 'asc' }],
      take: limit,
    });
  }
}

/** `P2002` is Prisma's unique-constraint code. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}
