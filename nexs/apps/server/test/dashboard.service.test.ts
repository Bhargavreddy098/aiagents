import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DASHBOARD_FAILURE_WINDOW_DAYS,
  DASHBOARD_RECENT_ACTIVITY,
  DASHBOARD_RECENT_RECEIPTS,
  DASHBOARD_RECENT_RUNS,
  DASHBOARD_UPCOMING_SCHEDULES,
} from '@nexs/shared';
import {
  CONTROL_TENANT,
  OTHER_TENANT,
  createControlHarness,
  type ControlHarness,
} from './helpers/control-harness.js';

/**
 * `DashboardService` — the composed snapshot.
 *
 * ## What this file is really asserting
 *
 * The spec's rule for this endpoint is **"zero hard-coded numbers"**, and a test cannot assert
 * "no constant was used" directly. What it can do is the equivalent: seed a *known, non-round*
 * number of rows for every field and require the field to equal that number. A service that
 * returned a plausible default would have to return exactly the number the test happened to
 * seed, for every field, which is not a mistake anyone makes by accident.
 *
 * So the seeds below are deliberately awkward — 3 agents where 2 are active, 4 runs of which 2
 * hold a slot, 6 schedules of which 3 can fire — and each test states the row it expects the
 * number to have come from.
 *
 * ## Why the rows are written through the client rather than through the services
 *
 * For an aggregate test the interesting input is the *set of rows*, and a service call that
 * derives three columns from one argument obscures exactly that. `db.run.create({status})`
 * says "there is one run and its status is this", which is the premise the assertion is about.
 * Where a service's side effects are the point (agents, whose activation writes a version),
 * the service is used instead.
 */

const DAY_MS = 86_400_000;
const USER = 'usr_dashboard';

/** A user id that exists only as a string: `countUnread` is a count, not a lookup. */
const NOBODY = 'usr_no_notifications';

describe('DashboardService', () => {
  let harness: ControlHarness;

  beforeEach(async () => {
    harness = await createControlHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  // ── seeding ────────────────────────────────────────────────────────────────

  async function seedAgent(tenantId: string, status: string, name = `agent-${status}`): Promise<string> {
    const row = await harness.db.agent.create({ data: { tenantId, name, status } });
    return row.id;
  }

  async function seedGoal(tenantId: string, status: string): Promise<string> {
    const row = await harness.db.goal.create({ data: { tenantId, title: `goal-${status}`, status } });
    return row.id;
  }

  async function seedTask(tenantId: string, status: string): Promise<string> {
    const row = await harness.db.task.create({ data: { tenantId, title: `task-${status}`, status } });
    return row.id;
  }

  async function seedWorkflow(tenantId: string, status: string): Promise<string> {
    const row = await harness.db.workflow.create({
      data: { tenantId, name: `wf-${status}`, status },
    });
    return row.id;
  }

  async function seedRun(
    tenantId: string,
    input: { status: string; createdAt?: Date; kind?: string; error?: string | null } = { status: 'queued' },
  ): Promise<string> {
    const row = await harness.db.run.create({
      data: {
        tenantId,
        kind: input.kind ?? 'task',
        status: input.status,
        error: input.error ?? null,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      },
    });
    return row.id;
  }

  /**
   * An approval with a deadline.
   *
   * The deadline is not optional here, and that is a fact about the product rather than about
   * this helper: `ApprovalRequestInput.expiresAt` is a required `Date`, so every approval the
   * engine asks for has one. Seeding a null would be seeding a row nothing can produce — and
   * it would silently pass, because `countPending` filters on `expiresAt > now` and a null
   * simply fails that comparison rather than raising.
   */
  async function seedApproval(tenantId: string, status: string, expiresAt?: Date): Promise<string> {
    const action = await harness.db.action.create({
      data: { tenantId, kind: 'tool', title: 'do a thing', payload: {} },
    });
    const row = await harness.db.approval.create({
      data: {
        tenantId,
        actionId: action.id,
        title: 'Approve a thing',
        requestedAction: {},
        status,
        expiresAt: expiresAt ?? new Date(Date.now() + 3_600_000),
      },
    });
    return row.id;
  }

  async function seedSchedule(
    tenantId: string,
    input: {
      name: string;
      nextFireAt: Date | null;
      enabled?: boolean;
      lastFiredAt?: Date | null;
      kind?: string;
      cron?: string | null;
    },
  ): Promise<string> {
    const row = await harness.db.schedule.create({
      data: {
        tenantId,
        name: input.name,
        kind: input.kind ?? 'recurring',
        cron: input.cron ?? '0 9 * * *',
        targetKind: 'task',
        targetId: 'tsk_target',
        enabled: input.enabled ?? true,
        nextFireAt: input.nextFireAt,
        lastFiredAt: input.lastFiredAt ?? null,
      },
    });
    return row.id;
  }

  async function seedMcpServer(
    tenantId: string,
    name: string,
    status = 'connected',
  ): Promise<string> {
    const row = await harness.db.mcpServer.create({
      data: { tenantId, name, transport: 'stdio', status },
    });
    return row.id;
  }

  async function seedProvider(
    tenantId: string,
    name: string,
    input: { enabled?: boolean; status?: string; lastHealthCheck?: Date | null } = {},
  ): Promise<string> {
    const row = await harness.db.modelProvider.create({
      data: {
        tenantId,
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        type: 'openai',
        enabled: input.enabled ?? true,
        status: input.status ?? 'unverified',
        lastHealthCheck: input.lastHealthCheck ?? null,
      },
    });
    return row.id;
  }

  /** A step that has started — the only kind the activity feed admits. */
  async function seedStep(
    runId: string,
    input: { seq: number; startedAt: Date | null; status?: string; name?: string },
  ): Promise<string> {
    const row = await harness.db.step.create({
      data: {
        runId,
        seq: input.seq,
        position: input.seq,
        name: input.name ?? `step-${input.seq}`,
        stepType: 'tool',
        status: input.status ?? 'completed',
        startedAt: input.startedAt,
        // Required with no default on the column. The same string the repository writes, so a
        // test that reached for a unique index would exercise the same constraint the engine
        // relies on rather than an invented value.
        idempotencyKey: `${runId}:${input.seq}:0`,
      },
    });
    return row.id;
  }

  /**
   * A tool call row, for the receipt join.
   *
   * `args` is required with no default, which is the point of going through one helper: the
   * three call sites below all need the same two required columns, and writing them out three
   * times is how one of them ends up subtly different from the others.
   */
  async function seedToolCall(
    tenantId: string,
    toolId: string,
    runId: string | null = null,
  ): Promise<string> {
    const row = await harness.db.toolCall.create({
      data: { tenantId, runId, toolId, args: {}, sideEffect: runId !== null },
    });
    return row.id;
  }

  // ── the empty workspace ────────────────────────────────────────────────────

  it('reports an empty workspace as empty rather than as a plausible default', async () => {
    const summary = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // Every counter is zero because there are no rows, and the test can say so because it
    // seeded none. The moment a service substituted a constant, one of these would stop
    // matching — which is the whole point of asserting the empty case first.
    expect(summary.counts).toEqual({
      agentsActive: 0,
      agentsTotal: 0,
      goalsActive: 0,
      tasksRunning: 0,
      workflowsActive: 0,
      runsActive: 0,
      approvalsPending: 0,
    });
    expect(summary.recentRuns).toEqual([]);
    expect(summary.recentActivity).toEqual([]);
    expect(summary.providerHealth).toEqual([]);
    expect(summary.connectedServices).toEqual([]);
    expect(summary.upcomingSchedules).toEqual([]);
    expect(summary.recentReceipts).toEqual([]);
    expect(summary.unreadNotifications).toBe(0);
    expect(summary.failures.count).toBe(0);
    expect(summary.verifications).toEqual({ total: 0, pending: 0, passed: 0, failed: 0 });
  });

  it('stamps the snapshot with the instant it describes', async () => {
    const before = Date.now();
    const summary = await harness.dashboardService.get(CONTROL_TENANT, USER);

    const generated = new Date(summary.generatedAt).getTime();
    expect(generated).toBeGreaterThanOrEqual(before);
    expect(generated).toBeLessThanOrEqual(Date.now());
  });

  it('states the failure window it counted over, alongside the count', async () => {
    const summary = await harness.dashboardService.get(CONTROL_TENANT, USER);

    expect(summary.failures.days).toBe(DASHBOARD_FAILURE_WINDOW_DAYS);
    // The label and the query come from one place: the window's start is exactly `days` before
    // the snapshot was taken, so a UI that renders "last 7 days" cannot be describing a
    // different range than the number it prints.
    const generated = new Date(summary.generatedAt).getTime();
    expect(new Date(summary.failures.since).getTime()).toBe(
      generated - DASHBOARD_FAILURE_WINDOW_DAYS * DAY_MS,
    );
  });

  // ── the counted tiles ──────────────────────────────────────────────────────

  it('counts agents by status, and counts all of them separately', async () => {
    await seedAgent(CONTROL_TENANT, 'active', 'a1');
    await seedAgent(CONTROL_TENANT, 'active', 'a2');
    await seedAgent(CONTROL_TENANT, 'draft', 'a3');

    const { counts } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // Two active out of three total. The pair is what makes the tile informative — "2 active"
    // means something different at "3 total" than at "40 total" — and asserting both is what
    // catches a service that filtered the total by mistake.
    expect(counts.agentsActive).toBe(2);
    expect(counts.agentsTotal).toBe(3);
  });

  it('counts active goals, not every goal', async () => {
    await seedGoal(CONTROL_TENANT, 'active');
    await seedGoal(CONTROL_TENANT, 'active');
    await seedGoal(CONTROL_TENANT, 'completed');
    await seedGoal(CONTROL_TENANT, 'draft');

    const { counts } = await harness.dashboardService.get(CONTROL_TENANT, USER);
    expect(counts.goalsActive).toBe(2);
  });

  it('counts only tasks whose own status is running', async () => {
    await seedTask(CONTROL_TENANT, 'running');
    await seedTask(CONTROL_TENANT, 'queued');
    await seedTask(CONTROL_TENANT, 'waiting_approval');
    await seedTask(CONTROL_TENANT, 'completed');

    const { counts } = await harness.dashboardService.get(CONTROL_TENANT, USER);
    expect(counts.tasksRunning).toBe(1);
  });

  it('counts active workflows, which is not the same as running workflows', async () => {
    await seedWorkflow(CONTROL_TENANT, 'active');
    await seedWorkflow(CONTROL_TENANT, 'draft');
    await seedWorkflow(CONTROL_TENANT, 'disabled');

    const { counts } = await harness.dashboardService.get(CONTROL_TENANT, USER);
    expect(counts.workflowsActive).toBe(1);
  });

  it('counts a run as active only when it holds a worker slot', async () => {
    await seedRun(CONTROL_TENANT, { status: 'planning' });
    await seedRun(CONTROL_TENANT, { status: 'running' });
    await seedRun(CONTROL_TENANT, { status: 'waiting_approval' });

    const { counts } = await harness.dashboardService.get(CONTROL_TENANT, USER);
    expect(counts.runsActive).toBe(3);
  });

  it('does not count a paused or finished run as active', async () => {
    await seedRun(CONTROL_TENANT, { status: 'paused' });
    await seedRun(CONTROL_TENANT, { status: 'queued' });
    await seedRun(CONTROL_TENANT, { status: 'completed' });
    await seedRun(CONTROL_TENANT, { status: 'failed' });

    const { counts } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // `paused` is the interesting exclusion: it looks "in flight" to a reader and is not,
    // because a paused run is parked on purpose and consumes no slot. If this tile ever
    // disagreed with the scheduler's own accounting, the dashboard would advertise headroom
    // that does not exist.
    expect(counts.runsActive).toBe(0);
  });

  it('counts pending approvals and excludes decided ones', async () => {
    await seedApproval(CONTROL_TENANT, 'pending');
    await seedApproval(CONTROL_TENANT, 'pending');
    await seedApproval(CONTROL_TENANT, 'approved');
    await seedApproval(CONTROL_TENANT, 'rejected');
    await seedApproval(CONTROL_TENANT, 'expired');

    const { counts } = await harness.dashboardService.get(CONTROL_TENANT, USER);
    expect(counts.approvalsPending).toBe(2);
  });

  it('does not count a lapsed approval as still pending', async () => {
    await seedApproval(CONTROL_TENANT, 'pending', new Date(Date.now() - 60_000));
    await seedApproval(CONTROL_TENANT, 'pending', new Date(Date.now() + 60_000));

    const { counts } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // An approval past its deadline is one the expiry sweep is about to close; showing it as
    // awaiting a decision would send an operator to a button that no longer does anything.
    expect(counts.approvalsPending).toBe(1);
  });

  // ── recent runs ────────────────────────────────────────────────────────────

  it('returns the most recent runs, newest first', async () => {
    const now = Date.now();
    for (let i = 0; i < 4; i += 1) {
      await seedRun(CONTROL_TENANT, {
        status: 'completed',
        createdAt: new Date(now - (10 - i) * 60_000),
      });
    }

    const { recentRuns } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    expect(recentRuns).toHaveLength(4);
    const times = recentRuns.map((run) => new Date(run.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('caps the recent-runs list at the shared page size', async () => {
    for (let i = 0; i < DASHBOARD_RECENT_RUNS + 4; i += 1) {
      await seedRun(CONTROL_TENANT, {
        status: 'completed',
        createdAt: new Date(Date.now() - i * 60_000),
      });
    }

    const { recentRuns } = await harness.dashboardService.get(CONTROL_TENANT, USER);
    expect(recentRuns).toHaveLength(DASHBOARD_RECENT_RUNS);
  });

  it('carries the failure reason on the run row', async () => {
    await seedRun(CONTROL_TENANT, { status: 'failed', error: 'provider refused the request' });

    const { recentRuns } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // On the row rather than fetched per run on click: a red row with no reason on it sends
    // the operator looking anyway, which defeats the point of a dashboard.
    expect(recentRuns[0]?.error).toBe('provider refused the request');
  });

  it('renders an unfinished run with null timestamps rather than zeroes', async () => {
    await seedRun(CONTROL_TENANT, { status: 'running' });

    const { recentRuns } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // `null` is the honest value for "has not happened"; a fabricated epoch or a `0` would
    // render as 1970 and read as data.
    expect(recentRuns[0]?.startedAt).toBeNull();
    expect(recentRuns[0]?.completedAt).toBeNull();
  });

  // ── recent activity ────────────────────────────────────────────────────────

  it('reports the latest started steps across the recent runs', async () => {
    const older = await seedRun(CONTROL_TENANT, {
      status: 'completed',
      createdAt: new Date(Date.now() - 60_000),
    });
    const newer = await seedRun(CONTROL_TENANT, { status: 'running' });

    await seedStep(older, { seq: 0, startedAt: new Date(Date.now() - 50_000), name: 'old-step' });
    await seedStep(newer, { seq: 0, startedAt: new Date(Date.now() - 1_000), name: 'new-step' });

    const { recentActivity } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    expect(recentActivity.map((step) => step.name)).toEqual(['new-step', 'old-step']);
    expect(recentActivity[0]).toMatchObject({ runId: newer, seq: 0, type: 'tool' });
  });

  it('excludes steps that have not started', async () => {
    const runId = await seedRun(CONTROL_TENANT, { status: 'running' });
    await seedStep(runId, { seq: 0, startedAt: new Date(Date.now() - 1_000), name: 'ran' });
    await seedStep(runId, { seq: 1, startedAt: null, status: 'pending', name: 'not-yet' });

    const { recentActivity } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // The load-bearing filter. A feed ordered by a nullable timestamp under `DESC` puts the
    // not-yet-started rows *first*, so without this the dashboard would open with the steps
    // that have not happened presented as the most recent things that did.
    expect(recentActivity.map((step) => step.name)).toEqual(['ran']);
  });

  it('caps the activity feed at the shared page size', async () => {
    const runId = await seedRun(CONTROL_TENANT, { status: 'running' });
    for (let i = 0; i < DASHBOARD_RECENT_ACTIVITY + 5; i += 1) {
      await seedStep(runId, { seq: i, startedAt: new Date(Date.now() - i * 1_000) });
    }

    const { recentActivity } = await harness.dashboardService.get(CONTROL_TENANT, USER);
    expect(recentActivity).toHaveLength(DASHBOARD_RECENT_ACTIVITY);
  });

  it('reads activity only from the runs it listed for this tenant', async () => {
    const mine = await seedRun(CONTROL_TENANT, { status: 'running' });
    const theirs = await seedRun(OTHER_TENANT, { status: 'running' });
    await seedStep(mine, { seq: 0, startedAt: new Date(), name: 'mine' });
    await seedStep(theirs, { seq: 0, startedAt: new Date(), name: 'theirs' });

    const { recentActivity } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // `Step` has no `tenantId` — its isolation is the run it belongs to. This is the assertion
    // that the ownership proof actually holds: the ids handed to the step read came from a
    // tenant-scoped run query, so another tenant's steps are unreachable by construction.
    expect(recentActivity.map((step) => step.name)).toEqual(['mine']);
  });

  // ── failures ───────────────────────────────────────────────────────────────

  it('counts only failed runs inside the window', async () => {
    const now = Date.now();
    await seedRun(CONTROL_TENANT, { status: 'failed', createdAt: new Date(now - 1 * DAY_MS) });
    await seedRun(CONTROL_TENANT, { status: 'failed', createdAt: new Date(now - 6 * DAY_MS) });
    // Outside the window by a day.
    await seedRun(CONTROL_TENANT, { status: 'failed', createdAt: new Date(now - 8 * DAY_MS) });
    // Inside the window, but not a failure.
    await seedRun(CONTROL_TENANT, { status: 'completed', createdAt: new Date(now - 1 * DAY_MS) });

    const { failures } = await harness.dashboardService.get(CONTROL_TENANT, USER);
    expect(failures.count).toBe(2);
  });

  // ── provider health ────────────────────────────────────────────────────────

  it('reports the stored health of each enabled provider', async () => {
    const checkedAt = new Date(Date.now() - 5 * 60_000);
    await seedProvider(CONTROL_TENANT, 'OpenAI', {
      status: 'healthy',
      lastHealthCheck: checkedAt,
    });

    const { providerHealth } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    expect(providerHealth).toHaveLength(1);
    expect(providerHealth[0]).toMatchObject({
      name: 'OpenAI',
      type: 'openai',
      status: 'healthy',
      lastHealthCheck: checkedAt.toISOString(),
    });
  });

  it('omits a disabled provider rather than reporting a frozen reading as health', async () => {
    await seedProvider(CONTROL_TENANT, 'Enabled', { status: 'healthy' });
    await seedProvider(CONTROL_TENANT, 'Disabled', { enabled: false, status: 'error' });

    const { providerHealth } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // The health sweep skips disabled providers, so this one's `status` column is a reading
    // from whenever it was last enabled. Reporting it would be a number that looks live and
    // is not — and it would make the dashboard show a permanent error nobody can clear.
    expect(providerHealth.map((provider) => provider.name)).toEqual(['Enabled']);
  });

  it('reports a provider that has never been probed as unverified, not healthy', async () => {
    await seedProvider(CONTROL_TENANT, 'Fresh');

    const { providerHealth } = await harness.dashboardService.get(CONTROL_TENANT, USER);
    expect(providerHealth[0]?.status).toBe('unverified');
    expect(providerHealth[0]?.lastHealthCheck).toBeNull();
  });

  // ── connected services ─────────────────────────────────────────────────────

  it('reports each MCP server with the number of tools it contributed', async () => {
    const first = await seedMcpServer(CONTROL_TENANT, 'Files', 'connected');
    const second = await seedMcpServer(CONTROL_TENANT, 'Search', 'error');

    await harness.mcpTools.upsert({ serverId: first, externalId: 'read', name: 'read_file', inputSchema: {} });
    await harness.mcpTools.upsert({ serverId: first, externalId: 'write', name: 'write_file', inputSchema: {} });
    await harness.mcpTools.upsert({ serverId: second, externalId: 'q', name: 'query', inputSchema: {} });

    const { connectedServices } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // Counted per server rather than totalled: "one server with three tools" and "three
    // servers with one each" are different situations, and only the per-row count tells them
    // apart. The failed server is still listed — a broken connection is the thing an operator
    // most needs to see.
    expect(connectedServices).toEqual(
      expect.arrayContaining([
        { kind: 'mcp', id: first, name: 'Files', status: 'connected', toolCount: 2 },
        { kind: 'mcp', id: second, name: 'Search', status: 'error', toolCount: 1 },
      ]),
    );
    expect(connectedServices).toHaveLength(2);
  });

  it('reports a connected server with no tools as zero rather than omitting it', async () => {
    await seedMcpServer(CONTROL_TENANT, 'Empty', 'connected');

    const { connectedServices } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // Zero here is a computed zero — the group query returned no bucket for this server — and
    // it is different from the *absent* connector count, which is absent because nothing in
    // the product can produce it.
    expect(connectedServices).toEqual([
      { kind: 'mcp', id: expect.any(String), name: 'Empty', status: 'connected', toolCount: 0 },
    ]);
  });

  it('does not report another tenant’s MCP servers', async () => {
    await seedMcpServer(CONTROL_TENANT, 'Mine', 'connected');
    await seedMcpServer(OTHER_TENANT, 'Theirs', 'connected');

    const { connectedServices } = await harness.dashboardService.get(CONTROL_TENANT, USER);
    expect(connectedServices.map((service) => service.name)).toEqual(['Mine']);
  });

  // ── upcoming schedules ─────────────────────────────────────────────────────

  it('lists schedules soonest first, with their next fire time', async () => {
    const soon = new Date(Date.now() + 60_000);
    const later = new Date(Date.now() + 3_600_000);
    await seedSchedule(CONTROL_TENANT, { name: 'later', nextFireAt: later });
    await seedSchedule(CONTROL_TENANT, { name: 'soon', nextFireAt: soon });

    const { upcomingSchedules } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    expect(upcomingSchedules.map((schedule) => schedule.name)).toEqual(['soon', 'later']);
    expect(upcomingSchedules[0]?.nextFireAt).toBe(soon.toISOString());
  });

  it('excludes a schedule with no next fire', async () => {
    await seedSchedule(CONTROL_TENANT, { name: 'spent', nextFireAt: null, kind: 'one_time' });
    await seedSchedule(CONTROL_TENANT, { name: 'live', nextFireAt: new Date(Date.now() + 60_000) });

    const { upcomingSchedules } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // A spent one-time schedule is not "upcoming" — there is no next time. Showing it with a
    // blank would be a row that says nothing, in a list whose whole purpose is "what happens
    // next".
    expect(upcomingSchedules.map((schedule) => schedule.name)).toEqual(['live']);
  });

  it('excludes a disabled schedule', async () => {
    await seedSchedule(CONTROL_TENANT, {
      name: 'paused',
      nextFireAt: new Date(Date.now() + 60_000),
      enabled: false,
    });

    const { upcomingSchedules } = await harness.dashboardService.get(CONTROL_TENANT, USER);
    expect(upcomingSchedules).toEqual([]);
  });

  it('caps the schedule list at the shared page size without dropping the soonest', async () => {
    const base = Date.now();
    // Seeded worst-first, so a `take` applied before the ordering would return the *latest*
    // five and the assertion below would fail.
    for (let i = DASHBOARD_UPCOMING_SCHEDULES + 2; i > 0; i -= 1) {
      await seedSchedule(CONTROL_TENANT, {
        name: `s${i}`,
        nextFireAt: new Date(base + i * 60_000),
      });
    }

    const { upcomingSchedules } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    expect(upcomingSchedules).toHaveLength(DASHBOARD_UPCOMING_SCHEDULES);
    expect(upcomingSchedules[0]?.name).toBe('s1');
  });

  // ── verifications ──────────────────────────────────────────────────────────

  it('summarises verifications by outcome, counting the undecided ones', async () => {
    await harness.seedPassingVerification();
    await harness.seedPassingVerification();
    await harness.seedFailedVerification();
    // Written but not completed — the state that exists between scheduling a check and running
    // it, and the one an operator needs to see rather than infer.
    await harness.verifications.create({
      tenantId: CONTROL_TENANT,
      type: 'schema',
      config: { check: 'pending' },
    });

    const { verifications } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    expect(verifications).toEqual({ total: 4, pending: 1, passed: 2, failed: 1 });
  });

  it('keeps the verification parts summing to the total', async () => {
    await harness.seedPassingVerification();
    await harness.seedFailedVerification();

    const { verifications } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // Structural rather than asserted: the total is the sum of the grouped rows, so this
    // cannot drift the way a separate `count(*)` could.
    expect(verifications.pending + verifications.passed + verifications.failed).toBe(
      verifications.total,
    );
  });

  // ── recent receipts ────────────────────────────────────────────────────────

  it('reports recent receipts with the run and tool each belongs to', async () => {
    const tool = await harness.seedTool({ name: 'send_email' });
    const runId = await seedRun(CONTROL_TENANT, { status: 'completed' });
    const callId = await seedToolCall(CONTROL_TENANT, tool.id, runId);
    await harness.receipts.create({
      tenantId: CONTROL_TENANT,
      toolCallId: callId,
      effect: { sent: true },
      idempotencyKey: 'idem-1',
    });

    const { recentReceipts } = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // `ExecutionReceipt` has no `runId` of its own — the run is reached through the tool call,
    // which is why the join lives in the repository. Asserting the resolved pair is what
    // proves the join happened rather than a `null` being quietly returned.
    expect(recentReceipts).toHaveLength(1);
    expect(recentReceipts[0]).toMatchObject({ runId, toolName: 'send_email' });
    expect(recentReceipts[0]?.effect).toEqual({ sent: true });
  });

  it('caps the receipt list at the shared page size', async () => {
    const tool = await harness.seedTool({ name: 'noop' });
    for (let i = 0; i < DASHBOARD_RECENT_RECEIPTS + 3; i += 1) {
      const callId = await seedToolCall(CONTROL_TENANT, tool.id);
      await harness.receipts.create({
        tenantId: CONTROL_TENANT,
        toolCallId: callId,
        effect: { i },
        idempotencyKey: `idem-${i}`,
      });
    }

    const { recentReceipts } = await harness.dashboardService.get(CONTROL_TENANT, USER);
    expect(recentReceipts).toHaveLength(DASHBOARD_RECENT_RECEIPTS);
  });

  it('does not report another tenant’s receipts', async () => {
    const tool = await harness.seedTool({ name: 'noop' });
    const callId = await seedToolCall(OTHER_TENANT, tool.id);
    await harness.receipts.create({
      tenantId: OTHER_TENANT,
      toolCallId: callId,
      effect: { theirs: true },
      idempotencyKey: 'idem-other',
    });

    const { recentReceipts } = await harness.dashboardService.get(CONTROL_TENANT, USER);
    expect(recentReceipts).toEqual([]);
  });

  // ── unread notifications ───────────────────────────────────────────────────

  it('counts the connecting user’s unread notifications, not the workspace’s', async () => {
    await harness.notifications.create({
      tenantId: CONTROL_TENANT,
      userId: USER,
      kind: 'approval_request',
      title: 'Mine',
      body: null,
      linkRoute: null,
    });
    await harness.notifications.create({
      tenantId: CONTROL_TENANT,
      userId: 'usr_colleague',
      kind: 'approval_request',
      title: 'Theirs',
      body: null,
      linkRoute: null,
    });

    const summary = await harness.dashboardService.get(CONTROL_TENANT, USER);
    const colleague = await harness.dashboardService.get(CONTROL_TENANT, 'usr_colleague');

    // The one field on this endpoint that is per *person*. A tenant-wide count would tell each
    // member how much unread mail the others have, which is a small leak that is still a leak.
    expect(summary.unreadNotifications).toBe(1);
    expect(colleague.unreadNotifications).toBe(1);
    expect((await harness.dashboardService.get(CONTROL_TENANT, NOBODY)).unreadNotifications).toBe(0);
  });

  it('does not count a read notification as unread', async () => {
    const row = await harness.notifications.create({
      tenantId: CONTROL_TENANT,
      userId: USER,
      kind: 'task_completed',
      title: 'Done',
      body: null,
      linkRoute: null,
    });
    await harness.notificationService.markRead(CONTROL_TENANT, USER, row.id);

    const { unreadNotifications } = await harness.dashboardService.get(CONTROL_TENANT, USER);
    expect(unreadNotifications).toBe(0);
  });

  // ── tenancy ────────────────────────────────────────────────────────────────

  it('reports nothing belonging to another workspace', async () => {
    await seedAgent(OTHER_TENANT, 'active');
    await seedGoal(OTHER_TENANT, 'active');
    await seedTask(OTHER_TENANT, 'running');
    await seedWorkflow(OTHER_TENANT, 'active');
    await seedRun(OTHER_TENANT, { status: 'running' });
    await seedRun(OTHER_TENANT, { status: 'failed' });
    await seedApproval(OTHER_TENANT, 'pending');
    await seedSchedule(OTHER_TENANT, { name: 'theirs', nextFireAt: new Date(Date.now() + 60_000) });

    const summary = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // The whole snapshot, in one assertion. Every aggregate here is a tenant-wide read, so
    // this is the test that would catch a `where` that lost its tenant predicate — the
    // failure that turns a dashboard into a cross-tenant data leak.
    expect(summary.counts).toEqual({
      agentsActive: 0,
      agentsTotal: 0,
      goalsActive: 0,
      tasksRunning: 0,
      workflowsActive: 0,
      runsActive: 0,
      approvalsPending: 0,
    });
    expect(summary.recentRuns).toEqual([]);
    expect(summary.recentActivity).toEqual([]);
    expect(summary.connectedServices).toEqual([]);
    expect(summary.upcomingSchedules).toEqual([]);
    expect(summary.providerHealth).toEqual([]);
    expect(summary.recentReceipts).toEqual([]);
    expect(summary.failures.count).toBe(0);
    expect(summary.verifications.total).toBe(0);
  });

  it('still reports this tenant’s rows when another tenant has its own', async () => {
    await seedAgent(CONTROL_TENANT, 'active', 'mine');
    await seedAgent(OTHER_TENANT, 'active', 'theirs');

    const summary = await harness.dashboardService.get(CONTROL_TENANT, USER);

    // The mirror of the test above, and the reason both exist: a service that returned nothing
    // would pass a tenancy test and fail this one, so the pair pins the filter from both sides.
    expect(summary.counts.agentsActive).toBe(1);
    expect(summary.counts.agentsTotal).toBe(1);
  });
});
