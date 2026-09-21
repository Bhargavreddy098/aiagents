import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_ACCESS, DASHBOARD_FAILURE_WINDOW_DAYS, DASHBOARD_RECENT_RUNS } from '@nexs/shared';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * `GET /api/dashboard` as a client actually sees it.
 *
 * The service suite proves the composition. This file proves the **wiring**, which is a
 * different set of failures that no service test can see:
 *
 *  - that the router is mounted and behind the shared auth middleware;
 *  - that the response is a plain JSON object rather than a stream (the two live endpoints
 *    sit next to each other in `app.ts`, and confusing them would be a silent, total break);
 *  - and that the endpoint takes no input — the limits are the spec's, so a caller cannot ask
 *    for a different window and then render a label that disagrees with the data.
 *
 * Rows are seeded through the fake client rather than through the services, because what is
 * under test here is whether the *route* reaches a service that sees the same rows — not
 * whether the services can create them.
 */

const config = loadConfig();
const VALID_PASSWORD = 'correct horse battery staple';

interface Ctx {
  app: ReturnType<typeof createApp>;
  fake: FakeDb;
  cookie: string;
  tenantId: string;
}

/** Sign up a workspace and return its access cookie plus the tenant the signup created. */
async function signUp(
  app: ReturnType<typeof createApp>,
  fake: FakeDb,
  label: string,
): Promise<{ cookie: string; tenantId: string }> {
  const res = await request(app)
    .post('/api/auth/signup')
    .send({
      email: `${label}-${Date.now()}-${Math.random()}@example.com`,
      password: VALID_PASSWORD,
      name: 'Ada',
    });

  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const access = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`));
  if (access === undefined) {
    throw new Error(`signup did not set an access cookie: ${res.status} ${JSON.stringify(res.body)}`);
  }

  // The newest tenant is this signup's. Reading it from the fake rather than from the token
  // keeps the test honest about which rows it is seeding.
  const tenantId = fake.tenants[fake.tenants.length - 1]!.id;
  return { cookie: access.split(';')[0]!, tenantId };
}

async function build(label = 'dashboard'): Promise<Ctx> {
  const fake = createFakeDb();
  const app = createApp({
    config,
    logger: createLogger(config),
    db: fake.client,
    queueStatus: () => 'not_initialized',
    version: '0.1.0-test',
  });
  const { cookie, tenantId } = await signUp(app, fake, label);
  return { app, fake, cookie, tenantId };
}

describe('GET /api/dashboard', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await build();
  });

  const get = (cookie?: string): request.Test =>
    cookie === undefined
      ? request(ctx.app).get('/api/dashboard')
      : request(ctx.app).get('/api/dashboard').set('cookie', cookie);

  it('refuses an unauthenticated request as JSON', async () => {
    const res = await get();

    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('answers a signed-in caller with the whole snapshot', async () => {
    const res = await get(ctx.cookie);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    // Every key present, even on an empty workspace. A dashboard client destructures this
    // object; a missing key is a crash on first render, not a zero.
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'connectedServices',
        'counts',
        'failures',
        'generatedAt',
        'providerHealth',
        'recentActivity',
        'recentReceipts',
        'recentRuns',
        'unreadNotifications',
        'upcomingSchedules',
        'verifications',
      ].sort(),
    );
    expect(res.body.counts).toMatchObject({ agentsActive: 0, agentsTotal: 0 });
    expect(res.body.recentRuns).toEqual([]);
  });

  it('reports numbers that trace to the rows in the database', async () => {
    await ctx.fake.client.agent.create({
      data: { tenantId: ctx.tenantId, name: 'a1', status: 'active' },
    });
    await ctx.fake.client.agent.create({
      data: { tenantId: ctx.tenantId, name: 'a2', status: 'active' },
    });
    await ctx.fake.client.agent.create({
      data: { tenantId: ctx.tenantId, name: 'a3', status: 'draft' },
    });
    await ctx.fake.client.task.create({
      data: { tenantId: ctx.tenantId, title: 'running', status: 'running' },
    });

    const res = await get(ctx.cookie);

    // The wiring assertion: a route that reached a *different* container than the one this
    // test seeded would report zeroes here.
    expect(res.body.counts).toMatchObject({ agentsActive: 2, agentsTotal: 3, tasksRunning: 1 });
  });

  it('returns the recent runs the tenant actually has, newest first', async () => {
    const now = Date.now();
    for (let i = 0; i < DASHBOARD_RECENT_RUNS + 2; i += 1) {
      await ctx.fake.client.run.create({
        data: {
          tenantId: ctx.tenantId,
          kind: 'task',
          status: 'completed',
          createdAt: new Date(now - i * 60_000),
        },
      });
    }

    const res = await get(ctx.cookie);

    expect(res.body.recentRuns).toHaveLength(DASHBOARD_RECENT_RUNS);
    const times = (res.body.recentRuns as Array<{ createdAt: string }>).map((run) =>
      new Date(run.createdAt).getTime(),
    );
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('counts only this workspace’s failures inside the window', async () => {
    const now = Date.now();
    await ctx.fake.client.run.create({
      data: {
        tenantId: ctx.tenantId,
        kind: 'task',
        status: 'failed',
        createdAt: new Date(now - 2 * 86_400_000),
      },
    });
    await ctx.fake.client.run.create({
      data: {
        tenantId: ctx.tenantId,
        kind: 'task',
        status: 'failed',
        createdAt: new Date(now - (DASHBOARD_FAILURE_WINDOW_DAYS + 2) * 86_400_000),
      },
    });

    const res = await get(ctx.cookie);

    expect(res.body.failures).toMatchObject({ days: DASHBOARD_FAILURE_WINDOW_DAYS, count: 1 });
  });

  it('counts unread notifications for the caller only', async () => {
    // A colleague in the same workspace. Their unread mail must not appear in this caller's
    // badge — the field is per person, and a tenant-wide count would leak it.
    const colleague = await ctx.fake.client.user.create({
      data: {
        tenantId: ctx.tenantId,
        email: `colleague-${Date.now()}@example.com`,
        passwordHash: 'x',
        name: 'Grace',
      },
    });

    await ctx.fake.client.notification.create({
      data: { tenantId: ctx.tenantId, userId: colleague.id, kind: 'task_completed', title: 'Theirs' },
    });

    const before = await get(ctx.cookie);
    expect(before.body.unreadNotifications).toBe(0);

    const me = ctx.fake.users.find((user) => user.tenantId === ctx.tenantId && user.id !== colleague.id);
    await ctx.fake.client.notification.create({
      data: { tenantId: ctx.tenantId, userId: me!.id, kind: 'task_completed', title: 'Mine' },
    });

    const after = await get(ctx.cookie);
    expect(after.body.unreadNotifications).toBe(1);
  });

  it('does not report another workspace’s rows', async () => {
    // A second tenant in the *same* database. Building a second app over a second fake would
    // prove nothing — two independent databases cannot leak into each other by construction,
    // so the test would pass for a reason unrelated to the tenant predicate.
    const other = await ctx.fake.client.tenant.create({ data: { name: 'Other Workspace' } });
    await ctx.fake.client.agent.create({
      data: { tenantId: other.id, name: 'theirs', status: 'active' },
    });
    await ctx.fake.client.run.create({
      data: { tenantId: other.id, kind: 'task', status: 'running' },
    });
    await ctx.fake.client.run.create({
      data: { tenantId: other.id, kind: 'task', status: 'failed' },
    });

    const res = await get(ctx.cookie);

    // Every tenant-wide aggregate in one assertion. This is the shape of failure that turns a
    // dashboard into a cross-tenant leak, and it is invisible to a service test that only ever
    // seeds one tenant.
    expect(res.body.counts).toMatchObject({ agentsTotal: 0, runsActive: 0 });
    expect(res.body.recentRuns).toEqual([]);
    expect(res.body.failures.count).toBe(0);
  });

  it('ignores query parameters rather than honouring a caller-chosen window', async () => {
    // The limits are the spec's, not the client's. A caller that could ask for `?days=1` and
    // render "last 7 days" over it would produce a number that disagrees with its own label —
    // which is exactly the class of bug the shared constants exist to prevent.
    const res = await request(ctx.app)
      .get('/api/dashboard?days=1&limit=999')
      .set('cookie', ctx.cookie);

    expect(res.status).toBe(200);
    expect(res.body.failures.days).toBe(DASHBOARD_FAILURE_WINDOW_DAYS);
    expect(res.body.recentRuns).toHaveLength(0);
  });
});
