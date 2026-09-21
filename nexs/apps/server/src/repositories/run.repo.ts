import type {
  ExecutionReceipt,
  Prisma,
  PrismaClient,
  Run,
  Step,
  ToolCall,
  Verification,
} from '@prisma/client';
import type { PlanStep, RunCheckpoint, RunStatus, StepStatus, VerifierType } from '@nexs/shared';
import { isUniqueViolation } from '../db-errors.js';
import { toJson, toOptionalJson } from './json.js';

/**
 * Persistence for the execution engine: runs, steps, tool calls, receipts and
 * verifications.
 *
 * Four things about this file are deliberate and worth reading before changing it.
 *
 * **`Step` has no `tenantId` column.** It is owned by its `Run`, and the schema gives it
 * `runId` instead. So `StepRepository` is scoped by `runId`, and every one of its callers
 * must already hold a `Run` that was read through `RunRepository.findById(tenantId, id)`.
 * That is the same trade the MCP repositories make for `MCPTool` (scoped by `serverId`).
 * Where a method could plausibly be reached without that proof — anything that returns
 * data rather than mutating a row the caller already owns — the tenant is still taken and
 * checked, and those are marked.
 *
 * **The claim is a compare-and-swap, not `SELECT … FOR UPDATE`.** The spec's §5.2 says
 * `FOR UPDATE`; `updateMany({ where: { id, tenantId, status: { in: allowed } } })` and a
 * check that exactly one row moved is the same guarantee expressed as a single statement.
 * Both give exactly one winner among concurrent claimers. The CAS is preferred here
 * because `FOR UPDATE` holds a lock for the duration of a transaction, so a second worker
 * *blocks* — consuming a pool connection to wait for a run it will then discover it
 * cannot have — whereas the CAS loser is a cheap no-op and is free to pick up other work.
 *
 * **A step's effect is recorded before the step is completed.** `ToolCall` is written with
 * status `requested` *before* the tool is invoked, and the `ExecutionReceipt` is written
 * after it returns but *before* the step row is marked `completed`. The window between
 * those two writes is the only place a crash can leave an effect whose completion is
 * unknown, and the ordering is what makes that window as small as it can be.
 *
 * **`listStale` is the one unscoped read.** Zombie-run reaping is a startup and
 * cron maintenance path with no request context to derive a tenant from; it has to see
 * every tenant's runs or it misses exactly the orphans it exists to find. Same exception,
 * same justification, as `McpServerRepository.listAllWithPids`.
 */

// ── runs ──────────────────────────────────────────────────────────────────────

export interface RunCreateInput {
  tenantId: string;
  kind: string;
  agentId?: string | null;
  agentVersionId?: string | null;
  goalId?: string | null;
  taskId?: string | null;
  workflowId?: string | null;
  input?: unknown;
  idempotencyKey?: string | null;
  correlationId?: string;
}

export interface RunListFilters {
  status?: string;
  kind?: string;
  agentId?: string;
  goalId?: string;
  taskId?: string;
  workflowId?: string;
  /** Inclusive lower bound on `createdAt`. */
  since?: Date;
  /** Exclusive upper bound on `createdAt`. */
  until?: Date;
  limit?: number;
  skip?: number;
}

export interface RunCompletion {
  output?: unknown;
  durationMs?: number;
  completedAt?: Date;
}

/** Statuses that occupy a worker slot, mirroring `isActiveRunStatus`. */
const ACTIVE_STATUSES: readonly RunStatus[] = ['planning', 'running', 'waiting_approval'];

export class RunRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Create a run, or return the existing one for a repeated idempotency key.
   *
   * The unique index on `(tenantId, idempotencyKey)` is the arbiter rather than a
   * check-then-insert, because two concurrent submissions of the same task would both
   * pass a pre-check and both insert.
   */
  async create(data: RunCreateInput): Promise<Run> {
    try {
      return await this.db.run.create({
        data: {
          tenantId: data.tenantId,
          kind: data.kind,
          agentId: data.agentId ?? null,
          agentVersionId: data.agentVersionId ?? null,
          goalId: data.goalId ?? null,
          taskId: data.taskId ?? null,
          workflowId: data.workflowId ?? null,
          input: toJson(data.input ?? {}),
          idempotencyKey: data.idempotencyKey ?? null,
          ...(data.correlationId === undefined ? {} : { correlationId: data.correlationId }),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err) && data.idempotencyKey !== undefined && data.idempotencyKey !== null) {
        const existing = await this.findByIdempotencyKey(data.tenantId, data.idempotencyKey);
        if (existing !== null) return existing;
      }
      throw err;
    }
  }

  /** Tenant-scoped: the tenant is the first argument and is always in the where. */
  async findById(tenantId: string, id: string): Promise<Run | null> {
    return this.db.run.findFirst({ where: { id, tenantId } });
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<Run | null> {
    return this.db.run.findFirst({ where: { tenantId, idempotencyKey } });
  }

  async list(tenantId: string, filters: RunListFilters = {}): Promise<Run[]> {
    return this.db.run.findMany({
      where: { ...this.filterWhere(tenantId, filters) },
      orderBy: { createdAt: 'desc' },
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
      ...(filters.skip === undefined ? {} : { skip: filters.skip }),
    });
  }

  /** The same filters as `list`, as a count — so a page's total cannot disagree with it. */
  async count(tenantId: string, filters: RunListFilters = {}): Promise<number> {
    return this.db.run.count({ where: this.filterWhere(tenantId, filters) });
  }

  /**
   * One `where` clause for both the list and the count.
   *
   * Written once so the two cannot drift: a filter added to `list` but not `count` would
   * produce a page of results whose stated total was wrong, which is the kind of bug that
   * looks like a UI rounding error and is not.
   */
  private filterWhere(tenantId: string, filters: RunListFilters): Prisma.RunWhereInput {
    const createdAt =
      filters.since === undefined && filters.until === undefined
        ? undefined
        : {
            ...(filters.since === undefined ? {} : { gte: filters.since }),
            ...(filters.until === undefined ? {} : { lt: filters.until }),
          };

    return {
      tenantId,
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.kind === undefined ? {} : { kind: filters.kind }),
      ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
      ...(filters.goalId === undefined ? {} : { goalId: filters.goalId }),
      ...(filters.taskId === undefined ? {} : { taskId: filters.taskId }),
      ...(filters.workflowId === undefined ? {} : { workflowId: filters.workflowId }),
      ...(createdAt === undefined ? {} : { createdAt }),
    };
  }

  /**
   * Pin the agent version a run executes, if it is not already pinned — gap #15.
   *
   * This is a compare-and-swap on `null`, and the `null` in the `where` is the whole
   * mechanism: a second call after the pin has been written matches no rows and changes
   * nothing, so a run that has already started cannot be re-pointed at a newer version by
   * a later delivery of the same job. Returns the number of rows changed, so a caller can
   * tell "I pinned it" from "it was already pinned".
   *
   * The alternative the gap register suggests — snapshotting the config into
   * `Run.checkpoint` — is not used, because `Run.agentVersionId` is already a foreign key
   * to an immutable row. A JSON blob in a checkpoint has no referential integrity, can be
   * overwritten by a checkpoint write, and duplicates a table that exists precisely to
   * hold this.
   */
  async pinAgentVersion(
    tenantId: string,
    id: string,
    agentVersionId: string,
  ): Promise<number> {
    const { count } = await this.db.run.updateMany({
      where: { id, tenantId, agentVersionId: null },
      data: { agentVersionId },
    });
    return count;
  }

  /**
   * How many runs of this tenant are holding a slot.
   *
   * Counted before a claim rather than enforced by a database constraint: the limit is
   * policy (`TENANT_CONCURRENCY`), it is expected to change, and a partial unique index
   * cannot express "at most N per tenant".
   */
  async countActiveForTenant(tenantId: string): Promise<number> {
    return this.db.run.count({ where: { tenantId, status: { in: [...ACTIVE_STATUSES] } } });
  }

  /**
   * Take ownership of a run, atomically.
   *
   * Returns the claimed row, or `null` when another worker got there first or the run is
   * no longer in a claimable state. Callers must treat `null` as "do nothing" rather than
   * as an error — losing the race is the normal outcome of at-least-once delivery.
   *
   * `to` is the status the winner moves the run to, and it is a parameter rather than
   * always `running` because a first pass goes to `planning`: the run is not executing
   * yet, and the UI distinguishes the two. Making it a separate statement after the claim
   * would open a window where a second worker could see `running` and start executing a
   * plan that does not exist.
   *
   * ## What the compare-and-swap does not do
   *
   * It compares *status*, not identity, so it excludes a second claim only when the first
   * one **changed** the status. `running` is in `allowedFrom` because an orphaned run's row
   * says `running` and recovery has to be able to take it — which means a claim from
   * `running` succeeds even though the run is already `running`, and therefore a second
   * worker handed a duplicate job for a live run will claim it and execute it alongside the
   * first.
   *
   * That is not a race the CAS can lose, and nothing here narrows it. What keeps it from
   * happening is upstream: `PgBossRunQueue` sends one job per run (`singletonKey: runId`),
   * and the recovery sweep only enqueues a run whose heartbeat is older than
   * `RUN_STALE_AFTER_MS`. Both are liveness *heuristics*, so the honest statement is that a
   * run whose worker is alive but has not heartbeat within the window can be executed twice.
   * Closing it properly means making the reclaim conditional on the heartbeat it was
   * justified by, which the claim does not currently take as an argument.
   */
  async claim(
    tenantId: string,
    id: string,
    allowedFrom: readonly RunStatus[],
    to: RunStatus = 'running',
  ): Promise<Run | null> {
    const now = new Date();
    const { count } = await this.db.run.updateMany({
      where: { id, tenantId, status: { in: [...allowedFrom] } },
      data: { status: to, lastHeartbeatAt: now },
    });
    if (count !== 1) return null;

    // `startedAt` is the *first* claim's timestamp and must survive a resume, so it is
    // set by its own guarded statement rather than in the CAS above.
    await this.db.run.updateMany({
      where: { id, tenantId, startedAt: null },
      data: { startedAt: now },
    });

    return this.findById(tenantId, id);
  }

  /** Move a run to `status`, optionally writing more columns in the same statement. */
  async setStatus(
    tenantId: string,
    id: string,
    status: RunStatus,
    extra: { error?: string | null; output?: unknown; completedAt?: Date | null } = {},
  ): Promise<number> {
    const data: Record<string, unknown> = { status };
    if (extra.error !== undefined) data['error'] = extra.error;
    if (extra.output !== undefined) data['output'] = toJson(extra.output);
    if (extra.completedAt !== undefined) data['completedAt'] = extra.completedAt;
    const { count } = await this.db.run.updateMany({ where: { id, tenantId }, data });
    return count;
  }

  /** Store the validated plan. Called once, before the first execution pass. */
  async savePlan(tenantId: string, id: string, plan: readonly PlanStep[]): Promise<number> {
    const { count } = await this.db.run.updateMany({
      where: { id, tenantId },
      data: { plan: toJson(plan) },
    });
    return count;
  }

  async saveCheckpoint(tenantId: string, id: string, checkpoint: RunCheckpoint): Promise<number> {
    const { count } = await this.db.run.updateMany({
      where: { id, tenantId },
      data: { checkpoint: toJson(checkpoint) },
    });
    return count;
  }

  async heartbeat(tenantId: string, id: string): Promise<number> {
    const { count } = await this.db.run.updateMany({
      where: { id, tenantId },
      data: { lastHeartbeatAt: new Date() },
    });
    return count;
  }

  async complete(tenantId: string, id: string, completion: RunCompletion = {}): Promise<number> {
    const data: Record<string, unknown> = {
      status: 'completed',
      completedAt: completion.completedAt ?? new Date(),
    };
    if (completion.output !== undefined) data['output'] = toJson(completion.output);
    if (completion.durationMs !== undefined) data['durationMs'] = completion.durationMs;
    const { count } = await this.db.run.updateMany({ where: { id, tenantId }, data });
    return count;
  }

  /** Runs waiting for a worker, oldest first — the order a fair queue would take them in. */
  async listQueued(tenantId: string, limit: number): Promise<Run[]> {
    return this.db.run.findMany({
      where: { tenantId, status: 'queued' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Every tenant's runs whose heartbeat has gone quiet.
   *
   * The unscoped read described at the top of this file. `cutoff` is computed by the
   * caller from `RUN_STALE_AFTER_MS` so the policy stays in configuration rather than
   * being baked into a query.
   */
  async listStale(cutoff: Date, statuses: readonly RunStatus[] = ACTIVE_STATUSES): Promise<Run[]> {
    return this.db.run.findMany({
      where: {
        status: { in: [...statuses] },
        OR: [{ lastHeartbeatAt: { lt: cutoff } }, { lastHeartbeatAt: null }],
      },
    });
  }

  /** Total wall-clock duration for a finished run, derived from its own timestamps. */
  static durationMsBetween(run: Pick<Run, 'startedAt'>, end: Date): number {
    if (run.startedAt === null) return 0;
    return Math.max(0, end.getTime() - run.startedAt.getTime());
  }

  /**
   * One step row by id, for callers that hold a step id and need its position.
   *
   * Unscoped by tenant, and it is the one read here that is, deliberately. `Step` has no
   * `tenantId` column — its isolation comes from `runId`, which is why the class comment
   * for the step repository below records it as a documented exception. The intended
   * caller is `ApprovalService.planStepIdFor`, which reaches it only after re-reading the
   * owning `Run` through a tenant-scoped query and confirming the approval it already read
   * belongs to this tenant. Possessing a step id is not, by itself, a way in: this method
   * is not reachable from any HTTP route.
   */
  async findStepById(stepId: string): Promise<Step | null> {
    return this.db.step.findUnique({ where: { id: stepId } });
  }
}

// ── steps ─────────────────────────────────────────────────────────────────────

/**
 * A step's idempotency key.
 *
 * `Step` carries a unique index on `(runId, seq, attempt)`, which is the real guard: it
 * is what makes "ensure the step row" safe to call twice. This column is the same triple
 * in a form that can be written on a receipt and read by a human, and it is what the
 * `ExecutionReceipt` cites so that a receipt can be traced back to the exact attempt that
 * produced it. The two must agree — if they ever diverge the index is still correct and
 * the receipt is merely less useful, which is the safe direction for a redundancy.
 */
export function stepIdempotencyKey(runId: string, seq: number, attempt: number): string {
  return `${runId}:${seq}:${attempt}`;
}

export interface StepEnsureInput {
  runId: string;
  seq: number;
  position: number;
  name: string;
  description?: string | null;
  stepType: string;
  toolId?: string | null;
  modelId?: string | null;
  input?: unknown;
  attempt?: number;
}

export class StepRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Get the step row for `(runId, seq, attempt)`, creating it if it is not there.
   *
   * Idempotent by design: the engine calls this on every pass, including replays, and a
   * second call must return the existing row rather than fail on the unique index. The
   * create is still attempted rather than relying solely on the pre-read, because two
   * workers can pass the pre-read together; the index is what actually decides, and the
   * loser re-reads.
   */
  async ensure(input: StepEnsureInput): Promise<Step> {
    const attempt = input.attempt ?? 0;
    const existing = await this.findBySeq(input.runId, input.seq, attempt);
    if (existing !== null) return existing;

    try {
      return await this.db.step.create({
        data: {
          runId: input.runId,
          seq: input.seq,
          position: input.position,
          name: input.name,
          description: input.description ?? null,
          stepType: input.stepType,
          toolId: input.toolId ?? null,
          modelId: input.modelId ?? null,
          input: toOptionalJson(input.input),
          attempt,
          idempotencyKey: stepIdempotencyKey(input.runId, input.seq, attempt),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const raced = await this.findBySeq(input.runId, input.seq, attempt);
        if (raced !== null) return raced;
      }
      throw err;
    }
  }

  async findBySeq(runId: string, seq: number, attempt: number): Promise<Step | null> {
    return this.db.step.findFirst({ where: { runId, seq, attempt } });
  }

  async findById(id: string): Promise<Step | null> {
    return this.db.step.findFirst({ where: { id } });
  }

  async findByRunId(runId: string): Promise<Step[]> {
    return this.db.step.findMany({ where: { runId }, orderBy: { seq: 'asc' } });
  }

  /** Steps of a run, oldest attempt first — the execution order. */
  async listByRunIdOrdered(runId: string): Promise<Step[]> {
    return this.db.step.findMany({
      where: { runId },
      orderBy: [{ seq: 'asc' }, { attempt: 'asc' }],
    });
  }

  /**
   * The most recently started steps across a set of runs — the dashboard's activity feed.
   *
   * `Step` carries no `tenantId`, so this method is **not** tenant-scoped and must only be
   * given run ids from a tenant-scoped read. That is the documented ownership proof for leaf
   * rows: the caller resolves the runs for a tenant first, and possession of a run id whose
   * ownership was already established is the authorisation for the steps beneath it. The
   * dashboard does exactly that — see `DashboardService`, which passes the ids of runs it
   * just listed for the tenant and never a caller-supplied id.
   *
   * Filtered to steps that have actually **started**, and that filter is load-bearing rather
   * than cosmetic. Ordering a nullable column is the trap: Postgres sorts `NULL`s first under
   * `DESC`, so an unfiltered query would put every not-yet-started step at the top of a feed
   * called "recent activity" — presenting the things that have not happened as the most
   * recent things that did.
   */
  async listRecentForRuns(runIds: readonly string[], limit: number): Promise<Step[]> {
    if (runIds.length === 0) return [];
    return this.db.step.findMany({
      where: { runId: { in: [...runIds] }, startedAt: { not: null } },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  }

  /**
   * `updateMany` rather than `update`: `Step` has no tenant column, so the guard is the
   * `runId` the caller proved ownership of. Passing it explicitly means a step id from
   * another run updates nothing instead of everything.
   */
  private async setStep(
    runId: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<number> {
    const { count } = await this.db.step.updateMany({ where: { id, runId }, data });
    return count;
  }

  async markRunning(runId: string, id: string): Promise<number> {
    return this.setStep(runId, id, { status: 'running', startedAt: new Date() });
  }

  async markWaitingApproval(runId: string, id: string): Promise<number> {
    return this.setStep(runId, id, { status: 'waiting_approval' });
  }

  async markCompleted(runId: string, id: string, output: unknown): Promise<number> {
    return this.setStep(runId, id, {
      status: 'completed',
      output: toOptionalJson(output),
      completedAt: new Date(),
      error: null,
    });
  }

  async markFailed(runId: string, id: string, error: string): Promise<number> {
    return this.setStep(runId, id, {
      status: 'failed',
      error,
      completedAt: new Date(),
    });
  }

  async markSkipped(runId: string, id: string, reason?: string): Promise<number> {
    return this.setStep(runId, id, {
      status: 'skipped',
      ...(reason === undefined ? {} : { error: reason }),
      completedAt: new Date(),
    });
  }

  /**
   * A retry is a *new* step row, not a mutation of the failed one.
   *
   * The unique index is `(runId, seq, attempt)`, so attempt 1 is a distinct row that
   * coexists with attempt 0. That is what keeps the history honest: a reader can see that
   * a step failed twice and succeeded on the third try, and the receipts from the failed
   * attempts still point at the rows they belong to.
   */
  async nextAttempt(runId: string, seq: number): Promise<number> {
    const attempts = await this.db.step.findMany({ where: { runId, seq } });
    let highest = -1;
    for (const row of attempts) {
      if (row.attempt > highest) highest = row.attempt;
    }
    return highest + 1;
  }

  async saveCheckpoint(runId: string, id: string, checkpoint: unknown): Promise<number> {
    return this.setStep(runId, id, { checkpoint: toJson(checkpoint) });
  }
}

// ── tool calls ────────────────────────────────────────────────────────────────

export interface ToolCallRecordInput {
  tenantId: string;
  runId?: string | null;
  stepId?: string | null;
  toolId: string;
  args: unknown;
  /** Mirrors the tool's declared capabilities at the moment of the call. */
  sideEffect: boolean;
}

export class ToolCallRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Write the `requested` row *before* the tool runs.
   *
   * This is the record that makes an interrupted call detectable. Without it, a process
   * killed between "invoke" and "record result" would leave no trace that the call ever
   * started, and a resume would cheerfully fire a second email. With it, the resume finds
   * a `requested` call with no receipt and knows the effect is in doubt.
   */
  async record(input: ToolCallRecordInput): Promise<ToolCall> {
    return this.db.toolCall.create({
      data: {
        tenantId: input.tenantId,
        runId: input.runId ?? null,
        stepId: input.stepId ?? null,
        toolId: input.toolId,
        args: toJson(input.args),
        sideEffect: input.sideEffect,
        status: 'requested',
      },
    });
  }

  /** Tenant-scoped: the tenant is the first argument and is always in the where. */
  async findById(tenantId: string, id: string): Promise<ToolCall | null> {
    return this.db.toolCall.findFirst({ where: { id, tenantId } });
  }

  /** Scoped by `stepId`; the caller must already hold the step's run. */
  async findByStep(stepId: string): Promise<ToolCall[]> {
    return this.db.toolCall.findMany({ where: { stepId }, orderBy: { createdAt: 'asc' } });
  }

  /**
   * Every tool call a run made, with each tool's name joined in.
   *
   * The join is here rather than left to the caller because a tool call is unreadable
   * without the name — `tol_9f3a` tells an operator nothing — and the alternative is an
   * N+1 in the mapper. Ordered by `createdAt` so the calls read in the order they happened,
   * which is the order the run detail view shows them in.
   */
  async listByRunIdWithTool(runId: string): Promise<Array<ToolCall & { tool: { name: string } | null }>> {
    return this.db.toolCall.findMany({
      where: { runId },
      include: { tool: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    }) as Promise<Array<ToolCall & { tool: { name: string } | null }>>;
  }

  async countForRun(runId: string): Promise<number> {
    return this.db.toolCall.count({ where: { runId } });
  }

  async markExecuted(
    tenantId: string,
    id: string,
    result: unknown,
    durationMs: number,
  ): Promise<number> {
    const { count } = await this.db.toolCall.updateMany({
      where: { id, tenantId },
      data: { status: 'executed', result: toJson(result), durationMs, error: null },
    });
    return count;
  }

  async markFailed(
    tenantId: string,
    id: string,
    error: string,
    durationMs: number,
  ): Promise<number> {
    const { count } = await this.db.toolCall.updateMany({
      where: { id, tenantId },
      data: { status: 'failed', error, durationMs },
    });
    return count;
  }
}

// ── execution receipts ────────────────────────────────────────────────────────

export interface ReceiptCreateInput {
  tenantId: string;
  toolCallId: string;
  effect: unknown;
  idempotencyKey: string;
  evidence?: unknown;
}

export class ExecutionReceiptRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(input: ReceiptCreateInput): Promise<ExecutionReceipt> {
    return this.db.executionReceipt.create({
      data: {
        tenantId: input.tenantId,
        toolCallId: input.toolCallId,
        effect: toJson(input.effect),
        idempotencyKey: input.idempotencyKey,
        evidence: toJson(input.evidence ?? {}),
      },
    });
  }

  /** Tenant-scoped: the tenant is the first argument and is always in the where. */
  async findByToolCall(tenantId: string, toolCallId: string): Promise<ExecutionReceipt | null> {
    return this.db.executionReceipt.findFirst({ where: { toolCallId, tenantId } });
  }

  /**
   * The receipt for a step, if one exists.
   *
   * Deliberately two queries rather than one relation filter: `ExecutionReceipt.idempotencyKey`
   * carries no index in the schema, while `toolCallId` is `@unique`, so going through the
   * tool calls is the path that stays fast as the table grows. The key on the receipt is
   * for traceability — it says which step *attempt* produced the effect — not for lookup.
   */
  async findForStep(stepId: string): Promise<ExecutionReceipt | null> {
    const calls = await this.db.toolCall.findMany({ where: { stepId } });
    if (calls.length === 0) return null;
    return this.db.executionReceipt.findFirst({
      where: { toolCallId: { in: calls.map((call) => call.id) } },
    });
  }

  async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ExecutionReceipt | null> {
    return this.db.executionReceipt.findFirst({ where: { tenantId, idempotencyKey } });
  }

  /**
   * Every receipt a run produced.
   *
   * Two queries rather than one relation filter, matching `findForStep`: `toolCallId` is
   * `@unique` and indexed, so going through the run's tool calls is the path that stays
   * fast. It also keeps this working against the in-memory fake, which models scalar
   * predicates but not relation filters.
   *
   * Scoped by `tenantId` even though the caller reaches it through a run it already owns:
   * the receipt table is tenant-owned, and a method that omitted the predicate would be the
   * one place a future caller could read across tenants.
   */
  async listByRunId(tenantId: string, runId: string): Promise<ExecutionReceipt[]> {
    const calls = await this.db.toolCall.findMany({ where: { runId } });
    if (calls.length === 0) return [];
    return this.db.executionReceipt.findMany({
      where: { tenantId, toolCallId: { in: calls.map((call) => call.id) } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * The tenant's most recent receipts, with the run and the tool each belongs to.
   *
   * Three queries rather than a relation chain, for the same reason `findForStep` is two:
   * `ExecutionReceipt` has no `runId`, so the run is reached through the tool call. Doing the
   * join here rather than in the service keeps data access in the layer that owns it, and
   * keeps the fake's "no relation filters in `where`" limit from shaping the service.
   *
   * `runId` and `toolName` are nullable in the result **on purpose**. A receipt whose tool
   * call was pruned is still the record that an effect happened; dropping the row, or
   * substituting a placeholder name, would hide exactly the thing a receipt exists to prove.
   */
  async listRecentWithContext(
    tenantId: string,
    limit: number,
  ): Promise<
    Array<{ receipt: ExecutionReceipt; runId: string | null; toolName: string | null }>
  > {
    const receipts = await this.db.executionReceipt.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    if (receipts.length === 0) return [];

    const calls = await this.db.toolCall.findMany({
      where: { id: { in: receipts.map((receipt) => receipt.toolCallId) } },
      include: { tool: true },
    });
    const callById = new Map(calls.map((call) => [call.id, call]));

    return receipts.map((receipt) => {
      const call = callById.get(receipt.toolCallId);
      return {
        receipt,
        runId: call?.runId ?? null,
        toolName: call?.tool.name ?? null,
      };
    });
  }
}

// ── verifications ─────────────────────────────────────────────────────────────

export interface VerificationCreateInput {
  tenantId: string;
  runId?: string | null;
  stepId?: string | null;
  goalId?: string | null;
  type: VerifierType;
  scope?: 'step' | 'goal_criteria';
  config: unknown;
}

export class VerificationRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(input: VerificationCreateInput): Promise<Verification> {
    return this.db.verification.create({
      data: {
        tenantId: input.tenantId,
        runId: input.runId ?? null,
        stepId: input.stepId ?? null,
        goalId: input.goalId ?? null,
        type: input.type,
        scope: input.scope ?? 'step',
        config: toJson(input.config),
      },
    });
  }

  /** Tenant-scoped: the tenant is the first argument and is always in the where. */
  async complete(
    tenantId: string,
    id: string,
    outcome: { passed: boolean; evidence: unknown },
  ): Promise<number> {
    const { count } = await this.db.verification.updateMany({
      where: { id, tenantId },
      data: {
        passed: outcome.passed,
        status: outcome.passed ? 'passed' : 'failed',
        evidence: toJson(outcome.evidence),
        completedAt: new Date(),
      },
    });
    return count;
  }

  async findByRunId(tenantId: string, runId: string): Promise<Verification[]> {
    return this.db.verification.findMany({
      where: { runId, tenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * A verification by id, tenant-scoped.
   *
   * This is the read the goal-completion gate depends on: a caller says "complete this goal
   * against verification X", and the service re-reads X here rather than trusting the
   * claim. The tenant predicate is load-bearing rather than defensive — without it, a
   * caller could name another tenant's passing verification and complete their own goal
   * with evidence that has nothing to do with it.
   */
  async findById(tenantId: string, id: string): Promise<Verification | null> {
    return this.db.verification.findFirst({ where: { id, tenantId } });
  }

  /**
   * The `goal_criteria` verification for a run, which is the only thing that may mark a
   * goal complete.
   *
   * Returns the most recent one, so a goal re-verified after a failure is judged on the
   * latest evidence rather than on the first attempt's.
   */
  async findGoalCriteria(tenantId: string, runId: string): Promise<Verification | null> {
    return this.db.verification.findFirst({
      where: { tenantId, runId, scope: 'goal_criteria' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * How many verifications this tenant has, split by outcome — the dashboard's summary.
   *
   * One grouped query rather than four counts, because four counts is four round trips and
   * four chances for the numbers to be read from four different moments. The groups are also
   * what makes the arithmetic honest: `total` is the sum of the groups, not a separate
   * `count(*)`, so `pending + passed + failed === total` is a property of the query rather
   * than an assertion someone has to remember to keep true.
   *
   * The `status: { in: … }` narrowing is load-bearing for that same reason. The schema
   * comment closes the vocabulary at `pending|passed|failed`, and counting only those means
   * a row with an unrecognised status is excluded from the total *and* from every part,
   * consistently. The alternative — an unfiltered total with three named parts — would let a
   * future status make the total silently exceed the sum of what the UI displays, which
   * reads as a rendering bug and is not one. Adding a status therefore has to be a deliberate
   * act that also adds a counter, which is the right amount of friction.
   *
   * `since` is optional because the caller owns the window policy (`DASHBOARD_FAILURE_WINDOW_DAYS`
   * is a failure window, not a verification one); omitting it means "everything".
   */
  async summarize(
    tenantId: string,
    since?: Date,
  ): Promise<{ total: number; pending: number; passed: number; failed: number }> {
    const groups = await this.db.verification.groupBy({
      by: ['status'],
      where: {
        tenantId,
        status: { in: ['pending', 'passed', 'failed'] },
        ...(since === undefined ? {} : { createdAt: { gte: since } }),
      },
      _count: true,
    });

    const counts = { pending: 0, passed: 0, failed: 0 };
    let total = 0;
    for (const group of groups) {
      const count = typeof group._count === 'number' ? group._count : 0;
      total += count;
      if (group.status === 'pending' || group.status === 'passed' || group.status === 'failed') {
        counts[group.status] += count;
      }
    }

    return { total, ...counts };
  }
}

// ── step status helper ────────────────────────────────────────────────────────

export function isStepTerminal(status: string): status is StepStatus {
  return status === 'completed' || status === 'skipped';
}
