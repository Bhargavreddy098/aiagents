import { ApiError, runKindFor, type RunKind } from '@nexs/shared';
import type { AgentRepository } from '../../repositories/agent.repo.js';
import type { RunRepository } from '../../repositories/run.repo.js';
import type { TaskRepository } from '../../repositories/task.repo.js';
import type { WorkflowService } from '../workflows/workflow.service.js';
import type { RunQueue } from '../queue/run-queue.js';
import type { Logger } from '../../logger.js';

/**
 * Starting the run that a trigger's occurrence calls for.
 *
 * ## Why this is shared
 *
 * A schedule firing and an event matching end in the same place: a `Run` that the engine
 * executes, identified by an occurrence so that a redelivered queue job does not produce a
 * second run. Schedules and events differ only in *why* they fire. Writing the run-creation
 * twice would be two places for the idempotency rule to be got wrong, and the rule is the
 * one thing here that must not be.
 *
 * ## The occurrence key
 *
 * Every run created here carries `idempotencyKey = occurrenceKey`, and the caller passes the
 * **transport's job id**. That choice is the whole point: a pg-boss job that is redelivered
 * after a crash keeps its id, so the run repository's unique index on
 * `(tenantId, idempotencyKey)` collapses the redelivery into the run that already exists. A
 * key derived from the clock would not — the redelivery would look like a new occurrence and
 * the workflow would run twice, which is the failure this exists to prevent.
 *
 * ## What each target kind does, and why they differ
 *
 * - **`workflow`** goes through `WorkflowService.run`, because a workflow's plan is its
 *   stored steps and only that service builds the plan from them and pins the active
 *   version. Creating the run directly would hand the engine a run with no plan, and the
 *   engine would *plan it with a model* — silently executing an LLM's idea of the workflow
 *   instead of the workflow.
 * - **`task`** creates the run directly, because a task is a stored request rather than a
 *   stored program: its input is the run's input.
 * - **`agent`** creates the run directly with no task or workflow behind it. This is the one
 *   case that produces a `kind` the caller must supply, since nothing else identifies it.
 */

export type OccurrenceTargetKind = 'task' | 'workflow' | 'agent';

export interface OccurrenceRequest {
  tenantId: string;
  target: { kind: OccurrenceTargetKind; id: string };
  /**
   * Stable identity of this occurrence. The queue job id, so a redelivery dedupes.
   *
   * Callers that have no transport job (a manual fire from the API) must synthesise one that
   * is stable for the thing being fired and unique between occurrences.
   */
  occurrenceKey: string;
  /** The trigger's payload, if any. How it is used depends on the target kind. */
  payload?: unknown;
  /** Run kind for an `agent` target, which has nothing else to derive one from. */
  runKind?: RunKind;
}

export interface OccurrenceResult {
  runId: string;
  taskId: string | null;
  workflowId: string | null;
  agentId: string | null;
}

export interface OccurrenceStarterDeps {
  runs: RunRepository;
  tasks: TaskRepository;
  agents: AgentRepository;
  workflows: WorkflowService;
  queue: RunQueue;
  logger: Logger;
}

export class OccurrenceStarter {
  constructor(private readonly deps: OccurrenceStarterDeps) {}

  async start(request: OccurrenceRequest): Promise<OccurrenceResult> {
    switch (request.target.kind) {
      case 'workflow':
        return this.startWorkflow(request);
      case 'task':
        return this.startTask(request);
      case 'agent':
        return this.startAgent(request);
      default: {
        // Exhaustiveness. A new target kind that reaches here would otherwise silently
        // start nothing, which is the worst possible outcome for a trigger.
        const unreachable: never = request.target.kind;
        throw new ApiError('VALIDATION_ERROR', `Unsupported trigger target "${String(unreachable)}"`);
      }
    }
  }

  private async startWorkflow(request: OccurrenceRequest): Promise<OccurrenceResult> {
    const { runId } = await this.deps.workflows.run(request.tenantId, request.target.id, {
      // The raw payload, not a nested copy. A workflow has no stored input of its own, and
      // the engine resolves a run's model from `input.context.modelId` — nesting the payload
      // would put that out of reach and leave every agent-less scheduled workflow unable to
      // name a model.
      ...(request.payload === undefined ? {} : { input: readObject(request.payload) }),
      idempotencyKey: request.occurrenceKey,
    });

    this.deps.logger.info(
      { tenantId: request.tenantId, workflowId: request.target.id, runId },
      'trigger started a workflow run',
    );

    return { runId, taskId: null, workflowId: request.target.id, agentId: null };
  }

  private async startTask(request: OccurrenceRequest): Promise<OccurrenceResult> {
    const task = await this.deps.tasks.findById(request.tenantId, request.target.id);
    if (task === null) {
      throw new ApiError('NOT_FOUND', 'The task this trigger points at does not exist', {
        taskId: request.target.id,
      });
    }

    const kind = runKindFor({
      goalId: task.goalId,
      taskId: task.id,
      workflowId: task.workflowId,
    });

    const run = await this.deps.runs.create({
      tenantId: request.tenantId,
      kind,
      agentId: task.agentId,
      goalId: task.goalId,
      taskId: task.id,
      workflowId: task.workflowId,
      /**
       * The task's stored input is its configuration, and the trigger's payload is the data
       * for *this* occurrence — so the payload is nested under `trigger` rather than merged
       * over the top. A shallow merge would let an inbound webhook body overwrite
       * `context.modelId` and break the very run it was meant to start.
       */
      input: {
        ...readObject(task.input),
        ...(request.payload === undefined ? {} : { trigger: request.payload }),
      },
      idempotencyKey: request.occurrenceKey,
    });

    await this.deps.queue.enqueue({ runId: run.id, tenantId: request.tenantId, kind });

    this.deps.logger.info(
      { tenantId: request.tenantId, taskId: task.id, runId: run.id, kind },
      'trigger started a task run',
    );

    return { runId: run.id, taskId: task.id, workflowId: task.workflowId, agentId: task.agentId };
  }

  private async startAgent(request: OccurrenceRequest): Promise<OccurrenceResult> {
    const agent = await this.deps.agents.findById(request.tenantId, request.target.id);
    if (agent === null) {
      throw new ApiError('NOT_FOUND', 'The agent this trigger points at does not exist', {
        agentId: request.target.id,
      });
    }

    const kind = request.runKind ?? 'event';
    const run = await this.deps.runs.create({
      tenantId: request.tenantId,
      kind,
      agentId: agent.id,
      input: readObject(request.payload),
      idempotencyKey: request.occurrenceKey,
    });

    await this.deps.queue.enqueue({ runId: run.id, tenantId: request.tenantId, kind });

    this.deps.logger.info(
      { tenantId: request.tenantId, agentId: agent.id, runId: run.id, kind },
      'trigger started an agent run',
    );

    return { runId: run.id, taskId: null, workflowId: null, agentId: agent.id };
  }
}

/**
 * A payload as a plain object.
 *
 * A `Run.input` is a JSON object, and a webhook payload is whatever the producer sent —
 * which may be an array or a scalar. Wrapping a non-object keeps the column's shape uniform
 * instead of storing a bare string, and `value` is the key so nothing about the original is
 * lost.
 */
function readObject(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}
