import {
  ApiError,
  canTransitionGoal,
  isTerminalGoalStatus,
  type CreateGoalInput,
  type GoalDetail,
  type GoalStatus,
  type SetGoalStatusInput,
  type UpdateGoalInput,
} from '@nexs/shared';
import type { GoalRepository } from '../../repositories/goal.repo.js';
import type { AgentRepository } from '../../repositories/agent.repo.js';
import type { RunRepository, VerificationRepository } from '../../repositories/run.repo.js';
import type { Logger } from '../../logger.js';
import { toGoalDetail, toGoalSummary } from '../../mappers/control.js';

/**
 * Goals: intent with machine-checkable criteria.
 *
 * The one rule this service exists to enforce is in `setStatus`: **a goal may not reach
 * `completed` without a passing verification.** Everything else here is ordinary CRUD; that
 * rule is what makes a completed goal mean something rather than being a status someone
 * typed.
 *
 * ## Why the gate re-reads the verification
 *
 * The caller sends `completedVerificationId`. It is treated as a *reference*, never as
 * evidence. The service re-reads the row and checks three things: that it exists **for this
 * tenant**, that it is a `goal_criteria` verification, and that it actually passed. Trusting
 * the id would let a caller complete a goal by naming a verification that failed, one that
 * belongs to another tenant, or one that does not exist — and the goal row would then carry
 * `completedVerificationId` pointing at nothing, which is worse than no gate at all because
 * it *looks* verified.
 */

export interface GoalServiceDeps {
  goals: GoalRepository;
  verifications: VerificationRepository;
  agents: AgentRepository;
  runs: RunRepository;
  logger: Logger;
}

export class GoalService {
  constructor(private readonly deps: GoalServiceDeps) {}

  async create(tenantId: string, input: CreateGoalInput): Promise<GoalDetail> {
    if (input.agentId !== undefined && input.agentId !== null) {
      await this.assertAgentExists(tenantId, input.agentId);
    }

    const goal = await this.deps.goals.create({
      tenantId,
      title: input.title,
      description: input.description ?? null,
      agentId: input.agentId ?? null,
      priority: input.priority ?? 3,
      criteria: (input.criteria ?? []) as never,
      constraints: (input.constraints ?? []) as never,
      deadline: input.deadline ?? null,
      // Always `draft`, like an agent: a goal that could be created `active` would be one
      // that starts work before anyone has reviewed its criteria.
      status: 'draft',
    });

    this.deps.logger.info({ tenantId, goalId: goal.id }, 'goal created');
    return this.detail(tenantId, goal.id);
  }

  async list(tenantId: string, query: { status?: GoalStatus; agentId?: string; limit?: number } = {}) {
    const goals = await this.deps.goals.list(tenantId, query);
    return goals.map(toGoalSummary);
  }

  async get(tenantId: string, id: string): Promise<GoalDetail> {
    return this.detail(tenantId, id);
  }

  async update(tenantId: string, id: string, input: UpdateGoalInput): Promise<GoalDetail> {
    const goal = await this.requireGoal(tenantId, id);

    if (isTerminalGoalStatus(goal.status as GoalStatus)) {
      // A completed goal is evidence of something that happened. Editing its criteria
      // afterwards would change what it is claimed to have achieved.
      throw new ApiError('CONFLICT', `A ${goal.status} goal cannot be edited`, {
        status: goal.status,
      });
    }

    if (input.agentId !== undefined && input.agentId !== null) {
      await this.assertAgentExists(tenantId, input.agentId);
    }

    const patch = {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.criteria === undefined ? {} : { criteria: input.criteria as never }),
      ...(input.constraints === undefined ? {} : { constraints: input.constraints as never }),
      ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
    };

    const updated = await this.deps.goals.update(tenantId, id, patch);
    if (updated === null) throw notFound(id);
    return this.detail(tenantId, id);
  }

  /**
   * Move a goal to a new status — and, for `completed`, demand the evidence.
   *
   * The order of checks is deliberate. The transition is checked first so a caller asking
   * for something the state machine forbids is told that, rather than being told about a
   * missing verification for a transition that was never going to be allowed.
   */
  async setStatus(tenantId: string, id: string, input: SetGoalStatusInput): Promise<GoalDetail> {
    const goal = await this.requireGoal(tenantId, id);
    const from = goal.status as GoalStatus;

    if (from === input.status) {
      throw new ApiError('CONFLICT', `The goal is already ${input.status}`, { status: from });
    }
    if (!canTransitionGoal(from, input.status)) {
      throw new ApiError('CONFLICT', `A goal cannot go from ${from} to ${input.status}`, {
        from,
        to: input.status,
      });
    }

    if (input.status === 'completed') {
      const verificationId = await this.requirePassingVerification(
        tenantId,
        id,
        input.completedVerificationId,
      );
      const completed = await this.deps.goals.completeWithVerification(
        tenantId,
        id,
        verificationId,
        new Date(),
      );
      if (completed === null) throw notFound(id);
      this.deps.logger.info(
        { tenantId, goalId: id, verificationId },
        'goal completed against a passing verification',
      );
      return this.detail(tenantId, id);
    }

    const updated = await this.deps.goals.setStatus(tenantId, id, input.status, {
      ...(input.status === 'failed' || input.status === 'cancelled'
        ? { completedAt: new Date() }
        : {}),
    });
    if (updated === null) throw notFound(id);

    this.deps.logger.info(
      { tenantId, goalId: id, from, to: input.status },
      'goal status changed',
    );
    return this.detail(tenantId, id);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Confirm the named verification is real, is this tenant's, is a `goal_criteria` check,
   * and passed. Returns its id so the caller writes back the id it validated rather than
   * the id it was handed.
   *
   * The third check is not ceremony: a `schema` verification that passed proves something
   * about a step's output, not about whether a goal was achieved. Accepting one would make
   * `completedVerificationId` name a check that never judged the goal.
   */
  private async requirePassingVerification(
    tenantId: string,
    goalId: string,
    verificationId: string | undefined,
  ): Promise<string> {
    if (verificationId === undefined) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'Completing a goal requires "completedVerificationId" naming a passing verification',
        { field: 'completedVerificationId' },
      );
    }

    const verification = await this.deps.verifications.findById(tenantId, verificationId);

    if (verification === null) {
      // Deliberately not "not found": from the caller's point of view the id is unusable,
      // and distinguishing "does not exist" from "belongs to someone else" would confirm
      // the existence of another tenant's rows.
      throw new ApiError('VALIDATION_ERROR', 'The verification does not exist', {
        verificationId,
      });
    }

    if (verification.scope !== 'goal_criteria') {
      throw new ApiError('CONFLICT', 'The verification is not a goal_criteria check', {
        verificationId,
        scope: verification.scope,
      });
    }

    // A verification attributed to a *different* goal is refused outright. One with no
    // attribution is allowed: the engine sets `goalId` from the run, and a run that carried
    // no goal id produces an unattributed verification — which is not evidence about some
    // other goal, so refusing it would block a legitimate case.
    if (verification.goalId !== null && verification.goalId !== goalId) {
      throw new ApiError('CONFLICT', 'The verification belongs to a different goal', {
        verificationId,
        verificationGoalId: verification.goalId,
      });
    }

    // Both columns are checked, because they are written together but read separately and
    // a row where they disagree is a row that was not written by `complete()`. Trusting
    // either one alone would let such a row through.
    if (verification.status !== 'passed' || verification.passed !== true) {
      throw new ApiError('CONFLICT', 'The verification did not pass', {
        verificationId,
        status: verification.status,
        passed: verification.passed,
      });
    }

    return verification.id;
  }

  private async detail(tenantId: string, id: string): Promise<GoalDetail> {
    const goal = await this.requireGoal(tenantId, id);
    const tasks = await this.deps.goals.countTasks(tenantId, id);
    return toGoalDetail(goal, { tasks });
  }

  private async requireGoal(tenantId: string, id: string) {
    const goal = await this.deps.goals.findById(tenantId, id);
    if (goal === null) throw notFound(id);
    return goal;
  }

  private async assertAgentExists(tenantId: string, agentId: string): Promise<void> {
    const agent = await this.deps.agents.findById(tenantId, agentId);
    if (agent === null) {
      throw new ApiError('VALIDATION_ERROR', 'The agent does not exist', { agentId });
    }
  }
}

function notFound(id: string): ApiError {
  return new ApiError('NOT_FOUND', 'The goal does not exist', { goalId: id });
}
