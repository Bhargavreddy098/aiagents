import {
  ApiError,
  canTransitionRun,
  isTerminalRunStatus,
  type ListRunsQuery,
  type RunDetail,
  type RunListResponse,
  type RunStatus,
} from '@nexs/shared';
import type {
  ExecutionReceiptRepository,
  RunRepository,
  StepRepository,
  ToolCallRepository,
  VerificationRepository,
} from '../../repositories/run.repo.js';
import type { ModelUsageRepository } from '../../repositories/model-usage.repo.js';
import type { RunQueue } from '../queue/run-queue.js';
import type { EngineEmitter } from '../engine/execution-engine.js';
import type { Logger } from '../../logger.js';
import { toRunDetail, toRunSummary } from '../../mappers/run.js';

/**
 * Runs: reading them, and steering them.
 *
 * ## Where cancel and pause actually take effect
 *
 * Setting `Run.status` does not stop a worker. The engine's loop re-reads the run at every
 * **step boundary** and returns early when it sees `cancelled` or `paused`, so a status
 * change is honoured within one step's duration rather than immediately — a tool call that
 * is already in flight is not interrupted, because interrupting it would leave an effect
 * whose result was never recorded.
 *
 * ## Why the service emits the frame as well as the engine
 *
 * The engine emits `run.cancelled` when it *observes* the stop, which is the moment the run
 * actually stopped. This service emits it when the *request* is accepted, which is the
 * moment the operator acted. Those are genuinely different facts, and a UI wants both: the
 * button should acknowledge immediately, and the run should visibly stop when it stops.
 *
 * The duplicate is harmless because the frames carry no payload beyond the run id — a client
 * applying them twice ends in the same state. What would be harmful is emitting only from
 * the engine, because a run cancelled while `queued` is never executed and so would produce
 * no frame at all: the operator's action would be invisible.
 */

export interface RunServiceDeps {
  runs: RunRepository;
  steps: StepRepository;
  toolCalls: ToolCallRepository;
  receipts: ExecutionReceiptRepository;
  verifications: VerificationRepository;
  modelUsage: ModelUsageRepository;
  queue: RunQueue;
  logger: Logger;
  emit?: EngineEmitter;
}

export class RunService {
  constructor(private readonly deps: RunServiceDeps) {}

  async list(tenantId: string, query: ListRunsQuery = {}): Promise<RunListResponse> {
    const filters = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
      ...(query.goalId === undefined ? {} : { goalId: query.goalId }),
      ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
      ...(query.workflowId === undefined ? {} : { workflowId: query.workflowId }),
      ...(query.since === undefined ? {} : { since: query.since }),
      ...(query.until === undefined ? {} : { until: query.until }),
    };

    // The rows and the total come from the same filter object, so a page's stated total
    // cannot disagree with the page. `count` and `list` share one `where` builder in the
    // repository for the same reason.
    const [runs, total] = await Promise.all([
      this.deps.runs.list(tenantId, {
        ...filters,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { skip: query.offset }),
      }),
      this.deps.runs.count(tenantId, filters),
    ]);

    return { runs: runs.map(toRunSummary), total };
  }

  async get(tenantId: string, id: string): Promise<RunDetail> {
    const run = await this.requireRun(tenantId, id);

    const [steps, toolCalls, receipts, verifications, modelUsage] = await Promise.all([
      this.deps.steps.listByRunIdOrdered(id),
      this.deps.toolCalls.listByRunIdWithTool(id),
      this.deps.receipts.listByRunId(tenantId, id),
      this.deps.verifications.findByRunId(tenantId, id),
      this.deps.modelUsage.listByRunId(tenantId, id),
    ]);

    return toRunDetail(run, { steps, toolCalls, receipts, verifications, modelUsage });
  }

  /**
   * Ask a run to stop.
   *
   * A terminal run is refused rather than silently accepted: reporting success for a run
   * that had already completed would tell the operator they stopped something that in fact
   * ran to the end.
   */
  async cancel(tenantId: string, id: string): Promise<RunDetail> {
    return this.transition(tenantId, id, 'cancelled');
  }

  async pause(tenantId: string, id: string): Promise<RunDetail> {
    return this.transition(tenantId, id, 'paused');
  }

  /**
   * Continue a run that was paused.
   *
   * The run is moved back to `running` and re-queued, because a paused run has no worker:
   * the loop that would have continued it returned when it saw `paused`. Nothing is
   * recomputed — the plan, the completed steps and the checkpoint all survive, so execution
   * picks up at the next step rather than restarting.
   *
   * Re-queueing is safe because the engine's claim is a compare-and-swap: if two resume
   * requests arrive, one wins the claim and the other is a cheap no-op.
   */
  async resume(tenantId: string, id: string): Promise<RunDetail> {
    const detail = await this.transition(tenantId, id, 'running');

    await this.deps.queue.enqueue({ runId: id, tenantId, kind: detail.kind });
    this.deps.logger.info({ tenantId, runId: id }, 'run resumed and re-queued');

    return detail;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async transition(
    tenantId: string,
    id: string,
    target: RunStatus,
  ): Promise<RunDetail> {
    const run = await this.requireRun(tenantId, id);
    const from = run.status as RunStatus;

    if (isTerminalRunStatus(from)) {
      throw new ApiError('CONFLICT', `The run is already ${from}`, { status: from });
    }
    if (from === target) {
      throw new ApiError('CONFLICT', `The run is already ${target}`, { status: from });
    }
    if (!canTransitionRun(from, target)) {
      throw new ApiError('CONFLICT', `A run cannot go from ${from} to ${target}`, {
        from,
        to: target,
      });
    }

    const changed = await this.deps.runs.setStatus(tenantId, id, target);
    if (changed === 0) {
      // The run moved between the read and the write — most likely because the engine
      // finished it in the meantime. Re-read so the caller sees what actually happened
      // rather than the stale status this call was reasoning about.
      const fresh = await this.requireRun(tenantId, id);
      throw new ApiError('CONFLICT', `The run is now ${fresh.status}`, { status: fresh.status });
    }

    this.emitFrame(tenantId, target, id);
    this.deps.logger.info({ tenantId, runId: id, from, to: target }, 'run status changed');

    return this.get(tenantId, id);
  }

  private emitFrame(tenantId: string, target: RunStatus, runId: string): void {
    if (this.deps.emit === undefined) return;
    if (target === 'cancelled') {
      this.deps.emit(tenantId, { name: 'run.cancelled', payload: { runId } });
    } else if (target === 'paused') {
      this.deps.emit(tenantId, { name: 'run.paused', payload: { runId } });
    } else if (target === 'running') {
      this.deps.emit(tenantId, { name: 'run.resumed', payload: { runId } });
    }
  }

  private async requireRun(tenantId: string, id: string) {
    const run = await this.deps.runs.findById(tenantId, id);
    if (run === null) throw notFound(id);
    return run;
  }
}

function notFound(id: string): ApiError {
  return new ApiError('NOT_FOUND', 'The run does not exist', { runId: id });
}
