import {
  ApiError,
  canTransitionWorkflow,
  isRunnableWorkflowStatus,
  type CreateWorkflowInput,
  type PlanStep,
  type RunWorkflowInput,
  type UpdateWorkflowInput,
  type WorkflowDetail,
  type WorkflowStatus,
  type WorkflowSummary,
} from '@nexs/shared';
import { validatePlanValue } from '../engine/plan.js';
import { canResolveModel, readContextBlock } from '../engine/run-input.js';
import {
  planFromInputSteps,
  planFromStoredSteps,
  validateWorkflowSteps,
  type WorkflowRepository,
  type WorkflowStepRow,
} from '../../repositories/workflow.repo.js';
import type { AgentRepository } from '../../repositories/agent.repo.js';
import type { ToolRepository } from '../../repositories/mcp.repo.js';
import type { RunRepository } from '../../repositories/run.repo.js';
import type { RunQueue } from '../queue/run-queue.js';
import type { Logger } from '../../logger.js';
import { toWorkflowDetail, toWorkflowSummary } from '../../mappers/control.js';

/**
 * Workflows: stored, versioned step graphs.
 *
 * Two things distinguish this service from ordinary CRUD:
 *
 *  1. **Steps are validated before they are written.** A workflow whose third step names a
 *     deleted tool would otherwise be accepted today and fail at 3am in a scheduled run.
 *     The validation is the engine's own ladder, not a second implementation of it — see
 *     `assertStepsValid`.
 *  2. **Running one presets the plan.** A workflow is a program a human wrote, so the
 *     engine must not re-derive it from a model. The plan is copied into the run's input,
 *     which freezes it by value: the schema has no `Run.workflowVersionId`, so editing the
 *     workflow afterwards cannot disturb a run already in flight.
 */

export interface WorkflowServiceDeps {
  workflows: WorkflowRepository;
  tools: ToolRepository;
  agents: AgentRepository;
  runs: RunRepository;
  queue: RunQueue;
  logger: Logger;
}

export class WorkflowService {
  constructor(private readonly deps: WorkflowServiceDeps) {}

  async create(tenantId: string, input: CreateWorkflowInput): Promise<WorkflowDetail> {
    const steps = input.steps as WorkflowStepRow[];
    await this.assertStepsValid(tenantId, steps);

    const created = await this.deps.workflows.create({
      tenantId,
      name: input.name,
      description: input.description ?? null,
      // `draft`, so a workflow is never runnable before someone has looked at it.
      status: 'draft',
      steps,
    });

    this.deps.logger.info(
      { tenantId, workflowId: created.workflow.id, steps: steps.length },
      'workflow created',
    );
    return this.detail(tenantId, created.workflow.id);
  }

  async list(
    tenantId: string,
    query: { status?: WorkflowStatus; limit?: number } = {},
  ): Promise<WorkflowSummary[]> {
    const workflows = await this.deps.workflows.list(tenantId, query);
    return workflows.map(toWorkflowSummary);
  }

  async get(tenantId: string, id: string): Promise<WorkflowDetail> {
    return this.detail(tenantId, id);
  }

  /** Publish version n+1. The previous version is left exactly as it was. */
  async addVersion(
    tenantId: string,
    id: string,
    input: UpdateWorkflowInput,
  ): Promise<WorkflowDetail> {
    await this.requireWorkflow(tenantId, id);

    const steps = input.steps as WorkflowStepRow[];
    await this.assertStepsValid(tenantId, steps);

    const result = await this.deps.workflows.addVersion(tenantId, id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      steps,
    });
    if (result === null) throw notFound(id);

    this.deps.logger.info(
      { tenantId, workflowId: id, version: result.version.version },
      'workflow version published',
    );
    return this.detail(tenantId, id);
  }

  async setStatus(
    tenantId: string,
    id: string,
    target: WorkflowStatus,
  ): Promise<WorkflowDetail> {
    const workflow = await this.requireWorkflow(tenantId, id);
    const from = workflow.status as WorkflowStatus;

    if (from === target) {
      throw new ApiError('CONFLICT', `The workflow is already ${target}`, { status: from });
    }
    if (!canTransitionWorkflow(from, target)) {
      throw new ApiError('CONFLICT', `A workflow cannot go from ${from} to ${target}`, {
        from,
        to: target,
      });
    }

    // Activating a workflow with no version to run would produce a run that fails the
    // moment it is asked for its plan.
    if (target === 'active' && workflow.activeVersionId === null) {
      throw new ApiError('CONFLICT', 'The workflow has no version to activate', { workflowId: id });
    }

    const updated = await this.deps.workflows.setStatus(tenantId, id, target);
    if (updated === null) throw notFound(id);

    this.deps.logger.info({ tenantId, workflowId: id, from, to: target }, 'workflow status changed');
    return this.detail(tenantId, id);
  }

  /**
   * Start a run whose plan is this workflow's active version.
   *
   * The run's `input.context.presetPlan` carries the translated plan, so the engine's
   * `presetPlan` path picks it up and validates it through the same ladder a generated plan
   * goes through. Passing it in the input rather than re-deriving it at execution time is
   * what freezes the plan by value.
   *
   * ## What the context block has to carry, and why
   *
   * A run's configuration comes from one of two places. If `agentId` is given, the pinned
   * `AgentVersion` supplies everything — instructions, model, approval policy, limits and
   * the tool allowlist — and the workflow contributes only the plan. If no agent is given,
   * the run describes itself in `input.context`, exactly like an ad-hoc run.
   *
   * The agent-less case needs two things the workflow cannot supply on its own:
   *
   *  - **An allowlist.** `RunContext.allowedToolIds` gates every `tool` step, and a
   *    workflow's steps name tools. The workflow *is* the authorisation here: the tools its
   *    active version was authored to call are the tools it may call. Omitting this is not
   *    a harmless default — an empty allowlist refuses every tool step, so the run would be
   *    created and then fail validation on its own plan.
   *  - **A model.** `Workflow` has no model column, and `RunContext.modelId` is required,
   *    so an agent-less run has to be told. That is a `VALIDATION_ERROR` here rather than a
   *    run that fails later with a message about the engine.
   *
   * The caller's `context` is **merged**, not replaced. Replacing it dropped a supplied
   * `modelId` — which is the only way an agent-less run can name one.
   */
  async run(
    tenantId: string,
    id: string,
    input: RunWorkflowInput = {},
  ): Promise<{ runId: string }> {
    const workflow = await this.requireWorkflow(tenantId, id);

    if (!isRunnableWorkflowStatus(workflow.status as WorkflowStatus)) {
      throw new ApiError('CONFLICT', `The workflow is ${workflow.status} and cannot be run`, {
        status: workflow.status,
      });
    }

    const version = await this.deps.workflows.findActiveVersion(tenantId, id);
    if (version === null) {
      throw new ApiError('CONFLICT', 'The workflow has no active version', { workflowId: id });
    }

    if (input.agentId !== undefined) {
      const agent = await this.deps.agents.findById(tenantId, input.agentId);
      if (agent === null) {
        throw new ApiError('VALIDATION_ERROR', 'The agent does not exist', {
          agentId: input.agentId,
        });
      }
    }

    // `planFromStoredSteps`, not the input translator: the stored config already carries the
    // folded `toolId`, so there is nothing left to fold in.
    const plan = planFromStoredSteps(version.steps);

    const supplied = readContextBlock(input.input);
    if (!canResolveModel({ agentId: input.agentId ?? null, input: input.input })) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'Running a workflow without an agent requires "input.context.modelId"',
        { field: 'input.context.modelId' },
      );
    }

    const run = await this.deps.runs.create({
      tenantId,
      kind: 'workflow',
      agentId: input.agentId ?? null,
      goalId: input.goalId ?? null,
      taskId: input.taskId ?? null,
      workflowId: id,
      input: {
        ...(input.input ?? {}),
        // `context` is the key the resolver reads.
        context: {
          ...supplied,
          // Ours, and deliberately not overridable: the plan is the active version's, and
          // the allowlist is the tools that version was authored to call. Letting a caller
          // widen it would let a request grant itself a tool the workflow never declared.
          presetPlan: plan,
          allowedToolIds: planToolIds(plan),
        },
      },
      idempotencyKey: input.idempotencyKey ?? null,
    });

    await this.deps.queue.enqueue({ runId: run.id, tenantId, kind: 'workflow' });
    this.deps.logger.info(
      { tenantId, workflowId: id, version: version.version, runId: run.id },
      'workflow run created',
    );

    return { runId: run.id };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Validate a submitted step list.
   *
   * Three layers, each catching something the others cannot:
   *
   *  1. `validateWorkflowSteps` — the shape: a tool step names a tool, names are unique,
   *     dependencies refer to steps that exist. It has no dependencies, so it can say
   *     "step 3 depends on 'foo', which is not here" in terms of the submitted array.
   *  2. Tool existence — a referenced tool must exist **and be enabled** for this tenant.
   *     This is the check that cannot be done without a repository.
   *  3. `validatePlanValue` — the engine's own ladder, run on the translated plan. It
   *     catches cycles, duplicate ids and anything the schema rung rejects. Using the
   *     engine's ladder rather than a parallel graph walk is the point: a workflow that
   *     passes here is one the engine will accept at execution time, because it is the same
   *     code making both judgements.
   */
  private async assertStepsValid(tenantId: string, steps: WorkflowStepRow[]): Promise<void> {
    const shapeIssues = validateWorkflowSteps(steps);
    if (shapeIssues.length > 0) {
      throw new ApiError('VALIDATION_ERROR', shapeIssues[0]!.message, {
        issues: shapeIssues,
      });
    }

    const referenced = [
      ...new Set(steps.map((step) => step.toolId).filter((id): id is string => id !== undefined)),
    ];

    const allowedToolIds = new Set<string>();
    for (const toolId of referenced) {
      const tool = await this.deps.tools.findById(tenantId, toolId);
      if (tool === null) {
        throw new ApiError('VALIDATION_ERROR', `A step references tool ${toolId}, which does not exist`, {
          toolId,
        });
      }
      if (tool.status !== 'enabled') {
        throw new ApiError('VALIDATION_ERROR', `A step references tool ${toolId}, which is ${tool.status}`, {
          toolId,
          status: tool.status,
        });
      }
      allowedToolIds.add(tool.id);
    }

    const plan = planFromInputSteps(steps);
    const validated = validatePlanValue(plan, {
      allowedToolIds,
      // A generous bound: this is a stored program, not a model's guess, and the run's own
      // `maxSteps` limit is what actually bounds execution. A low ceiling here would reject
      // a legitimate long workflow at the editor.
      maxSteps: 200,
    });

    if (!validated.ok) {
      throw new ApiError('VALIDATION_ERROR', validated.issues[0]!.message, {
        issues: validated.issues,
      });
    }
  }

  private async detail(tenantId: string, id: string): Promise<WorkflowDetail> {
    const workflow = await this.requireWorkflow(tenantId, id);
    const versions = await this.deps.workflows.listVersions(tenantId, id);
    return toWorkflowDetail(workflow, versions);
  }

  private async requireWorkflow(tenantId: string, id: string) {
    const workflow = await this.deps.workflows.findById(tenantId, id);
    if (workflow === null) throw notFound(id);
    return workflow;
  }
}

function notFound(id: string): ApiError {
  return new ApiError('NOT_FOUND', 'The workflow does not exist', { workflowId: id });
}

/**
 * The distinct tool ids a plan calls, which become the run's allowlist.
 *
 * A `Set` because a workflow may call the same tool in several steps, and the allowlist is
 * a set of permissions rather than a list of calls.
 */
function planToolIds(plan: readonly PlanStep[]): string[] {
  const ids = new Set<string>();
  for (const step of plan) {
    if (typeof step.toolId === 'string' && step.toolId.length > 0) ids.add(step.toolId);
  }
  return [...ids];
}
