import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_ACCESS } from '@nexs/shared';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * `/api/memory` as a client sees it.
 *
 * The service tests prove the behaviour; this file proves the **wiring** — that the router is
 * mounted, that authentication is applied to the whole router rather than to some routes, that the
 * body schema is attached to the create verb, and above all that `/search` is declared before
 * `/:id`.
 *
 * That last one is not hypothetical. Express matches in declaration order, so a `GET /:id`
 * declared first captures `search` as an id and every search answers 404 "the memory does not
 * exist" — a failure that looks like missing data rather than like a routing bug, and that no
 * service test could catch because the service is never reached.
 */

const config = loadConfig();
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
    .send({ email: `memory-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Ada' });

  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const access = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`));
  if (access === undefined) throw new Error('signup did not set an access cookie');

  return { app, fake, cookie: access.split(';')[0]! };
}

describe('/api/memory', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await build();
  });

  describe('authentication', () => {
    it('refuses every memory route without a session', async () => {
      await expect(request(ctx.app).get('/api/memory')).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).post('/api/memory').send({ content: 'x' })).resolves.toMatchObject({
        status: 401,
      });
      await expect(request(ctx.app).get('/api/memory/search?q=x')).resolves.toMatchObject({
        status: 401,
      });
      await expect(request(ctx.app).get('/api/memory/mem_1')).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).delete('/api/memory/mem_1')).resolves.toMatchObject({
        status: 401,
      });
    });
  });

  describe('the create / read / delete round trip', () => {
    it('stores a memory and hands back its id', async () => {
      const res = await request(ctx.app)
        .post('/api/memory')
        .set('Cookie', ctx.cookie)
        .send({ content: 'the staging deploy key rotates on fridays' });

      expect(res.status).toBe(201);
      expect(res.body.memory).toMatchObject({
        content: 'the staging deploy key rotates on fridays',
        // No agent named, so it belongs to the workspace — the right default for something an
        // operator typed by hand.
        scope: 'tenant',
        agentId: null,
      });
      // No embedding model is configured in this test, so it is keyword-searchable only. Reported
      // rather than assumed.
      expect(res.body.memory.hasEmbedding).toBe(false);
    });

    it('lists it, reads it back, and deletes it', async () => {
      const created = await request(ctx.app)
        .post('/api/memory')
        .set('Cookie', ctx.cookie)
        .send({ content: 'remember me' });
      const id = created.body.memory.id as string;

      const listed = await request(ctx.app).get('/api/memory').set('Cookie', ctx.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body.total).toBe(1);
      expect(listed.body.memories[0].id).toBe(id);

      const fetched = await request(ctx.app).get(`/api/memory/${id}`).set('Cookie', ctx.cookie);
      expect(fetched.status).toBe(200);
      expect(fetched.body.memory.content).toBe('remember me');

      const removed = await request(ctx.app).delete(`/api/memory/${id}`).set('Cookie', ctx.cookie);
      expect(removed.status).toBe(204);

      const after = await request(ctx.app).get('/api/memory').set('Cookie', ctx.cookie);
      expect(after.body.total).toBe(0);
    });
  });

  describe('search is not swallowed by the id route', () => {
    it('answers a search rather than 404-ing on a memory called "search"', async () => {
      await request(ctx.app)
        .post('/api/memory')
        .set('Cookie', ctx.cookie)
        .send({ content: 'the office wifi password is hunter2' });
      await request(ctx.app)
        .post('/api/memory')
        .set('Cookie', ctx.cookie)
        .send({ content: 'something else entirely' });

      const res = await request(ctx.app)
        .get('/api/memory/search?q=wifi')
        .set('Cookie', ctx.cookie);

      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('keyword');
      expect(res.body.memories.map((memory: { content: string }) => memory.content)).toEqual([
        'the office wifi password is hunter2',
      ]);
      // A keyword hit has no similarity, and the wire says so rather than inventing a number.
      expect(res.body.memories[0].score).toBeNull();
    });

    it('refuses a search with no query', async () => {
      const res = await request(ctx.app).get('/api/memory/search').set('Cookie', ctx.cookie);

      expect(res.status).toBe(400);
    });
  });

  describe('validation', () => {
    it('rejects an empty memory rather than storing a row that recalls as noise', async () => {
      const res = await request(ctx.app)
        .post('/api/memory')
        .set('Cookie', ctx.cookie)
        .send({ content: '   ' });

      expect(res.status).toBe(400);
    });

    it('rejects a scope outside the vocabulary', async () => {
      const res = await request(ctx.app)
        .post('/api/memory')
        .set('Cookie', ctx.cookie)
        .send({ content: 'x', scope: 'permanent' });

      expect(res.status).toBe(400);
    });

    it('rejects an unknown field rather than ignoring it', async () => {
      const res = await request(ctx.app)
        .post('/api/memory')
        .set('Cookie', ctx.cookie)
        .send({ content: 'x', tenantId: 'somebody-else' });

      expect(res.status).toBe(400);
    });

    it('rejects an agentId and a workspace flag together', async () => {
      const res = await request(ctx.app)
        .get('/api/memory?agentId=agt_1&workspace=true')
        .set('Cookie', ctx.cookie);

      expect(res.status).toBe(400);
    });
  });

  describe('tenant isolation over HTTP', () => {
    it('does not expose one tenant\'s memory to another', async () => {
      const mine = await request(ctx.app)
        .post('/api/memory')
        .set('Cookie', ctx.cookie)
        .send({ content: 'private to this tenant' });
      const id = mine.body.memory.id as string;

      // A second tenant, with its own session.
      const other = await request(ctx.app)
        .post('/api/auth/signup')
        .send({ email: `other-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Grace' });
      const raw = other.headers['set-cookie'];
      const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
      const otherCookie = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`))!.split(';')[0]!;

      const fetched = await request(ctx.app).get(`/api/memory/${id}`).set('Cookie', otherCookie);
      expect(fetched.status).toBe(404);

      const listed = await request(ctx.app).get('/api/memory').set('Cookie', otherCookie);
      expect(listed.body.total).toBe(0);
    });
  });
});
