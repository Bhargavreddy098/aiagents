import {
  ApiError,
  canTransitionTask,
  isImmediateTrigger,
  isTerminalTaskStatus,
  requiresEventSubscription,
  requiresSchedule,
  runKindFor,
  type CreateTaskInput,
  type TaskDetail,
  type TaskStatus,
  type TaskSummary,
  type TaskTriggerType,
} from '@nexs/shared';
import type { TaskRepository } from '../../repositories/task.repo.js';
import { canResolveModel } from '../engine/run-input.js';
import type { AgentRepository } from '../../repositories/agent.repo.js';
import type { GoalRepository } from '../../repositories/goal.repo.js';
import type { WorkflowRepository } from '../../repositories/workflow.repo.js';
import type { ScheduleRepository } from '../../repositories/schedule.repo.js';
import type { EventRepository } from '../../repositories/event.repo.js';
import type { RunRepository } from '../../repositories/run.repo.js';
import type { RunQueue } from '../queue/run-queue.js';
import type { Logger } from '../../logger.js';
import { toTaskDetail, toTaskSummary } from '../../mappers/control.js';

/**
 * Tasks: the scheduling half of a unit of work.
 *
 * The single most important behaviour here is what happens on a **duplicate delivery**.
 * A caller that is retrying sends the same `idempotencyKey`, and the answer must be "you
 * already created this" — not a second task, and above all not a second **run**. Two runs
 * for one task means two sets of side effects, which is the failure this whole design
 * exists to prevent.
 *
 * So `create` branches on `created` from the repository: a task that already existed gets
 * its current state returned and **no run is started**. The run is created only on the
 * delivery that actually created the task.
 */

export interface TaskServiceDeps {
  tasks: TaskRepository;
  runs: RunRepository;
  agents: AgentRepository;
  goals: GoalRepository;
  workflows: WorkflowRepository;
  /** Phase 11: a `recurring` task must name a schedule that exists. */
  schedules: ScheduleRepository;
  /** Phase 11: an `event` task must name a subscription that exists. */
  events: EventRepository;
  queue: RunQueue;
  logger: Logger;
}

export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  async create(tenantId: string, input: CreateTaskInput): Promise<TaskDetail> {
    const trigger = input.triggerType as TaskTriggerType;
    await this.assertTriggerSatisfied(tenantId, trigger, input);
    await this.assertReferencesExist(tenantId, input);

    // An immediate or manual task starts a run *now*, so its configuration has to be
    // resolvable now. With no agent to supply a model and no model in the input, the run
    // can only fail — the resolver requires a model and there is nowhere to get one.
    // Refusing here gives the caller a message about their request; accepting would hand
    // back a 201 and leave the task `running` behind a run that is already `failed`.
    //
    // A scheduled, recurring or event task is *not* checked, because it does not start a
    // run yet — its agent may legitimately be assigned before it fires.
    if (isImmediateTrigger(trigger) && !canResolveModel(input)) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'An immediate task needs an agent or "input.context.modelId" to run',
        { field: 'agentId' },
      );
    }

    const { task, created } = await this.deps.tasks.createIdempotent({
      tenantId,
      title: input.title,
      description: input.description ?? null,
      goalId: input.goalId ?? null,
      agentId: input.agentId ?? null,
      workflowId: input.workflowId ?? null,
      status: 'queued',
      priority: input.priority ?? 3,
      triggerType: trigger,
      scheduledAt: input.scheduledAt ?? null,
      scheduleId: input.scheduleId ?? null,
      eventSubscriptionId: input.eventSubscriptionId ?? null,
      input: (input.input ?? {}) as never,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    if (!created) {
      // A retry. The task exists; starting a run here would give one task two runs and two
      // sets of effects, which is exactly what the idempotency key is for.
      this.deps.logger.info(
        { tenantId, taskId: task.id },
        'task creation deduplicated; no run started',
      );
      return this.detail(tenantId, task.id);
    }

    this.deps.logger.info(
      { tenantId, taskId: task.id, triggerType: trigger },
      'task created',
    );

    if (isImmediateTrigger(trigger)) {
      await this.startRun(tenantId, task.id);
    }

    return this.detail(tenantId, task.id);
  }

  async list(
    tenantId: string,
    query: {
      status?: TaskStatus;
      goalId?: string;
      agentId?: string;
      workflowId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<TaskSummary[]> {
    const tasks = await this.deps.tasks.list(tenantId, query);
    return tasks.map(toTaskSummary);
  }

  async get(tenantId: string, id: string): Promise<TaskDetail> {
    return this.detail(tenantId, id);
  }

  /**
   * Cancel a task.
   *
   * Cancelling the task does **not** cancel a run that is already executing — a run has its
   * own lifecycle and its own endpoint, and a task cannot reach into a run's steps to stop
   * one mid-flight. What this does is stop the task from being scheduled again and mark it
   * honestly. A caller who wants the run stopped cancels the run.
   */
  async cancel(tenantId: string, id: string): Promise<TaskDetail> {
    const task = await this.requireTask(tenantId, id);
    const from = task.status as TaskStatus;

    if (isTerminalTaskStatus(from)) {
      throw new ApiError('CONFLICT', `The task is already ${from}`, { status: from });
    }
    if (!canTransitionTask(from, 'cancelled')) {
      throw new ApiError('CONFLICT', `A task cannot go from ${from} to cancelled`, {
        from,
        to: 'cancelled',
      });
    }

    const updated = await this.deps.tasks.setStatus(tenantId, id, 'cancelled', {
      completedAt: new Date(),
    });
    if (updated === null) throw notFound(id);

    this.deps.logger.info({ tenantId, taskId: id, from }, 'task cancelled');
    return this.detail(tenantId, id);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Create the run for a task and hand it to the executor.
   *
   * The run's kind is decided by `runKindFor` from the task's own provenance, so a task
   * that runs a workflow produces a `workflow` run and appears in that filter — which is
   * what an operator looking at the run list expects to find.
   *
   * The task's status moves to `queued` → `running` at the same time. The run owns the
   * detail from here; the task tracks it. Doing both writes here rather than leaving the
   * task at `queued` means a task that has started is not indistinguishable from one that
   * has not.
   */
  private async startRun(tenantId: string, taskId: string): Promise<void> {
    const task = await this.deps.tasks.findById(tenantId, taskId);
    if (task === null) return;

    const kind = runKindFor({
      goalId: task.goalId,
      taskId: task.id,
      workflowId: task.workflowId,
    });

    const run = await this.deps.runs.create({
      tenantId,
      kind,
      agentId: task.agentId,
      goalId: task.goalId,
      taskId: task.id,
      workflowId: task.workflowId,
      input: task.input as never,
      // Scoped to the task, so a retried delivery of the same task cannot produce a second
      // run even if it somehow reached this point twice.
      idempotencyKey: `task:${task.id}`,
    });

    await this.deps.tasks.setStatus(tenantId, taskId, 'running', { startedAt: new Date() });
    await this.deps.queue.enqueue({ runId: run.id, tenantId, kind });

    this.deps.logger.info({ tenantId, taskId, runId: run.id, kind }, 'task started a run');
  }

  /**
   * A trigger that names a companion row must name one that exists.
   *
   * `recurring` without a schedule would be a task that claims to repeat and never does;
   * `event` without a subscription would never fire. Both are silent failures — the task
   * simply sits there — so they are refused at creation rather than discovered later.
   *
   * ## What changed when the scheduler arrived
   *
   * These branches used to refuse outright with `FEATURE_DISABLED`, because schedules and
   * subscriptions did not exist yet and a caller asking for one deserved to be told so
   * rather than handed a task that would never run. Now they exist, so the check is a real
   * existence check, and a *missing* row is a `VALIDATION_ERROR` naming the field rather
   * than a feature that is not built.
   *
   * ## Which side owns the trigger
   *
   * The **schedule** does. `Schedule.targetId` is what a fire actually starts, and
   * `Task.scheduleId` is a back-pointer for display. So this checks that the named schedule
   * exists and is the right kind — a `one_time` schedule named as a task's recurring trigger
   * is a genuine mistake worth catching — and does not require the schedule to point back at
   * this task, which it could not: the task does not have an id until it is created.
   */
  private async assertTriggerSatisfied(
    tenantId: string,
    trigger: TaskTriggerType,
    input: CreateTaskInput,
  ): Promise<void> {
    if (requiresSchedule(trigger)) {
      if (input.scheduleId === undefined || input.scheduleId === null) {
        throw new ApiError('VALIDATION_ERROR', 'A recurring task requires "scheduleId"', {
          field: 'scheduleId',
          triggerType: trigger,
        });
      }

      const schedule = await this.deps.schedules.findById(tenantId, input.scheduleId);
      if (schedule === null) {
        throw new ApiError('VALIDATION_ERROR', 'The schedule does not exist', {
          field: 'scheduleId',
          scheduleId: input.scheduleId,
        });
      }
      if (schedule.kind !== 'recurring') {
        throw new ApiError(
          'VALIDATION_ERROR',
          `A recurring task needs a recurring schedule, but that schedule is ${schedule.kind}`,
          { field: 'scheduleId', kind: schedule.kind },
        );
      }
      return;
    }

    if (requiresEventSubscription(trigger)) {
      if (input.eventSubscriptionId === undefined || input.eventSubscriptionId === null) {
        throw new ApiError('VALIDATION_ERROR', 'An event task requires "eventSubscriptionId"', {
          field: 'eventSubscriptionId',
          triggerType: trigger,
        });
      }

      const subscription = await this.deps.events.findSubscriptionById(
        tenantId,
        input.eventSubscriptionId,
      );
      if (subscription === null) {
        throw new ApiError('VALIDATION_ERROR', 'The event subscription does not exist', {
          field: 'eventSubscriptionId',
          eventSubscriptionId: input.eventSubscriptionId,
        });
      }
      return;
    }

    if (trigger === 'scheduled' && (input.scheduledAt === undefined || input.scheduledAt === null)) {
      throw new ApiError('VALIDATION_ERROR', 'A scheduled task requires "scheduledAt"', {
        field: 'scheduledAt',
      });
    }
  }

  private async assertReferencesExist(
    tenantId: string,
    input: CreateTaskInput,
  ): Promise<void> {
    if (input.agentId !== undefined && input.agentId !== null) {
      const agent = await this.deps.agents.findById(tenantId, input.agentId);
      if (agent === null) {
        throw new ApiError('VALIDATION_ERROR', 'The agent does not exist', {
          agentId: input.agentId,
        });
      }
    }

    if (input.goalId !== undefined && input.goalId !== null) {
      const goal = await this.deps.goals.findById(tenantId, input.goalId);
      if (goal === null) {
        throw new ApiError('VALIDATION_ERROR', 'The goal does not exist', { goalId: input.goalId });
      }
    }

    if (input.workflowId !== undefined && input.workflowId !== null) {
      const workflow = await this.deps.workflows.findById(tenantId, input.workflowId);
      if (workflow === null) {
        throw new ApiError('VALIDATION_ERROR', 'The workflow does not exist', {
          workflowId: input.workflowId,
        });
      }
    }
  }

  private async detail(tenantId: string, id: string): Promise<TaskDetail> {
    const task = await this.requireTask(tenantId, id);
    const runs = await this.deps.runs.list(tenantId, { taskId: id });
    return toTaskDetail(task, runs.map((run) => run.id));
  }

  private async requireTask(tenantId: string, id: string) {
    const task = await this.deps.tasks.findById(tenantId, id);
    if (task === null) throw notFound(id);
    return task;
  }
}

function notFound(id: string): ApiError {
  return new ApiError('NOT_FOUND', 'The task does not exist', { taskId: id });
}
