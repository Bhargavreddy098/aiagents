import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_ACCESS } from '@nexs/shared';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * The Phase 6 control-plane surface as a client actually sees it.
 *
 * The service tests prove the behaviour; this file proves the **wiring** — that the routers
 * are mounted, that authentication is applied once per router rather than per route, that
 * the zod schemas are attached to the verbs that need them, and above all that a path
 * parameter survives the trip through Express 5.
 *
 * That last one is not hypothetical. Express 5 types `req.params[key]` as
 * `string | string[]`, and every controller had to be changed to narrow it through
 * `pathParam`. A test that only exercised the services would not have caught a single one
 * of those, because the bug was in the boundary and not in the logic.
 */

const config = loadConfig();
const VALID_PASSWORD = 'correct horse battery staple';

/**
 * An immediate task with no agent has to name its own model, or it could never run.
 *
 * Module-scoped rather than per-describe because both the task and the run tests need it.
 */
const RUNNABLE = { input: { context: { modelId: 'mdl_test' } } };

interface Ctx {
  app: ReturnType<typeof createApp>;
  fake: FakeDb;
  cookie: string;
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

  const res = await request(app)
    .post('/api/auth/signup')
    .send({ email: `control-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Ada' });

  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const access = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`));
  if (access === undefined) throw new Error('signup did not set an access cookie');

  return { app, fake, cookie: access.split(';')[0]! };
}

describe('the control-plane HTTP surface', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await build();
  });

  /** Seed a usable model straight into the database — Phase 6 has no models route yet. */
  async function seedModel(): Promise<string> {
    const tenant = ctx.fake.tenants[0]!;
    const provider = await ctx.fake.client.modelProvider.create({
      data: {
        tenantId: tenant.id,
        name: 'Test Provider',
        slug: 'test-provider',
        type: 'openai',
        enabled: true,
        status: 'healthy',
      },
    });
    const model = await ctx.fake.client.model.create({
      data: {
        tenantId: tenant.id,
        providerId: provider.id,
        name: 'Test Model',
        externalModelId: 'test-model',
        type: 'chat',
      },
    });
    return model.id;
  }

  describe('authentication', () => {
    it('refuses every control-plane route without a cookie', async () => {
      const paths = [
        ['get', '/api/agents'],
        ['get', '/api/agents/agt_1'],
        ['post', '/api/agents'],
        ['get', '/api/goals'],
        ['get', '/api/tasks'],
        ['get', '/api/workflows'],
        ['get', '/api/runs'],
      ] as const;

      for (const [method, path] of paths) {
        const res = await request(ctx.app)[method](path);
        expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
      }
    });
  });

  describe('agents', () => {
    it('creates, reads and lists an agent', async () => {
      const created = await request(ctx.app)
        .post('/api/agents')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Reporter' });

      expect(created.status).toBe(201);
      expect(created.body.agent).toMatchObject({ name: 'Reporter', status: 'draft' });
      const id: string = created.body.agent.id;

      const read = await request(ctx.app).get(`/api/agents/${id}`).set('Cookie', ctx.cookie);
      expect(read.status).toBe(200);
      expect(read.body.agent.versions).toHaveLength(1);

      const list = await request(ctx.app).get('/api/agents').set('Cookie', ctx.cookie);
      expect(list.status).toBe(200);
      expect(list.body.agents).toHaveLength(1);
    });

    it('narrows the path parameter, returning 404 rather than a widened query', async () => {
      const res = await request(ctx.app)
        .get('/api/agents/agt_does_not_exist')
        .set('Cookie', ctx.cookie);

      // The point of `pathParam`: a missing or non-string parameter becomes a 404 here,
      // rather than reaching Prisma as `where: { id: undefined }` — which Prisma drops,
      // silently widening the query to "the first row of any tenant".
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects an unknown field rather than ignoring it', async () => {
      const res = await request(ctx.app)
        .post('/api/agents')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Reporter', nonsense: true });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('mints a version on a behaviour change and not on a rename', async () => {
      const created = await request(ctx.app)
        .post('/api/agents')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Reporter', instructions: 'Be brief.' });
      const id: string = created.body.agent.id;

      const renamed = await request(ctx.app)
        .patch(`/api/agents/${id}`)
        .set('Cookie', ctx.cookie)
        .send({ name: 'Chief Reporter' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.agent.versions).toHaveLength(1);

      const edited = await request(ctx.app)
        .patch(`/api/agents/${id}`)
        .set('Cookie', ctx.cookie)
        .send({ instructions: 'Be verbose.' });
      expect(edited.body.agent.versions).toHaveLength(2);
    });

    it('refuses to activate an agent with no model', async () => {
      const created = await request(ctx.app)
        .post('/api/agents')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Reporter' });

      const res = await request(ctx.app)
        .post(`/api/agents/${created.body.agent.id}/activate`)
        .set('Cookie', ctx.cookie);

      expect(res.status).toBe(400);
      expect(res.body.error.details).toMatchObject({ field: 'modelId' });
    });

    it('activates an agent whose model is usable', async () => {
      const modelId = await seedModel();
      const created = await request(ctx.app)
        .post('/api/agents')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Reporter', modelId });

      const res = await request(ctx.app)
        .post(`/api/agents/${created.body.agent.id}/activate`)
        .set('Cookie', ctx.cookie);

      expect(res.status).toBe(200);
      expect(res.body.agent.status).toBe('active');
    });

    it('duplicates an agent into a new draft at version 1', async () => {
      const created = await request(ctx.app)
        .post('/api/agents')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Reporter', instructions: 'Be brief.' });

      const res = await request(ctx.app)
        .post(`/api/agents/${created.body.agent.id}/duplicate`)
        .set('Cookie', ctx.cookie)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.agent).toMatchObject({ name: 'Reporter (copy)', status: 'draft' });
      expect(res.body.agent.versions).toHaveLength(1);
    });

    it('archives an agent and refuses to edit it afterwards', async () => {
      const created = await request(ctx.app)
        .post('/api/agents')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Reporter' });
      const id: string = created.body.agent.id;

      const archived = await request(ctx.app)
        .delete(`/api/agents/${id}`)
        .set('Cookie', ctx.cookie);
      expect(archived.body.agent.status).toBe('archived');

      const edit = await request(ctx.app)
        .patch(`/api/agents/${id}`)
        .set('Cookie', ctx.cookie)
        .send({ instructions: 'Nope' });
      expect(edit.status).toBe(409);
    });
  });

  describe('goals', () => {
    it('refuses to complete a goal without a passing verification', async () => {
      const created = await request(ctx.app)
        .post('/api/goals')
        .set('Cookie', ctx.cookie)
        .send({ title: 'Ship the report' });
      const id: string = created.body.goal.id;

      await request(ctx.app)
        .post(`/api/goals/${id}/status`)
        .set('Cookie', ctx.cookie)
        .send({ status: 'active' })
        .expect(200);

      const res = await request(ctx.app)
        .post(`/api/goals/${id}/status`)
        .set('Cookie', ctx.cookie)
        .send({ status: 'completed' });

      expect(res.status).toBe(400);
      expect(res.body.error.details).toMatchObject({ field: 'completedVerificationId' });
    });

    it('refuses an illegal transition', async () => {
      const created = await request(ctx.app)
        .post('/api/goals')
        .set('Cookie', ctx.cookie)
        .send({ title: 'A goal' });

      const res = await request(ctx.app)
        .post(`/api/goals/${created.body.goal.id}/status`)
        .set('Cookie', ctx.cookie)
        .send({ status: 'completed' });

      expect(res.status).toBe(409);
      expect(res.body.error.details).toMatchObject({ from: 'draft', to: 'completed' });
    });
  });

  describe('tasks', () => {
    it('creates an immediate task and starts its run', async () => {
      const res = await request(ctx.app)
        .post('/api/tasks')
        .set('Cookie', ctx.cookie)
        .send({ title: 'Send the report', triggerType: 'immediate', ...RUNNABLE });

      expect(res.status).toBe(201);
      expect(res.body.task.status).toBe('running');
      expect(res.body.task.runIds).toHaveLength(1);
    });

    it('refuses an immediate task that could never resolve a model', async () => {
      const res = await request(ctx.app)
        .post('/api/tasks')
        .set('Cookie', ctx.cookie)
        .send({ title: 'Doomed', triggerType: 'immediate' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('deduplicates a retried delivery', async () => {
      const body = {
        title: 'Send the report',
        triggerType: 'immediate',
        idempotencyKey: 'delivery-1',
        ...RUNNABLE,
      };

      const first = await request(ctx.app)
        .post('/api/tasks')
        .set('Cookie', ctx.cookie)
        .send(body);
      const second = await request(ctx.app)
        .post('/api/tasks')
        .set('Cookie', ctx.cookie)
        .send(body);

      expect(second.body.task.id).toBe(first.body.task.id);
      expect(second.body.task.runIds).toHaveLength(1);
    });

    it('rejects a scheduled task with no time at the HTTP boundary', async () => {
      const res = await request(ctx.app)
        .post('/api/tasks')
        .set('Cookie', ctx.cookie)
        .send({ title: 'Later', triggerType: 'scheduled' });

      expect(res.status).toBe(400);
    });

    it('refuses a recurring task whose schedule does not exist', async () => {
      // Phase 11 changed this from 404 `FEATURE_DISABLED` ("schedules arrive in a later
      // phase") to 400 `VALIDATION_ERROR`: the scheduler exists now, so a dangling schedule
      // id is a bad request rather than an unavailable feature.
      const res = await request(ctx.app)
        .post('/api/tasks')
        .set('Cookie', ctx.cookie)
        .send({ title: 'Every morning', triggerType: 'recurring', scheduleId: 'sch_1' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toMatchObject({ field: 'scheduleId' });
    });
  });

  describe('workflows', () => {
    it('creates a workflow and refuses to run it while it is a draft', async () => {
      const created = await request(ctx.app)
        .post('/api/workflows')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Arithmetic',
          steps: [{ name: 'add', stepType: 'transform', config: { operation: 'noop' } }],
        });

      expect(created.status).toBe(201);
      expect(created.body.workflow.versions).toHaveLength(1);

      const run = await request(ctx.app)
        .post(`/api/workflows/${created.body.workflow.id}/run`)
        .set('Cookie', ctx.cookie)
        .send({});

      expect(run.status).toBe(409);
    });

    it('rejects a step that names a tool which does not exist', async () => {
      const res = await request(ctx.app)
        .post('/api/workflows')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Broken',
          steps: [{ name: 'add', stepType: 'tool', toolId: 'tol_missing', config: {} }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.details).toMatchObject({ toolId: 'tol_missing' });
    });

    it('publishes a new version', async () => {
      const created = await request(ctx.app)
        .post('/api/workflows')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Arithmetic',
          steps: [{ name: 'add', stepType: 'transform', config: { operation: 'noop' } }],
        });
      const id: string = created.body.workflow.id;

      const res = await request(ctx.app)
        .post(`/api/workflows/${id}/versions`)
        .set('Cookie', ctx.cookie)
        .send({
          steps: [
            { name: 'add', stepType: 'transform', config: { operation: 'noop' } },
            { name: 'again', stepType: 'transform', config: { operation: 'noop' }, dependsOn: ['add'] },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.workflow.versions).toHaveLength(2);
    });
  });

  describe('runs', () => {
    it('lists runs with a total', async () => {
      await request(ctx.app)
        .post('/api/tasks')
        .set('Cookie', ctx.cookie)
        .send({ title: 'One', triggerType: 'immediate', ...RUNNABLE });

      const res = await request(ctx.app).get('/api/runs').set('Cookie', ctx.cookie);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });

    it('rejects an unsupported filter instead of silently ignoring it', async () => {
      const res = await request(ctx.app).get('/api/runs?kind=task').set('Cookie', ctx.cookie);
      expect(res.status).toBe(400);
    });

    it('returns 404 for a run that does not exist', async () => {
      const res = await request(ctx.app).get('/api/runs/run_missing').set('Cookie', ctx.cookie);
      expect(res.status).toBe(404);
    });

    it('cancels a run and reports the new status', async () => {
      const created = await request(ctx.app)
        .post('/api/tasks')
        .set('Cookie', ctx.cookie)
        .send({ title: 'One', triggerType: 'immediate', ...RUNNABLE });
      const runId: string = created.body.task.runIds[0];

      const res = await request(ctx.app)
        .post(`/api/runs/${runId}/cancel`)
        .set('Cookie', ctx.cookie);

      // Either the run was still running (200) or the in-process executor had already
      // finished it (409) — both are honest, and which one happens depends on timing.
      // What must never happen is a 500.
      expect([200, 409]).toContain(res.status);
      if (res.status === 200) expect(res.body.run.status).toBe('cancelled');
    });
  });
});
