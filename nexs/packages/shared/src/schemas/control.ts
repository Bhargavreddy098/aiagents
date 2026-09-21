import { z } from 'zod';
import {
  AGENT_STATUSES,
  GOAL_STATUSES,
  TASK_TRIGGER_TYPES,
  WORKFLOW_ON_FAIL,
  WORKFLOW_STEP_TYPES,
} from '../types/control.js';
import { APPROVAL_POLICY_MODES } from '../types/engine.js';

/**
 * Control-plane input schemas.
 *
 * Two conventions run through this file, both of them there to keep the failure message
 * actionable:
 *
 *  1. **`updateSchema`s are `.strict()` and every field is optional.** A `PATCH` that names
 *     a field which does not exist is a typo, and silently dropping it means the caller
 *     believes they changed something they did not. `.strict()` turns that into an
 *     "unrecognized key" error naming the key.
 *  2. **Nothing here is `.default()`-ed.** A default applied at the boundary is a value the
 *     caller never sent being written to a row, and it makes the service unable to tell
 *     "set this to X" from "said nothing". Defaults belong where the row is created, so
 *     the schema's job stays "is this well-formed?".
 */

// ── shared pieces ─────────────────────────────────────────────────────────────

const id = z.string().trim().min(1);
const idList = z.array(id);

/** `z.unknown()` rather than `z.any()`: the value is stored verbatim, never traversed. */
const jsonObject = z.record(z.string(), z.unknown());

const approvalPolicy = z
  .object({
    mode: z.enum(APPROVAL_POLICY_MODES),
    /** Only meaningful for `risk-based`; ignored otherwise. */
    minRiskLevel: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();

/**
 * Execution limits as an operator writes them — all optional, because the engine merges
 * whatever is supplied over `DEFAULT_RUN_LIMITS`. Requiring all five would mean an
 * operator changing one budget has to restate the other four, and would silently pin them
 * to today's defaults forever.
 */
const executionLimits = z
  .object({
    maxSteps: z.number().int().positive().max(1000).optional(),
    maxDurationMs: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().positive().max(10_000).optional(),
    maxContextTokens: z.number().int().positive().optional(),
    stepTimeoutMs: z.number().int().positive().optional(),
    maxRetries: z.number().int().min(0).max(10).optional(),
  })
  .strict();

const priority = z.number().int().min(1).max(5);

// ── agents ────────────────────────────────────────────────────────────────────

const agentConfigFields = {
  instructions: z.string().max(32_000),
  modelId: id.nullable(),
  fallbackModelId: id.nullable(),
  toolIds: idList,
  mcpServerIds: idList,
  connectorAccountIds: idList,
  memoryEnabled: z.boolean(),
  browserAccess: z.boolean(),
  sandboxAccess: z.boolean(),
  approvalPolicy,
  executionLimits,
};

/**
 * Every config field as optional, which is how both `create` and `update` see it.
 *
 * The fields are optional and carry **no defaults**, and that is a deliberate choice worth
 * stating rather than an omission. A schema default is a value the caller never sent being
 * written to a row, which makes "set this to X" indistinguishable from "said nothing"
 * further down — and the versioning logic compares snapshots to decide whether a change
 * warrants a new version, so it cares about exactly that distinction. The defaults live in
 * `AgentService`, applied at row creation, so the boundary stays honest about what actually
 * arrived.
 *
 * Declared once and shared by both schemas rather than written out twice: the two lists are
 * the same list, and the only reason they were ever different is that one of them was
 * written by hand and got it wrong.
 */
const optionalAgentConfigFields = {
  instructions: agentConfigFields.instructions.optional(),
  modelId: agentConfigFields.modelId.optional(),
  fallbackModelId: agentConfigFields.fallbackModelId.optional(),
  toolIds: agentConfigFields.toolIds.optional(),
  mcpServerIds: agentConfigFields.mcpServerIds.optional(),
  connectorAccountIds: agentConfigFields.connectorAccountIds.optional(),
  memoryEnabled: agentConfigFields.memoryEnabled.optional(),
  browserAccess: agentConfigFields.browserAccess.optional(),
  sandboxAccess: agentConfigFields.sandboxAccess.optional(),
  approvalPolicy: agentConfigFields.approvalPolicy.optional(),
  executionLimits: agentConfigFields.executionLimits.optional(),
};

export const createAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    ...optionalAgentConfigFields,
  })
  .strict();

/**
 * A `PATCH` may change the name, the description, or any subset of the config.
 *
 * No `.strict()`-visible distinction is drawn between "a config change" and "a metadata
 * change" here, because the service already has to compare the resulting snapshot against
 * the current one to decide whether a version is warranted — and a rename that mints a
 * version would bury the versions that matter.
 */
export const updateAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    ...optionalAgentConfigFields,
  })
  .strict();

export const listAgentsSchema = z
  .object({
    /** `all` is the explicit "do not filter" — distinct from omitting the key. */
    status: z.enum(['all', ...AGENT_STATUSES]).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

// ── goals ─────────────────────────────────────────────────────────────────────

/**
 * A goal criterion as an operator writes it.
 *
 * `type` is left as a free string here rather than an enum of the verifier's types, and
 * that is a deliberate asymmetry with the read path: `readSuccessCriteria` narrows stored
 * criteria and *drops* the ones it does not recognise, logging the drop. Rejecting an
 * unknown type at the boundary instead would be the stronger check — but the verifier's
 * type list is the engine's, and duplicating it here would create a second copy that can
 * fall out of step with the first. The narrowing happens once, where the criteria are
 * consumed.
 */
const goalCriterion = z
  .object({
    type: z.string().trim().min(1),
    config: jsonObject.optional(),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

export const createGoalSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(4000).optional(),
    agentId: id.nullable().optional(),
    priority: priority.optional(),
    criteria: z.array(goalCriterion).max(50).optional(),
    constraints: z.array(jsonObject).max(50).optional(),
    deadline: z.coerce.date().nullable().optional(),
  })
  .strict();

export const updateGoalSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().max(4000).optional(),
    agentId: id.nullable().optional(),
    priority: priority.optional(),
    criteria: z.array(goalCriterion).max(50).optional(),
    constraints: z.array(jsonObject).max(50).optional(),
    deadline: z.coerce.date().nullable().optional(),
  })
  .strict();

/**
 * A status change.
 *
 * `completedVerificationId` is accepted here because completing a goal *is* a status
 * change that carries an argument. It is not trusted — the service re-reads the
 * verification row and checks that it passed — but it has to arrive with the request,
 * because only the caller knows which verification they mean when a goal has several.
 */
export const setGoalStatusSchema = z
  .object({
    status: z.enum(GOAL_STATUSES),
    completedVerificationId: id.optional(),
  })
  .strict();

// ── tasks ─────────────────────────────────────────────────────────────────────

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(4000).optional(),
    goalId: id.nullable().optional(),
    agentId: id.nullable().optional(),
    workflowId: id.nullable().optional(),
    priority: priority.optional(),
    triggerType: z.enum(TASK_TRIGGER_TYPES),
    scheduledAt: z.coerce.date().nullable().optional(),
    scheduleId: id.nullable().optional(),
    eventSubscriptionId: id.nullable().optional(),
    input: jsonObject.optional(),
    idempotencyKey: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.triggerType !== 'scheduled' || value.scheduledAt !== undefined,
    // A `scheduled` task with no time is a task that will never run, and the failure would
    // be silence rather than an error.
    { message: 'a scheduled task requires "scheduledAt"', path: ['scheduledAt'] },
  );

// ── workflows ─────────────────────────────────────────────────────────────────

/**
 * A workflow step as an operator writes it.
 *
 * `toolId` is not conditionally required here even though the engine requires it for a
 * tool step, because the condition depends on `stepType` — and a `refine` over the array
 * gives a better message than a per-field rule can, since it can say which step is wrong.
 * That check lives in `validateWorkflowSteps`, which the service calls before writing.
 */
export const workflowStepSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    stepType: z.enum(WORKFLOW_STEP_TYPES),
    config: jsonObject,
    toolId: id.optional(),
    dependsOn: z.array(z.string().trim().min(1)).optional(),
    retryPolicy: z
      .object({
        maxRetries: z.number().int().min(0).max(10),
        backoffMs: z.number().int().min(0).max(300_000),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().int().positive().max(3_600_000).nullable().optional(),
    onFail: z.enum(WORKFLOW_ON_FAIL).optional(),
  })
  .strict();

export const createWorkflowSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).optional(),
    steps: z.array(workflowStepSchema).min(1).max(200),
  })
  .strict();

/**
 * A new version of an existing workflow.
 *
 * Steps are required and replace the previous set wholesale. A `PATCH`-style step edit
 * would need per-step identity and a diff, and the version is immutable once written —
 * so "edit a workflow" is honestly "publish version n+1", not "mutate version n".
 */
export const updateWorkflowSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(4000).optional(),
    steps: z.array(workflowStepSchema).min(1).max(200),
  })
  .strict();

export const runWorkflowSchema = z
  .object({
    agentId: id.optional(),
    goalId: id.optional(),
    taskId: id.optional(),
    input: jsonObject.optional(),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

// ── runs ──────────────────────────────────────────────────────────────────────

export const listRunsSchema = z
  .object({
    status: z.string().trim().min(1).optional(),
    agentId: id.optional(),
    goalId: id.optional(),
    taskId: id.optional(),
    workflowId: id.optional(),
    /** Inclusive lower bound on `createdAt`. */
    since: z.coerce.date().optional(),
    /** Exclusive upper bound on `createdAt`. */
    until: z.coerce.date().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

// ── inferred input types ──────────────────────────────────────────────────────

export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export type ListAgentsQuery = z.infer<typeof listAgentsSchema>;

export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;
export type SetGoalStatusInput = z.infer<typeof setGoalStatusSchema>;

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export type WorkflowStepInput = z.infer<typeof workflowStepSchema>;
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;
export type RunWorkflowInput = z.infer<typeof runWorkflowSchema>;

export type ListRunsQuery = z.infer<typeof listRunsSchema>;
