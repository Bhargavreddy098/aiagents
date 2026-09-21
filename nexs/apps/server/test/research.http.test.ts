import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_ACCESS } from '@nexs/shared';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * `/api/research` as a client sees it.
 *
 * The service tests prove the provenance rules; this file proves the **wiring** — that the router
 * is mounted, that authentication covers the whole router, that each body schema is attached to
 * the verb that needs it, and above all that `/runs` is declared before `/:id`.
 *
 * That last one is the reason this file exists. Express matches in declaration order, so a
 * `GET /:id` declared first captures `runs` as a project id and every run listing answers 404
 * "the research project does not exist". The failure reads as missing data rather than as a
 * routing mistake, and no service test can catch it because the service is never reached.
 */

/**
 * A search provider is configured here because `createApp` builds the **real** container, and
 * `ResearchService.startRun` refuses when no provider exists — a research run whose second step
 * cannot run should never create two rows and a queue job. So a deployment that wants research has
 * to configure search, and this harness is one that does. The refusal itself is asserted below, in
 * a second app built from the unmodified environment.
 */
const SEARCH_ENV = { ...process.env, SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: 'test-search-key' };

const config = loadConfig(SEARCH_ENV);
const VALID_PASSWORD = 'correct horse battery staple';

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
    .send({ email: `research-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Ada' });

  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const access = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`));
  if (access === undefined) throw new Error('signup did not set an access cookie');

  return { app, fake, cookie: access.split(';')[0]! };
}

describe('/api/research', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await build();
  });

  async function openProject(title = 'Vendor risk'): Promise<string> {
    const res = await request(ctx.app)
      .post('/api/research')
      .set('Cookie', ctx.cookie)
      .send({ title, question: 'Which vendors had a breach in Q3?' });
    expect(res.status).toBe(201);
    return res.body.project.id as string;
  }

  describe('authentication', () => {
    it('refuses every research route without a session', async () => {
      await expect(request(ctx.app).get('/api/research')).resolves.toMatchObject({ status: 401 });
      await expect(
        request(ctx.app).post('/api/research').send({ title: 'x', question: 'y' }),
      ).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).get('/api/research/runs?projectId=p1')).resolves.toMatchObject({
        status: 401,
      });
      await expect(request(ctx.app).get('/api/research/prj_1')).resolves.toMatchObject({
        status: 401,
      });
      await expect(
        request(ctx.app).post('/api/research/prj_1/runs').send({ modelId: 'm' }),
      ).resolves.toMatchObject({ status: 401 });
      await expect(
        request(ctx.app).post('/api/research/runs/r1/finish').send({ status: 'completed' }),
      ).resolves.toMatchObject({ status: 401 });
    });
  });

  describe('the project round trip', () => {
    it('opens, lists, reads, archives and deletes', async () => {
      const id = await openProject();

      const listed = await request(ctx.app).get('/api/research').set('Cookie', ctx.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body.total).toBe(1);
      expect(listed.body.projects[0].id).toBe(id);

      const fetched = await request(ctx.app).get(`/api/research/${id}`).set('Cookie', ctx.cookie);
      expect(fetched.status).toBe(200);
      expect(fetched.body.project.question).toBe('Which vendors had a breach in Q3?');
      expect(fetched.body.project.runs).toEqual([]);

      const archived = await request(ctx.app)
        .post(`/api/research/${id}/archive`)
        .set('Cookie', ctx.cookie);
      expect(archived.status).toBe(200);
      expect(archived.body.project.status).toBe('archived');

      const removed = await request(ctx.app)
        .delete(`/api/research/${id}`)
        .set('Cookie', ctx.cookie);
      expect(removed.status).toBe(204);
    });
  });

  describe('run listing is not swallowed by the id route', () => {
    it('answers a run listing rather than 404-ing on a project called "runs"', async () => {
      const projectId = await openProject();
      // Written straight to the database so this test is about routing and nothing else — the
      // engine is not involved in a GET.
      await ctx.fake.client.researchRun.create({ data: { projectId, status: 'queued' } });

      const res = await request(ctx.app)
        .get(`/api/research/runs?projectId=${projectId}`)
        .set('Cookie', ctx.cookie);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0].status).toBe('queued');
    });

    it('refuses a run listing with no projectId', async () => {
      const res = await request(ctx.app).get('/api/research/runs').set('Cookie', ctx.cookie);
      expect(res.status).toBe(400);
    });
  });

  describe('starting a run', () => {
    it('refuses a project with no agent when the request names no model', async () => {
      const projectId = await openProject();

      const res = await request(ctx.app)
        .post(`/api/research/${projectId}/runs`)
        .set('Cookie', ctx.cookie)
        .send({});

      expect(res.status).toBe(400);
    });

    it('starts a run when the request names a model', async () => {
      const projectId = await openProject();

      const res = await request(ctx.app)
        .post(`/api/research/${projectId}/runs`)
        .set('Cookie', ctx.cookie)
        .send({ modelId: 'mdl_research' });

      expect(res.status).toBe(201);
      expect(res.body.run.status).toBe('running');
      expect(res.body.run.projectId).toBe(projectId);
      expect(res.body.run.runId).not.toBeNull();
    });

    it('refuses to start a run when the deployment has no search provider', async () => {
      // A second app, built from the unmodified environment where `SEARCH_PROVIDER` defaults to
      // `none`. Research's second step is a search, so a run started without one would create two
      // rows and a queue job and then fail — and the failure would read as a bug in research rather
      // than as a missing key.
      const bare = loadConfig();
      const fake = createFakeDb();
      const app = createApp({
        config: bare,
        logger: createLogger(bare),
        db: fake.client,
        queueStatus: () => 'not_initialized',
        version: '0.1.0-test',
      });

      const signup = await request(app)
        .post('/api/auth/signup')
        .send({ email: `bare-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Ada' });
      const raw = signup.headers['set-cookie'];
      const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
      const access = cookies.find((cookie) => cookie.startsWith(`${COOKIE_ACCESS}=`));
      const cookie = access!.split(';')[0]!;

      const project = await request(app)
        .post('/api/research')
        .set('Cookie', cookie)
        .send({ title: 't', question: 'q' });

      const res = await request(app)
        .post(`/api/research/${project.body.project.id}/runs`)
        .set('Cookie', cookie)
        .send({ modelId: 'mdl_research' });

      // 404 is this API's `FEATURE_DISABLED`, and the message names what to set.
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('FEATURE_DISABLED');
      expect(res.body.error.message).toContain('SEARCH_PROVIDER');

      await fake.client.$disconnect();
    });
  });

  describe('evidence', () => {
    async function startedRun(): Promise<string> {
      const projectId = await openProject();
      const res = await request(ctx.app)
        .post(`/api/research/${projectId}/runs`)
        .set('Cookie', ctx.cookie)
        .send({ modelId: 'mdl_research' });
      return res.body.run.id as string;
    }

    it('records a source, a cited finding, and finishes the run', async () => {
      const runId = await startedRun();

      const source = await request(ctx.app)
        .post(`/api/research/runs/${runId}/sources`)
        .set('Cookie', ctx.cookie)
        .send({ url: 'https://example.test/report', title: 'Q3 report' });
      expect(source.status).toBe(201);

      const finding = await request(ctx.app)
        .post(`/api/research/runs/${runId}/findings`)
        .set('Cookie', ctx.cookie)
        .send({
          claim: 'Vendor A disclosed a breach',
          verified: true,
          sourceIds: [source.body.source.id],
        });
      expect(finding.status).toBe(201);
      expect(finding.body.finding.verified).toBe(true);

      const finished = await request(ctx.app)
        .post(`/api/research/runs/${runId}/finish`)
        .set('Cookie', ctx.cookie)
        .send({ status: 'completed', result: { summary: 'one vendor affected' } });
      expect(finished.status).toBe(200);
      expect(finished.body.run.status).toBe('completed');
      // The evidence comes back with the run, so the Research page has provenance in one read.
      expect(finished.body.run.sources).toHaveLength(1);
      expect(finished.body.run.findings).toHaveLength(1);
    });

    it('refuses a finding that cites a source the run never recorded', async () => {
      const runId = await startedRun();

      const res = await request(ctx.app)
        .post(`/api/research/runs/${runId}/findings`)
        .set('Cookie', ctx.cookie)
        .send({ claim: 'unsupported', sourceIds: ['src_invented'] });

      expect(res.status).toBe(400);
    });

    it('refuses a terminal status that is not terminal', async () => {
      const runId = await startedRun();

      // `running` is not a caller's to set — it is what starting a run means, and accepting it
      // here would let a client walk a finished run backwards.
      const res = await request(ctx.app)
        .post(`/api/research/runs/${runId}/finish`)
        .set('Cookie', ctx.cookie)
        .send({ status: 'running' });

      expect(res.status).toBe(400);
    });
  });

  describe('validation', () => {
    it('rejects a project with no question', async () => {
      const res = await request(ctx.app)
        .post('/api/research')
        .set('Cookie', ctx.cookie)
        .send({ title: 'x' });

      expect(res.status).toBe(400);
    });

    it('rejects an unknown field rather than ignoring it', async () => {
      const res = await request(ctx.app)
        .post('/api/research')
        .set('Cookie', ctx.cookie)
        .send({ title: 'x', question: 'y', tenantId: 'somebody-else' });

      expect(res.status).toBe(400);
    });
  });

  describe('tenant isolation over HTTP', () => {
    it('does not expose one tenant\'s project to another', async () => {
      const id = await openProject('private project');

      const other = await request(ctx.app)
        .post('/api/auth/signup')
        .send({ email: `other-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Grace' });
      const raw = other.headers['set-cookie'];
      const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
      const otherCookie = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`))!.split(';')[0]!;

      await expect(
        request(ctx.app).get(`/api/research/${id}`).set('Cookie', otherCookie),
      ).resolves.toMatchObject({ status: 404 });

      const listed = await request(ctx.app).get('/api/research').set('Cookie', otherCookie);
      expect(listed.body.total).toBe(0);
    });
  });
});
