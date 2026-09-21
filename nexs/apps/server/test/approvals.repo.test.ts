import { describe, expect, it, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';
import {
  ActionRepository,
  ApprovalRepository,
  readRisk,
} from '../src/repositories/approval.repo.js';
import { NotificationRepository } from '../src/repositories/notification.repo.js';

/**
 * Phase 7 repositories: tenant isolation, and the compare-and-swap that makes a decision
 * happen exactly once.
 *
 * ## Why these are tested against the fake and not a stub
 *
 * The two properties under test live *in* the repository. "Every query carries `tenantId`"
 * is a statement about the `where` clauses, and "a second decision loses" is a statement
 * about `updateMany` returning zero rows. Stubbing the repository would remove both and
 * leave the assertions testing nothing.
 *
 * ## Why `expiresAt` is always passed explicitly
 *
 * Every time-sensitive call takes its `now` as an argument. A test that relied on
 * `new Date()` would be racing the clock — an approval created with a 15-minute expiry and
 * asserted as "not expired" passes today and fails on a slow CI machine only if the
 * boundary is mis-set, which is exactly the class of bug that hides.
 */

const TENANT = 'tnt_a';
const OTHER = 'tnt_b';
const USER = 'usr_a';
const OTHER_USER = 'usr_b';

let fake: FakeDb;
let actions: ActionRepository;
let approvals: ApprovalRepository;
let notifications: NotificationRepository;

beforeEach(() => {
  fake = createFakeDb();
  actions = new ActionRepository(fake.client);
  approvals = new ApprovalRepository(fake.client);
  notifications = new NotificationRepository(fake.client);
});

/** An action + approval pair in one tenant, which is the only shape the service creates. */
async function seedPair(tenantId: string, overrides: { expiresAt?: Date; stepId?: string } = {}) {
  const action = await actions.create({
    tenantId,
    runId: null,
    agentId: null,
    kind: 'approval',
    title: 'Send the report',
    description: 'Writes to an external service',
    payload: { url: 'https://api.test/send' },
    risk: { level: 'high', reasons: ['The tool can change something outside this system'] },
    requiredPermissions: ['http:write'],
  });

  const approval = await approvals.create({
    tenantId,
    actionId: action.id,
    title: 'Send the report',
    description: 'Writes to an external service',
    agentId: null,
    goalId: null,
    taskId: null,
    runId: null,
    stepId: overrides.stepId ?? null,
    requestedAction: { title: 'Send the report' },
    reason: 'Writes to an external service',
    requiredPermissions: ['http:write'],
    riskInformation: { level: 'high', reasons: ['The tool can change something outside this system'] },
    expiresAt: overrides.expiresAt ?? new Date('2030-01-01T00:00:00.000Z'),
  });

  return { action, approval };
}

// ── tenant isolation ──────────────────────────────────────────────────────────

describe('approval tenant isolation', () => {
  it('does not let one tenant read another tenant approval by id', async () => {
    const { approval } = await seedPair(OTHER);

    // Possessing the id is not a capability: the where carries tenantId, so this is a miss
    // rather than a hit on someone else's row.
    expect(await approvals.findById(TENANT, approval.id)).toBeNull();
    expect(await approvals.findById(OTHER, approval.id)).not.toBeNull();
  });

  it('does not let one tenant list, count or find-for-step across the boundary', async () => {
    await seedPair(OTHER, { stepId: 'stp_other' });

    expect(await approvals.list(TENANT)).toHaveLength(0);
    expect(await approvals.count(TENANT)).toBe(0);
    expect(await approvals.countPending(TENANT)).toBe(0);
    expect(await approvals.findForStep(TENANT, 'stp_other')).toBeNull();
  });

  it('does not let one tenant read or move another tenant action', async () => {
    const { action } = await seedPair(OTHER);

    expect(await actions.findById(TENANT, action.id)).toBeNull();
    // `setStatus` uses `updateMany` with the tenant in the where, so a foreign id updates
    // nothing and reports failure rather than silently writing across the boundary.
    expect(await actions.setStatus(TENANT, action.id, 'approved')).toBeNull();
  });

  it('does not let one tenant decide another tenant approval', async () => {
    const { approval } = await seedPair(OTHER);
    const now = new Date('2026-01-01T00:00:00.000Z');

    expect(await approvals.decide(TENANT, approval.id, 'approved', USER, now)).toBe(false);

    const reloaded = await approvals.findById(OTHER, approval.id);
    expect(reloaded?.status).toBe('pending');
  });

  it('keeps notifications scoped to the tenant *and* the user', async () => {
    await notifications.create({
      tenantId: OTHER,
      userId: OTHER_USER,
      kind: 'approval_request',
      title: 'For the other tenant',
      body: null,
      linkRoute: null,
    });

    // Tenant alone is not enough — the row belongs to a tenant this caller is not in.
    expect(await notifications.list(TENANT, USER)).toHaveLength(0);
    // And a same-tenant caller must not see a colleague's notifications: `userId` is in the
    // where for the same reason `tenantId` is.
    expect(await notifications.list(OTHER, USER)).toHaveLength(0);
    expect(await notifications.list(OTHER, OTHER_USER)).toHaveLength(1);
  });
});

// ── decide: the compare-and-swap ──────────────────────────────────────────────

describe('approval decide', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');

  it('records the decision, the decider and the time', async () => {
    const { approval } = await seedPair(TENANT, { expiresAt: new Date('2026-06-01T13:00:00.000Z') });

    expect(await approvals.decide(TENANT, approval.id, 'approved', USER, now, 'looks fine')).toBe(true);

    const reloaded = await approvals.findById(TENANT, approval.id);
    expect(reloaded?.status).toBe('approved');
    expect(reloaded?.decidedBy).toBe(USER);
    expect(reloaded?.decidedAt?.toISOString()).toBe(now.toISOString());
    expect(reloaded?.reason).toBe('looks fine');
  });

  it('loses the race when a second decision arrives for the same approval', async () => {
    const { approval } = await seedPair(TENANT, { expiresAt: new Date('2026-06-01T13:00:00.000Z') });

    expect(await approvals.decide(TENANT, approval.id, 'approved', USER, now)).toBe(true);
    // The second caller must be told it lost. Returning true here is what would resume the
    // run twice — the loser would believe it was the one that decided.
    expect(await approvals.decide(TENANT, approval.id, 'rejected', OTHER_USER, now)).toBe(false);

    const reloaded = await approvals.findById(TENANT, approval.id);
    expect(reloaded?.status).toBe('approved');
    expect(reloaded?.decidedBy).toBe(USER);
  });

  it('refuses a decision on an approval whose clock has already run out', async () => {
    // Expired a minute before the decision arrives. The expiry job may not have fired yet,
    // so the row is still `pending` — which is exactly the window this predicate closes.
    const { approval } = await seedPair(TENANT, { expiresAt: new Date('2026-06-01T11:59:00.000Z') });

    expect(await approvals.decide(TENANT, approval.id, 'approved', USER, now)).toBe(false);
    expect((await approvals.findById(TENANT, approval.id))?.status).toBe('pending');
  });

  it('expires only a pending row whose clock has run out', async () => {
    const lapsed = await seedPair(TENANT, { expiresAt: new Date('2026-06-01T11:00:00.000Z') });
    const live = await seedPair(TENANT, { expiresAt: new Date('2026-06-01T13:00:00.000Z') });

    expect(await approvals.expire(TENANT, lapsed.approval.id, now)).toBe(true);
    // Not yet due — the expiry sweep must not reach it early, or a run fails while the
    // operator still has time left on the clock.
    expect(await approvals.expire(TENANT, live.approval.id, now)).toBe(false);

    expect((await approvals.findById(TENANT, lapsed.approval.id))?.status).toBe('expired');
    expect((await approvals.findById(TENANT, live.approval.id))?.status).toBe('pending');
  });

  it('will not expire an approval that was already decided', async () => {
    const { approval } = await seedPair(TENANT, { expiresAt: new Date('2026-06-01T11:00:00.000Z') });

    expect(await approvals.decide(TENANT, approval.id, 'approved', USER, new Date('2026-06-01T10:59:00.000Z'))).toBe(true);
    // The decision beat the clock, so the sweep finds nothing to do. Without this, an
    // approval could be approved and expired, and the run resumed and failed.
    expect(await approvals.expire(TENANT, approval.id, now)).toBe(false);
    expect((await approvals.findById(TENANT, approval.id))?.status).toBe('approved');
  });

  it('lists exactly the rows each clock predicate claims to', async () => {
    const lapsed = await seedPair(TENANT, { expiresAt: new Date('2026-06-01T11:00:00.000Z') });
    const live = await seedPair(TENANT, { expiresAt: new Date('2026-06-01T13:00:00.000Z') });

    const actionable = await approvals.list(TENANT, { actionableOnly: true, now });
    expect(actionable.map((row) => row.id)).toEqual([live.approval.id]);

    const expired = await approvals.list(TENANT, { expiredOnly: true, now });
    expect(expired.map((row) => row.id)).toEqual([lapsed.approval.id]);
  });

  it('sweeps lapsed approvals unscoped, then moves only the rows still pending', async () => {
    const expiredAlready = await seedPair(TENANT, { expiresAt: new Date('2026-06-01T10:00:00.000Z') });
    const lapsed = await seedPair(TENANT, { expiresAt: new Date('2026-06-01T11:00:00.000Z') });
    await seedPair(OTHER, { expiresAt: new Date('2026-06-01T11:00:00.000Z') });
    await seedPair(TENANT, { expiresAt: new Date('2026-06-01T13:00:00.000Z') });

    // The first pair was already decided in a previous sweep, so it is out of the window.
    await approvals.expire(TENANT, expiredAlready.approval.id, new Date('2026-06-01T10:30:00.000Z'));

    // Unscoped on purpose — this is the maintenance read the `approval.expire` job uses, and
    // it has to see every tenant or it silently skips exactly the approvals it exists for.
    const due = await approvals.listLapsed(now, 100);
    expect(due.map((row) => row.id).sort()).toEqual(
      [lapsed.approval.id, due.find((row) => row.tenantId === OTHER)!.id].sort(),
    );
  });

  it('finds the most recent approval for a step when one was re-requested', async () => {
    const first = await seedPair(TENANT, { stepId: 'stp_x' });
    await approvals.expire(TENANT, first.approval.id, new Date('2026-06-01T12:00:00.000Z'));
    // A second request for the same step, which is what a retry produces after an expiry.
    const second = await seedPair(TENANT, { stepId: 'stp_x' });

    const found = await approvals.findForStep(TENANT, 'stp_x');
    // The newer row speaks for the step. Returning the older one would resurrect a decision
    // that was already superseded.
    expect(found?.id).toBe(second.approval.id);
    // Insertion order is not guaranteed to match creation order at millisecond resolution,
    // so the tie is broken explicitly rather than left to chance.
    expect(found?.id).not.toBe(first.approval.id);
  });
});

// ── notifications ─────────────────────────────────────────────────────────────

describe('notifications', () => {
  async function seedNotification(userId = USER, title = 'Hello') {
    return notifications.create({
      tenantId: TENANT,
      userId,
      kind: 'approval_request',
      title,
      body: null,
      linkRoute: null,
    });
  }

  it('counts only unread rows, and stops counting one that was read', async () => {
    await seedNotification(USER, 'one');
    const second = await seedNotification(USER, 'two');

    expect(await notifications.countUnread(TENANT, USER)).toBe(2);

    expect(await notifications.markRead(TENANT, USER, second.id, new Date())).toBe(true);
    expect(await notifications.countUnread(TENANT, USER)).toBe(1);
  });

  it('is idempotent on a repeated read and does not move the timestamp', async () => {
    const row = await seedNotification();
    const firstReadAt = new Date('2026-06-01T12:00:00.000Z');

    expect(await notifications.markRead(TENANT, USER, row.id, firstReadAt)).toBe(true);
    // A second read is a no-op: `readAt: null` in the where means the row is not matched, so
    // a double click cannot rewrite when the operator actually saw it.
    const later = new Date('2026-06-01T18:00:00.000Z');
    expect(await notifications.markRead(TENANT, USER, row.id, later)).toBe(false);

    expect((await notifications.findById(TENANT, USER, row.id))?.readAt?.toISOString()).toBe(
      firstReadAt.toISOString(),
    );
  });

  it('marks every unread row read in one pass and reports how many', async () => {
    await seedNotification(USER, 'one');
    await seedNotification(USER, 'two');
    const alreadyRead = await seedNotification(USER, 'three');
    await notifications.markRead(TENANT, USER, alreadyRead.id, new Date());
    // A different user's row, which must not be swept up with this one's.
    await seedNotification(OTHER_USER, 'not yours');

    expect(await notifications.markAllRead(TENANT, USER, new Date())).toBe(2);
    expect(await notifications.countUnread(TENANT, USER)).toBe(0);
    expect(await notifications.countUnread(TENANT, OTHER_USER)).toBe(1);
  });

  it('filters the list by unread and by kind', async () => {
    const unread = await seedNotification(USER, 'unread');
    await notifications.create({
      tenantId: TENANT,
      userId: USER,
      kind: 'task_failed',
      title: 'a failure',
      body: null,
      linkRoute: null,
    });
    await notifications.markRead(TENANT, USER, unread.id, new Date());

    const unreadOnly = await notifications.list(TENANT, USER, { unreadOnly: true });
    expect(unreadOnly.map((row) => row.title)).toEqual(['a failure']);

    const failures = await notifications.list(TENANT, USER, { kind: 'task_failed' });
    expect(failures.map((row) => row.title)).toEqual(['a failure']);
  });
});

// ── the risk reader ───────────────────────────────────────────────────────────

describe('readRisk', () => {
  it('narrows a well-formed blob', () => {
    expect(readRisk({ level: 'high', reasons: ['a'] })).toEqual({ level: 'high', reasons: ['a'] });
  });

  it('falls back to the safest reading of a malformed blob', () => {
    // `low` rather than `high`: this feeds a *display* of what the engine already decided,
    // and the engine's decision is in the approval row either way. Inventing a `high` here
    // would show an operator a scary badge for a risk nothing assessed.
    expect(readRisk(null)).toEqual({ level: 'low', reasons: [] });
    expect(readRisk({ level: 'nonsense', reasons: ['x', 7] })).toEqual({ level: 'low', reasons: ['x'] });
  });
});
