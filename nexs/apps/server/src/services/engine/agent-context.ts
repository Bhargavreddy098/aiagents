import {
  DEFAULT_RUN_LIMITS,
  normaliseApprovalPolicy,
  type PlanStep,
  type RunLimits,
} from '@nexs/shared';
import type { Run } from '@prisma/client';
import type { AgentRepository } from '../../repositories/agent.repo.js';
import { readAgentConfigSnapshot } from '../../repositories/agent.repo.js';
import type { GoalRepository } from '../../repositories/goal.repo.js';
import type { Logger } from '../../logger.js';
import type { RunContext, RunContextResolver } from './execution-engine.js';
import { createInputContextResolver, readSuccessCriteria } from './default-context.js';

/**
 * The real run-context resolver: a run reads its configuration from the `AgentVersion` it
 * pinned at start, never from the live `Agent` row — **gap #15**.
 *
 * ## Why this is the whole point
 *
 * An agent is edited while a run is in flight. The run's plan was built against one set of
 * instructions, one model and one tool allowlist; if the next step resolves the *live* row,
 * it executes the second half of a plan under a configuration the plan was never built for.
 * The failure is silent — nothing errors, the run simply does something the operator did
 * not ask for, and the audit trail says the agent was edited at some point.
 *
 * Pinning closes it: `Run.agentVersionId` is written once, at run start, and every later
 * read goes through it. The version row is immutable, so the configuration cannot move
 * underneath a running plan.
 *
 * ## Where the pin is written
 *
 * In the **engine**, immediately before this resolver is called — see
 * `ExecutionEngine.pinAgentVersionIfNeeded`. Not here: a resolver that writes is a
 * surprising resolver, and pinning at resolve time would mean a resolve could happen
 * against an unpinned run, which is the exact state this design exists to make impossible.
 * The run-creating services also pin at creation, so the common path never needs the
 * engine's fallback; the fallback exists for runs created without an agent-aware service.
 *
 * ## Two sources, one shape
 *
 * A run either has an agent (config comes from the pinned snapshot) or it does not (an
 * ad-hoc or chat run, which describes its own configuration in `Run.input`). The second
 * case is Phase 5's resolver, reused rather than reimplemented.
 */

export interface AgentContextResolverDeps {
  agents: AgentRepository;
  goals: GoalRepository;
  logger: Logger;
  /** Used only for a run with no agent and no model of its own. */
  defaultModelId?: string;
  defaultLimits?: Partial<RunLimits>;
}

export function createAgentContextResolver(deps: AgentContextResolverDeps): RunContextResolver {
  const fromInput = createInputContextResolver({
    ...(deps.defaultModelId === undefined ? {} : { defaultModelId: deps.defaultModelId }),
    ...(deps.defaultLimits === undefined ? {} : { defaultLimits: deps.defaultLimits }),
  });

  return async (run: Run): Promise<RunContext> => {
    if (run.agentVersionId === null) {
      // No agent. Either an ad-hoc run describing itself, or a bug upstream that failed to
      // pin. The two are indistinguishable from here, so this reads the input and lets the
      // missing-model error surface with its own message rather than guessing.
      return fromInput(run);
    }

    const version = await deps.agents.findVersionById(run.tenantId, run.agentVersionId);
    if (version === null) {
      // A pinned version that cannot be read is not a case to paper over by falling back to
      // the live agent. That fallback would silently substitute a different configuration
      // for the one the plan was built against — which is precisely the bug this file
      // exists to prevent. Failing the run is the honest outcome.
      throw new Error(
        `Run ${run.id} pinned agent version ${run.agentVersionId}, which could not be read`,
      );
    }

    const snapshot = readAgentConfigSnapshot(version.config);
    if (snapshot === null) {
      throw new Error(
        `Run ${run.id} pinned agent version ${run.agentVersionId}, whose config is not a snapshot`,
      );
    }

    const modelId = snapshot.modelId ?? deps.defaultModelId;
    if (modelId === undefined || modelId.length === 0) {
      // The version is immutable, so this cannot be fixed by editing the agent — a new
      // version is needed, and the message should say so.
      throw new Error(
        `Run ${run.id} pinned agent version ${run.agentVersionId}, which names no model`,
      );
    }

    // The goal's criteria are what the run is judged against. Read from the goal row at
    // resolve time rather than copied into the run, because a criterion is a *claim about
    // the world* — it is evaluated when the run finishes, not when it starts, and freezing
    // it at start would let a goal be completed against a check the operator has since
    // corrected.
    //
    // `readSuccessCriteria` is Phase 5's narrowing helper, reused rather than reimplemented:
    // it keeps each criterion's `config` (a `schema` criterion without its schema judges
    // nothing) and drops entries whose `type` the verifier does not recognise, so a typo in
    // a stored goal cannot make it permanently uncompletable.
    const goal = run.goalId === null ? null : await deps.goals.findById(run.tenantId, run.goalId);
    const criteria = goal === null ? [] : readSuccessCriteria(goal.criteria);

    return {
      instructions: snapshot.instructions,
      modelId,
      allowedToolIds: snapshot.toolIds,
      approvalPolicy: normaliseApprovalPolicy(snapshot.approvalPolicy),
      limits: { ...DEFAULT_RUN_LIMITS, ...readLimits(snapshot.executionLimits) },
      goal: goal?.title ?? null,
      task: null,
      goalId: run.goalId,
      ...(criteria.length === 0 ? {} : { successCriteria: criteria }),
      ...presetPlanFrom(run),
    };
  };
}

/**
 * Read the execution limits an operator stored, keeping only what the engine understands.
 *
 * Unknown keys are dropped rather than passed through: `maxContextTokens` is an agent-level
 * budgeting setting that the *gateway* applies, not a run limit, and letting it through
 * would put a field on `RunContext.limits` that nothing reads — which reads as a limit that
 * is being enforced when it is not.
 */
function readLimits(value: unknown): Partial<RunLimits> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: Partial<RunLimits> = {};

  for (const key of [
    'maxSteps',
    'maxToolCalls',
    'maxDurationMs',
    'stepTimeoutMs',
    'maxRetries',
  ] as const) {
    const candidate = raw[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      out[key] = candidate;
    }
  }
  return out;
}

/**
 * A plan the run carries rather than one the planner invents.
 *
 * This is how a workflow run works. The plan is **copied into the run's input at creation**
 * rather than re-derived from the workflow at execution time, because the schema has no
 * `Run.workflowVersionId` to pin against — so the plan is frozen by value. Editing the
 * workflow afterwards therefore cannot change a run that is already in flight, which is the
 * same guarantee `agentVersionId` provides for configuration, obtained a different way.
 *
 * It is returned as a partial context so a run with no preset plan does not gain a
 * `presetPlan: undefined` key — which `exactOptionalPropertyTypes` would reject and which
 * would make `context.presetPlan !== undefined` a lie.
 */
function presetPlanFrom(run: Run): { presetPlan: PlanStep[] } | Record<string, never> {
  if (run.input === null || typeof run.input !== 'object' || Array.isArray(run.input)) return {};
  const context = (run.input as Record<string, unknown>)['context'];
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return {};
  const plan = (context as Record<string, unknown>)['presetPlan'];
  if (!Array.isArray(plan) || plan.length === 0) return {};
  return { presetPlan: plan as PlanStep[] };
}
