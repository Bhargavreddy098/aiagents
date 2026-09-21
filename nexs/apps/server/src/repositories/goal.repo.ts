import type { Goal, Prisma, PrismaClient } from '@prisma/client';
import type { GoalStatus } from '@nexs/shared';

/**
 * Goals, and the verification that gates completion.
 *
 * A goal is a statement of intent with machine-checkable criteria. The load-bearing rule
 * is that **a goal may only reach `completed` through a passing verification**, and this
 * repository is where that rule gets its teeth: `completeWithVerification` is the only
 * method that can write `completed`, and it takes the verification id as a required
 * argument. There is no general `setStatus(…, 'completed')` to reach for by mistake.
 *
 * That is a deliberate asymmetry with `AgentRepository.setStatus`, which accepts any
 * status. The difference is that an agent's statuses are all operator choices, while a
 * goal's `completed` is a *claim about the world* — and a claim needs evidence.
 */

export interface CreateGoalRow {
  tenantId: string;
  title: string;
  description?: string | null;
  agentId: string | null;
  priority: number;
  criteria: Prisma.InputJsonValue;
  constraints: Prisma.InputJsonValue;
  deadline: Date | null;
  status: GoalStatus;
}

export interface GoalPatch {
  title?: string;
  description?: string | null;
  agentId?: string | null;
  priority?: number;
  criteria?: Prisma.InputJsonValue;
  constraints?: Prisma.InputJsonValue;
  deadline?: Date | null;
}

export interface GoalListFilters {
  status?: GoalStatus;
  agentId?: string;
  limit?: number;
}

export class GoalRepository {
  constructor(private readonly db: PrismaClient) {}

  async findById(tenantId: string, id: string): Promise<Goal | null> {
    return this.db.goal.findFirst({ where: { id, tenantId } });
  }

  async list(tenantId: string, filters: GoalListFilters = {}): Promise<Goal[]> {
    return this.db.goal.findMany({
      where: {
        tenantId,
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
    });
  }

  async count(tenantId: string, filters: { status?: GoalStatus; agentId?: string } = {}) {
    return this.db.goal.count({
      where: {
        tenantId,
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
      },
    });
  }

  async create(data: CreateGoalRow): Promise<Goal> {
    return this.db.goal.create({
      data: {
        tenantId: data.tenantId,
        title: data.title,
        description: data.description ?? null,
        agentId: data.agentId,
        priority: data.priority,
        criteria: data.criteria,
        constraints: data.constraints,
        deadline: data.deadline,
        status: data.status,
      },
    });
  }

  async update(tenantId: string, id: string, patch: GoalPatch): Promise<Goal | null> {
    const { count } = await this.db.goal.updateMany({ where: { id, tenantId }, data: patch });
    if (count !== 1) return null;
    return this.findById(tenantId, id);
  }

  /**
   * Move a goal to a non-terminal status.
   *
   * Refuses `completed` outright rather than relying on the caller not to pass it. A
   * guard at the service layer is the right place for the *message*; this is the place
   * that makes the rule impossible to route around.
   */
  async setStatus(
    tenantId: string,
    id: string,
    status: GoalStatus,
    extra: { completedAt?: Date | null } = {},
  ): Promise<Goal | null> {
    if (status === 'completed') {
      throw new Error(
        'GoalRepository.setStatus cannot reach "completed" — use completeWithVerification, which requires evidence',
      );
    }
    const { count } = await this.db.goal.updateMany({
      where: { id, tenantId },
      data: {
        status,
        ...(extra.completedAt === undefined ? {} : { completedAt: extra.completedAt }),
      },
    });
    if (count !== 1) return null;
    return this.findById(tenantId, id);
  }

  /**
   * The only way to reach `completed`.
   *
   * The caller has already re-read the verification and confirmed it passed; what this
   * method guarantees is that the reference and the status land in the same write, so a
   * goal can never be observed as `completed` with no verification behind it. Splitting
   * those into two writes would leave a window in which exactly that is true.
   */
  async completeWithVerification(
    tenantId: string,
    id: string,
    verificationId: string,
    completedAt: Date,
  ): Promise<Goal | null> {
    const { count } = await this.db.goal.updateMany({
      where: { id, tenantId },
      data: { status: 'completed', completedVerificationId: verificationId, completedAt },
    });
    if (count !== 1) return null;
    return this.findById(tenantId, id);
  }

  /** Tasks belonging to a goal, for the composed goal view. */
  async countTasks(tenantId: string, goalId: string): Promise<number> {
    return this.db.task.count({ where: { tenantId, goalId } });
  }
}
