/**
 * Control-plane contracts: agents, goals, tasks and workflows.
 *
 * Phase 6 is where the things an operator *configures* appear, as opposed to the things
 * the engine *does*. The contracts live here for the same reason the engine's do: the
 * service layer, the repositories and the HTTP boundary all have to agree, and a status
 * that cannot legally be reached should be rejected at the boundary rather than
 * discovered in the database later.
 *
 * Three properties are structural rather than conventional:
 *
 *  1. **Every status is a state machine.** `AGENT_TRANSITIONS`, `GOAL_TRANSITIONS` and
 *     `WORKFLOW_TRANSITIONS` are the same source of truth as their status lists.
 *  2. **A config snapshot is frozen and complete.** `AgentConfigSnapshot` is what an
 *     `AgentVersion` stores and what a run reads. It carries no id, no status and no
 *     timestamps, because those are properties of the agent, not of a version of its
 *     configuration — and including them is how a "snapshot" quietly becomes a second
 *     copy of the mutable row that then drifts from it.
 *  3. **A workflow's step vocabulary is broader than a plan's, and the mapping is
 *     explicit.** A workflow says `browser`; a plan says `tool`. `toPlanStepType` is the
 *     single place that translation happens.
 */

import { type PlanStepType, type RunKind } from './engine.js';

// ── agent state machine ───────────────────────────────────────────────────────

export const AGENT_STATUSES = ['draft', 'active', 'paused', 'disabled', 'archived'] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * The legal agent transitions.
 *
 * `archived` is terminal, and deliberately so. The action vocabulary the spec defines is
 * activate / pause / resume / disable / duplicate / delete — there is no *restore*, so a
 * soft delete that could be undone would be a delete in name only. Bringing an archived
 * agent back is done by duplicating it, which produces a **new** agent at version 1, and
 * that is the honest outcome: the archived agent's runs point at its own old versions and
 * must keep doing so.
 *
 * `draft → paused` is absent because pausing something that never ran says nothing. A
 * draft is already not running.
 */
export const AGENT_TRANSITIONS: Readonly<Record<AgentStatus, readonly AgentStatus[]>> = {
  draft: ['active', 'archived'],
  active: ['paused', 'disabled', 'archived'],
  paused: ['active', 'disabled', 'archived'],
  disabled: ['active', 'archived'],
  archived: [],
};

export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return AGENT_TRANSITIONS[status].length === 0;
}

export function canTransitionAgent(from: AgentStatus, to: AgentStatus): boolean {
  return AGENT_TRANSITIONS[from].includes(to);
}

/** Only an `active` agent may be started. Paused and disabled both mean "do not run". */
export function isRunnableAgentStatus(status: AgentStatus): boolean {
  return status === 'active';
}

// ── goal state machine ────────────────────────────────────────────────────────

export const GOAL_STATUSES = [
  'draft',
  'active',
  'paused',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * The legal goal transitions.
 *
 * The three terminal statuses are terminal. `active → completed` is allowed directly,
 * because a goal whose criteria are already satisfied has no reason to pass through
 * `paused` first — the spec's arrow diagram is a summary of the reachable states, not a
 * requirement that every path be walked.
 *
 * `blocked` is reachable from `active` and `paused` and can return to either, because
 * "blocked" describes a condition rather than a stage: something external is in the way,
 * and when it clears the goal resumes where it was.
 */
export const GOAL_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  draft: ['active', 'cancelled'],
  active: ['paused', 'blocked', 'completed', 'failed', 'cancelled'],
  paused: ['active', 'blocked', 'completed', 'failed', 'cancelled'],
  blocked: ['active', 'paused', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return GOAL_TRANSITIONS[status].length === 0;
}

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  return GOAL_TRANSITIONS[from].includes(to);
}

/**
 * The one status that may not be reached by an ordinary transition request.
 *
 * `completed` requires a passing verification, which is a stronger condition than "the
 * transition is legal". Keeping it in its own predicate means the rule is enforced in one
 * place and cannot be lost by a caller that happens to check `canTransitionGoal` only.
 */
export function requiresVerificationToReach(status: GoalStatus): boolean {
  return status === 'completed';
}

// ── task state machine ────────────────────────────────────────────────────────

export const TASK_STATUSES = [
  'queued',
  'running',
  'paused',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * A task's status deliberately mirrors its run's, minus the statuses that describe
 * execution *inside* a run.
 *
 * `planning` and `timeout` are absent: a task does not plan, and a task that times out has
 * a run that timed out — the task's own honest status is `failed`, with the run carrying
 * the reason. Having the two vocabularies be near-identical and explicitly mapped is what
 * stops the task status from becoming a second, drifting opinion about the same fact.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['paused', 'waiting_approval', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'failed', 'cancelled'],
  waiting_approval: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TASK_TRANSITIONS[status].length === 0;
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

// ── task triggers ─────────────────────────────────────────────────────────────

export const TASK_TRIGGER_TYPES = [
  'immediate',
  'scheduled',
  'recurring',
  'event',
  'manual',
] as const;

export type TaskTriggerType = (typeof TASK_TRIGGER_TYPES)[number];

/**
 * Which triggers must name a companion row, and which are self-sufficient.
 *
 * `recurring` without a `scheduleId` would be a task that claims to repeat and never does;
 * `event` without an `eventSubscriptionId` would never fire. Both are configuration
 * mistakes that should be rejected at creation rather than discovered when the task
 * silently fails to run, so the requirement is declared here rather than left to a comment.
 */
export function requiresSchedule(trigger: TaskTriggerType): boolean {
  return trigger === 'recurring';
}

export function requiresEventSubscription(trigger: TaskTriggerType): boolean {
  return trigger === 'event';
}

/** A trigger that should start a run as soon as the task is created. */
export function isImmediateTrigger(trigger: TaskTriggerType): boolean {
  return trigger === 'immediate' || trigger === 'manual';
}

// ── workflow state machine ────────────────────────────────────────────────────

export const WORKFLOW_STATUSES = ['draft', 'active', 'disabled', 'archived'] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/**
 * A workflow has no `paused`. An agent can be paused because it holds state between runs;
 * a workflow is a stored program, so "stop using this version" is `disabled` and there is
 * nothing meaningful in between.
 */
export const WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
  draft: ['active', 'archived'],
  active: ['disabled', 'archived'],
  disabled: ['active', 'archived'],
  archived: [],
};

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return WORKFLOW_TRANSITIONS[status].length === 0;
}

export function canTransitionWorkflow(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return WORKFLOW_TRANSITIONS[from].includes(to);
}

/** Only an `active` workflow with an active version can be run. */
export function isRunnableWorkflowStatus(status: WorkflowStatus): boolean {
  return status === 'active';
}

// ── workflow steps ────────────────────────────────────────────────────────────

/**
 * The step vocabulary a workflow author writes against.
 *
 * Wider than `PLAN_STEP_TYPES` on purpose. An author thinks in terms of *what* a step is —
 * "this one drives the browser", "this one calls an MCP server" — while the engine cares
 * only that the step resolves to a tool and a capability set. The extra names are the
 * author's vocabulary; `toPlanStepType` is the translation into the engine's.
 */
export const WORKFLOW_STEP_TYPES = [
  'ai',
  'tool',
  'connector',
  'mcp',
  'browser',
  'sandbox',
  'approval',
  'condition',
  'verification',
  'transform',
  'notification',
] as const;

export type WorkflowStepType = (typeof WORKFLOW_STEP_TYPES)[number];

/**
 * Map an author's step type onto the engine's.
 *
 * `connector`, `mcp`, `browser` and `sandbox` all become `tool`, because in the engine
 * every one of them *is* a tool call: the `Tool` row's `type` decides which provider
 * serves it, and the capability set decides whether it needs approval. A separate plan
 * step type per provider would push a dispatch decision into the plan that the
 * `ToolInvoker` already owns, and would mean a plan could name a provider directly —
 * bypassing the allowlist that is the whole point of resolving tools by id.
 *
 * `notification` becomes `tool` for the same reason: `notify` is a registered native tool.
 * `ai` becomes `model`, which is the engine's name for "ask the model".
 */
export function toPlanStepType(stepType: WorkflowStepType): PlanStepType {
  switch (stepType) {
    case 'ai':
      return 'model';
    case 'tool':
    case 'connector':
    case 'mcp':
    case 'browser':
    case 'sandbox':
    case 'notification':
      return 'tool';
    case 'approval':
      return 'approval';
    case 'condition':
      return 'condition';
    case 'verification':
      return 'verification';
    case 'transform':
      return 'transform';
  }
}

/** The engine step types that address a tool, and therefore require a `toolId`. */
export function workflowStepRequiresTool(stepType: WorkflowStepType): boolean {
  return toPlanStepType(stepType) === 'tool';
}

// ── workflow failure policy ───────────────────────────────────────────────────

export const WORKFLOW_ON_FAIL = ['stop', 'continue', 'retry_then_stop'] as const;

export type WorkflowOnFail = (typeof WORKFLOW_ON_FAIL)[number];

/**
 * Whether a failed step aborts the run.
 *
 * `retry_then_stop` aborts *after* the retries are exhausted, so it stops for the same
 * reason `stop` does — the difference is only how many attempts it took to get there. That
 * is why this predicate is about aborting rather than about retrying: the retry count is
 * the engine's business, and a caller asking "does the run continue?" should not have to
 * know which of the two stopping modes it is looking at.
 */
export function abortsOnFailure(onFail: WorkflowOnFail): boolean {
  return onFail !== 'continue';
}

// ── agent config snapshot ─────────────────────────────────────────────────────

/**
 * The frozen configuration an `AgentVersion` stores.
 *
 * Exactly the fields that change an agent's *behaviour*, and nothing else. The name and
 * description are deliberately excluded: renaming an agent does not change what a run
 * does, and including them would make every rename mint a new version — which would bury
 * the versions that matter under versions that do not, and make "which config did this run
 * use?" harder to answer, not easier.
 */
export interface AgentConfigSnapshot {
  instructions: string;
  modelId: string | null;
  fallbackModelId: string | null;
  /** Canonical `Tool.id` allowlist. */
  toolIds: string[];
  mcpServerIds: string[];
  connectorAccountIds: string[];
  memoryEnabled: boolean;
  browserAccess: boolean;
  sandboxAccess: boolean;
  approvalPolicy: unknown;
  executionLimits: unknown;
}

/** The agent columns that a config change is detected against, in a stable order. */
export const AGENT_CONFIG_FIELDS = [
  'instructions',
  'modelId',
  'fallbackModelId',
  'toolIds',
  'mcpServerIds',
  'connectorAccountIds',
  'memoryEnabled',
  'browserAccess',
  'sandboxAccess',
  'approvalPolicy',
  'executionLimits',
] as const satisfies readonly (keyof AgentConfigSnapshot)[];

export type AgentConfigField = (typeof AGENT_CONFIG_FIELDS)[number];

/**
 * The minimum an object must look like to be snapshotted.
 *
 * Structural rather than a Prisma type, because this package must not import Prisma — and
 * because stating the requirement as "these eleven fields" is the actual contract. A
 * Prisma `Agent` row satisfies it without a cast.
 */
export type AgentConfigSource = {
  [K in AgentConfigField]: K extends 'modelId' | 'fallbackModelId'
    ? string | null
    : K extends 'memoryEnabled' | 'browserAccess' | 'sandboxAccess'
      ? boolean
      : K extends 'instructions'
        ? string
        : K extends 'toolIds' | 'mcpServerIds' | 'connectorAccountIds'
          ? string[]
          : unknown;
};

/**
 * Freeze an agent's behaviour-defining configuration.
 *
 * Key order follows `AGENT_CONFIG_FIELDS`, and that is load-bearing rather than cosmetic:
 * `agentConfigChanged` compares with `JSON.stringify`, which is only a valid equality test
 * if both sides are built by this function. Building the object here — rather than at each
 * call site — is what guarantees that.
 */
export function snapshotAgentConfig(source: AgentConfigSource): AgentConfigSnapshot {
  return {
    instructions: source.instructions,
    modelId: source.modelId,
    fallbackModelId: source.fallbackModelId,
    toolIds: [...source.toolIds],
    mcpServerIds: [...source.mcpServerIds],
    connectorAccountIds: [...source.connectorAccountIds],
    memoryEnabled: source.memoryEnabled,
    browserAccess: source.browserAccess,
    sandboxAccess: source.sandboxAccess,
    approvalPolicy: source.approvalPolicy,
    executionLimits: source.executionLimits,
  };
}

/**
 * Whether two snapshots differ in a way that warrants a new version.
 *
 * `JSON.stringify` is the comparison, and the reason it is acceptable here is that both
 * sides are built by `snapshotAgentConfig` from the same field list in the same order — so
 * key order is not incidental, it is part of the contract. Comparing parsed objects
 * field-by-field would be more obviously correct and is the thing to do if a second
 * producer of this shape ever appears.
 */
export function agentConfigChanged(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): boolean {
  for (const field of AGENT_CONFIG_FIELDS) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) return true;
  }
  return false;
}

// ── run provenance ────────────────────────────────────────────────────────────

/**
 * What a run was started from.
 *
 * More than one of these can be set at once — a task that runs a workflow for a goal sets
 * all three — so this is not a discriminated union. The order of the checks in
 * `runKindFor` is therefore a real decision: the most specific thing the run *is* wins,
 * because that is what an operator filtering the run list is looking for.
 */
export interface RunProvenance {
  goalId?: string | null;
  taskId?: string | null;
  workflowId?: string | null;
}

export function runKindFor(provenance: RunProvenance): RunKind {
  if (provenance.workflowId !== null && provenance.workflowId !== undefined) return 'workflow';
  if (provenance.taskId !== null && provenance.taskId !== undefined) return 'task';
  if (provenance.goalId !== null && provenance.goalId !== undefined) return 'goal';
  return 'task';
}

// ── wire shapes ───────────────────────────────────────────────────────────────

/**
 * What the API returns for a control-plane entity.
 *
 * Every timestamp is an ISO string, not a `Date`. The rows carry `Date` objects, and
 * `JSON.stringify` would turn those into strings anyway — so declaring them as strings is
 * what the client actually receives, rather than what the server happens to hold. A type
 * that says `Date` and a wire that carries a string is how a client ends up calling
 * `.getTime()` on a string and failing at runtime.
 */

export interface AgentVersionSummary {
  id: string;
  version: number;
  createdAt: string;
}

/**
 * An agent as it appears in a list.
 *
 * The config fields are deliberately absent — a list of fifty agents does not need fifty
 * instruction blocks, and `AgentDetail` carries them for the one agent being viewed.
 */
export interface AgentSummary {
  id: string;
  name: string;
  description: string | null;
  status: AgentStatus;
  version: number;
  activeVersionId: string | null;
  modelId: string | null;
  toolIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** Everything known about one agent: identity, config, history and what it owns. */
export interface AgentDetail extends AgentSummary {
  instructions: string;
  fallbackModelId: string | null;
  mcpServerIds: string[];
  connectorAccountIds: string[];
  memoryEnabled: boolean;
  browserAccess: boolean;
  sandboxAccess: boolean;
  approvalPolicy: unknown;
  executionLimits: unknown;
  archivedAt: string | null;
  versions: AgentVersionSummary[];
  /**
   * What this agent owns, as counts.
   *
   * Counts rather than arrays: the detail view needs to say "12 runs" without shipping
   * twelve runs, and each of these traces to a `count()` against a real table — none is
   * computed from anything the server is holding in memory.
   */
  counts: {
    goals: number;
    tasks: number;
    runs: number;
  };
}

export interface GoalSummary {
  id: string;
  title: string;
  description: string | null;
  agentId: string | null;
  status: GoalStatus;
  priority: number;
  deadline: string | null;
  completedVerificationId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface GoalDetail extends GoalSummary {
  criteria: unknown;
  constraints: unknown;
  counts: { tasks: number };
}

export interface TaskSummary {
  id: string;
  title: string;
  description: string | null;
  goalId: string | null;
  agentId: string | null;
  workflowId: string | null;
  status: TaskStatus;
  priority: number;
  triggerType: TaskTriggerType;
  scheduledAt: string | null;
  scheduleId: string | null;
  eventSubscriptionId: string | null;
  retryCount: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends TaskSummary {
  input: unknown;
  output: unknown;
  /** The runs this task has produced, newest first. A task can outlive one run. */
  runIds: string[];
}

export interface WorkflowStepDetail {
  id: string;
  position: number;
  name: string;
  stepType: WorkflowStepType;
  config: unknown;
  dependsOn: string[];
  retryPolicy: unknown;
  timeoutMs: number | null;
  onFail: WorkflowOnFail;
}

export interface WorkflowVersionDetail {
  id: string;
  version: number;
  createdAt: string;
  steps: WorkflowStepDetail[];
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  activeVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  versions: WorkflowVersionDetail[];
}

