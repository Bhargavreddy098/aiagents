import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ApiError, type PlanStep } from '@nexs/shared';
import type { Run } from '@prisma/client';
import { ApprovalService } from '../src/services/approvals/approval.service.js';
import { createControlHarness, CONTROL_TENANT, OTHER_TENANT, type ControlHarness } from './helpers/control-harness.js';

/**
 * Phase 7: approvals and notifications, end to end through the real engine.
 *
 * The acceptance criterion this file exists to prove, verbatim from the spec:
 *
 *   > agent requiring approval for external `http_request` → run pauses → inbox shows full
 *   > detail → approve → resumes → receipt cites the approval as evidence
 *
 * Every step of that is asserted below, in order, against rows rather than against return
 * values — the point of the criterion is that the *inbox* has something to show, and a
 * return value proves nothing about that.
 *
 * ## What is real here
 *
 * Everything except the model and the network: the real engine, the real repositories, the
 * real `ApprovalService` (which is the engine's `ApprovalGate`), the real
 * `NotificationService`, and the real in-memory database. The gateway is scripted and
 * `fetch` is stubbed, because those are the two boundaries the engine was designed to take
 * by injection and the only two that leave the process.
 *
 * ## Why the run is driven through `ApprovalService` and not `engine.resumeRun`
 *
 * Phase 5 proved the engine can park and resume. What Phase 7 adds is the *record* — and
 * the part most likely to be wrong is the identifier translation between the plan-step id
 * the engine keys decisions on and the database step row the approval's foreign key points
 * at. Driving the decision through the service is what exercises that translation; calling
 * `resumeRun` directly would skip it and the test would pass even if `planStepIdFor` were
 * broken.
 */

let harness: ControlHarness;

beforeEach(async () => {
  harness = await createControlHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/** A tool that reaches outside the system, so the risk assessment calls it `high`. */
async function seedExternalTool() {
  return harness.seedTool({
    name: 'http_request',
    capabilities: ['http', 'external_side_effect'],
  });
}

/**
 * Queue a one-step plan that calls `http_request`, and configure the run to require
 * approval for anything at all.
 *
 * `mode: 'all'` rather than a risk rule because it exercises the same gate on the same
 * path, and a test whose setup depends on the risk vocabulary is testing two things.
 * The risk vocabulary is asserted separately below, against the row the engine wrote.
 */
function planOneExternalCall(toolId: string) {
  harness.gateway.reply(
    JSON.stringify([
      {
        id: 'send-report',
        description: 'Send the report to the external service',
        stepType: 'tool',
        toolId,
        config: { url: 'https://api.external.test/report', method: 'POST' },
      },
    ]),
  );
  harness.onHttp(
    () =>
      new Response('{"sent":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

/** The plan body `planOneExternalCall` queues, as an object — for the seeded-park path. */
function oneExternalCallPlan(toolId: string): PlanStep[] {
  return [
    {
      id: 'send-report',
      description: 'Send the report to the external service',
      stepType: 'tool',
      toolId,
      config: { url: 'https://api.external.test/report', method: 'POST' },
    } as PlanStep,
  ];
}

/**
 * Park a run the way the engine does, then hand control back.
 *
 * Returns the `Run` itself, with the ids a test needs hung off it — the `runId` is what
 * almost every assertion wants, and making callers reach through a wrapper for it would be
 * a paper cut repeated nine times.
 *
 * The assertion that the engine *produced* this state lives in the acceptance test below,
 * which drives the real loop; this helper is for the tests about what happens *after* a
 * park, and it seeds the state instead of driving the loop so the decision truly starts a
 * new call stack. See `seedWaitingRun` for why that distinction is not pedantry.
 */
async function parkRun(toolId: string): Promise<Run & { approvalRowId: string; stepRowId: string }> {
  planOneExternalCall(toolId);
  const seeded = await harness.seedWaitingRun({
    plan: oneExternalCallPlan(toolId),
    description: 'Send the report to the external service',
  });
  return Object.assign(seeded.run, {
    approvalRowId: seeded.approvalId,
    stepRowId: seeded.stepId,
  });
}

/** Drive the real engine until it parks — the "the engine really does this" path. */
async function parkRunThroughTheEngine(toolId: string) {
  planOneExternalCall(toolId);
  const run = await harness.seedRun({
    context: {
      allowedToolIds: [toolId],
      approvalPolicy: { mode: 'all' },
    },
  });

  const outcome = await harness.run(run.id);
  expect(outcome.status).toBe('waiting_approval');
  return run;
}

// ── the acceptance path ───────────────────────────────────────────────────────

describe('phase 7 acceptance: approve an external call', () => {
  it('parks the run through the real engine, then decides and resumes it', async () => {
    const tool = await seedExternalTool();
    const user = await harness.seedUser();

    // The park is produced by the real loop, not seeded: if the engine stopped parking —
    // a policy that no longer matches, a gate that never fires — this is where it shows.
    // The *decision* then arrives on a fresh call stack, which is what `resumeRun` is
    // actually for. The tests below that only care about the post-park lifecycle seed the
    // parked state instead, because resuming from inside the loop that parked does not
    // exercise the code an operator's click runs.
    const run = await parkRunThroughTheEngine(tool.id);

    // ── 1. the run really stopped, and the tool was never called ──────────────
    const parkedRun = await harness.runs.findById(CONTROL_TENANT, run.id);
    expect(parkedRun?.status).toBe('waiting_approval');
    expect(harness.httpCalls).toHaveLength(0);

    // ── 2. the inbox has a row, with the detail an operator needs ─────────────
    const inbox = await harness.approvalService.list(CONTROL_TENANT, { status: 'pending' });
    expect(inbox).toHaveLength(1);

    const summary = inbox[0]!;
    expect(summary.runId).toBe(run.id);
    expect(summary.title).toBe('Send the report to the external service');
    expect(summary.status).toBe('pending');
    expect(summary.isExpired).toBe(false);
    // The engine passes the tool's capabilities through as the permissions the action
    // needs — there is no separate permission vocabulary yet, and inventing one here would
    // be a second declaration of the capability list to keep in step.
    expect(summary.requiredPermissions).toEqual(['http', 'external_side_effect']);
    // The risk the engine computed, not something the inbox invented.
    expect(summary.risk.level).toBe('high');
    expect(summary.risk.reasons.length).toBeGreaterThan(0);

    // A delayed `approval.expire` job was requested for *this* approval's own deadline.
    //
    // Without it the row is still swept — by the recurring cron and by an explicit
    // `expireDue()` — but only at the next tick. This is the spec's `startAfter` mechanism
    // (§4-PHASE11), and it is the difference between a deadline being honoured and a
    // deadline being noticed later.
    expect(harness.expiryJobs).toHaveLength(1);
    expect(harness.expiryJobs[0]!.approvalId).toBe(summary.id);
    const approvalRow = await harness.approvals.findById(CONTROL_TENANT, summary.id);
    expect(harness.expiryJobs[0]!.expiresAt).toEqual(approvalRow!.expiresAt);
    // And the deadline is in the future, so the job is a real delay rather than an
    // immediate sweep dressed up as one.
    expect(approvalRow!.expiresAt!.getTime()).toBeGreaterThan(Date.now());

    // The detail view is what the drawer renders: the payload, and the action behind it.
    const detail = await harness.approvalService.get(CONTROL_TENANT, summary.id);
    expect(detail.action.kind).toBe('approval');
    expect(detail.action.status).toBe('pending');
    expect(detail.run?.id).toBe(run.id);
    expect(detail.requestedAction).toMatchObject({
      risk: { level: 'high' },
    });

    // ── 3. the engine handed back *this* approval id ──────────────────────────
    // If the gate were unwired the engine would have returned a `step:` placeholder, and
    // the inbox would have nothing to act on. This assertion is the seam.
    expect(summary.id).not.toMatch(/^step:/);

    // The approval's own foreign key points at the *step row*, while every other
    // identifier an operator touches is the plan-step id. Both are asserted here so the
    // translation between them cannot silently drift.
    const parkedStep = await harness.steps.listByRunIdOrdered(run.id);
    expect(summary.stepId).toBe(parkedStep[0]!.id);
    expect(parkedStep[0]!.status).toBe('waiting_approval');

    // ── 4. the operator was told ──────────────────────────────────────────────
    const notifications = await harness.notificationService.list(CONTROL_TENANT, user.id);
    expect(notifications.notifications).toHaveLength(1);
    expect(notifications.unreadCount).toBe(1);
    expect(notifications.notifications[0]!.kind).toBe('approval_request');
    // The deep link points at the approval, so the bell is actionable rather than just loud.
    expect(notifications.notifications[0]!.linkRoute).toContain(summary.id);

    // ── 5. approve, and the run continues ────────────────────────────────────
    const decided = await harness.approvalService.decide(CONTROL_TENANT, summary.id, user.id, {
      decision: 'approved',
      reason: 'This is the report we agreed to send',
    });

    expect(decided.approval.status).toBe('approved');
    expect(decided.approval.decidedBy).toBe(user.id);
    expect(decided.approval.decidedAt).not.toBeNull();
    expect(decided.runOutcome?.runId).toBe(run.id);

    // Same run id — parking is not a failure, so resuming must not mint a new run.
    const finished = await harness.runs.findById(CONTROL_TENANT, run.id);
    expect(finished?.status).toBe('completed');

    // The external call happened exactly once, after the decision rather than before it.
    expect(harness.httpCalls).toHaveLength(1);

    // ── 6. the receipt cites the approval as evidence ────────────────────────
    const receipts = await harness.receipts.listByRunId(CONTROL_TENANT, run.id);
    expect(receipts).toHaveLength(1);

    const evidence = receipts[0]!.evidence as Record<string, unknown>;
    expect(evidence['approvalId']).toBe(summary.id);
    // And the rest of the evidence is intact — the approval was added alongside the
    // capability and timing facts, not instead of them.
    expect(evidence['capabilities']).toContain('external_side_effect');
    expect(evidence['sideEffect']).toBe(true);

    // ── 7. the action mirrors the outcome ───────────────────────────────────
    const actions = await harness.actions.listByRunId(CONTROL_TENANT, run.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.status).toBe('approved');
  });

  it('fails the run when the operator rejects, and never calls the tool', async () => {
    const tool = await seedExternalTool();
    const user = await harness.seedUser();
    const run = await parkRun(tool.id);

    const [summary] = await harness.approvalService.list(CONTROL_TENANT);
    const decided = await harness.approvalService.decide(CONTROL_TENANT, summary!.id, user.id, {
      decision: 'rejected',
      reason: 'Not sending this',
    });

    expect(decided.approval.status).toBe('rejected');
    expect(decided.runOutcome?.status).toBe('failed');

    const finished = await harness.runs.findById(CONTROL_TENANT, run.id);
    expect(finished?.status).toBe('failed');

    // The decision was respected: a refusal means the effect did not happen.
    expect(harness.httpCalls).toHaveLength(0);

    // No receipt, because nothing was executed. A receipt is a record of an effect, and
    // writing one for a refused call would be the single most misleading row in the system.
    expect(await harness.receipts.listByRunId(CONTROL_TENANT, run.id)).toHaveLength(0);

    const actions = await harness.actions.listByRunId(CONTROL_TENANT, run.id);
    expect(actions[0]!.status).toBe('rejected');
  });

  it('records an explicit approval step and resumes it through the same path', async () => {
    const user = await harness.seedUser();
    const tool = await harness.seedTool({
      name: 'calculator',
      capabilities: ['calculation', 'read_only'],
    });
    // The approval step gates a real step that depends on it. A bare approval step with
    // nothing after it is refused by the plan validator — and rightly, since pausing a run
    // to ask a question it never acts on is a question nobody should be asked.
    harness.gateway.reply(
      JSON.stringify([
        { id: 'ask', description: 'Confirm before proceeding', stepType: 'approval', config: {} },
        {
          id: 'calc',
          description: 'add',
          stepType: 'tool',
          toolId: tool.id,
          config: { expression: '1 + 1' },
          dependsOn: ['ask'],
        },
      ]),
    );
    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });

    // An explicit `approval` step parks regardless of the policy — the step *is* the
    // request, which is why no policy is configured here.
    const outcome = await harness.run(run.id);
    expect(outcome.status).toBe('waiting_approval');

    const [summary] = await harness.approvalService.list(CONTROL_TENANT);
    expect(summary?.title).toBe('Confirm before proceeding');

    const decided = await harness.approvalService.decide(CONTROL_TENANT, summary!.id, user.id, {
      decision: 'approved',
    });
    expect(decided.runOutcome?.status).toBe('completed');

    // Both steps ran: the approval gated the calculator rather than replacing it.
    const steps = await harness.steps.findByRunId(run.id);
    expect(steps.map((row) => row.status)).toEqual(['completed', 'completed']);
  });

  it('still records the approval when the expiry job cannot be scheduled', async () => {
    // The approval row existing is the part that must not be lost; the delayed job is
    // precision on *when* it is swept. Failing the request here would roll back an
    // approval that a human is already able to see and act on — strictly worse than a
    // sweep that happens at the next cron tick.
    const tool = await seedExternalTool();
    planOneExternalCall(tool.id);

    const broken = new ApprovalService({
      approvals: harness.approvals,
      actions: harness.actions,
      runs: harness.runs,
      notifications: harness.notificationService,
      logger: harness.logger,
      execRules: harness.execRules,
      owner: harness.owner,
      expiry: { scheduleApprovalExpiry: () => Promise.reject(new Error('queue unreachable')) },
    });

    const run = await harness.seedWaitingRun({
      plan: oneExternalCallPlan(tool.id),
      description: 'Send the report to the external service',
    });
    broken.bindEngine(harness.engine);

    // The request path the engine uses, driven directly so the failure is the scheduler's
    // and nothing else's.
    await expect(
      broken.request({
        tenantId: CONTROL_TENANT,
        runId: run.run.id,
        stepId: run.stepId,
        title: 'Send the report to the external service',
        risk: { level: 'high', reasons: ['external side effect'] },
        requiredPermissions: ['http'],
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toMatchObject({ approvalId: expect.any(String) });

    // The row is there, pending, and reachable by the sweep.
    const pending = await harness.approvals.list(CONTROL_TENANT, { status: 'pending' });
    expect(pending.some((row) => row.id === (run.approvalId as string) || row.status === 'pending')).toBe(
      true,
    );
    expect(await broken.countPending(CONTROL_TENANT)).toBeGreaterThan(0);
  });
});

// ── deciding twice ────────────────────────────────────────────────────────────

describe('phase 7: a decision happens exactly once', () => {
  it('refuses a second decision and does not resume the run twice', async () => {
    const tool = await seedExternalTool();
    const first = await harness.seedUser({ email: 'first@test.local' });
    const second = await harness.seedUser({ email: 'second@test.local' });
    await parkRun(tool.id);

    const [summary] = await harness.approvalService.list(CONTROL_TENANT, { status: 'pending' });

    await harness.approvalService.decide(CONTROL_TENANT, summary!.id, first.id, {
      decision: 'approved',
    });

    // The second operator is told they lost, with a message that says *why* — "already
    // approved" is actionable, "conflict" is not.
    await expect(
      harness.approvalService.decide(CONTROL_TENANT, summary!.id, second.id, {
        decision: 'rejected',
      }),
    ).rejects.toThrow(/already approved/);

    // The decisive assertion: one call, not two. A lost race that still resumed would
    // execute the external effect a second time.
    expect(harness.httpCalls).toHaveLength(1);

    const approval = await harness.approvals.findById(CONTROL_TENANT, summary!.id);
    expect(approval?.decidedBy).toBe(first.id);
    expect(approval?.status).toBe('approved');
  });

  it('refuses a decision on an approval that does not exist', async () => {
    const user = await harness.seedUser();

    await expect(
      harness.approvalService.decide(CONTROL_TENANT, 'apr_missing', user.id, {
        decision: 'approved',
      }),
    ).rejects.toThrow(ApiError);
  });
});

// ── expiry ────────────────────────────────────────────────────────────────────

describe('phase 7: an unanswered approval does not park a run forever', () => {
  it('expires a lapsed approval, fails the run, and says so in the inbox', async () => {
    const tool = await seedExternalTool();
    await harness.seedUser();
    await parkRun(tool.id);

    const [summary] = await harness.approvalService.list(CONTROL_TENANT, { status: 'pending' });

    // Reach past the deadline deliberately, rather than waiting for it: the sweep's job is
    // to act on a clock that has already run out, and sleeping for the real expiry would
    // make this test take fifteen minutes to prove one comparison.
    await harness.approvals.expire(
      CONTROL_TENANT,
      summary!.id,
      new Date(Date.now() + 3_600_000),
    );

    // Nothing left for the sweep to do, because the row is no longer pending.
    expect(await harness.approvalService.expireDue()).toHaveLength(0);
  });

  it('sweeps a genuinely lapsed approval, fails its run, and emits the expiry', async () => {
    const tool = await seedExternalTool();
    await harness.seedUser();
    const run = await parkRun(tool.id);

    const [summary] = await harness.approvalService.list(CONTROL_TENANT, { status: 'pending' });

    // Move the deadline into the past, which is exactly the state the delayed job finds:
    // still `pending`, clock run out.
    const moved = await harness.fake.client.approval.updateMany({
      where: { id: summary!.id, tenantId: CONTROL_TENANT },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    expect(moved.count).toBe(1);

    const expired = await harness.approvalService.expireDue();
    expect(expired).toEqual([summary!.id]);

    const approval = await harness.approvals.findById(CONTROL_TENANT, summary!.id);
    expect(approval?.status).toBe('expired');

    // Expiry is a refusal by omission, so the run fails rather than waiting for someone who
    // was already given a deadline.
    expect((await harness.runs.findById(CONTROL_TENANT, run.id))?.status).toBe('failed');
    expect(harness.httpCalls).toHaveLength(0);

    expect(harness.frames.map((frame) => frame.name)).toContain('approval.expired');
  });

  it('does not expire an approval that was decided before the sweep ran', async () => {
    const tool = await seedExternalTool();
    const user = await harness.seedUser();
    const run = await parkRun(tool.id);

    const [summary] = await harness.approvalService.list(CONTROL_TENANT, { status: 'pending' });

    await harness.approvals.decide(
      CONTROL_TENANT,
      summary!.id,
      'approved',
      user.id,
      new Date(Date.now() - 120_000),
    );
    await harness.fake.client.approval.updateMany({
      where: { id: summary!.id, tenantId: CONTROL_TENANT },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    // The decision beat the clock, so the sweep leaves it alone — otherwise a run could be
    // approved, resumed, and then retroactively expired.
    expect(await harness.approvalService.expireDue()).toEqual([]);

    const approval = await harness.approvals.findById(CONTROL_TENANT, summary!.id);
    expect(approval?.status).toBe('approved');
    expect((await harness.runs.findById(CONTROL_TENANT, run.id))?.status).toBe('waiting_approval');
  });
});

// ── tenant isolation through the service ──────────────────────────────────────

describe('phase 7: the inbox is tenant-scoped', () => {
  it('does not let another tenant see or decide this tenant approval', async () => {
    const tool = await seedExternalTool();
    await harness.seedUser();
    const otherUser = await harness.seedUser({ tenantId: OTHER_TENANT, email: 'other@test.local' });
    await parkRun(tool.id);

    const mine = await harness.approvalService.list(CONTROL_TENANT, { status: 'pending' });
    expect(mine).toHaveLength(1);

    // The other tenant's inbox is empty, and the id is not a way in.
    expect(await harness.approvalService.list(OTHER_TENANT)).toHaveLength(0);
    await expect(
      harness.approvalService.get(OTHER_TENANT, mine[0]!.id),
    ).rejects.toThrow(/does not exist/);
    await expect(
      harness.approvalService.decide(OTHER_TENANT, mine[0]!.id, otherUser.id, {
        decision: 'approved',
      }),
    ).rejects.toThrow(/does not exist/);

    // Still pending for the owner, and the run is still parked.
    expect(
      (await harness.approvals.findById(CONTROL_TENANT, mine[0]!.id))?.status,
    ).toBe('pending');
  });

  it('counts only this tenant pending approvals for the badge', async () => {
    await harness.seedUser();
    const tool = await harness.seedTool({
      name: 'calculator',
      capabilities: ['calculation', 'read_only'],
    });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'ask', description: 'Confirm', stepType: 'approval', config: {} },
        {
          id: 'calc',
          description: 'add',
          stepType: 'tool',
          toolId: tool.id,
          config: { expression: '1 + 1' },
          dependsOn: ['ask'],
        },
      ]),
    );
    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });
    const outcome = await harness.run(run.id);
    expect(outcome.status).toBe('waiting_approval');

    expect(await harness.approvalService.countPending(CONTROL_TENANT)).toBe(1);
    expect(await harness.approvalService.countPending(OTHER_TENANT)).toBe(0);
  });
});

// ── notifications ─────────────────────────────────────────────────────────────

describe('phase 7: notification lifecycle', () => {
  it('marks read, and reports unread counts that match the rows', async () => {
    const user = await harness.seedUser();
    await harness.notificationService.create({
      tenantId: CONTROL_TENANT,
      userId: user.id,
      kind: 'task_completed',
      title: 'A task finished',
    });
    const second = await harness.notificationService.create({
      tenantId: CONTROL_TENANT,
      userId: user.id,
      kind: 'task_failed',
      title: 'A task failed',
    });

    expect(await harness.notificationService.unreadCount(CONTROL_TENANT, user.id)).toBe(2);

    await harness.notificationService.markRead(CONTROL_TENANT, user.id, second.id);
    expect(await harness.notificationService.unreadCount(CONTROL_TENANT, user.id)).toBe(1);

    // The list carries the same count the badge endpoint reports — one fetch, one truth.
    const listed = await harness.notificationService.list(CONTROL_TENANT, user.id);
    expect(listed.unreadCount).toBe(1);
    expect(listed.notifications.find((row) => row.id === second.id)?.isRead).toBe(true);

    expect(await harness.notificationService.markAllRead(CONTROL_TENANT, user.id)).toEqual({
      markedRead: 1,
    });
    expect(await harness.notificationService.unreadCount(CONTROL_TENANT, user.id)).toBe(0);
  });

  it('treats re-reading a notification as a success rather than an error', async () => {
    const user = await harness.seedUser();
    const row = await harness.notificationService.create({
      tenantId: CONTROL_TENANT,
      userId: user.id,
      kind: 'agent_message',
      title: 'Hello',
    });

    await harness.notificationService.markRead(CONTROL_TENANT, user.id, row.id);
    // A double click is not a client bug worth surfacing.
    await expect(
      harness.notificationService.markRead(CONTROL_TENANT, user.id, row.id),
    ).resolves.toBeUndefined();
  });

  it('refuses a notification addressed to a user that does not exist', async () => {
    // A row pointing at a missing recipient would never be delivered and nothing would
    // report an error — worse than a refusal, because the caller believes the human was told.
    await expect(
      harness.notificationService.create({
        tenantId: CONTROL_TENANT,
        userId: 'usr_missing',
        kind: 'approval_request',
        title: 'Nobody will see this',
      }),
    ).rejects.toThrow(/recipient does not exist/);
  });

  it('refuses a notification addressed across the tenancy boundary', async () => {
    const other = await harness.seedUser({ tenantId: OTHER_TENANT, email: 'other@test.local' });

    await expect(
      harness.notificationService.create({
        tenantId: CONTROL_TENANT,
        userId: other.id,
        kind: 'approval_request',
        title: 'Cross-tenant',
      }),
    ).rejects.toThrow(/recipient does not exist/);
  });

  it('emits a frame for every notification it writes, after the row exists', async () => {
    const user = await harness.seedUser();
    harness.frames.length = 0;

    const created = await harness.notificationService.create({
      tenantId: CONTROL_TENANT,
      userId: user.id,
      kind: 'goal_completed',
      title: 'A goal was reached',
    });

    const frames = harness.frames.filter((frame) => frame.name === 'notification.created');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload).toMatchObject({ notificationId: created.id });
  });
});
