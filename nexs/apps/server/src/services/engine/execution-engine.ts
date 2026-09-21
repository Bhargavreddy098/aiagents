import {
  DEFAULT_APPROVAL_EXPIRY_MS,
  DEFAULT_RUN_LIMITS,
  emptyCheckpoint,
  hasSideEffects,
  isReadOnly,
  isTerminalRunStatus,
  parseRunError,
  serialiseRunError,
  type ApprovalPolicy,
  type PlanStep,
  type RunCheckpoint,
  type RunLimits,
  type RunStatus,
  type SseFrame,
  type SSEEventName,
  type StructuredRunError,
  type SuccessCriterion,
} from '@nexs/shared';
import type { Run, Step } from '@prisma/client';
import type { Logger } from '../../logger.js';
import type {
  ExecutionReceiptRepository,
  RunRepository,
  StepRepository,
  ToolCallRepository,
  VerificationRepository,
} from '../../repositories/run.repo.js';
import { isStepTerminal, stepIdempotencyKey } from '../../repositories/run.repo.js';
import type { ToolRepository } from '../../repositories/mcp.repo.js';
import type { ToolInvoker } from '../tools/tool-invoker.js';
import { EmptyPlanError, PlanValidationError, type Planner, type PlannerGateway } from './planner.js';
import { validatePlanValue } from './plan.js';
import type { VerificationSubject, Verifier } from './verifier.js';

/**
 * The execution engine — §5.2's loop, and the second heart of the system.
 *
 * The whole design rests on one idea: **at-least-once delivery plus idempotent handlers
 * equals effectively-exactly-once side effects.** pg-boss will deliver a run more than
 * once — on a crash, on a timeout, on a lost connection — and there is no way to prevent
 * that. What can be prevented is a duplicate *effect*, and the only way to do it is to
 * make every step safe to run twice.
 *
 * Four mechanisms do that work, and they are worth naming because each one covers a
 * different failure:
 *
 *  1. **A compare-and-swap claim.** Two workers can both be handed the same run. Only one
 *     moves it out of `queued`/`running`, and the loser returns without doing anything.
 *  2. **An idempotent step row.** `Step` is unique on `(runId, seq, attempt)`, so
 *     "ensure the row" can be called on every pass — including replays — and the second
 *     call returns the first one's row.
 *  3. **The receipt written before the completion.** The tool call is recorded as
 *     `requested` *before* it is invoked and its receipt is written *after* it returns but
 *     *before* the step is marked complete. A crash in that window leaves a receipt, and a
 *     resume that finds a receipt adopts its effect instead of re-running the call.
 *  4. **A retry policy that refuses to retry effects.** Where the window is genuinely
 *     ambiguous — a `requested` call with no receipt — the engine stops rather than
 *     guesses. A failed run an operator can inspect is strictly better than a second
 *     email.
 *
 * The engine never writes a step's `completed` status before its side effect is durable.
 * That ordering *is* the guarantee; everything else here is bookkeeping.
 */

// ── context ───────────────────────────────────────────────────────────────────

/**
 * Everything the engine needs that does not come from the `Run` row itself.
 *
 * Resolved through a seam rather than read here, because the source changes: Phase 5
 * builds it from the run's input, and Phase 6 builds it from the `AgentVersion` the run
 * pinned at start [gap #15]. Keeping the engine ignorant of `Agent` is what stops it from
 * ever being tempted to re-read the live agent mid-run, which is the bug that pinning
 * exists to prevent.
 */
export interface RunContext {
  instructions: string;
  modelId: string;
  allowedToolIds: readonly string[];
  approvalPolicy: ApprovalPolicy;
  limits: RunLimits;
  goal?: string | null;
  task?: string | null;
  goalId?: string | null;
  /** Goal criteria, verified as `goal_criteria` before the run may complete. */
  successCriteria?: SuccessCriterion[];
  /**
   * A plan supplied by the caller instead of one the planner invents.
   *
   * This is how a workflow run works: its plan is the versioned step graph, which was
   * authored by a human and must not be re-derived by a model.
   */
  presetPlan?: PlanStep[];
}

export type RunContextResolver = (run: Run) => Promise<RunContext>;

/**
 * The narrow view of the agent layer the engine needs, so a run can pin the version it
 * executes — gap #15.
 *
 * Structural rather than `Pick<AgentRepository, 'findById'>`, because the engine only ever
 * reads `activeVersionId` from the result. Declaring the requirement as "something that can
 * hand me an agent's active version id" keeps the engine from depending on the agent
 * repository's class shape, and means the port cannot quietly grow a method the engine
 * starts calling.
 *
 * Optional on the engine's dependencies: a run with no agent (an ad-hoc or chat run) never
 * needs it, and every Phase 5 test runs without one.
 */
export interface AgentPinPort {
  findById(
    tenantId: string,
    id: string,
  ): Promise<{ activeVersionId: string | null } | null>;
}

// ── approval gate ─────────────────────────────────────────────────────────────

export interface ApprovalRequestInput {
  tenantId: string;
  runId: string;
  stepId: string;
  title: string;
  description?: string;
  risk: { level: 'low' | 'medium' | 'high'; reasons: string[] };
  requiredPermissions: string[];
  expiresAt: Date;
}

export interface ApprovalDecision {
  id: string;
  status: string;
  decision: 'approved' | 'rejected' | null;
}

/**
 * Where approval rows live. Phase 7 implements this against the `Approval` table; the
 * engine only needs to be able to ask and to read back.
 */
export interface ApprovalGate {
  request(input: ApprovalRequestInput): Promise<{ approvalId: string }>;
  findForStep(tenantId: string, stepId: string): Promise<ApprovalDecision | null>;
}

// ── outcomes ──────────────────────────────────────────────────────────────────

export type RunExecutionOutcome =
  | { status: 'completed'; runId: string; output: unknown }
  | { status: 'failed'; runId: string; error: StructuredRunError }
  | { status: 'waiting_approval'; runId: string; stepId: string; approvalId: string }
  | { status: 'paused'; runId: string }
  | { status: 'cancelled'; runId: string }
  | { status: 'timeout'; runId: string }
  | { status: 'deferred'; runId: string; reason: string }
  | { status: 'not_claimed'; runId: string };

// ── errors ────────────────────────────────────────────────────────────────────

/**
 * Raised when a step may not proceed without a human decision.
 *
 * A control-flow signal rather than a failure: the engine catches it, parks the run and
 * returns normally. Nothing about the run has gone wrong, and treating it as an error
 * would fail it.
 */
export class ApprovalRequiredError extends Error {
  /**
   * Both identifiers, because they answer different questions.
   *
   * `planStepId` is the plan's own id and is the key an approval is recorded under — a
   * decision applies to the *step*, not to one attempt of it, so a retry must find the
   * same approval rather than asking again. `stepId` is the database row, which is what
   * the `Approval` table points at and what gets marked `waiting_approval`.
   */
  constructor(
    readonly planStepId: string,
    readonly stepId: string,
    readonly approvalId: string,
    readonly risk: { level: 'low' | 'medium' | 'high'; reasons: string[] },
    readonly title: string,
  ) {
    super(`Step "${planStepId}" is waiting for approval`);
    this.name = 'ApprovalRequiredError';
  }
}

/** Raised when an approval was explicitly rejected. This one is a real failure. */
export class ApprovalRejectedError extends Error {
  constructor(
    readonly planStepId: string,
    readonly approvalId: string,
  ) {
    super(`Step "${planStepId}" was rejected`);
    this.name = 'ApprovalRejectedError';
  }
}

/** Raised when a `verification` step's check did not pass. */
export class VerificationFailedError extends Error {
  constructor(
    readonly stepId: string,
    readonly verificationType: string,
    readonly evidence: unknown,
    readonly detail?: string,
  ) {
    super(detail ?? `Verification "${verificationType}" failed for step "${stepId}"`);
    this.name = 'VerificationFailedError';
  }
}

/** Raised when a step exceeds its own timeout. */
export class StepTimeoutError extends Error {
  constructor(
    readonly stepId: string,
    readonly timeoutMs: number,
  ) {
    super(`Step "${stepId}" exceeded its ${timeoutMs}ms timeout`);
    this.name = 'StepTimeoutError';
  }
}

// ── deps ──────────────────────────────────────────────────────────────────────

/**
 * Where a frame goes.
 *
 * The tenant is the **first** argument rather than a field on the frame, and that is not a
 * style choice: fan-out is per tenant, and the emitter is the only component that knows which
 * tenant it is acting for. Deriving it from the payload's `runId` would put a database read on
 * the path of every frame; omitting it entirely is what made the stream inert before this
 * signature existed — the composition root had nothing to route by, so nothing was routed.
 *
 * Same shape as `EventBus.publish`, deliberately: the composition root's implementation of
 * this type is a one-line call into the bus.
 */
export type EngineEmitter = <N extends SSEEventName>(
  tenantId: string,
  frame: SseFrame<N>,
) => void;

export interface ExecutionEngineDeps {
  runs: RunRepository;
  steps: StepRepository;
  toolCalls: ToolCallRepository;
  receipts: ExecutionReceiptRepository;
  verifications: VerificationRepository;
  tools: ToolRepository;
  invoker: ToolInvoker;
  planner: Planner;
  verifier: Verifier;
  /** Only `chat` is used, for `model` steps. See `PlannerGateway`. */
  gateway: PlannerGateway;
  resolveContext: RunContextResolver;
  logger: Logger;
  now: () => number;
  emit?: EngineEmitter;
  approvals?: ApprovalGate;
  /**
   * Used to find the run's live browser session so a `browser_state` verification has
   * something to inspect. Typed structurally rather than as `BrowserManager` so the engine
   * does not depend on the browser layer to describe a session lookup.
   */
  browserSessions?: {
    list(
      tenantId: string,
      options: { runId?: string; status?: string; limit?: number },
    ): Promise<Array<{ id: string }>>;
  };
  /**
   * Where the engine learns an agent's current version so it can pin it — gap #15.
   *
   * Absent for a run with no agent, and absent in every Phase 5 test. When it is missing,
   * `pinAgentVersionIfNeeded` leaves the run unpinned and the resolver falls back to the
   * run's own input, which is exactly the Phase 5 behaviour.
   */
  agents?: AgentPinPort;
  options?: Partial<RunLimits> & { tenantConcurrency?: number };
}

// ── the engine ────────────────────────────────────────────────────────────────

export class ExecutionEngine {
  private readonly limits: RunLimits;
  private readonly tenantConcurrency: number;

  constructor(private readonly deps: ExecutionEngineDeps) {
    this.limits = { ...DEFAULT_RUN_LIMITS, ...(deps.options ?? {}) };
    this.tenantConcurrency = deps.options?.tenantConcurrency ?? 5;
  }

  /**
   * Run a run to completion, or to the first reason it cannot continue.
   *
   * Safe to call for a run that is already finished, already parked, or already being run
   * by someone else: all three return a status rather than throwing, because the caller is
   * a queue consumer and "this delivery had nothing to do" is a normal outcome.
   */
  async executeRun(tenantId: string, runId: string): Promise<RunExecutionOutcome> {
    const run = await this.deps.runs.findById(tenantId, runId);
    if (run === null) {
      throw new Error(`Run ${runId} does not exist for tenant ${tenantId}`);
    }

    const status = run.status as RunStatus;
    if (isTerminalRunStatus(status)) {
      // A finished run is not claimable, and this outcome describes the *delivery* rather
      // than the run: `not_claimed` says "there was nothing here for me to do", which is
      // exactly what happened.
      //
      // This branch used to answer `cancelled`, which conflated "already finished" with "was
      // cancelled while running" — two different facts, and the second one is a fact about
      // the run that only the loop below can observe. `runtime.ts`'s consumer carried a
      // comment asserting a completed run comes back `not_claimed` while the code said
      // otherwise; the comment described the intent and the code was wrong.
      return { status: 'not_claimed', runId };
    }
    if (status === 'paused' || status === 'waiting_approval') {
      // Parked runs are resumed explicitly. A queue delivery for one is a redelivery of a
      // job that already did its work, not an instruction to continue.
      return { status: 'paused', runId };
    }

    const needsPlan = run.plan === null;
    if (status === 'queued') {
      const active = await this.deps.runs.countActiveForTenant(tenantId);
      if (active >= this.tenantConcurrency) {
        return {
          status: 'deferred',
          runId,
          reason: `tenant already has ${active} active runs (limit ${this.tenantConcurrency})`,
        };
      }
    }

    const claimed = await this.deps.runs.claim(
      tenantId,
      runId,
      ['queued', 'planning', 'running'],
      needsPlan ? 'planning' : 'running',
    );
    if (claimed === null) return { status: 'not_claimed', runId };

    let checkpoint = readCheckpoint(claimed.checkpoint) ?? emptyCheckpoint(isoTime(this.deps.now()));

    try {
      // The pin happens before the context is resolved, and the resolved context is built
      // from the *pinned* row rather than `claimed`. `claimed` was read before the pin was
      // written, so resolving against it would read a run whose `agentVersionId` is still
      // null and fall through to the input fallback — silently executing an ad-hoc context
      // for a run that has an agent.
      const pinned = await this.pinAgentVersionIfNeeded(claimed);
      const context = await this.deps.resolveContext(pinned);

      // The plan is held in a local rather than re-read from `claimed`, because `claimed`
      // was fetched *before* the plan was written — reading `claimed.plan` here would see
      // `null` on a first pass and the loop would execute nothing at all.
      let plan: PlanStep[];

      if (claimed.plan === null) {
        plan = await this.plan(claimed, context);
        await this.deps.runs.savePlan(tenantId, runId, plan);
        checkpoint = { ...checkpoint, planned: true };
        await this.deps.runs.saveCheckpoint(tenantId, runId, checkpoint);
        this.emit(tenantId, { name: 'run.plan_ready', payload: { runId, plan: plan as never } });
      } else {
        plan = readPlan(claimed.plan);
        if (checkpoint.planned !== true) {
          checkpoint = { ...checkpoint, planned: true };
          await this.deps.runs.saveCheckpoint(tenantId, runId, checkpoint);
        }
      }

      await this.deps.runs.setStatus(tenantId, runId, 'running');
      this.emit(tenantId, { name: 'run.started', payload: { runId } });

      return await this.loop(pinned, context, checkpoint, plan);
    } catch (cause) {
      return this.failRun(tenantId, runId, this.toRunError(cause));
    }
  }

  /**
   * Continue a run that was parked for approval.
   *
   * Resumes the *same* run id rather than starting a new one — the plan, the completed
   * steps and the checkpoint all survive, which is the entire point of parking instead of
   * failing. The decision is recorded in the checkpoint before execution resumes, so the
   * step that was waiting sees it on its next pass and does not park again.
   */
  async resumeRun(
    tenantId: string,
    runId: string,
    decision: { stepId: string; approvalId: string; decision: 'approved' | 'rejected' },
  ): Promise<RunExecutionOutcome> {
    const run = await this.deps.runs.findById(tenantId, runId);
    if (run === null) throw new Error(`Run ${runId} does not exist for tenant ${tenantId}`);

    const checkpoint = readCheckpoint(run.checkpoint) ?? emptyCheckpoint(isoTime(this.deps.now()));
    const approvals = { ...(checkpoint.approvals ?? {}) };
    approvals[decision.stepId] = { approvalId: decision.approvalId, decision: decision.decision };
    await this.deps.runs.saveCheckpoint(tenantId, runId, { ...checkpoint, approvals });

    await this.deps.runs.setStatus(tenantId, runId, 'running');
    this.emit(tenantId, { name: 'run.resumed', payload: { runId } });

    return this.executeRun(tenantId, runId);
  }

  /** Ask the planner, or accept a plan the caller already authored. */
  private async plan(run: Run, context: RunContext): Promise<PlanStep[]> {
    if (context.presetPlan !== undefined) {
      // A preset plan is validated by the same ladder as a generated one. It is authored
      // by a human, but it is stored, versioned and executed exactly like any other plan,
      // and a workflow that references a deleted tool should fail at validation rather
      // than halfway through execution.
      const result = validatePlanValue(context.presetPlan, {
        allowedToolIds: new Set(context.allowedToolIds),
        maxSteps: context.limits.maxSteps,
      });
      if (!result.ok) {
        throw new PlanValidationError('The supplied plan is not valid.', result.issues, 0);
      }
      return result.plan;
    }

    return this.deps.planner.plan({
      tenantId: run.tenantId,
      runId: run.id,
      modelId: context.modelId,
      instructions: context.instructions,
      goal: context.goal ?? null,
      task: context.task ?? null,
      input: run.input,
      allowedToolIds: context.allowedToolIds,
      maxSteps: context.limits.maxSteps,
    });
  }

  /**
   * Pin the agent version this run will execute, once — gap #15.
   *
   * Without this, a run's configuration is whatever the agent looks like at the moment each
   * step happens to resolve it. Editing an agent mid-run would then change the behaviour of
   * a plan that was built for the old configuration, silently and with no error anywhere.
   *
   * The write is a compare-and-swap on `agentVersionId: null` inside `RunRepository`, so
   * the winner of a race is the only one that pins and every loser adopts what the winner
   * wrote. That matters because `executeRun` runs on every queue delivery, and
   * at-least-once delivery means two deliveries of the same job are ordinary rather than
   * exceptional: a blind write would let the second delivery re-point a running run at a
   * version published after it started.
   *
   * Returns the run to use for the rest of this execution. It is a re-read rather than the
   * input row because the input row's `agentVersionId` is still `null` — using it would
   * resolve the context as if the run had no agent at all.
   */
  private async pinAgentVersionIfNeeded(run: Run): Promise<Run> {
    if (run.agentVersionId !== null) return run;
    if (run.agentId === null) return run;
    if (this.deps.agents === undefined) return run;

    const agent = await this.deps.agents.findById(run.tenantId, run.agentId);
    if (agent === null || agent.activeVersionId === null) {
      // Nothing to pin. An agent with no active version is a configuration the resolver
      // reports; failing here would report it as an engine fault instead.
      return run;
    }

    const changed = await this.deps.runs.pinAgentVersion(
      run.tenantId,
      run.id,
      agent.activeVersionId,
    );

    if (changed === 1) {
      this.emit(run.tenantId, {
        name: 'run.version_pinned',
        payload: { runId: run.id, agentId: run.agentId, agentVersionId: agent.activeVersionId },
      });
    }

    // Re-read either way. When this call lost the race the re-read is what makes the run
    // adopt the version the winner pinned, rather than the one this call observed.
    return (await this.deps.runs.findById(run.tenantId, run.id)) ?? run;
  }

  // ── the loop ────────────────────────────────────────────────────────────────

  private async loop(
    run: Run,
    context: RunContext,
    checkpoint: RunCheckpoint,
    plan: readonly PlanStep[],
  ): Promise<RunExecutionOutcome> {
    const startedAt = Date.parse(checkpoint.startedAt);
    const deadline = startedAt + context.limits.maxDurationMs;

    for (let index = 0; index < plan.length; index += 1) {
      const planStep = plan[index]!;

      // Every step boundary is where the run's own budget and the operator's wishes are
      // re-checked. Doing it here rather than inside a step means a cancel or a pause is
      // honoured within one step's duration rather than at the end of the run.
      if (this.deps.now() >= deadline) {
        return this.timeout(run, context, checkpoint);
      }

      const fresh = await this.deps.runs.findById(run.tenantId, run.id);
      if (fresh === null) return { status: 'not_claimed', runId: run.id };
      if (fresh.status === 'cancelled') {
        this.emit(run.tenantId, { name: 'run.cancelled', payload: { runId: run.id } });
        return { status: 'cancelled', runId: run.id };
      }
      if (fresh.status === 'paused') {
        this.emit(run.tenantId, { name: 'run.paused', payload: { runId: run.id } });
        return { status: 'paused', runId: run.id };
      }

      await this.deps.runs.heartbeat(run.tenantId, run.id);

      const skipped = await this.skipReason(run.tenantId, planStep, checkpoint);
      if (skipped !== null) {
        // A skipped step still gets a row. The state machine names `skipped` as a step
        // status, and the UI renders the plan from step rows — a step that vanished
        // because a branch was not taken would look like a plan that never had it.
        const row = await this.deps.steps.ensure({
          runId: run.id,
          seq: index,
          position: index,
          name: planStep.id,
          description: planStep.description,
          stepType: planStep.stepType,
          toolId: planStep.toolId ?? null,
          input: planStep.config,
        });
        if (!isStepTerminal(row.status)) {
          await this.deps.steps.markSkipped(run.id, row.id, skipped);
        }
        checkpoint = recordSkip(checkpoint, planStep.id, skipped);
        await this.deps.runs.saveCheckpoint(run.tenantId, run.id, checkpoint);
        continue;
      }

      const outcome = await this.executeStep(run, context, planStep, index, checkpoint);

      if (outcome.kind === 'completed') {
        checkpoint = recordCompletion(checkpoint, planStep.id, outcome.output, this.deps.now());
        await this.deps.runs.saveCheckpoint(run.tenantId, run.id, checkpoint);
        continue;
      }

      if (outcome.kind === 'skipped') {
        checkpoint = recordSkip(checkpoint, planStep.id, outcome.reason);
        await this.deps.runs.saveCheckpoint(run.tenantId, run.id, checkpoint);
        continue;
      }

      if (outcome.kind === 'approval_required') {
        // The row is marked by its database id; the caller is told the plan-step id,
        // because that is the key a later decision is recorded under.
        await this.deps.steps.markWaitingApproval(run.id, outcome.stepId);
        await this.deps.runs.setStatus(run.tenantId, run.id, 'waiting_approval');
        this.emit(run.tenantId, { name: 'run.paused', payload: { runId: run.id } });
        return {
          status: 'waiting_approval',
          runId: run.id,
          stepId: outcome.planStepId,
          approvalId: outcome.approvalId,
        };
      }

      // `failed`
      return this.failRun(run.tenantId, run.id, outcome.error, checkpoint);
    }

    return this.finish(run, context, checkpoint);
  }

  /** All steps are done. The goal criteria are the last thing that can stop a completion. */
  private async finish(
    run: Run,
    context: RunContext,
    checkpoint: RunCheckpoint,
  ): Promise<RunExecutionOutcome> {
    const criteria = context.successCriteria ?? [];
    if (criteria.length > 0) {
      const subject = await this.subjectFor(run.tenantId, run.id, null, checkpoint, null);
      const outcome = await this.deps.verifier.verify({
        tenantId: run.tenantId,
        runId: run.id,
        stepId: null,
        goalId: context.goalId ?? run.goalId ?? null,
        type: 'goal_criteria',
        scope: 'goal_criteria',
        config: { criteria },
        subject,
      });

      const verification = await this.deps.verifications.create({
        tenantId: run.tenantId,
        runId: run.id,
        goalId: context.goalId ?? run.goalId ?? null,
        type: 'goal_criteria',
        scope: 'goal_criteria',
        config: { criteria },
      });
      await this.deps.verifications.complete(run.tenantId, verification.id, {
        passed: outcome.passed,
        evidence: outcome.evidence,
      });

      if (!outcome.passed) {
        // A goal may only reach `completed` through a passing `goal_criteria`. This is the
        // single place that rule is enforced, which is what makes it a rule rather than a
        // convention.
        return this.failRun(
          run.tenantId,
          run.id,
          {
            code: 'STEP_FAILED',
            message: 'The run finished its steps but its success criteria were not met.',
            details: { verificationId: verification.id, evidence: outcome.evidence },
          },
          checkpoint,
        );
      }
    }

    const output = buildRunOutput(checkpoint);
    await this.deps.runs.complete(run.tenantId, run.id, {
      output,
      durationMs: elapsedMs(run, this.deps.now()),
    });
    this.emit(run.tenantId, { name: 'run.completed', payload: { runId: run.id, output } });
    return { status: 'completed', runId: run.id, output };
  }

  // ── one step ────────────────────────────────────────────────────────────────

  /**
   * Execute a plan step, or adopt the result of an execution that already happened.
   *
   * The two branches at the top are the replay path and they are the reason a crash-resume
   * is safe. Everything after them is a first execution.
   */
  private async executeStep(
    run: Run,
    context: RunContext,
    planStep: PlanStep,
    index: number,
    checkpoint: RunCheckpoint,
  ): Promise<StepOutcome> {
    const seq = index;

    for (let attempt = 0; attempt <= context.limits.maxRetries; attempt += 1) {
      const step = await this.deps.steps.ensure({
        runId: run.id,
        seq,
        position: index,
        name: planStep.id,
        description: planStep.description,
        stepType: planStep.stepType,
        toolId: planStep.toolId ?? null,
        input: planStep.config,
        attempt,
      });

      // ── replay path 1: the step already finished ────────────────────────────
      if (step.status === 'completed') {
        return { kind: 'completed', output: step.output };
      }
      if (step.status === 'skipped') {
        return { kind: 'skipped', reason: 'already skipped' };
      }

      // ── replay path 2: the effect happened but the step did not commit ──────
      if (step.status === 'running' || step.status === 'waiting_approval') {
        const adopted = await this.adoptPriorExecution(run, step);
        if (adopted !== null) return adopted;
      }

      await this.deps.steps.markRunning(run.id, step.id);
      this.emit(run.tenantId, {
        name: 'step.started',
        payload: {
          runId: run.id,
          stepId: step.id,
          seq,
          stepType: planStep.stepType,
          name: planStep.description,
        },
      });

      const startedAt = this.deps.now();
      try {
        const output = await this.perform(run, context, planStep, step, checkpoint, attempt);
        await this.deps.steps.markCompleted(run.id, step.id, output);
        this.emit(run.tenantId, {
          name: 'step.completed',
          payload: { runId: run.id, stepId: step.id, durationMs: this.deps.now() - startedAt },
        });
        return { kind: 'completed', output };
      } catch (cause) {
        if (cause instanceof ApprovalRequiredError) {
          return {
            kind: 'approval_required',
            planStepId: cause.planStepId,
            stepId: cause.stepId,
            approvalId: cause.approvalId,
          };
        }

        const error = this.stepError(cause, planStep);
        await this.deps.steps.markFailed(run.id, step.id, serialiseRunError(error));
        this.emit(run.tenantId, {
          name: 'step.failed',
          payload: { runId: run.id, stepId: step.id, error: { code: error.code, message: error.message }, retryCount: attempt },
        });

        // An approval that was explicitly rejected is a decision, not a transient fault.
        // Retrying it would be asking the operator the same question again.
        if (cause instanceof ApprovalRejectedError || cause instanceof VerificationFailedError) {
          return { kind: 'failed', error };
        }

        const verdict = await this.retryVerdict(run, planStep, step, cause, attempt, context);
        if (verdict.retry) continue;
        return { kind: 'failed', error: verdict.escalateTo === undefined ? error : verdict.escalateTo };
      }
    }

    return {
      kind: 'failed',
      error: {
        code: 'STEP_FAILED',
        message: `Step "${planStep.id}" failed after ${context.limits.maxRetries + 1} attempts`,
        stepId: planStep.id,
      },
    };
  }

  /**
   * Look for evidence that this step already had its effect.
   *
   * Returns the outcome to adopt, or `null` when the step genuinely needs to run. The
   * three cases are the whole of the crash-recovery story:
   *
   *  - **A receipt exists.** The tool ran and returned. Adopt its effect as the step's
   *    output. This is the common case and it is what makes "side effects fire exactly
   *    once" true for a crash *after* the call.
   *  - **A side-effecting call was recorded but never confirmed.** The process died
   *    somewhere between "we are about to call" and "we recorded the result". There is no
   *    way to know whether the effect landed, so the step fails with a structured error
   *    naming the ambiguity. Not re-running is the only safe choice.
   *  - **A read-only call was recorded but never confirmed.** Re-running is safe by
   *    definition, so `null` is returned and the normal path executes it again.
   */
  private async adoptPriorExecution(run: Run, step: Step): Promise<StepOutcome | null> {
    const receipt = await this.deps.receipts.findForStep(step.id);
    if (receipt !== null) {
      this.deps.logger.info(
        { runId: run.id, stepId: step.id, idempotencyKey: receipt.idempotencyKey },
        'adopting a recorded effect instead of re-running the step',
      );
      await this.deps.steps.markCompleted(run.id, step.id, receipt.effect);
      return { kind: 'completed', output: receipt.effect };
    }

    const calls = await this.deps.toolCalls.findByStep(step.id);
    const inDoubt = calls.find((call) => call.status === 'requested' && call.sideEffect);
    if (inDoubt === undefined) return null;

    const error: StructuredRunError = {
      code: 'STEP_FAILED',
      stepId: step.id,
      message:
        'This step was interrupted after a side-effecting tool call started and before its result was recorded. ' +
        'It has not been retried, because the effect may or may not have been applied.',
      details: {
        toolCallId: inDoubt.id,
        toolId: inDoubt.toolId,
        startedAt: inDoubt.createdAt.toISOString(),
        idempotencyKey: stepIdempotencyKey(run.id, step.seq, step.attempt),
      },
    };
    await this.deps.steps.markFailed(run.id, step.id, serialiseRunError(error));
    return { kind: 'failed', error };
  }

  /**
   * Whether a failed attempt may be retried.
   *
   * The rule is blunt on purpose: **a step whose tool declares side effects is never
   * retried automatically.** A tool that says it writes files, sends notifications or
   * changes something outside the system cannot be safely repeated without knowing
   * whether the first attempt landed, and a `failed` status from such a tool is not proof
   * that it did nothing — a timeout in the middle of a write reports failure and leaves a
   * half-written file.
   *
   * The cost is that `maxRetries` does much less for tool steps than its name suggests.
   * That is the right trade: an operator can retry explicitly once they have looked at
   * what happened, and a duplicate side effect cannot be un-sent.
   */
  private async retryVerdict(
    run: Run,
    planStep: PlanStep,
    step: Step,
    cause: unknown,
    attempt: number,
    context: RunContext,
  ): Promise<{ retry: boolean; escalateTo?: StructuredRunError }> {
    if (attempt >= context.limits.maxRetries) return { retry: false };

    if (cause instanceof StepTimeoutError) {
      return { retry: false };
    }

    if (planStep.stepType === 'tool') {
      const tool = await this.deps.tools.findById(run.tenantId, planStep.toolId ?? '');
      const capabilities = tool?.capabilities ?? [];
      if (tool !== null && hasSideEffects(capabilities)) {
        return {
          retry: false,
          escalateTo: {
            code: 'STEP_FAILED',
            stepId: planStep.id,
            message:
              `Tool "${tool.name}" can have effects outside this system, so the step was not retried. ` +
              'Retry it explicitly once you have checked what the first attempt did.',
            details: { toolId: tool.id, capabilities, attempt },
          },
        };
      }
      // A tool that is not explicitly read-only is treated as effectful for retry
      // purposes: the absence of a declaration is not evidence of safety.
      if (tool !== null && !isReadOnly(capabilities) && !hasSideEffects(capabilities)) {
        return { retry: false };
      }
    }

    return { retry: true };
  }

  // ── performing one step ─────────────────────────────────────────────────────

  private async perform(
    run: Run,
    context: RunContext,
    planStep: PlanStep,
    step: Step,
    checkpoint: RunCheckpoint,
    attempt: number,
  ): Promise<unknown> {
    switch (planStep.stepType) {
      case 'model':
        return this.performModel(run, context, planStep, checkpoint);
      case 'tool':
        return this.performTool(run, context, planStep, step, checkpoint, attempt);
      case 'transform':
        return performTransform(planStep, checkpoint, run.input);
      case 'condition':
        return performCondition(planStep, checkpoint, run.input);
      case 'verification':
        return this.performVerification(run, planStep, step, checkpoint);
      case 'approval':
        return this.performApproval(run, context, planStep, step, checkpoint);
      default:
        throw new Error(`Unsupported step type "${String(planStep.stepType)}"`);
    }
  }

  private async performModel(
    run: Run,
    context: RunContext,
    planStep: PlanStep,
    checkpoint: RunCheckpoint,
  ): Promise<unknown> {
    const prompt =
      typeof planStep.config['prompt'] === 'string'
        ? (planStep.config['prompt'] as string)
        : planStep.description;

    const result = await this.deps.gateway.chat({
      tenantId: run.tenantId,
      runId: run.id,
      stepId: null,
      modelId: typeof planStep.config['modelId'] === 'string'
        ? (planStep.config['modelId'] as string)
        : context.modelId,
      messages: [
        { role: 'system', content: context.instructions },
        {
          role: 'user',
          content: `${prompt}\n\nOutputs so far:\n${renderOutputs(checkpoint)}`,
        },
      ],
      ...(typeof planStep.config['temperature'] === 'number'
        ? { temperature: planStep.config['temperature'] as number }
        : {}),
    });

    return {
      content: result.content,
      modelId: result.modelId,
      providerId: result.providerId,
      usage: result.usage,
    };
  }

  /**
   * The tool path, and the ordering that makes it safe.
   *
   * Read the five numbered writes in order. Every one of them is placed where it is for a
   * reason, and moving any of them changes what a crash means:
   *
   *  1. `ToolCall` with status `requested` — written *before* the call, so an interruption
   *     leaves evidence that a call was in flight.
   *  2. the call itself.
   *  3. `ToolCall` → `executed`/`failed` with the result.
   *  4. `ExecutionReceipt` — written *before* the step is completed, so a resume can adopt
   *     the effect rather than repeat it.
   *  5. the step's `completed` status, by the caller.
   */
  private async performTool(
    run: Run,
    context: RunContext,
    planStep: PlanStep,
    step: Step,
    checkpoint: RunCheckpoint,
    attempt: number,
  ): Promise<unknown> {
    const toolId = planStep.toolId;
    if (toolId === undefined) {
      throw new Error(`Step "${planStep.id}" is a tool step with no toolId`);
    }

    if (checkpoint.toolCallCount >= context.limits.maxToolCalls) {
      throw new Error(
        `This run has reached its limit of ${context.limits.maxToolCalls} tool calls`,
      );
    }

    const args = planStep.config;
    const { tool, capabilities, sideEffect } = await this.deps.invoker.resolve(
      run.tenantId,
      toolId,
      args,
    );

    await this.ensureApprovalForTool(run, context, planStep, step, tool.name, capabilities, checkpoint);

    // ── 1. the intent, before the effect ───────────────────────────────────────
    const call = await this.deps.toolCalls.record({
      tenantId: run.tenantId,
      runId: run.id,
      stepId: step.id,
      toolId: tool.id,
      args,
      sideEffect,
    });

    const startedAt = this.deps.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), context.limits.stepTimeoutMs);

    this.emit(run.tenantId, { name: 'tool.started', payload: { runId: run.id, toolName: tool.name, args } });

    try {
      // ── 2. the call ──────────────────────────────────────────────────────────
      const outcome = await this.deps.invoker.invoke({
        tenantId: run.tenantId,
        runId: run.id,
        stepId: step.id,
        toolId: tool.id,
        args,
        signal: controller.signal,
      });

      // ── 3. the result ────────────────────────────────────────────────────────
      await this.deps.toolCalls.markExecuted(
        run.tenantId,
        call.id,
        { content: outcome.result.content, ref: outcome.result.ref, truncated: outcome.result.truncated },
        outcome.durationMs,
      );

      // ── 4. the receipt, before anyone can claim the step is done ────────────
      const receipt = await this.deps.receipts.create({
        tenantId: run.tenantId,
        toolCallId: call.id,
        effect: {
          toolId: tool.id,
          toolName: tool.name,
          ok: outcome.ok,
          content: outcome.result.content,
          ...(outcome.result.ref === undefined ? {} : { ref: outcome.result.ref }),
          truncated: outcome.result.truncated,
        },
        idempotencyKey: stepIdempotencyKey(run.id, step.seq, attempt),
        evidence: {
          capabilities,
          sideEffect,
          durationMs: outcome.durationMs,
          toolReportedError: outcome.toolReportedError,
          // Cite the approval that authorised this call, when one did.
          //
          // This is what makes "a human allowed this" checkable after the fact rather than
          // merely asserted: the receipt is the durable record of the effect, and an effect
          // that only happened because someone clicked Approve should say so. Read from the
          // checkpoint rather than from the tool call, because the decision is keyed by the
          // plan step — a decision applies to the step, not to one attempt of it, so a
          // retried step cites the same approval the first attempt did.
          ...approvalEvidence(checkpoint, planStep.id),
        },
      });

      this.emit(run.tenantId, {
        name: 'tool.completed',
        payload: { runId: run.id, toolName: tool.name, ok: outcome.ok, durationMs: outcome.durationMs },
      });

      checkpoint.toolCallCount += 1;

      if (!outcome.ok) {
        this.emit(run.tenantId, {
          name: 'tool.failed',
          payload: {
            runId: run.id,
            toolName: tool.name,
            error: { code: 'STEP_FAILED', message: outcome.result.content.slice(0, 500) },
          },
        });
        throw new ToolReportedFailure(tool.name, outcome.result.content);
      }

      return {
        toolName: tool.name,
        toolId: tool.id,
        content: outcome.result.content,
        // The parsed payload, when the tool returned JSON. Without it a `transform` or
        // `condition` step downstream could only ever address the tool's result as an
        // opaque string, which would make a plan unable to branch on what a tool returned.
        result: tryParseJson(outcome.result.content) ?? outcome.result.content,
        ...(outcome.result.ref === undefined ? {} : { ref: outcome.result.ref }),
        truncated: outcome.result.truncated,
        receiptId: receipt.id,
      };
    } catch (cause) {
      if (cause instanceof ApprovalRequiredError) throw cause;

      const elapsed = this.deps.now() - startedAt;
      if (controller.signal.aborted) {
        await this.deps.toolCalls.markFailed(
          run.tenantId,
          call.id,
          `Timed out after ${context.limits.stepTimeoutMs}ms`,
          elapsed,
        );
        throw new StepTimeoutError(planStep.id, context.limits.stepTimeoutMs);
      }

      await this.deps.toolCalls.markFailed(
        run.tenantId,
        call.id,
        cause instanceof Error ? cause.message : String(cause),
        elapsed,
      );
      throw cause;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Park the step if the approval policy says this call needs a human.
   *
   * Consulted *before* the tool call is recorded, because a call that is going to wait for
   * approval has not happened yet, and recording it as `requested` would make a later
   * resume see an in-flight effect that was never started.
   */
  private async ensureApprovalForTool(
    run: Run,
    context: RunContext,
    planStep: PlanStep,
    step: Step,
    toolName: string,
    capabilities: readonly string[],
    checkpoint: RunCheckpoint,
  ): Promise<void> {
    const policy = context.approvalPolicy;
    if (policy.mode === 'none') return;

    const risk = assessRisk(capabilities);
    if (!policyRequiresApproval(policy, { name: toolName, capabilities, risk })) return;

    const existing = await this.resolveApproval(run.tenantId, planStep.id, step.id, checkpoint);
    if (existing?.decision === 'approved') return;
    if (existing?.decision === 'rejected') {
      throw new ApprovalRejectedError(planStep.id, existing.approvalId);
    }

    const approvalId = await this.requestApproval(
      run,
      step,
      planStep.id,
      planStep.description,
      risk,
      capabilities,
    );
    throw new ApprovalRequiredError(planStep.id, step.id, approvalId, risk, planStep.description);
  }

  private async performApproval(
    run: Run,
    context: RunContext,
    planStep: PlanStep,
    step: Step,
    checkpoint: RunCheckpoint,
  ): Promise<unknown> {
    const existing = await this.resolveApproval(run.tenantId, planStep.id, step.id, checkpoint);
    if (existing?.decision === 'approved') {
      return { approved: true, approvalId: existing.approvalId };
    }
    if (existing?.decision === 'rejected') {
      throw new ApprovalRejectedError(planStep.id, existing.approvalId);
    }

    const risk = assessRisk([]);
    const approvalId =
      existing?.id ??
      (await this.requestApproval(
        run,
        step,
        planStep.id,
        planStep.description,
        risk,
        requiredPermissions(planStep),
      ));

    throw new ApprovalRequiredError(planStep.id, step.id, approvalId, risk, planStep.description);
  }

  private async performVerification(
    run: Run,
    planStep: PlanStep,
    step: Step,
    checkpoint: RunCheckpoint,
  ): Promise<unknown> {
    const type = planStep.config['type'];
    if (typeof type !== 'string') {
      throw new Error(`Verification step "${planStep.id}" has no "type"`);
    }

    const config = (planStep.config['config'] ?? {}) as Record<string, unknown>;
    const dependsOn = planStep.dependsOn ?? [];
    const upstream = dependsOn.length > 0 ? dependsOn[dependsOn.length - 1]! : null;
    const subject = await this.subjectFor(run.tenantId, run.id, step.id, checkpoint, upstream);

    const verification = await this.deps.verifications.create({
      tenantId: run.tenantId,
      runId: run.id,
      stepId: step.id,
      type: type as never,
      scope: 'step',
      config,
    });

    const outcome = await this.deps.verifier.verify({
      tenantId: run.tenantId,
      runId: run.id,
      stepId: step.id,
      type: type as never,
      scope: 'step',
      config,
      subject,
    });

    await this.deps.verifications.complete(run.tenantId, verification.id, {
      passed: outcome.passed,
      evidence: outcome.evidence,
    });

    if (!outcome.passed) {
      throw new VerificationFailedError(planStep.id, type, outcome.evidence, outcome.error);
    }

    return { passed: true, verificationId: verification.id, evidence: outcome.evidence };
  }

  // ── approvals ───────────────────────────────────────────────────────────────

  /**
   * The decision for a step, from the engine's own checkpoint or from the approval table.
   *
   * The checkpoint is consulted first because it is the state the engine has already acted
   * on; the gate is the system of record and is the only source when the engine has not
   * parked yet.
   */
  private async resolveApproval(
    tenantId: string,
    planStepId: string,
    dbStepId: string,
    checkpoint: RunCheckpoint,
  ): Promise<{ id: string; approvalId: string; decision: 'approved' | 'rejected' | null } | null> {
    // The checkpoint is keyed by the plan-step id, because a decision applies to the step
    // rather than to one attempt of it. The approval table is keyed by the row, because
    // that is what its foreign key points at.
    const recorded = checkpoint.approvals?.[planStepId];
    if (recorded !== undefined) {
      return { id: recorded.approvalId, approvalId: recorded.approvalId, decision: recorded.decision };
    }
    if (this.deps.approvals === undefined) return null;

    const found = await this.deps.approvals.findForStep(tenantId, dbStepId);
    if (found === null) return null;
    return { id: found.id, approvalId: found.id, decision: found.decision };
  }

  private async requestApproval(
    run: Run,
    step: Step,
    planStepId: string,
    description: string,
    risk: { level: 'low' | 'medium' | 'high'; reasons: string[] },
    permissions: readonly string[],
  ): Promise<string> {
    const expiresAt = new Date(this.deps.now() + DEFAULT_APPROVAL_EXPIRY_MS);

    // The id is keyed on the *plan step*, not the row, because that is the id the caller is
    // handed in the outcome and the id a later decision is recorded under. Keying it on the
    // row would hand back an identifier that `resumeRun` never looks up, so the resumed step
    // would park again forever.
    const approvalId =
      this.deps.approvals === undefined
        ? // No approval table yet (Phase 7). The run still parks, and `resumeRun` can still
          // record a decision — which is what makes the park/resume cycle testable now and
          // what keeps the engine from depending on a table it does not own.
          `step:${planStepId}`
        : (
            await this.deps.approvals.request({
              tenantId: run.tenantId,
              runId: run.id,
              stepId: step.id,
              title: description,
              risk,
              requiredPermissions: [...permissions],
              expiresAt,
            })
          ).approvalId;

    // Emitted whether or not the approval table exists. A run parking is precisely the
    // moment an operator needs to hear about it, so the notification path must not be
    // conditional on a table this phase does not own.
    this.emit(run.tenantId, {
      name: 'approval.created',
      payload: {
        approvalId,
        title: description,
        risk,
        expiresAt: expiresAt.toISOString(),
      },
    });

    return approvalId;
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  /** Build the subject a verifier may inspect, from the run's own recorded state. */
  private async subjectFor(
    tenantId: string,
    runId: string,
    stepId: string | null,
    checkpoint: RunCheckpoint,
    upstreamStepId: string | null,
  ): Promise<VerificationSubject> {
    let output: unknown = null;
    let toolResult: unknown = null;

    if (stepId !== null) {
      const step = await this.deps.steps.findById(stepId);
      output = step?.output ?? null;
      const calls = await this.deps.toolCalls.findByStep(stepId);
      const last = calls[calls.length - 1];
      if (last !== undefined && last.status === 'executed') toolResult = last.result;
    } else if (upstreamStepId !== null) {
      output = checkpoint.completedSteps[upstreamStepId]?.output ?? null;
    } else {
      // A run-level verification (a `goal_criteria`) judges the run, so its subject is the
      // run's own output rather than any one step's.
      output = buildRunOutput(checkpoint);
    }

    // The most recent http_request result, which `http_response` verification is defined
    // against — the spec says "asserts against the recorded http tool result", and a run
    // may make several.
    const steps = await this.deps.steps.listByRunIdOrdered(runId);
    let lastHttpResult: unknown = null;
    for (const candidate of steps) {
      const calls = await this.deps.toolCalls.findByStep(candidate.id);
      for (const call of calls) {
        if (call.status !== 'executed') continue;
        const result = call.result as Record<string, unknown> | null;
        if (result === null || typeof result !== 'object') continue;
        const content = result['content'];
        if (typeof content !== 'string') continue;
        const parsed = tryParseJson(content);
        if (parsed !== null && typeof (parsed as Record<string, unknown>)['status'] === 'number') {
          lastHttpResult = parsed;
        }
      }
    }

    return {
      output,
      toolResult,
      outputs: checkpoint.outputs,
      lastHttpResult,
      browserSessionId: await this.browserSessionFor(tenantId, runId),
    };
  }
  private async browserSessionFor(tenantId: string, runId: string): Promise<string | null> {
    const sessions = await this.deps.browserSessions?.list(tenantId, { runId, status: 'active', limit: 1 });
    return sessions?.[0]?.id ?? null;
  }

  /** Steps that must not run because a condition upstream evaluated false. */
  private async skipReason(
    _tenantId: string,
    planStep: PlanStep,
    checkpoint: RunCheckpoint,
  ): Promise<string | null> {
    for (const dependency of planStep.dependsOn ?? []) {
      const output = checkpoint.completedSteps[dependency]?.output;
      if (isFalseCondition(output)) {
        return `skipped because "${dependency}" evaluated false`;
      }
      if (isSkipMarker(output)) {
        return `skipped because "${dependency}" was skipped`;
      }
    }
    return null;
  }

  private stepError(cause: unknown, planStep: PlanStep): StructuredRunError {
    if (cause instanceof StepTimeoutError) {
      return { code: 'STEP_TIMEOUT', message: cause.message, stepId: planStep.id };
    }
    if (cause instanceof VerificationFailedError) {
      return {
        code: 'STEP_FAILED',
        message: cause.message,
        stepId: planStep.id,
        details: { verifier: cause.verificationType, evidence: cause.evidence },
      };
    }
    if (cause instanceof ApprovalRejectedError) {
      return { code: 'APPROVAL_REJECTED', message: cause.message, stepId: planStep.id };
    }
    return {
      code: 'STEP_FAILED',
      message: cause instanceof Error ? cause.message : String(cause),
      stepId: planStep.id,
    };
  }

  private toRunError(cause: unknown): StructuredRunError {
    if (cause instanceof PlanValidationError) {
      return {
        code: 'PLAN_INVALID',
        message: cause.message,
        issues: [...cause.issues],
        details: { attempts: cause.attempts },
      };
    }
    if (cause instanceof EmptyPlanError) {
      // A knowable configuration condition, not a fault in this system. Reported as
      // `INTERNAL` it would read as a bug in the engine and send the operator to the wrong
      // place; `PLAN_FAILED` says what it is — no plan was produced, and here is why.
      return { code: 'PLAN_FAILED', message: cause.message };
    }
    return {
      code: 'INTERNAL',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }

  private async failRun(
    tenantId: string,
    runId: string,
    error: StructuredRunError,
    checkpoint?: RunCheckpoint,
  ): Promise<RunExecutionOutcome> {
    await this.deps.runs.setStatus(tenantId, runId, 'failed', {
      error: serialiseRunError(error),
      completedAt: new Date(),
    });
    if (checkpoint !== undefined) {
      await this.deps.runs.saveCheckpoint(tenantId, runId, checkpoint);
    }
    this.emit(tenantId, { name: 'run.failed', payload: { runId, error: { code: error.code, message: error.message } } });
    return { status: 'failed', runId, error };
  }

  private async timeout(
    run: Run,
    context: RunContext,
    checkpoint: RunCheckpoint,
  ): Promise<RunExecutionOutcome> {
    const error: StructuredRunError = {
      code: 'RUN_TIMEOUT',
      message: `The run exceeded its ${context.limits.maxDurationMs}ms budget`,
    };
    await this.deps.runs.setStatus(run.tenantId, run.id, 'timeout', {
      error: serialiseRunError(error),
      completedAt: new Date(),
    });
    await this.deps.runs.saveCheckpoint(run.tenantId, run.id, checkpoint);
    this.emit(run.tenantId, {
      name: 'run.failed',
      payload: { runId: run.id, error: { code: error.code, message: error.message } },
    });
    return { status: 'timeout', runId: run.id };
  }

  private emit<N extends SSEEventName>(tenantId: string, frame: SseFrame<N>): void {
    try {
      this.deps.emit?.(tenantId, frame);
    } catch (cause) {
      // A subscriber that throws must not fail a run. The stream is a view of the run, not
      // part of it, and an observability bug that can fail work is worse than no stream.
      this.deps.logger.warn({ err: cause, event: frame.name }, 'failed to emit an SSE frame');
    }
  }
}

// ── step outcomes ─────────────────────────────────────────────────────────────

type StepOutcome =
  | { kind: 'completed'; output: unknown }
  | { kind: 'skipped'; reason: string }
  | { kind: 'approval_required'; planStepId: string; stepId: string; approvalId: string }
  | { kind: 'failed'; error: StructuredRunError };

/** A tool that ran and reported its own failure, as opposed to a call that did not happen. */
class ToolReportedFailure extends Error {
  constructor(
    readonly toolName: string,
    readonly detail: string,
  ) {
    super(`Tool "${toolName}" reported failure`);
    this.name = 'ToolReportedFailure';
  }
}

// ── checkpoint bookkeeping ────────────────────────────────────────────────────

function readCheckpoint(value: unknown): RunCheckpoint | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Partial<RunCheckpoint>;
  if (typeof candidate.nextIndex !== 'number' || typeof candidate.startedAt !== 'string') return null;
  return {
    nextIndex: candidate.nextIndex,
    completedSteps: candidate.completedSteps ?? {},
    outputs: candidate.outputs ?? {},
    toolCallCount: candidate.toolCallCount ?? 0,
    startedAt: candidate.startedAt,
    ...(candidate.planned === undefined ? {} : { planned: candidate.planned }),
    ...(candidate.approvals === undefined ? {} : { approvals: candidate.approvals }),
  };
}

function readPlan(value: unknown): PlanStep[] {
  if (!Array.isArray(value)) return [];
  return value as PlanStep[];
}

function recordCompletion(
  checkpoint: RunCheckpoint,
  stepId: string,
  output: unknown,
  now: number,
): RunCheckpoint {
  return {
    ...checkpoint,
    completedSteps: {
      ...checkpoint.completedSteps,
      [stepId]: { output, completedAt: isoTime(now) },
    },
    outputs: { ...checkpoint.outputs, [stepId]: output },
  };
}

function recordSkip(checkpoint: RunCheckpoint, stepId: string, reason: string): RunCheckpoint {
  return {
    ...checkpoint,
    completedSteps: {
      ...checkpoint.completedSteps,
      [stepId]: { output: { skipped: true, reason }, completedAt: isoTime(Date.now()) },
    },
  };
}

/**
 * The run's output.
 *
 * The last non-skipped step's output, because that is what a caller means by "the result".
 * The whole named-outputs map is preserved alongside it so a consumer can still reach an
 * intermediate value, and so a `goal_criteria` verification has something to judge.
 */
function buildRunOutput(checkpoint: RunCheckpoint): unknown {
  const entries = Object.entries(checkpoint.completedSteps);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const [stepId, record] = entries[index]!;
    if (isSkipMarker(record.output) || isFalseCondition(record.output)) continue;
    return { stepId, result: record.output, outputs: checkpoint.outputs };
  }
  return { stepId: null, result: null, outputs: checkpoint.outputs };
}

function isSkipMarker(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)['skipped'] === true
  );
}

function isFalseCondition(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)['result'] === false &&
    'left' in (value as Record<string, unknown>)
  );
}

// ── transform and condition ───────────────────────────────────────────────────

/**
 * The name space a step's `path` / `left` expression resolves against.
 *
 * Single-sourced deliberately. A plan author writes `left: 'input.go'` to mean "the caller
 * said go", and the one thing that must not vary is where `input` points: if a condition
 * and a transform disagreed about it, the same expression would silently mean two things
 * depending on which step type happened to contain it.
 *
 * A step's own operand (`config.input`) is therefore *not* reachable as `input` — it is
 * `stepInput`, so it cannot shadow the run's payload.
 */
function stepScope(
  planStep: PlanStep,
  checkpoint: RunCheckpoint,
  runInput: unknown,
): Record<string, unknown> {
  return {
    // Prior steps' outputs, keyed by plan-step id: `{{calc.result.result}}`.
    outputs: checkpoint.outputs,
    // The run's input payload. This is the natural subject of a gate condition.
    input: runInput,
    // The same payload under a second name, so `run.input.x` reads as it looks.
    run: { input: runInput },
    // This step's own configuration, for a plan that wants its own literal.
    config: planStep.config,
    // A transform's operand, kept under its own name rather than shadowing `input`.
    stepInput: planStep.config['input'],
  };
}

function performTransform(
  planStep: PlanStep,
  checkpoint: RunCheckpoint,
  runInput: unknown,
): unknown {
  const operation = planStep.config['operation'];
  const input = planStep.config['input'];

  switch (operation) {
    case 'pick': {
      const path = planStep.config['path'];
      if (typeof path !== 'string') throw new Error('transform "pick" needs a "path"');
      return { value: readPath(stepScope(planStep, checkpoint, runInput), path) };
    }
    case 'template': {
      const template = planStep.config['template'];
      if (typeof template !== 'string') throw new Error('transform "template" needs a "template"');
      // The operand's own keys are merged at the top level, which is what makes
      // `{{result.status}}` work for an operand shaped like a tool result; `input` and
      // `run` are added afterwards so a template can also address the run's payload.
      const values = {
        ...checkpoint.outputs,
        ...(typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}),
        input: runInput,
        run: { input: runInput },
      };
      return { value: renderTemplate(template, values) };
    }
    case 'json_parse': {
      const value = typeof input === 'string' ? input : JSON.stringify(input ?? null);
      return { value: JSON.parse(value) };
    }
    default:
      throw new Error(`Unsupported transform operation "${String(operation)}"`);
  }
}

/**
 * A condition returns `{ result, left, right, operator }`.
 *
 * `left` is carried in the output deliberately: `isFalseCondition` uses its presence to
 * tell a condition's `false` apart from any other step whose output happens to be
 * `{ result: false }`, and a branch that silently triggered on an unrelated object would
 * skip half a plan.
 */
function performCondition(
  planStep: PlanStep,
  checkpoint: RunCheckpoint,
  runInput: unknown,
): unknown {
  const operator = planStep.config['operator'];
  if (typeof operator !== 'string') throw new Error('condition needs an "operator"');

  const scope = stepScope(planStep, checkpoint, runInput);
  const left = typeof planStep.config['left'] === 'string'
    ? readPath(scope, planStep.config['left'] as string)
    : planStep.config['left'];
  const right = planStep.config['right'];

  return { result: compareValues(operator, left, right), operator, left, right: right ?? null };
}

function compareValues(operator: string, left: unknown, right: unknown): boolean {
  switch (operator) {
    case 'eq':
      return left === right;
    case 'ne':
      return left !== right;
    case 'exists':
      return left !== undefined && left !== null;
    case 'gt':
      return numeric(left) > numeric(right);
    case 'gte':
      return numeric(left) >= numeric(right);
    case 'lt':
      return numeric(left) < numeric(right);
    case 'lte':
      return numeric(left) <= numeric(right);
    case 'contains':
      return typeof left === 'string' && typeof right === 'string' && left.includes(right);
    case 'matches':
      return typeof left === 'string' && typeof right === 'string' && new RegExp(right).test(left);
    case 'in':
      return Array.isArray(right) && right.includes(left);
    default:
      throw new Error(`Unsupported condition operator "${operator}"`);
  }
}

function numeric(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  // NaN makes every comparison false, which is the safe reading of "these are not
  // comparable" for a branch condition.
  return Number.NaN;
}

/** Dot-path lookup. Returns `undefined` rather than throwing, so `exists` can be expressed. */
export function readPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function renderTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, key: string) => {
    const value = readPath(values, key.trim());
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function renderOutputs(checkpoint: RunCheckpoint): string {
  const entries = Object.entries(checkpoint.outputs);
  if (entries.length === 0) return '(nothing yet)';
  return entries
    .map(([key, value]) => `- ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');
}

// ── approval policy ───────────────────────────────────────────────────────────

/**
 * A coarse risk level derived from capabilities.
 *
 * Deliberately coarse: the vocabulary is closed, the levels are three, and the mapping is
 * documented rather than learned. A finer score would invite tuning it against incidents
 * instead of fixing the policy that let the incident through.
 *
 *  - `low`    — the tool declares no effect.
 *  - `medium` — the effect is inside the system's own boundary: files, notifications,
 *               the sandbox. Reversible by an operator with access to the workspace.
 *  - `high`   — the effect reaches outside: an HTTP write, a connector, anything that has
 *               already happened by the time we could react.
 */
export function assessRisk(capabilities: readonly string[]): {
  level: 'low' | 'medium' | 'high';
  reasons: string[];
} {
  if (capabilities.includes('external_side_effect')) {
    return {
      level: 'high',
      reasons: ['The tool can change something outside this system'],
    };
  }
  const internal = ['writes_files', 'notify', 'sandbox_exec', 'memory'].filter((capability) =>
    capabilities.includes(capability),
  );
  if (internal.length > 0) {
    return {
      level: 'medium',
      reasons: [`The tool can change state inside the workspace (${internal.join(', ')})`],
    };
  }
  return { level: 'low', reasons: [] };
}

export function policyRequiresApproval(
  policy: ApprovalPolicy,
  tool: { name: string; capabilities: readonly string[]; risk: { level: 'low' | 'medium' | 'high' } },
): boolean {
  if (policy.mode === 'none') return false;
  if (policy.mode === 'all') return true;

  const order = { low: 0, medium: 1, high: 2 } as const;
  for (const rule of policy.rules ?? []) {
    const match = rule.match;
    if (match.toolNames !== undefined && !match.toolNames.includes(tool.name)) continue;
    if (
      match.toolCapabilities !== undefined &&
      !match.toolCapabilities.some((capability) => tool.capabilities.includes(capability))
    ) {
      continue;
    }
    if (match.minRisk !== undefined && order[tool.risk.level] < order[match.minRisk]) continue;
    return true;
  }
  return false;
}

function requiredPermissions(planStep: PlanStep): string[] {
  const declared = planStep.config['requiredPermissions'];
  if (!Array.isArray(declared)) return [];
  return declared.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The approval this step was authorised by, as a fragment for the receipt's evidence.
 *
 * Returns `{}` when the step ran without one, so the caller can spread the result
 * unconditionally. An empty object rather than `{ approvalId: null }` on purpose: the
 * receipt's `evidence` is a record of what *did* happen, and a null field would suggest
 * someone looked and found nothing rather than that no approval was ever in play.
 *
 * Only an approval with a decision is cited. A step whose checkpoint entry is missing has
 * not been authorised by anything — and if it somehow reached the tool call anyway, this
 * must not invent a citation for it. The `approved` filter is the same check
 * `resolveApproval` makes before letting a step proceed, so the evidence agrees with the
 * decision to proceed by construction.
 */
function approvalEvidence(
  checkpoint: RunCheckpoint,
  planStepId: string,
): { approvalId?: string } {
  const recorded = checkpoint.approvals?.[planStepId];
  if (recorded === undefined || recorded.decision !== 'approved') return {};
  return { approvalId: recorded.approvalId };
}

// ── misc ──────────────────────────────────────────────────────────────────────

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function elapsedMs(run: Run, now: number): number {
  if (run.startedAt === null) return 0;
  return Math.max(0, now - run.startedAt.getTime());
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Re-exported so callers can render a stored error without importing the parser. */
export { parseRunError };
