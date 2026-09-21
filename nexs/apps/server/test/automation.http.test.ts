import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_ACCESS } from '@nexs/shared';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * `/api/events` and `/api/schedules` as a client actually sees them.
 *
 * The service suites prove the behaviour. This file proves the **wiring**, which is a
 * different set of things that can be wrong and that no service test can see:
 *
 *  - that both routers are mounted and behind the shared auth middleware;
 *  - that the zod schemas are attached to the verbs that need them, so a bad body is a 400
 *    at the boundary rather than a 500 from deep inside a service;
 *  - that the status codes say what they mean — `202` for an ingest whose effect has not
 *    happened yet, `204` for a delete;
 *  - and, most importantly, that **`/subscriptions` is not captured by `/:id`**. Express
 *    matches in declaration order, so this is a live trap: if the routes were ever
 *    reordered, every subscription list request would 404 with "the event does not exist"
 *    and the service tests would all still pass.
 *
 * The last test in the file is the Phase 11 acceptance criterion taken the whole way: a
 * webhook arrives over HTTP and a run appears for the subscribed task.
 */

const config = loadConfig();
const VALID_PASSWORD = 'correct horse battery staple';

/**
 * An agent-less task has to name its own model, or it could never run.
 *
 * Module-scoped because several tests create tasks that must be startable — the point of
 * the end-to-end test is that the run really starts, so a task that could never resolve a
 * model would make it pass or fail for the wrong reason.
 */
const RUNNABLE = { input: { context: { modelId: 'mdl_test' } } };

interface Ctx {
  app: ReturnType<typeof createApp>;
  fake: FakeDb;
  cookie: string;
}

/** Sign up a workspace and return its access cookie. */
async function signUp(app: ReturnType<typeof createApp>, label: string): Promise<string> {
  const res = await request(app)
    .post('/api/auth/signup')
    .send({
      email: `${label}-${Date.now()}-${Math.random()}@example.com`,
      password: VALID_PASSWORD,
      // Required by `signupSchema` — without it the request is a 400 and there is no cookie
      // to find, which is a confusing way to learn that a field was missing.
      name: 'Ada',
    });

  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const access = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`));
  if (access === undefined) {
    // The status and body are included because the alternative is a bare "no cookie" from
    // deep inside a beforeEach, which says nothing about why.
    throw new Error(`signup did not set an access cookie: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return access.split(';')[0]!;
}

async function build(): Promise<Ctx> {
  const fake = createFakeDb();
  const app = createApp({
    config,
    logger: createLogger(config),
    db: fake.client,
    queueStatus: () => 'not_initialized',
    version: '0.1.0-test',
  });
  return { app, fake, cookie: await signUp(app, 'automation') };
}

describe('the automation HTTP surface', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await build();
  });

  /** A startable task, created through the real route. */
  async function createTask(): Promise<string> {
    const res = await request(ctx.app)
      .post('/api/tasks')
      .set('Cookie', ctx.cookie)
      .send({
        title: 'Report',
        triggerType: 'scheduled',
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        ...RUNNABLE,
      });
    if (res.status !== 201) throw new Error(`could not create a task: ${res.status}`);
    return res.body.task.id as string;
  }

  describe('authentication', () => {
    it('refuses every automation route without a cookie', async () => {
      const paths = [
        ['get', '/api/schedules'],
        ['post', '/api/schedules'],
        ['get', '/api/schedules/sch_1'],
        ['post', '/api/schedules/sch_1/enable'],
        ['post', '/api/schedules/sch_1/disable'],
        ['post', '/api/schedules/sch_1/fire'],
        ['delete', '/api/schedules/sch_1'],
        ['get', '/api/events'],
        ['post', '/api/events'],
        ['get', '/api/events/evt_1'],
        ['get', '/api/events/subscriptions'],
        ['post', '/api/events/subscriptions'],
        ['patch', '/api/events/subscriptions/sub_1'],
        ['delete', '/api/events/subscriptions/sub_1'],
      ] as const;

      for (const [method, path] of paths) {
        const res = await request(ctx.app)[method](path);
        expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
      }
    });
  });

  describe('schedules', () => {
    it('creates a recurring schedule and reports when it will next fire', async () => {
      const taskId = await createTask();

      const res = await request(ctx.app)
        .post('/api/schedules')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Every ten minutes',
          kind: 'recurring',
          cron: '*/10 * * * *',
          targetKind: 'task',
          targetId: taskId,
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.kind).toBe('recurring');
      expect(res.body.enabled).toBe(true);
      // A real answer, not null: `GET /api/schedules` exists to show this, and a scheduler
      // list that cannot say when anything runs is not worth having.
      expect(res.body.nextFireAt).not.toBeNull();
    });

    it('rejects a non-UTC timezone at the boundary', async () => {
      const taskId = await createTask();

      const res = await request(ctx.app)
        .post('/api/schedules')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Tokyo',
          kind: 'recurring',
          cron: '0 9 * * *',
          timezone: 'Asia/Tokyo',
          targetKind: 'task',
          targetId: taskId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a malformed cron, and a recurring schedule with no cron at all', async () => {
      const taskId = await createTask();

      for (const body of [
        { name: 'Bad', kind: 'recurring', cron: 'not a cron', targetKind: 'task', targetId: taskId },
        { name: 'Missing', kind: 'recurring', targetKind: 'task', targetId: taskId },
      ]) {
        const res = await request(ctx.app)
          .post('/api/schedules')
          .set('Cookie', ctx.cookie)
          .send(body);
        expect(res.status).toBe(400);
      }
    });

    it('rejects a target that does not exist', async () => {
      const res = await request(ctx.app)
        .post('/api/schedules')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Orphan',
          kind: 'recurring',
          cron: '*/5 * * * *',
          targetKind: 'task',
          targetId: 'tsk_missing',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.details).toMatchObject({ field: 'targetId' });
    });

    it('lists, reads, disables, enables and deletes a schedule', async () => {
      const taskId = await createTask();
      const created = await request(ctx.app)
        .post('/api/schedules')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Nightly',
          kind: 'recurring',
          cron: '0 3 * * *',
          targetKind: 'task',
          targetId: taskId,
        });
      const id = created.body.id as string;

      const list = await request(ctx.app).get('/api/schedules').set('Cookie', ctx.cookie);
      expect(list.status).toBe(200);
      expect(list.body.schedules).toHaveLength(1);

      const one = await request(ctx.app).get(`/api/schedules/${id}`).set('Cookie', ctx.cookie);
      expect(one.status).toBe(200);
      expect(one.body.name).toBe('Nightly');

      const off = await request(ctx.app)
        .post(`/api/schedules/${id}/disable`)
        .set('Cookie', ctx.cookie);
      expect(off.status).toBe(200);
      expect(off.body.enabled).toBe(false);

      const on = await request(ctx.app)
        .post(`/api/schedules/${id}/enable`)
        .set('Cookie', ctx.cookie);
      expect(on.status).toBe(200);
      expect(on.body.enabled).toBe(true);

      const removed = await request(ctx.app)
        .delete(`/api/schedules/${id}`)
        .set('Cookie', ctx.cookie);
      expect(removed.status).toBe(204);

      const gone = await request(ctx.app).get(`/api/schedules/${id}`).set('Cookie', ctx.cookie);
      expect(gone.status).toBe(404);
    });

    it('fires a schedule on demand and produces a run a client can then read', async () => {
      // The manual trigger goes through the same `fire` path the queue consumer uses, so
      // this proves the whole chain: route → service → occurrence starter → run row.
      const taskId = await createTask();
      const created = await request(ctx.app)
        .post('/api/schedules')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Now',
          kind: 'recurring',
          cron: '0 3 * * *',
          targetKind: 'task',
          targetId: taskId,
        });

      const fired = await request(ctx.app)
        .post(`/api/schedules/${created.body.id}/fire`)
        .set('Cookie', ctx.cookie);

      // 200 for a skip as well as a fire: "nothing happened, and here is why" is a
      // successful answer to a successful request.
      expect(fired.status).toBe(200);
      expect(fired.body.outcome).toBe('fired');
      expect(fired.body.runId).toBeDefined();

      const run = await request(ctx.app)
        .get(`/api/runs/${fired.body.runId}`)
        .set('Cookie', ctx.cookie);
      expect(run.status).toBe(200);
      expect(run.body.run.taskId).toBe(taskId);
    });

    it('refuses to edit a schedule with a field the schema does not have', async () => {
      // `enabled` is deliberately absent from the update schema — it is a verb route — so a
      // patch that tries to set it must be refused rather than silently ignored.
      const taskId = await createTask();
      const created = await request(ctx.app)
        .post('/api/schedules')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Nightly',
          kind: 'recurring',
          cron: '0 3 * * *',
          targetKind: 'task',
          targetId: taskId,
        });

      const res = await request(ctx.app)
        .patch(`/api/schedules/${created.body.id}`)
        .set('Cookie', ctx.cookie)
        .send({ enabled: false });

      expect(res.status).toBe(400);
    });
  });

  describe('events', () => {
    it('ingests an event and answers 202, because the effect has not happened yet', async () => {
      const res = await request(ctx.app)
        .post('/api/events')
        .set('Cookie', ctx.cookie)
        .send({ type: 'build.finished', source: 'ci', subject: 'repo/main', payload: { sha: 'abc' } });

      // 202 rather than 201: the event is stored and matched, but what it started is a run
      // that executes later in a worker. 201 would claim a ready resource.
      expect(res.status).toBe(202);
      expect(res.body.deduplicated).toBe(false);
      expect(res.body.event.type).toBe('build.finished');
      expect(res.body.triggered).toBe(0);
    });

    it('reports a repeat delivery as deduplicated', async () => {
      const body = { type: 'build.finished', source: 'ci', externalId: 'delivery-1' };

      const first = await request(ctx.app).post('/api/events').set('Cookie', ctx.cookie).send(body);
      const second = await request(ctx.app).post('/api/events').set('Cookie', ctx.cookie).send(body);

      expect(first.body.deduplicated).toBe(false);
      expect(second.body.deduplicated).toBe(true);
      expect(second.body.event.id).toBe(first.body.event.id);
    });

    it('rejects an event with no type or no source', async () => {
      for (const body of [{ source: 'ci' }, { type: 'build.finished' }, {}]) {
        const res = await request(ctx.app).post('/api/events').set('Cookie', ctx.cookie).send(body);
        expect(res.status).toBe(400);
      }
    });

    it('lists and reads events', async () => {
      await request(ctx.app)
        .post('/api/events')
        .set('Cookie', ctx.cookie)
        .send({ type: 'build.finished', source: 'ci' });

      const list = await request(ctx.app).get('/api/events').set('Cookie', ctx.cookie);
      expect(list.status).toBe(200);
      expect(list.body.events).toHaveLength(1);

      const one = await request(ctx.app)
        .get(`/api/events/${list.body.events[0].id}`)
        .set('Cookie', ctx.cookie);
      expect(one.status).toBe(200);

      const missing = await request(ctx.app).get('/api/events/evt_missing').set('Cookie', ctx.cookie);
      expect(missing.status).toBe(404);
    });

    it('resolves /subscriptions rather than treating it as an event id', async () => {
      // The declaration-order trap. If `GET /:id` were declared first, this would 404 with
      // "the event does not exist" — and every service test would still pass.
      const res = await request(ctx.app).get('/api/events/subscriptions').set('Cookie', ctx.cookie);

      expect(res.status).toBe(200);
      expect(res.body.subscriptions).toEqual([]);
    });

    it('creates a subscription, and never echoes the secret back', async () => {
      const taskId = await createTask();

      const withSecret = await request(ctx.app)
        .post('/api/events/subscriptions')
        .set('Cookie', ctx.cookie)
        .send({
          topic: 'build.finished',
          filter: { source: 'ci' },
          targetKind: 'task',
          targetId: taskId,
          secret: 'a-long-enough-hmac-key',
        });

      expect(withSecret.status).toBe(201);
      expect(withSecret.body.hasSecret).toBe(true);
      expect(withSecret.body.filter).toEqual({ source: 'ci' });
      // A key that can be read back is a key that can be used to forge the webhooks it
      // exists to authenticate.
      expect(JSON.stringify(withSecret.body)).not.toContain('a-long-enough-hmac-key');

      const list = await request(ctx.app).get('/api/events/subscriptions').set('Cookie', ctx.cookie);
      expect(list.body.subscriptions).toHaveLength(1);
    });

    it('rejects a subscription whose target does not exist', async () => {
      const res = await request(ctx.app)
        .post('/api/events/subscriptions')
        .set('Cookie', ctx.cookie)
        .send({ topic: 'build.finished', targetKind: 'task', targetId: 'tsk_missing' });

      expect(res.status).toBe(400);
      expect(res.body.error.details).toMatchObject({ field: 'targetId' });
    });

    it('updates and deletes a subscription', async () => {
      const taskId = await createTask();
      const created = await request(ctx.app)
        .post('/api/events/subscriptions')
        .set('Cookie', ctx.cookie)
        .send({ topic: 'build.finished', targetKind: 'task', targetId: taskId });
      const id = created.body.id as string;

      const patched = await request(ctx.app)
        .patch(`/api/events/subscriptions/${id}`)
        .set('Cookie', ctx.cookie)
        .send({ enabled: false });
      expect(patched.status).toBe(200);
      expect(patched.body.enabled).toBe(false);

      const removed = await request(ctx.app)
        .delete(`/api/events/subscriptions/${id}`)
        .set('Cookie', ctx.cookie);
      expect(removed.status).toBe(204);

      const again = await request(ctx.app)
        .delete(`/api/events/subscriptions/${id}`)
        .set('Cookie', ctx.cookie);
      expect(again.status).toBe(404);
    });

    it('does not let a second workspace see the first one’s events', async () => {
      // Tenant isolation at the boundary. The service proves the repository scopes its
      // reads; this proves the *tenant* the controller passes is the authenticated one
      // rather than something a caller could influence.
      await request(ctx.app)
        .post('/api/events')
        .set('Cookie', ctx.cookie)
        .send({ type: 'build.finished', source: 'ci' });

      const other = await signUp(ctx.app, 'other');
      const res = await request(ctx.app).get('/api/events').set('Cookie', other);

      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([]);
    });

    it('does not let a second workspace read the first one’s schedule by id', async () => {
      const taskId = await createTask();
      const created = await request(ctx.app)
        .post('/api/schedules')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Private',
          kind: 'recurring',
          cron: '0 3 * * *',
          targetKind: 'task',
          targetId: taskId,
        });

      const other = await signUp(ctx.app, 'other');
      const res = await request(ctx.app)
        .get(`/api/schedules/${created.body.id}`)
        .set('Cookie', other);

      expect(res.status).toBe(404);
    });
  });

  describe('the acceptance criterion, end to end', () => {
    it('turns a webhook into a run for the subscribed target', async () => {
      // Phase 11: *"webhook event triggers subscribed workflow"*. A task stands in for the
      // workflow here because creating a runnable workflow needs a tool, and there is no
      // tools route yet — the run-creation path is the same `OccurrenceStarter` either way,
      // and `events.service.test.ts` covers the workflow target specifically.
      const taskId = await createTask();

      const subscription = await request(ctx.app)
        .post('/api/events/subscriptions')
        .set('Cookie', ctx.cookie)
        .send({ topic: 'build.finished', filter: { source: 'ci' }, targetKind: 'task', targetId: taskId });
      expect(subscription.status).toBe(201);

      const ingested = await request(ctx.app)
        .post('/api/events')
        .set('Cookie', ctx.cookie)
        .send({ type: 'build.finished', source: 'ci', externalId: 'd-1', payload: { sha: 'abc' } });

      expect(ingested.status).toBe(202);
      expect(ingested.body.matchedSubscriptions).toBe(1);
      expect(ingested.body.triggered).toBe(1);
      expect(ingested.body.failures).toEqual([]);

      // The effect is visible through the API: a run exists for the subscribed task.
      const runs = await request(ctx.app)
        .get(`/api/runs?taskId=${taskId}`)
        .set('Cookie', ctx.cookie);
      expect(runs.status).toBe(200);
      expect(runs.body.runs).toHaveLength(1);
      expect(runs.body.runs[0].taskId).toBe(taskId);

      // And a replay of the same delivery adds nothing.
      const replay = await request(ctx.app)
        .post('/api/events')
        .set('Cookie', ctx.cookie)
        .send({ type: 'build.finished', source: 'ci', externalId: 'd-1', payload: { sha: 'abc' } });

      expect(replay.body.deduplicated).toBe(true);
      expect(replay.body.triggered).toBe(0);

      const after = await request(ctx.app)
        .get(`/api/runs?taskId=${taskId}`)
        .set('Cookie', ctx.cookie);
      expect(after.body.runs).toHaveLength(1);
    });
  });
});
