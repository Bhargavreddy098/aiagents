/**
 * Execution-engine contracts.
 *
 * Everything the engine persists or emits has a shape here, and nothing in this file
 * mentions Prisma, pg-boss, SSE or HTTP. The engine is written against these types; the
 * repositories map them onto columns and the transport layer maps them onto frames.
 *
 * Two properties are structural rather than conventional, and both are encoded below:
 *
 *  1. **A run's state is a state machine, not a string.** `RUN_STATUSES` and
 *     `RUN_TRANSITIONS` are the same source of truth, so a status that cannot legally be
 *     reached is rejected at the boundary rather than discovered in the database later.
 *  2. **A plan step's identity is its `id`, not its index.** `dependsOn` references ids,
 *     which is what makes the acyclicity check meaningful and what lets the engine resume
 *     a partially-executed plan whose ordering was never the array order.
 */

// ── run state machine ─────────────────────────────────────────────────────────

export const RUN_STATUSES = [
  'queued',
  'planning',
  'running',
  'waiting_approval',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'timeout',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * The legal transitions, per the state machine in §5.1.
 *
 * `queued → planning` and `planning → running` exist because planning is itself a step:
 * a run that is being planned has not started executing, and the UI shows that
 * distinction. A plan-less run (a chat turn with no tools) still passes through
 * `planning` so that every run has one shape in the database.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['planning', 'running', 'cancelled'],
  planning: ['running', 'waiting_approval', 'failed', 'cancelled', 'timeout', 'paused'],
  running: ['waiting_approval', 'paused', 'completed', 'failed', 'cancelled', 'timeout'],
  waiting_approval: ['running', 'paused', 'failed', 'cancelled', 'timeout'],
  paused: ['running', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
  timeout: [],
};

/** No further work will happen without an explicit operator action. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return RUN_TRANSITIONS[status].length === 0;
}

/** The run holds a worker slot. Used by the per-tenant concurrency accounting. */
export function isActiveRunStatus(status: RunStatus): boolean {
  return status === 'planning' || status === 'running' || status === 'waiting_approval';
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

// ── step state machine ────────────────────────────────────────────────────────

export const STEP_STATUSES = [
  'pending',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'skipped',
] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

export const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  pending: ['running', 'waiting_approval', 'skipped', 'failed'],
  running: ['completed', 'failed', 'waiting_approval', 'skipped'],
  waiting_approval: ['running', 'skipped', 'failed'],
  completed: [],
  failed: ['running'],
  skipped: [],
};

export function isTerminalStepStatus(status: StepStatus): boolean {
  return status === 'completed' || status === 'skipped';
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

// ── plan ──────────────────────────────────────────────────────────────────────

/**
 * The step types a *planner* may emit.
 *
 * Deliberately narrower than `Step.stepType` in the schema, which also carries `mcp`,
 * `connector`, `browser`, `sandbox` and `notification`. Those are execution *mechanisms*
 * resolved from a tool row at run time; a planner that emitted `browser` would be
 * choosing an implementation rather than an intent, and would bypass the tool allowlist
 * that the validation ladder enforces. A tool step names a `toolId` and the invoker
 * decides how to reach it.
 */
export const PLAN_STEP_TYPES = [
  'model',
  'tool',
  'condition',
  'approval',
  'verification',
  'transform',
] as const;

export type PlanStepType = (typeof PLAN_STEP_TYPES)[number];

export interface PlanStep {
  /** Stable within a plan. `dependsOn` references these, never indices. */
  id: string;
  /** Human-readable intent. This is what the UI renders — never raw reasoning. */
  description: string;
  stepType: PlanStepType;
  /** Required for `tool` steps; validated against the agent's allowlist. */
  toolId?: string;
  config: Record<string, unknown>;
  dependsOn?: string[];
}

/**
 * Why a plan was rejected. Every field is present in the structured error the run
 * records, because "the plan was invalid" is not actionable and the correction retry
 * needs the exact reason to have any chance of fixing it.
 */
export interface PlanValidationIssue {
  /** Dotted path into the plan, e.g. `steps[2].dependsOn`. */
  path: string;
  message: string;
  /** Machine-readable discriminator, so the retry prompt can be built without parsing prose. */
  code:
    | 'not_json'
    | 'schema'
    | 'shape'
    | 'too_many_steps'
    | 'duplicate_id'
    | 'unknown_dependency'
    | 'cyclic'
    | 'self_dependency'
    | 'unknown_tool'
    | 'missing_tool_id'
    | 'empty_plan';
}

export type PlanValidationResult =
  | { ok: true; plan: PlanStep[] }
  | { ok: false; issues: PlanValidationIssue[] };

// ── checkpoint ────────────────────────────────────────────────────────────────

/**
 * The commit boundary.
 *
 * `completedSteps` is keyed by plan-step id rather than by index, so inserting or
 * reordering a step in a later attempt cannot silently skip or repeat a different step —
 * the worst a reordered plan can do is fail to find a key and re-run that step, which is
 * the safe direction.
 */
export interface RunCheckpoint {
  /** Index of the next step to consider in `Run.plan`. An optimisation, not the truth. */
  nextIndex: number;
  completedSteps: Record<string, { output?: unknown; completedAt: string }>;
  /** Named outputs, addressable from `condition` and `transform` configs. */
  outputs: Record<string, unknown>;
  toolCallCount: number;
  startedAt: string;
  /** Set once the planner has produced a validated plan. */
  planned?: boolean;
  /**
   * Approval decisions the engine itself has recorded, keyed by plan-step id.
   *
   * The `Approval` table becomes the system of record in Phase 7, and the engine reads
   * from it through the approval gate when one is wired. This is the engine's own replay
   * state, and it is what makes the park/resume cycle complete — and testable — before
   * that table exists. When both are present the checkpoint wins, because it is the state
   * the engine has already acted on.
   */
  approvals?: Record<string, { approvalId: string; decision: 'approved' | 'rejected' }>;
}

export function emptyCheckpoint(startedAt: string): RunCheckpoint {
  return { nextIndex: 0, completedSteps: {}, outputs: {}, toolCallCount: 0, startedAt };
}

// ── limits ────────────────────────────────────────────────────────────────────

/**
 * All three limits from [gap #16] plus the per-step timeout.
 *
 * They are enforced at different boundaries on purpose: `maxSteps` before the plan is
 * accepted (so an absurd plan never becomes a row), `maxToolCalls` before each tool
 * dispatch (so a loop that keeps calling tools is stopped by the counter, not by a
 * wall-clock guess), and `maxDurationMs` at every step boundary.
 */
export interface RunLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxDurationMs: number;
  stepTimeoutMs: number;
  maxRetries: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxSteps: 25,
  maxToolCalls: 50,
  maxDurationMs: 15 * 60_000,
  stepTimeoutMs: 120_000,
  maxRetries: 2,
};

// ── approval policy ───────────────────────────────────────────────────────────

/**
 * The approval modes, as a list rather than a bare union.
 *
 * The list exists so the HTTP boundary can validate against the same source the engine
 * switches on. A `z.enum` cannot be derived from a type alias, so without this the schema
 * would carry a second, hand-written copy of these three strings — and a mode added to the
 * engine but not to the schema would be rejected at the boundary as invalid, which is a
 * confusing way to find out about a missing edit.
 */
export const APPROVAL_POLICY_MODES = ['none', 'all', 'risk-based'] as const;

export type ApprovalMode = (typeof APPROVAL_POLICY_MODES)[number];

export interface ApprovalRule {
  match: {
    toolCapabilities?: string[];
    minRisk?: 'low' | 'medium' | 'high';
    toolNames?: string[];
  };
}

export interface ApprovalPolicy {
  mode: ApprovalMode;
  rules?: ApprovalRule[];
  /** Defaults to 15 minutes when absent. */
  expiryMs?: number;
}

export const DEFAULT_APPROVAL_EXPIRY_MS = 900_000;

export function normaliseApprovalPolicy(value: unknown): ApprovalPolicy {
  if (value === null || typeof value !== 'object') return { mode: 'none' };
  const candidate = value as Partial<ApprovalPolicy>;
  const mode = candidate.mode;
  if (mode === undefined || !APPROVAL_POLICY_MODES.includes(mode)) return { mode: 'none' };
  const policy: ApprovalPolicy = { mode };
  if (Array.isArray(candidate.rules)) policy.rules = candidate.rules;
  if (typeof candidate.expiryMs === 'number' && candidate.expiryMs > 0) {
    policy.expiryMs = candidate.expiryMs;
  }
  return policy;
}

// ── verification ──────────────────────────────────────────────────────────────

export const VERIFIER_TYPES = [
  'schema',
  'content',
  'http_response',
  'file_exists',
  'tool_result',
  'browser_state',
  'goal_criteria',
  'human',
] as const;

export type VerifierType = (typeof VERIFIER_TYPES)[number];

/**
 * A success criterion attached to a goal.
 *
 * `goal_criteria` is deliberately not in this union: a criterion that verified another
 * criterion would let a goal certify itself, and the whole point of the type is that a
 * goal reaches `completed` only through evidence that originates outside it.
 */
export const SUCCESS_CRITERION_TYPES = [
  'schema',
  'content',
  'http_response',
  'file_exists',
  'tool_result',
  'browser_state',
] as const;

export type SuccessCriterionType = (typeof SUCCESS_CRITERION_TYPES)[number];

export interface SuccessCriterion {
  type: SuccessCriterionType;
  config: Record<string, unknown>;
  description: string;
}

export interface VerificationOutcome {
  passed: boolean;
  /** What the verifier actually observed, so a failure is diagnosable. */
  evidence: Record<string, unknown>;
  /** Set when the verifier could not run at all — distinct from "ran and failed". */
  error?: string;
}

// ── structured run errors ─────────────────────────────────────────────────────

/**
 * The `Run.error` column is a string, so a structured error has to be serialised into
 * it. Rather than inventing a second encoding, the engine writes JSON and reads it back
 * through this type, and the UI falls back to showing the raw string when it is not JSON.
 */
export interface StructuredRunError {
  code:
    | 'PLAN_INVALID'
    | 'PLAN_FAILED'
    | 'STEP_FAILED'
    | 'STEP_TIMEOUT'
    | 'RUN_TIMEOUT'
    | 'TOOL_LIMIT_EXCEEDED'
    | 'STEP_LIMIT_EXCEEDED'
    | 'CANCELLED'
    | 'APPROVAL_REJECTED'
    | 'APPROVAL_EXPIRED'
    | 'INTERNAL';
  message: string;
  /** Plan-step id, when the failure belongs to one step. */
  stepId?: string;
  /** Populated for `PLAN_INVALID`. */
  issues?: PlanValidationIssue[];
  /** Anything else worth keeping, already JSON-safe. */
  details?: Record<string, unknown>;
}

export function serialiseRunError(error: StructuredRunError): string {
  return JSON.stringify(error);
}

export function parseRunError(raw: string | null | undefined): StructuredRunError | null {
  if (raw === null || raw === undefined || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && 'code' in parsed && 'message' in parsed) {
      return parsed as StructuredRunError;
    }
    return null;
  } catch {
    return null;
  }
}

// ── run kinds ─────────────────────────────────────────────────────────────────

export const RUN_KINDS = ['chat', 'task', 'workflow', 'goal', 'research', 'event'] as const;

export type RunKind = (typeof RUN_KINDS)[number];
