import type { Action, Approval, Prisma, PrismaClient } from '@prisma/client';
import type { ApprovalStatus, RiskInformation } from '@nexs/shared';

/**
 * Approvals, and the `Action` row each one gates.
 *
 * An approval is the system asking a human a question, and the load-bearing rule is that
 * **the question can only be answered once**. Every method here that moves an approval out
 * of `pending` does it with a conditional write — `updateMany({ where: { id, tenantId,
 * status: 'pending' } })` and a `count !== 1` check — rather than an unconditional update.
 *
 * That is not defensive coding for its own sake. Two operators clicking Approve at the same
 * moment is the ordinary case for an inbox, and so is one operator clicking Approve while
 * the expiry job fires. In both collisions the loser must be told it lost, because the run
 * is about to resume and a second resume must not be issued. An unconditional update would
 * report success to whoever wrote last and leave the engine resuming twice.
 *
 * ## Why `Action` and `Approval` are separate tables
 *
 * `Action` is what the agent *wanted to do*; `Approval` is the permission question about it.
 * Keeping them apart is what lets the same action be re-requested after an expiry without
 * inventing a second action, and it is why `Action.status` tracks execution while
 * `Approval.status` tracks the decision. Collapsing them would lose one of the two.
 *
 * ## `tenantId` is the first argument, always
 *
 * Tenant isolation is structural in this codebase: a plain indexed scalar on every row, and
 * every `where` carries it. Here it matters more than usual, because an approval names a run
 * and a step — possessing an approval id from another tenant must not be a capability to
 * read or decide it.
 */

// ── action ────────────────────────────────────────────────────────────────────

export interface CreateActionRow {
  tenantId: string;
  runId: string | null;
  agentId: string | null;
  kind: string;
  title: string;
  description: string | null;
  payload: Prisma.InputJsonValue;
  risk: Prisma.InputJsonValue;
  requiredPermissions: string[];
}

export class ActionRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: CreateActionRow): Promise<Action> {
    return this.db.action.create({
      data: {
        tenantId: data.tenantId,
        runId: data.runId,
        agentId: data.agentId,
        kind: data.kind,
        title: data.title,
        description: data.description,
        payload: data.payload,
        risk: data.risk,
        requiredPermissions: data.requiredPermissions,
        status: 'pending',
      },
    });
  }

  async findById(tenantId: string, id: string): Promise<Action | null> {
    return this.db.action.findFirst({ where: { id, tenantId } });
  }

  /**
   * Move the action to its outcome.
   *
   * Unconditional on `status` on purpose, unlike the approval transitions: the action
   * mirrors what the run did, and the run's own state machine is what arbitrates that. A
   * conditional write here would be a second, weaker copy of the engine's rules that could
   * disagree with it. The compare-and-swap that matters lives in `ApprovalRepository`.
   */
  async setStatus(
    tenantId: string,
    id: string,
    status: Action['status'],
  ): Promise<Action | null> {
    const { count } = await this.db.action.updateMany({ where: { id, tenantId }, data: { status } });
    if (count !== 1) return null;
    return this.findById(tenantId, id);
  }

  /** Every action a run produced, oldest first — the order they were wanted in. */
  async listByRunId(tenantId: string, runId: string): Promise<Action[]> {
    return this.db.action.findMany({
      where: { tenantId, runId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * The action a step's approval gates.
   *
   * Looked up by run rather than by step, because `Action` carries no `stepId` column —
   * the step lives on the `Approval`. Callers that know the step go through
   * `ApprovalRepository.findForStep` and then read `actionId`.
   */
  async findPendingForRun(tenantId: string, runId: string): Promise<Action[]> {
    return this.db.action.findMany({
      where: { tenantId, runId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
  }
}

// ── approval ──────────────────────────────────────────────────────────────────

export interface CreateApprovalRow {
  tenantId: string;
  actionId: string;
  title: string;
  description: string | null;
  agentId: string | null;
  goalId: string | null;
  taskId: string | null;
  runId: string | null;
  stepId: string | null;
  requestedAction: Prisma.InputJsonValue;
  reason: string | null;
  requiredPermissions: string[];
  riskInformation: Prisma.InputJsonValue;
  expiresAt: Date | null;
  /**
   * `tool` (the plan-step gate) or `exec` (an owner-only command, §4.4).
   *
   * Optional, defaulting to `'tool'` at the column — so every existing caller keeps working and
   * the only path that must state it explicitly is the exec one. `decideExec`'s compare-and-swap
   * filters on `kind: 'exec'`, which means a row written without it can never be answered with
   * `allow_always`, however the request is formed.
   */
  kind?: 'tool' | 'exec';
}

export interface ApprovalListFilters {
  status?: ApprovalStatus;
  runId?: string;
  agentId?: string;
  /** Only `pending` rows whose `expiresAt` has not passed — what the inbox acts on. */
  actionableOnly?: boolean;
  /** Only `pending` rows whose `expiresAt` *has* passed — what the expiry job sweeps. */
  expiredOnly?: boolean;
  /** The instant "expired" is measured against. Injected so tests are not clock-bound. */
  now?: Date;
  limit?: number;
}

export class ApprovalRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: CreateApprovalRow): Promise<Approval> {
    return this.db.approval.create({
      data: {
        tenantId: data.tenantId,
        actionId: data.actionId,
        title: data.title,
        description: data.description,
        agentId: data.agentId,
        goalId: data.goalId,
        taskId: data.taskId,
        runId: data.runId,
        stepId: data.stepId,
        requestedAction: data.requestedAction,
        reason: data.reason,
        requiredPermissions: data.requiredPermissions,
        riskInformation: data.riskInformation,
        expiresAt: data.expiresAt,
        // Omitted rather than defaulted here, so the column's `DEFAULT 'tool'` is the single
        // place the default lives. Writing it explicitly would mean two answers to "what is a
        // newly created approval?", and the column is the one the queries rely on.
        ...(data.kind === undefined ? {} : { kind: data.kind }),
        status: 'pending',
      },
    });
  }

  async findById(tenantId: string, id: string): Promise<Approval | null> {
    return this.db.approval.findFirst({ where: { id, tenantId } });
  }

  /**
   * The approval gating a step, if one exists.
   *
   * Deliberately not filtered to `pending`: the engine asks this question to find out
   * whether a step was *already* decided, and a query that hid decided rows would make a
   * resumed step park again forever — the exact bug the engine's `resolveApproval`
   * comment warns about.
   *
   * The most recent row wins. A step that expired and was re-requested has two rows, and
   * the one that speaks for the step is the newer one; returning the older would resurrect
   * a decision that was already superseded.
   *
   * `createdAt` alone is not a total order. Two requests for the same step inside one
   * millisecond — which a retry immediately after an expiry can easily produce — leave the
   * sort tied, and a tied sort resolves to whatever order the storage engine happens to
   * return. That order is not defined by the schema and differs between Postgres and the
   * in-memory fake, so the answer would change with the backend. `id` is added as a
   * tiebreaker purely to make the result **deterministic**; it is a cuid, so the comparison
   * is arbitrary but stable, which is all a tiebreak needs to be.
   */
  async findForStep(tenantId: string, stepId: string): Promise<Approval | null> {
    return this.db.approval.findFirst({
      where: { tenantId, stepId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async findForAction(tenantId: string, actionId: string): Promise<Approval | null> {
    return this.db.approval.findFirst({ where: { tenantId, actionId } });
  }

  async list(tenantId: string, filters: ApprovalListFilters = {}): Promise<Approval[]> {
    const now = filters.now ?? new Date();
    return this.db.approval.findMany({
      where: {
        tenantId,
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.runId === undefined ? {} : { runId: filters.runId }),
        ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
        // Both bounds are expressed as `expiresAt` predicates rather than a status filter,
        // because "actionable" is about the clock, not the stored status: a pending row
        // whose expiry job has not fired yet is still `pending` in the database.
        ...(filters.actionableOnly === true
          ? { status: 'pending', expiresAt: { gt: now } }
          : {}),
        ...(filters.expiredOnly === true ? { status: 'pending', expiresAt: { lte: now } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
    });
  }

  async count(tenantId: string, filters: { status?: ApprovalStatus } = {}): Promise<number> {
    return this.db.approval.count({
      where: {
        tenantId,
        ...(filters.status === undefined ? {} : { status: filters.status }),
      },
    });
  }

  /** Pending approvals across the tenant — the inbox badge. */
  async countPending(tenantId: string, now: Date = new Date()): Promise<number> {
    return this.db.approval.count({
      where: { tenantId, status: 'pending', expiresAt: { gt: now } },
    });
  }

  /**
   * Answer a pending approval. **The compare-and-swap.**
   *
   * `status: 'pending'` in the `where` is what makes a double decision impossible: of two
   * concurrent callers exactly one finds a row to update, and the other gets `false` and
   * must be told the approval was already decided. An unconditional update would let both
   * report success, and the caller that reports success is the one that resumes the run.
   *
   * `expiresAt: { gt: now }` closes the second race — approve arriving while the expiry
   * job is mid-flight. Without it, an approval that the clock had already invalidated
   * could still be approved, and the run would resume on a decision the expiry job was
   * simultaneously failing. Whichever write lands first wins, and both agree.
   */
  async decide(
    tenantId: string,
    id: string,
    decision: 'approved' | 'rejected',
    decidedBy: string,
    now: Date,
    reason?: string,
  ): Promise<boolean> {
    const { count } = await this.db.approval.updateMany({
      where: { id, tenantId, status: 'pending', expiresAt: { gt: now } },
      data: {
        status: decision,
        decidedBy,
        decidedAt: now,
        ...(reason === undefined ? {} : { reason }),
      },
    });
    return count === 1;
  }

  /**
   * Answer a pending **exec** approval. The same compare-and-swap as `decide`, with one extra
   * condition and one extra column.
   *
   * `kind: 'exec'` in the `where` is what makes the two decision vocabularies impossible to
   * mix up at the database level: `allow_always` can only ever land on a row that is an exec
   * approval, so a malformed request cannot write "allow always" onto step 3 of a plan even if
   * a controller somewhere forgot to check. The check belongs in the query, not only in the
   * service, because this is the write that decides whether a standing permission is granted.
   *
   * `status` is derived by the caller via `execDecisionToStatus`, so `allow_once` and
   * `allow_always` both record `approved` — the difference between them is a row in
   * `ExecAllowlistRule`, not a different state. `decision` records which button was pressed,
   * because "was this once, or from now on?" is the first question an operator asks when a
   * command runs without prompting.
   */
  async decideExec(
    tenantId: string,
    id: string,
    status: 'approved' | 'rejected',
    outcome: string,
    decidedBy: string,
    now: Date,
    reason?: string,
  ): Promise<boolean> {
    const { count } = await this.db.approval.updateMany({
      where: { id, tenantId, kind: 'exec', status: 'pending', expiresAt: { gt: now } },
      data: {
        status,
        decision: outcome,
        decidedBy,
        decidedAt: now,
        ...(reason === undefined ? {} : { reason }),
      },
    });
    return count === 1;
  }

  /**
   * Mark a lapsed approval expired. Compare-and-swap for the same reason as `decide`, with
   * the clock on the other side: only a row still `pending` *and* past its expiry moves.
   *
   * `expiresAt: { lte: now }` is what makes "a decision beats the clock" hold in this
   * direction too — an approval approved a millisecond before this runs is no longer
   * `pending`, so it is left alone. Ordering between the two is decided by the database,
   * not by which job happened to start first.
   */
  async expire(tenantId: string, id: string, now: Date): Promise<boolean> {
    const { count } = await this.db.approval.updateMany({
      where: { id, tenantId, status: 'pending', expiresAt: { lte: now } },
      data: { status: 'expired', decidedAt: now },
    });
    return count === 1;
  }

  /**
   * Every pending approval whose clock has run out, for the expiry sweep.
   *
   * Unscoped by tenant and deliberately so: this is a maintenance read, like
   * `RunRepository.listStale`, and the sweep runs once for the whole system rather than
   * once per tenant. It is the only method here without a `tenantId` argument, and the
   * expiry job re-enters through `expire()`, which is scoped.
   */
  async listLapsed(now: Date, limit: number): Promise<Approval[]> {
    return this.db.approval.findMany({
      where: { status: 'pending', expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  }
}

/** Narrow a stored `riskInformation` blob into the wire shape, defensively. */
export function readRisk(value: unknown): RiskInformation {
  if (value === null || typeof value !== 'object') return { level: 'low', reasons: [] };
  const candidate = value as { level?: unknown; reasons?: unknown };
  const level =
    candidate.level === 'high' || candidate.level === 'medium' || candidate.level === 'low'
      ? candidate.level
      : 'low';
  const reasons = Array.isArray(candidate.reasons)
    ? candidate.reasons.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { level, reasons };
}
