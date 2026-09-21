import type {
  ExecutionReceipt,
  ModelUsage,
  Run,
  Step,
  ToolCall,
  Verification,
} from '@prisma/client';
import { parseRunError } from '@nexs/shared';
import type {
  RunDetail,
  RunErrorView,
  RunModelUsageView,
  RunReceiptView,
  RunStepView,
  RunSummary,
  RunToolCallView,
  RunVerificationView,
} from '@nexs/shared';

/**
 * The single place a run row becomes a wire shape.
 *
 * Two decisions are made here rather than in the controller, because they are about what
 * the data *means* rather than how it is transported:
 *
 *  1. **An unparseable `error` column is preserved as `raw`.** `parseRunError` returns
 *     `null` when the column is not JSON. Dropping it would leave a failed run with no
 *     explanation at all, which is worse than an unstructured one.
 *  2. **A tool call's name comes from the joined `Tool` row, and may be `null`.** The name
 *     is not on `ToolCall`; it is joined in, and a missing tool row is reported as `null`
 *     rather than papered over with the id — an operator seeing `null` learns the tool was
 *     deleted, which is the actual situation.
 */

function iso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

function isoRequired(value: Date): string {
  return value.toISOString();
}

/**
 * The `error` column, as a structured error or as raw text.
 *
 * Exported because the run list and the run detail both need it, and a second
 * implementation of "parse this column" is a second thing that can disagree about what a
 * failed run said.
 */
export function toRunErrorView(raw: string | null): RunErrorView | null {
  if (raw === null || raw.length === 0) return null;

  const parsed = parseRunError(raw);
  if (parsed === null) {
    // Not a structured error. `code` is set to a sentinel rather than left blank so a client
    // can render it uniformly, and `raw` carries the actual text.
    return { code: 'UNSTRUCTURED', message: raw, raw };
  }

  return {
    code: parsed.code,
    message: parsed.message,
    ...(parsed.stepId === undefined ? {} : { stepId: parsed.stepId }),
    ...(parsed.issues === undefined ? {} : { issues: parsed.issues }),
    ...(parsed.details === undefined ? {} : { details: parsed.details }),
  };
}

export function toRunSummary(run: Run): RunSummary {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    agentId: run.agentId,
    agentVersionId: run.agentVersionId,
    goalId: run.goalId,
    taskId: run.taskId,
    workflowId: run.workflowId,
    correlationId: run.correlationId,
    idempotencyKey: run.idempotencyKey,
    lastHeartbeatAt: iso(run.lastHeartbeatAt),
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
    durationMs: run.durationMs,
    createdAt: isoRequired(run.createdAt),
    updatedAt: isoRequired(run.updatedAt),
    error: toRunErrorView(run.error),
  };
}

export function toRunStepView(step: Step): RunStepView {
  return {
    id: step.id,
    seq: step.seq,
    position: step.position,
    attempt: step.attempt,
    retryCount: step.retryCount,
    name: step.name,
    description: step.description,
    stepType: step.stepType,
    status: step.status,
    toolId: step.toolId,
    modelId: step.modelId,
    output: step.output,
    // The step's error column holds the serialised structured error, so it is parsed the
    // same way the run's is. A step that failed and a run that failed should read alike.
    error: typeof step.error === 'string' ? toRunErrorView(step.error) : null,
    startedAt: iso(step.startedAt),
    completedAt: iso(step.completedAt),
  };
}

/** A tool call with its tool's name joined in. */
export type ToolCallWithTool = ToolCall & { tool: { name: string } | null };

export function toRunToolCallView(call: ToolCallWithTool): RunToolCallView {
  return {
    id: call.id,
    stepId: call.stepId,
    toolId: call.toolId,
    toolName: call.tool?.name ?? null,
    status: call.status,
    args: call.args,
    result: call.result,
    error: call.error,
    sideEffect: call.sideEffect,
    durationMs: call.durationMs,
    createdAt: isoRequired(call.createdAt),
  };
}

export function toRunReceiptView(receipt: ExecutionReceipt): RunReceiptView {
  return {
    id: receipt.id,
    toolCallId: receipt.toolCallId,
    idempotencyKey: receipt.idempotencyKey,
    effect: receipt.effect,
    evidence: receipt.evidence,
    createdAt: isoRequired(receipt.createdAt),
  };
}

export function toRunVerificationView(verification: Verification): RunVerificationView {
  return {
    id: verification.id,
    stepId: verification.stepId,
    goalId: verification.goalId,
    type: verification.type,
    scope: verification.scope,
    status: verification.status,
    passed: verification.passed,
    config: verification.config,
    evidence: verification.evidence,
    createdAt: isoRequired(verification.createdAt),
    completedAt: iso(verification.completedAt),
  };
}

export function toRunModelUsageView(usage: ModelUsage): RunModelUsageView {
  return {
    id: usage.id,
    modelId: usage.modelId,
    providerId: usage.providerId,
    stepId: usage.stepId,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    latencyMs: usage.latencyMs,
    costEstimate: usage.costEstimate,
    cached: usage.cached,
    createdAt: isoRequired(usage.createdAt),
  };
}

export function toRunDetail(
  run: Run,
  parts: {
    steps: Step[];
    toolCalls: ToolCallWithTool[];
    receipts: ExecutionReceipt[];
    verifications: Verification[];
    modelUsage: ModelUsage[];
  },
): RunDetail {
  return {
    ...toRunSummary(run),
    plan: run.plan,
    input: run.input,
    output: run.output,
    steps: parts.steps.map(toRunStepView),
    toolCalls: parts.toolCalls.map(toRunToolCallView),
    receipts: parts.receipts.map(toRunReceiptView),
    verifications: parts.verifications.map(toRunVerificationView),
    modelUsage: parts.modelUsage.map(toRunModelUsageView),
  };
}
