import {
  ApiError,
  execCommandMatches,
  execDecisionToStatus,
  isExecRuleActive,
  type ApprovalDetail,
  type ApprovalStatus,
  type ApprovalSummary,
  type CheckExecInput,
  type DecideApprovalInput,
  type DecideExecApprovalInput,
  type ExecAllowlistRuleSummary,
  type ExecDecisionOption,
  type ExecRequestedAction,
  type RequestExecApprovalInput,
} from '@nexs/shared';
import type { Approval, ExecAllowlistRule } from '@prisma/client';
import type { ActionRepository, ApprovalRepository } from '../../repositories/approval.repo.js';
import type { ExecAllowlistRepository } from '../../repositories/exec-allowlist.repo.js';
import type { RunRepository } from '../../repositories/run.repo.js';
import type { Logger } from '../../logger.js';
import type {
  ApprovalDecision as GateDecision,
  ApprovalGate,
  ApprovalRequestInput,
  EngineEmitter,
  ExecutionEngine,
} from '../engine/execution-engine.js';
import type { NotificationService } from '../notifications/notification.service.js';
import { toApprovalDetail, toApprovalSummary } from '../../mappers/approval.js';

/**
 * Approvals: the system asking a human, and the run waiting for the answer.
 *
 * This service is the seam the engine was built around in Phase 5. The engine already
 * knows how to park a run, emit `approval.created`, and resume from a decision — what it
 * did not have was a table to ask. `request()` and `findForStep()` are the `ApprovalGate`
 * the engine expects, and they are the **only** two methods the engine calls.
 *
 * ## The problem this file actually solves
 *
 * The engine keys a decision on the **plan-step id**, because a decision applies to a step
 * rather than to one attempt of it — a retry must find the same approval rather than asking
 * again. The `Approval` table keys on the database **step row**, because that is what its
 * foreign key points at. Those are different identifiers, and nothing in the schema records
 * the mapping.
 *
 * So the decision path has to recover the plan-step id to call `resumeRun` at all. It is
 * recovered from `Run.plan`: the plan is stored as an array of steps each carrying its own
 * `id`, and the approval's `stepId` names the database row, whose `seq` is the step's
 * position. `planStepIdFor()` is that lookup, and it is why `resumeRun` is given a plan-step
 * id rather than the row id — handing it the row id would write a checkpoint entry under a
 * key the engine never reads, and the resumed step would park again forever.
 *
 * ## Why approve and reject go through the engine rather than updating a status
 *
 * Flipping `Approval.status` would make the inbox look right and leave the run parked. The
 * run is the thing that has to move, and the engine is the only component permitted to
 * mutate run state — so the decision is recorded in the checkpoint and then the run is
 * resumed, all through `engine.resumeRun`. The approval row is updated *first*, because it
 * is the compare-and-swap that decides whether this caller won; a caller that lost must not
 * resume anything.
 *
 * ## Expiry
 *
 * `expireDue()` is the sweep behind the `approval.expire` delayed job. It fails the step
 * through the same path a rejection takes, so an expired approval does not leave a run
 * parked forever — which is the honest reading of "the human did not answer in time".
 */

/**
 * Schedules the delayed job that will expire one approval.
 *
 * A port rather than a `QueueService` import, for the same reason the engine takes an
 * `ApprovalGate` rather than a repository: the service's job is to decide *that* a deadline
 * needs acting on, and how that instruction reaches a worker is transport. Optional, so the
 * service is constructible in a test and in a process with no queue — a missing scheduler
 * costs the precision of the fire time, never correctness, because `expireDue()` remains
 * the backstop.
 */
export interface ApprovalExpiryScheduler {
  scheduleApprovalExpiry(approvalId: string, expiresAt: Date): Promise<void>;
}

export interface ApprovalServiceDeps {
  approvals: ApprovalRepository;
  actions: ActionRepository;
  runs: RunRepository;
  notifications: NotificationService;
  /**
   * Standing exec permissions (§4.4). What `allow_always` writes, and what the gateway
   * consults before deciding whether to ask a human at all.
   */
  execRules: ExecAllowlistRepository;
  /**
   * Who the command owner is (§5.6).
   *
   * A port rather than a tenant lookup, for the reason the engine takes an `ApprovalGate`
   * rather than a repository: the service's job is to decide *that* a caller is not the owner,
   * and where ownership is recorded is a storage question. It also means a test can grant
   * ownership in one line instead of seeding a tenant row to say so.
   */
  owner: OwnerDirectory;
  /** Bound late: the engine's constructor needs this service's gate. See `bindEngine`. */
  logger: Logger;
  emit?: EngineEmitter;
  now?: () => number;
  /**
   * Enqueues the `approval.expire` delayed job (spec §4-PHASE11).
   *
   * Left out, an approval is still swept — by the recurring cron and by any explicit
   * `expireDue()` call. What is lost is *timeliness*: the sweep finds it at the next tick
   * rather than at the moment its own deadline passed.
   */
  expiry?: ApprovalExpiryScheduler;
}

/**
 * The command owner (§5.6): the one identity allowed to run privileged commands and to grant
 * an exec approval.
 *
 * `null` means **nobody**, and that is a deliberate distinction rather than an inconvenience.
 * A workspace with no owner can grant no standing permission and answers every exec request
 * with a refusal that names the fix — which is materially different from treating "no owner
 * configured" as "everyone is the owner", the reading that would make this whole gate
 * decorative in exactly the deployment where it matters most.
 */
export interface OwnerDirectory {
  findOwner(tenantId: string): Promise<string | null>;
}

/** What an exec decision returns. */
export interface ExecDecideResult {
  approval: ApprovalDetail;
  /** What the engine did with the run. `null` when the command was not attached to one. */
  runOutcome: { status: string; runId: string } | null;
  /** The rule `allow_always` created. `null` for `allow_once` and `deny`. */
  createdRule: ExecAllowlistRuleSummary | null;
}

/**
 * The answer to "is this command already permitted?".
 *
 * `reason` is prose for a log line and never a substitute for `allowed` — a caller that
 * branched on the sentence would break the moment it was reworded, and the two could then
 * disagree.
 */
export interface ExecCheckResult {
  allowed: boolean;
  rule: ExecAllowlistRuleSummary | null;
  reason: string;
}

export interface DecideResult {
  approval: ApprovalDetail;
  /** What the engine did with the run. `null` when there was no run to resume. */
  runOutcome: { status: string; runId: string } | null;
}

export class ApprovalService implements ApprovalGate {
  private engine: ExecutionEngine | undefined;

  constructor(private readonly deps: ApprovalServiceDeps) {}

  /**
   * Hand the service its engine, after both exist.
   *
   * The container builds the engine, which needs this gate; and this service, which needs to
   * resume runs. One of the two edges must be late, and this is the cheaper one: a single
   * setter, versus the engine taking a factory or the gate taking an indirection it would
   * otherwise never need. Nothing can call `decide()` before the container returns, because
   * no HTTP route exists until `createApp` has.
   */
  bindEngine(engine: ExecutionEngine): void {
    this.engine = engine;
  }

  // ── the engine's gate ───────────────────────────────────────────────────────

  /**
   * Record that a step needs a human, and return the id the engine will cite.
   *
   * Two rows, because they answer different questions: an `Action` is what the agent wanted
   * to do, an `Approval` is the question about it. The action is what the inbox shows as the
   * payload; the approval carries the deadline, the risk and the decision.
   *
   * The `Action` is keyed by run rather than by step — the table has no `stepId` column —
   * so a run with two approvals has two actions distinguishable only by their content. That
   * is acceptable here and deliberately not "fixed" with a schema change: the inbox always
   * renders an approval together with the action the approval points at, so the pairing is
   * never ambiguous to the reader.
   */
  async request(input: ApprovalRequestInput): Promise<{ approvalId: string }> {
    const run = await this.deps.runs.findById(input.tenantId, input.runId);

    // The engine hands over a `stepId`, and this is the row the approval points at. The
    // plan-step id is recovered on the way back out, in `planStepIdFor`.
    const stepId = input.stepId;

    const action = await this.deps.actions.create({
      tenantId: input.tenantId,
      runId: input.runId,
      agentId: run?.agentId ?? null,
      kind: 'approval',
      title: input.title,
      description: input.description ?? null,
      payload: {
        runId: input.runId,
        stepId,
        title: input.title,
        description: input.description ?? null,
        requiredPermissions: input.requiredPermissions,
        risk: input.risk,
        requestedAt: new Date(this.now()).toISOString(),
      },
      risk: input.risk,
      requiredPermissions: input.requiredPermissions,
    });

    const approval = await this.deps.approvals.create({
      tenantId: input.tenantId,
      actionId: action.id,
      title: input.title,
      description: input.description ?? null,
      agentId: run?.agentId ?? null,
      goalId: run?.goalId ?? null,
      taskId: run?.taskId ?? null,
      runId: input.runId,
      stepId,
      requestedAction: {
        runId: input.runId,
        title: input.title,
        description: input.description ?? null,
        risk: input.risk,
        requiredPermissions: input.requiredPermissions,
      },
      reason: input.description ?? null,
      requiredPermissions: input.requiredPermissions,
      riskInformation: input.risk,
      expiresAt: input.expiresAt,
    });

    this.deps.logger.info(
      {
        tenantId: input.tenantId,
        approvalId: approval.id,
        runId: input.runId,
        risk: input.risk.level,
      },
      'approval requested',
    );

    // Notify everyone who can act on it. A pending approval nobody was told about is a run
    // that will time out rather than one that was refused, and the difference matters.
    await this.notifyApprovers(input, approval);

    // Schedule the expiry for this approval's own deadline (the spec's `approval.expire`
    // delayed job). Failing to enqueue it is logged and swallowed: the row is `pending` and
    // the recurring sweep will find it, so a queue hiccup delays a sweep rather than
    // stranding a run. The one thing that must not happen is the approval not existing —
    // and that has already succeeded above.
    if (this.deps.expiry !== undefined && approval.expiresAt !== null) {
      await this.deps.expiry.scheduleApprovalExpiry(approval.id, approval.expiresAt).catch((err: unknown) => {
        this.deps.logger.warn(
          { err, tenantId: input.tenantId, approvalId: approval.id },
          'could not schedule the approval expiry job; the periodic sweep will catch it',
        );
      });
    }

    // The `approval.created` frame itself is emitted by the engine, not here — the engine
    // emits it whether or not a gate is wired, and emitting a second one would double every
    // inbox refresh.
    return { approvalId: approval.id };
  }

  /**
   * The approval gating a step, in the shape the engine reads.
   *
   * Returns `null` for "no approval exists", which the engine reads as "this step has not
   * asked yet" and therefore parks. A decided row is returned with its decision, which is
   * what lets a resumed step proceed instead of asking again.
   *
   * `decision` is `null` while pending. The engine treats `null` as "keep waiting", so a
   * pending row does not accidentally read as a rejection.
   */
  async findForStep(tenantId: string, stepId: string): Promise<GateDecision | null> {
    const approval = await this.deps.approvals.findForStep(tenantId, stepId);
    if (approval === null) return null;

    const status = approval.status as ApprovalStatus;
    return {
      id: approval.id,
      status,
      decision:
        status === 'approved' ? 'approved' : status === 'rejected' || status === 'expired' ? 'rejected' : null,
    };
  }

  // ── the inbox ───────────────────────────────────────────────────────────────

  async list(
    tenantId: string,
    filters: { status?: ApprovalStatus; runId?: string; agentId?: string; actionableOnly?: boolean; limit?: number } = {},
  ): Promise<ApprovalSummary[]> {
    const rows = await this.deps.approvals.list(tenantId, filters);
    const now = new Date(this.now());
    return rows.map((row) => toApprovalSummary(row, now));
  }

  async get(tenantId: string, id: string): Promise<ApprovalDetail> {
    const approval = await this.requireApproval(tenantId, id);
    const action = await this.deps.actions.findById(tenantId, approval.actionId);
    if (action === null) {
      // A dangling approval is a broken invariant, not a missing resource: the FK is
      // required, so this can only happen if the row was written outside this service.
      throw new ApiError('INTERNAL_ERROR', 'The approval references a missing action', {
        approvalId: id,
        actionId: approval.actionId,
      });
    }

    const run =
      approval.runId === null ? null : await this.deps.runs.findById(tenantId, approval.runId);
    const runView = run === null ? null : { id: run.id, kind: run.kind, status: run.status };

    return toApprovalDetail(approval, action, runView, new Date(this.now()));
  }

  async countPending(tenantId: string): Promise<number> {
    return this.deps.approvals.countPending(tenantId, new Date(this.now()));
  }

  /**
   * Answer a pending approval and move the run.
   *
   * The order is the whole of the correctness argument:
   *
   *  1. **Claim the decision.** `approvals.decide()` is a compare-and-swap that only matches
   *     a row still `pending` and not yet lapsed. A loser gets `false` and is told the
   *     approval was already decided — and crucially never reaches step 2, so a double click
   *     cannot resume a run twice.
   *  2. **Mirror it onto the action**, so the inbox row and the action agree.
   *  3. **Resume the run**, handing the engine the *plan-step* id (see `planStepIdFor`).
   *
   * Step 3 can fail — the run may have been cancelled while the approval sat in the inbox, or
   * the process may die between 1 and 3. Neither is silent: a failure to resume is logged and
   * surfaced as an `INTERNAL_ERROR`, and the approval stays decided. That asymmetry is
   * deliberate — the decision really was made, and losing it would mean asking the human
   * again for something they already answered. The run is recoverable by the stale-run
   * reaper; an unmade decision is not.
   */
  async decide(
    tenantId: string,
    id: string,
    userId: string,
    input: DecideApprovalInput,
  ): Promise<DecideResult> {
    const approval = await this.requireApproval(tenantId, id);

    if (approval.status !== 'pending') {
      throw new ApiError('CONFLICT', `The approval was already ${approval.status}`, {
        approvalId: id,
        status: approval.status,
      });
    }

    const now = new Date(this.now());
    const won = await this.deps.approvals.decide(
      tenantId,
      id,
      input.decision,
      userId,
      now,
      input.reason,
    );

    if (!won) {
      // Lost the race — either a second operator clicked first, or the expiry job fired.
      // Re-read to say which, because the two want different words: "already approved by
      // someone else" is not "this request timed out while you were looking at it".
      const current = await this.deps.approvals.findById(tenantId, id);
      throw new ApiError('CONFLICT', describeLostRace(current), {
        approvalId: id,
        status: current?.status ?? 'unknown',
      });
    }

    await this.deps.actions.setStatus(
      tenantId,
      approval.actionId,
      input.decision === 'approved' ? 'approved' : 'rejected',
    );

    this.deps.logger.info(
      { tenantId, approvalId: id, decision: input.decision, decidedBy: userId },
      'approval decided',
    );

    this.deps.emit?.(tenantId, {
      name: 'approval.resolved',
      payload: { approvalId: id, decision: input.decision, decidedBy: userId },
    });

    const runOutcome = await this.resumeRun(tenantId, approval, input.decision);

    return { approval: await this.get(tenantId, id), runOutcome };
  }

  // ── exec approvals: the owner-only command gate (§4.4) ──────────────────────

  /**
   * Raise an approval for a command that is about to run.
   *
   * **The owner's own request is refused.** The card exists so a human can authorise a command
   * the gateway is about to run. If the requester *is* the owner, the card has one possible
   * answer: it would write a `pending` row only the clock could resolve, because the owner
   * approving their own request is the self-approval this gate replaces. The refusal says to run
   * it directly, which is also what the caller wants to hear.
   *
   * **An unowned workspace is refused** because nobody could legally answer — see
   * `OwnerDirectory`. The alternative reading, "no owner means everyone", makes the gate
   * decorative exactly where it matters most.
   */
  async requestExec(
    tenantId: string,
    requestedBy: string,
    input: RequestExecApprovalInput,
  ): Promise<ApprovalDetail> {
    const ownerId = await this.deps.owner.findOwner(tenantId);

    if (ownerId === null) {
      throw new ApiError('FORBIDDEN', OWNER_UNCONFIGURED, { tenantId });
    }
    if (ownerId === requestedBy) {
      throw new ApiError(
        'FORBIDDEN',
        'You are the command owner, so this command needs no approval — run it directly.',
        { tenantId, command: input.command },
      );
    }

    // The exact argv the owner will be shown, copied once and reused for the eventual rule.
    // Building it twice is how a card ends up describing a different command from the authorised one.
    const request: ExecRequestedAction = {
      command: input.command,
      args: [...input.args],
      cwd: input.cwd,
    };

    const expiresAt = new Date(this.now() + (input.expiresInMs ?? EXEC_APPROVAL_TTL_MS));
    const risk = {
      level: 'high',
      // Not a judgement about the command's content — this service cannot read a shell command
      // and will not pretend to. It is the honest level for "runs code on the host".
      reasons: [`runs a command on the host in ${request.cwd}`],
    };

    // Two rows, as for a tool approval: the action is what the command *is* and survives a lapse,
    // so re-requesting is a new question about the same command rather than a competing one.
    const action = await this.deps.actions.create({
      tenantId,
      runId: input.runId ?? null,
      agentId: null,
      kind: 'exec',
      title: `${request.command} ${request.args.join(' ')}`.trim(),
      description: input.description ?? null,
      payload: { ...request },
      risk,
      requiredPermissions: ['sandbox_exec'],
    });

    const approval = await this.deps.approvals.create({
      tenantId,
      actionId: action.id,
      title: `Run ${request.command}`,
      description: input.description ?? null,
      agentId: null,
      goalId: null,
      taskId: null,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      requestedAction: { ...request },
      reason: null,
      requiredPermissions: ['sandbox_exec'],
      riskInformation: risk,
      expiresAt,
      kind: 'exec',
    });

    // Only the owner is told. The tool path fans out to every tenant member — correct there,
    // while there are no roles — but here it would put a "run this command" card in front of
    // people who cannot answer it, which is how a security control starts to look like noise.
    await this.notifyOwner(tenantId, ownerId, approval.id, approval.title, approval.description);

    if (this.deps.expiry !== undefined) {
      try {
        await this.deps.expiry.scheduleApprovalExpiry(approval.id, expiresAt);
      } catch (err) {
        // Losing the precise fire time costs timeliness, never correctness: `expireDue()` is the
        // backstop and it runs on the cron.
        this.deps.logger.warn(
          { err, tenantId, approvalId: approval.id },
          'could not schedule the exec approval expiry; the sweep remains the backstop',
        );
      }
    }

    this.deps.emit?.(tenantId, {
      name: 'approval.created',
      payload: {
        approvalId: approval.id,
        title: approval.title,
        risk,
        expiresAt: expiresAt.toISOString(),
      },
    });

    return this.get(tenantId, approval.id);
  }

  /**
   * Is this caller the command owner?
   *
   * Authorisation lives here rather than in a controller so every caller — the web route, the
   * CLI, a channel's inline button — gets one answer without repeating the rule. A check each
   * entry point must remember is a check one of them will forget.
   */
  private async assertOwner(tenantId: string, userId: string): Promise<void> {
    const ownerId = await this.deps.owner.findOwner(tenantId);

    if (ownerId === null) throw new ApiError('FORBIDDEN', OWNER_UNCONFIGURED, { tenantId });
    if (ownerId !== userId) {
      throw new ApiError('FORBIDDEN', 'Only the command owner may grant an exec approval', {
        tenantId,
        ownerId,
      });
    }
  }

  /**
   * Tell the owner a command is waiting.
   *
   * Failures are logged and swallowed, for the same trade the tool path makes: the approval row
   * exists and the command stays blocked either way, and losing that because a bell could not be
   * rung would be the wrong way round.
   */
  private async notifyOwner(
    tenantId: string,
    ownerId: string,
    approvalId: string,
    title: string,
    description: string | null,
  ): Promise<void> {
    try {
      await this.deps.notifications.create({
        tenantId,
        userId: ownerId,
        kind: 'approval_request',
        title,
        body: description ?? undefined,
        linkRoute: `/approvals?approval=${approvalId}`,
      });
    } catch (err) {
      this.deps.logger.warn(
        { err, tenantId, approvalId },
        'could not notify the owner; the approval is still in the inbox',
      );
    }
  }

  /**
   * Answer an exec approval: allow once, allow always, or deny.
   *
   * The order mirrors `decide` — authorise, claim, mirror, act — with one addition: on
   * `allow_always` a **standing rule** is written, and that happens *after* the
   * compare-and-swap. If it happened before, a lost race would leave a permission granted by
   * whoever did not win the decision: a permanent consequence for a decision never recorded.
   */
  async decideExec(
    tenantId: string,
    id: string,
    userId: string,
    input: DecideExecApprovalInput,
  ): Promise<ExecDecideResult> {
    await this.assertOwner(tenantId, userId);

    const approval = await this.requireApproval(tenantId, id);

    // A tool approval answered through this endpoint is a client bug, and saying so beats
    // recording `allow_always` against a plan step. The repository's CAS enforces the same thing
    // in its `where`; this check exists so the caller gets a sentence rather than a zero-row
    // update that looks like a lost race.
    if (approval.kind !== 'exec') {
      throw new ApiError(
        'VALIDATION_ERROR',
        'This approval is a plan-step gate; decide it with the approve/reject endpoint',
        { approvalId: id, kind: approval.kind },
      );
    }

    const status = execDecisionToStatus(input.decision as ExecDecisionOption);
    const now = new Date(this.now());

    const won = await this.deps.approvals.decideExec(
      tenantId,
      id,
      status,
      input.decision,
      userId,
      now,
      input.reason,
    );

    if (!won) {
      const current = await this.deps.approvals.findById(tenantId, id);
      throw new ApiError('CONFLICT', describeLostRace(current), {
        approvalId: id,
        status: current?.status ?? 'unknown',
      });
    }

    await this.deps.actions.setStatus(tenantId, approval.actionId, status);

    const createdRule =
      input.decision === 'allow_always'
        ? await this.grantStandingPermission(tenantId, approval, userId)
        : null;

    this.deps.logger.info(
      {
        tenantId,
        approvalId: id,
        outcome: input.decision,
        decidedBy: userId,
        ruleId: createdRule?.id ?? null,
      },
      'exec approval decided',
    );

    this.deps.emit?.(tenantId, {
      name: 'approval.resolved',
      payload: { approvalId: id, decision: status, decidedBy: userId, outcome: input.decision },
    });

    // The run, if there was one, is told through the same path a tool decision takes — so an
    // allowed command resumes its step and a denied one fails it, with no second mechanism to
    // keep in step with the first.
    const runOutcome = await this.resumeRun(tenantId, approval, status);

    return { approval: await this.get(tenantId, id), runOutcome, createdRule };
  }

  /**
   * Write the rule `allow_always` promises, from the request the owner actually saw.
   *
   * The command is read back out of the stored `requestedAction` rather than taken as a
   * parameter. That is the security property, not a style choice: a caller whose in-memory value
   * had drifted could otherwise grant permission for one command while the owner approved
   * another — and that column is the only record of what was approved.
   */
  private async grantStandingPermission(
    tenantId: string,
    approval: Approval,
    createdBy: string,
  ): Promise<ExecAllowlistRuleSummary> {
    const request = readExecRequest(approval.requestedAction);

    if (request === null) {
      // An exec approval with no readable command is a broken invariant, not a missing field.
      // Refusing is the only safe answer: a rule with no command authorises nothing at best.
      throw new ApiError('INTERNAL_ERROR', 'The exec approval carries no readable command', {
        approvalId: approval.id,
      });
    }

    const rule = await this.deps.execRules.create({
      tenantId,
      agentId: approval.agentId,
      command: request.command,
      args: [...request.args],
      cwd: request.cwd,
      createdBy,
      // No expiry: "always" is what the button says. A default TTL would make the label a lie,
      // and an operator who wants a window can revoke the rule.
      expiresAt: null,
    });

    return toExecRuleSummary(rule, new Date(this.now()));
  }

  /**
   * "Is this command already permitted?" — asked *before* raising an approval.
   *
   * The cheap path, and the whole reason `allow_always` is worth having: the gateway consults
   * this instead of asking a human again. Deliberately a read — any authenticated member may call
   * it, and what it returns is only ever a rule the owner already granted.
   */
  async checkExec(tenantId: string, input: CheckExecInput): Promise<ExecCheckResult> {
    const now = new Date(this.now());
    const request: ExecRequestedAction = {
      command: input.command,
      args: [...input.args],
      cwd: input.cwd,
    };

    const candidates = await this.deps.execRules.findCandidates(
      tenantId,
      request.command,
      request.cwd,
      input.agentId ?? null,
      now,
    );

    // `execCommandMatches` is applied here, over candidates the database narrowed by command and
    // cwd — the arg rule cannot be expressed in a `where`, and approximating it in SQL would be a
    // second implementation of one security rule.
    const rule =
      candidates.find(
        (candidate) => execCommandMatches(candidate, request) && isExecRuleActive(candidate, now),
      ) ?? null;

    if (rule === null) {
      return {
        allowed: false,
        rule: null,
        reason: 'No standing permission covers this command in this directory.',
      };
    }

    // Best-effort. The command is authorised either way, and losing an audit timestamp must not
    // turn an allowed command into a refused one.
    let lastUsedAt = rule.lastUsedAt;
    try {
      await this.deps.execRules.touchLastUsed(tenantId, rule.id, now);
      lastUsedAt = now;
    } catch (err) {
      this.deps.logger.warn({ err, tenantId, ruleId: rule.id }, 'could not record exec rule use');
    }

    return {
      allowed: true,
      rule: toExecRuleSummary({ ...rule, lastUsedAt }, now),
      reason: 'A standing permission covers this command in this directory.',
    };
  }

  /** The standing permissions, for the Settings list and the audit view. */
  async listExecRules(
    tenantId: string,
    filters: { agentId?: string; includeInactive?: boolean; limit?: number } = {},
  ): Promise<ExecAllowlistRuleSummary[]> {
    const now = new Date(this.now());
    const rows = await this.deps.execRules.list(tenantId, filters);
    return rows.map((row) => toExecRuleSummary(row, now));
  }

  /**
   * Take a standing permission away.
   *
   * Owner-only, like granting it: a permission one member can revoke and another can grant is not
   * a permission. The repository's compare-and-swap means a second revoke reports a conflict
   * rather than silently moving the timestamp — "who revoked this, and when" is an audit fact.
   */
  async revokeExecRule(
    tenantId: string,
    id: string,
    userId: string,
  ): Promise<ExecAllowlistRuleSummary> {
    await this.assertOwner(tenantId, userId);

    const now = new Date(this.now());
    const won = await this.deps.execRules.revoke(tenantId, id, now);

    if (!won) {
      const existing = await this.deps.execRules.findById(tenantId, id);
      throw new ApiError(
        'CONFLICT',
        existing === null ? 'The rule does not exist' : 'The rule was already revoked',
        { ruleId: id },
      );
    }

    const revoked = await this.deps.execRules.findById(tenantId, id);
    if (revoked === null) {
      throw new ApiError('INTERNAL_ERROR', 'The rule disappeared while being revoked', {
        ruleId: id,
      });
    }

    this.deps.logger.info({ tenantId, ruleId: id, revokedBy: userId }, 'exec permission revoked');

    return toExecRuleSummary(revoked, now);
  }

  /**
   * Fail the runs behind approvals nobody answered.
   *
   * Called by the `approval.expire` job. Each lapsed approval that this call actually moves
   * (the compare-and-swap again, so a decision landing concurrently wins) is failed through
   * the same path a rejection takes.
   *
   * Returns the ids it expired, because the caller — the job — has nothing else to report
   * on and an empty sweep is a meaningful result.
   */
  async expireDue(limit = 100): Promise<string[]> {
    const now = new Date(this.now());
    const lapsed = await this.deps.approvals.listLapsed(now, limit);
    const expired: string[] = [];

    for (const approval of lapsed) {
      const won = await this.deps.approvals.expire(approval.tenantId, approval.id, now);
      if (!won) continue;

      expired.push(approval.id);
      await this.deps.actions.setStatus(approval.tenantId, approval.actionId, 'expired');

      this.deps.logger.warn(
        { tenantId: approval.tenantId, approvalId: approval.id, runId: approval.runId },
        'approval expired without a decision',
      );

      this.deps.emit?.(approval.tenantId, {
        name: 'approval.expired',
        payload: { approvalId: approval.id },
      });

      // Expired is a *refusal by omission*. The engine is told `rejected` so the step fails
      // rather than parking again — the alternative is a run that waits forever for someone
      // who was already given a deadline.
      await this.resumeRun(approval.tenantId, approval, 'rejected', 'expired');
    }

    return expired;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Continue the run behind a decided approval.
   *
   * Returns `null` when there is nothing to resume — an approval with no run (a
   * hand-raised one, which this service never creates but the schema permits) or a run that
   * has already finished. Neither is an error: an approval whose run completed while the
   * operator was reading it is a normal, if slightly embarrassing, sequence.
   */
  private async resumeRun(
    tenantId: string,
    approval: Approval,
    decision: 'approved' | 'rejected',
    via: 'decision' | 'expired' = 'decision',
  ): Promise<{ status: string; runId: string } | null> {
    if (approval.runId === null) return null;
    if (this.engine === undefined) {
      // Without an engine the decision is still durable, which is the part that must not be
      // lost. Failing loudly here would roll back nothing anyway — the approval is already
      // decided — so the honest move is to say so and let the reaper pick the run up.
      this.deps.logger.error(
        { tenantId, approvalId: approval.id, runId: approval.runId },
        'an approval was decided but no engine is bound to resume the run',
      );
      return null;
    }

    const run = await this.deps.runs.findById(tenantId, approval.runId);
    if (run === null) return null;

    // Only a parked run can be resumed. A run that already completed, failed or was
    // cancelled has moved past this approval, and calling `resumeRun` on it would restart
    // execution from the checkpoint — running steps an operator believes are finished.
    if (run.status !== 'waiting_approval' && run.status !== 'paused') {
      this.deps.logger.info(
        { tenantId, runId: run.id, status: run.status, approvalId: approval.id },
        'approval decided but the run is no longer parked; nothing to resume',
      );
      return { status: run.status, runId: run.id };
    }

    const planStepId = await this.planStepIdFor(tenantId, approval);

    const outcome = await this.engine.resumeRun(tenantId, run.id, {
      stepId: planStepId,
      approvalId: approval.id,
      decision,
    });

    this.deps.logger.info(
      { tenantId, runId: run.id, approvalId: approval.id, decision, via, outcome: outcome.status },
      'run resumed from an approval decision',
    );

    return { status: outcome.status, runId: run.id };
  }

  /**
   * Recover the plan-step id a decision must be recorded under.
   *
   * Read from `Run.plan` by matching the approval's database `stepId` back to the plan entry
   * at the same position. The plan is the array the engine executed, and each entry carries
   * its own `id` — which is the key `resumeRun` writes into `checkpoint.approvals` and the
   * key the engine looks up when it re-executes the step.
   *
   * Two fallbacks, both deliberate and both narrow:
   *
   *  - **No plan, or no step row.** The run never got as far as a plan (a `waiting_approval`
   *    run always has one, but the row may be missing in a hand-built test fixture), so the
   *    approval's own id is used. It is not the plan-step id, and the resumed run will park
   *    again — which is a visible, correctable failure rather than a silently wrong resume.
   *  - **`stepId` is null.** Same reasoning: an approval not attached to a step cannot have
   *    its plan key recovered, and inventing one would write a decision under a key nothing
   *    reads.
   *
   * The second fallback is also what made the original off-by-one so quiet: a wrong index
   * does not throw, it just returns this same sentinel. See the note on `index` below.
   */
  private async planStepIdFor(tenantId: string, approval: Approval): Promise<string> {
    if (approval.stepId === null || approval.runId === null) return approval.id;

    const run = await this.deps.runs.findById(tenantId, approval.runId);
    if (run === null) return approval.id;

    const plan = run.plan as unknown;
    if (!Array.isArray(plan)) return approval.id;

    const step = await this.deps.runs.findStepById(approval.stepId);
    if (step === null) return approval.id;

    // `seq` is 0-based and the plan is 0-indexed, so the row's `seq` *is* the plan index.
    //
    // The first version of this subtracted one, on the assumption that `seq` was 1-based.
    // It is not: the engine writes `seq: index` and `position: index` from the same loop
    // counter. Subtracting one therefore read the *previous* entry, which for the first
    // step is off the front of the array — and the fallback below quietly returned the
    // approval's own id. Everything downstream still "worked", because a decision recorded
    // under the wrong key just parks the step again; the only visible symptom was a receipt
    // with no `approvalId`. That is why this reads `position` rather than `seq`: the two
    // are always equal today, but `position` is the field that *means* "where in the plan",
    // and a future step type that retries under a new `seq` would break the `seq` reading
    // while leaving `position` correct.
    const index = step.position;
    const entry = plan[index] as { id?: unknown } | undefined;
    if (entry === undefined || typeof entry.id !== 'string') return approval.id;

    return entry.id;
  }

  /**
   * Tell everyone who might act on a new approval.
   *
   * The recipients are every member of the tenant. That is the honest scope while there are
   * no roles in the schema: `requiredPermissions` names what the *action* needs, and there is
   * no table that maps permissions to users, so narrowing the audience any further would be
   * guessing. The alternative — notifying nobody — fails the one thing an approval request
   * has to achieve, which is reaching a human.
   *
   * Notification failures are logged and swallowed. The approval row exists and the run is
   * parked either way, and losing that because a bell could not be rung would be the wrong
   * trade — the inbox still shows it.
   */
  private async notifyApprovers(
    input: ApprovalRequestInput,
    approval: Approval,
  ): Promise<void> {
    try {
      const recipients = await this.deps.notifications.listRecipients(input.tenantId);
      for (const userId of recipients) {
        await this.deps.notifications.create({
          tenantId: input.tenantId,
          userId,
          kind: 'approval_request',
          title: input.title,
          body: input.description ?? undefined,
          linkRoute: `/inbox?approval=${approval.id}`,
        });
      }
    } catch (err) {
      this.deps.logger.warn(
        { err, tenantId: input.tenantId, approvalId: approval.id },
        'could not notify approvers; the approval is still in the inbox',
      );
    }
  }

  private async requireApproval(tenantId: string, id: string): Promise<Approval> {
    const approval = await this.deps.approvals.findById(tenantId, id);
    if (approval === null) {
      throw new ApiError('NOT_FOUND', 'The approval does not exist', { approvalId: id });
    }
    return approval;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/**
 * Say which race the caller lost.
 *
 * Three outcomes, phrased so the operator can tell them apart: someone else decided it, the
 * clock ran out, or the row is gone. A single "conflict" message would leave the loser
 * unable to know whether to re-read the inbox or to chase a colleague.
 */
/** How long an exec approval stands when the caller does not choose. */
const EXEC_APPROVAL_TTL_MS = 15 * 60 * 1000;

/**
 * The refusal for a workspace with no command owner.
 *
 * A constant rather than a literal in two places, because the message *is* the remedy: it names
 * where to fix it, and the request path and the decision path must give the same instruction or
 * an operator will fix half the problem.
 */
const OWNER_UNCONFIGURED =
  'This workspace has no command owner, so no exec approval can be granted. Set the command owner in Settings first.';

/**
 * Narrow a stored `requestedAction` blob into an exec command, defensively.
 *
 * Reads a column written by an earlier version of this code, so nothing about it may be assumed:
 * a malformed value returns `null` and the caller refuses, rather than producing a rule whose
 * command is `undefined` — which would be a permission that matches nothing (at best) or
 * everything (at worst, depending on the comparison).
 */
function readExecRequest(value: unknown): ExecRequestedAction | null {
  if (value === null || typeof value !== 'object') return null;

  const candidate = value as { command?: unknown; args?: unknown; cwd?: unknown };
  if (typeof candidate.command !== 'string' || typeof candidate.cwd !== 'string') return null;

  const args = Array.isArray(candidate.args)
    ? candidate.args.filter((entry): entry is string => typeof entry === 'string')
    : [];

  return { command: candidate.command, args, cwd: candidate.cwd };
}

/**
 * A rule row as the wire sees it.
 *
 * `isActive` is **derived** here from `revokedAt`/`expiresAt` via `isExecRuleActive`, never
 * stored, so it cannot disagree with the fields it summarises. The wire shape ships it because
 * the UI's job is to grey out a dead rule rather than to render a Revoke button that will fail.
 */
function toExecRuleSummary(rule: ExecAllowlistRule, now: Date): ExecAllowlistRuleSummary {
  return {
    id: rule.id,
    agentId: rule.agentId,
    command: rule.command,
    args: [...rule.args],
    cwd: rule.cwd,
    createdBy: rule.createdBy,
    isActive: isExecRuleActive(rule, now),
    lastUsedAt: rule.lastUsedAt?.toISOString() ?? null,
    expiresAt: rule.expiresAt?.toISOString() ?? null,
    revokedAt: rule.revokedAt?.toISOString() ?? null,
    createdAt: rule.createdAt.toISOString(),
  };
}

function describeLostRace(current: Approval | null): string {
  if (current === null) return 'The approval no longer exists';
  if (current.status === 'expired') {
    return 'The approval expired before this decision was recorded';
  }
  if (current.status === 'approved' || current.status === 'rejected') {
    return `The approval was already ${current.status}`;
  }
  return 'The approval could not be decided; it was modified concurrently';
}
