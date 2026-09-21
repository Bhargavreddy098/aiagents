import {
  DEFAULT_RUN_LIMITS,
  normaliseApprovalPolicy,
  SUCCESS_CRITERION_TYPES,
  type PlanStep,
  type RunLimits,
  type SuccessCriterion,
} from '@nexs/shared';
import type { Run } from '@prisma/client';
import type { RunContext, RunContextResolver } from './execution-engine.js';
import { readContextBlock } from './run-input.js';

/**
 * The default run-context resolver: the configuration travels on the run itself.
 *
 * This exists so the engine has no compile-time dependency on `Agent`, `AgentVersion` or
 * `Goal`, which is what keeps Phase 5 buildable and testable before Phase 6 exists. It
 * reads a `context` block out of `Run.input`, which is how a caller that already knows
 * what it wants a run to do describes it — a test, an ad-hoc API run, or a workflow that
 * carries its own instructions.
 *
 * **It is not the final resolver.** Phase 6 supplies one that reads the `AgentVersion` the
 * run pinned at start [gap #15], and that is the one production runs will use. The
 * distinction matters: reading configuration from the run's input is fine when the caller
 * *is* the source of truth, and wrong when the run is supposed to execute a snapshot of an
 * agent that may have been edited since. Swapping the resolver is the whole mechanism —
 * the engine itself never learns where its context came from.
 *
 * Defaults are deliberately conservative. A run with no declared model cannot plan, so
 * `modelId` is required; everything else has a safe fallback, and the approval policy
 * falls back to `none` because an unconfigured run that started parking for approval would
 * be a surprising thing to discover in production.
 */

export interface InputContextBlock {
  instructions?: string;
  modelId?: string;
  allowedToolIds?: string[];
  approvalPolicy?: unknown;
  limits?: Partial<RunLimits>;
  goal?: string;
  task?: string;
  successCriteria?: unknown;
  presetPlan?: unknown;
}

export interface InputContextResolverOptions {
  /** Used when the run's input does not name a model. */
  defaultModelId?: string;
  /** Used when the run's input does not carry a limits block. */
  defaultLimits?: Partial<RunLimits>;
}

export function createInputContextResolver(
  options: InputContextResolverOptions = {},
): RunContextResolver {
  return async (run: Run): Promise<RunContext> => {
    const block = readContextBlock(run.input) as InputContextBlock;
    const modelId = block.modelId ?? options.defaultModelId;

    if (modelId === undefined || modelId.length === 0) {
      throw new Error(
        `Run ${run.id} has no model: its input carries no "context.modelId" and no default is configured`,
      );
    }

    return {
      instructions: block.instructions ?? '',
      modelId,
      allowedToolIds: block.allowedToolIds ?? [],
      approvalPolicy: normaliseApprovalPolicy(block.approvalPolicy),
      limits: { ...DEFAULT_RUN_LIMITS, ...(options.defaultLimits ?? {}), ...(block.limits ?? {}) },
      goal: block.goal ?? null,
      task: block.task ?? null,
      goalId: run.goalId,
      ...(block.successCriteria === undefined
        ? {}
        : { successCriteria: readSuccessCriteria(block.successCriteria) }),
      ...(block.presetPlan === undefined ? {} : { presetPlan: block.presetPlan as PlanStep[] }),
    };
  };
}

/**
 * Narrow a stored `successCriteria` value into real criteria.
 *
 * A criterion with an unknown `type` is dropped rather than kept, because the verifier
 * would fail it — and a goal that can never complete because of a typo in a stored config
 * is a worse outcome than one that completes without that check. The drop is visible: it
 * is logged by the verifier when the criterion set is empty.
 */
export function readSuccessCriteria(value: unknown): SuccessCriterion[] {
  if (!Array.isArray(value)) return [];
  const out: SuccessCriterion[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const candidate = entry as Partial<SuccessCriterion>;
    if (typeof candidate.type !== 'string') continue;
    if (!SUCCESS_CRITERION_TYPES.includes(candidate.type as never)) continue;
    out.push({
      type: candidate.type,
      config:
        candidate.config !== null && typeof candidate.config === 'object'
          ? (candidate.config as Record<string, unknown>)
          : {},
      description: candidate.description ?? candidate.type,
    });
  }
  return out;
}
