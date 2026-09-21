import request from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { COOKIE_ACCESS } from '@nexs/shared';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * `/api/providers` and `/api/models` as a client sees it.
 *
 * ## What these tests are actually proving
 *
 * The service-level behaviour is not the point here — it is that the **wiring** holds, and that the
 * two rules this surface exists to enforce survive the trip over HTTP:
 *
 *  1. **A key goes in and never comes out.** The assertions look at the *whole* response body for
 *     the plaintext key rather than at named fields, because the failure mode being guarded against
 *     is a field nobody thought to check.
 *  2. **A failed probe does not fail the create.** The row exists either way, and the response says
 *     what the probe found.
 *
 * The catalogue sync runs against a **local HTTP server started by the test**, not a stub. That is
 * deliberate: the discovery path goes gateway → adapter → `fetch`, and stubbing `fetch` would skip
 * the adapter — which is where the catalogue shape is actually parsed. A stub would prove the
 * service calls something; this proves the whole chain works against a real socket.
 */

const config = loadConfig();
const VALID_PASSWORD = 'correct horse battery staple';

interface FakeProvider {
  url: string;
  /** Requests the fake received, so a test can assert what was actually asked for. */
  requests: string[];
  close: () => Promise<void>;
}

/**
 * A stand-in for a provider's API.
 *
 * Answers `GET /v1/models` with a two-entry catalogue — one chat model and one embedding model —
 * so the type guess has something to get right and something to get *deliberately* different from
 * the default.
 */
async function startFakeProvider(): Promise<FakeProvider> {
  const requests: string[] = [];

  const server: Server = createServer((req, res) => {
    requests.push(`${req.method ?? 'GET'} ${req.url ?? '/'}`);

    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            { id: 'gpt-4o-2024-08-06', object: 'model', owned_by: 'openai' },
            { id: 'text-embedding-3-small', object: 'model', owned_by: 'openai' },
          ],
        }),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

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
    .send({ email: `providers-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Ada' });

  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const access = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`));
  if (access === undefined) throw new Error('signup did not set an access cookie');

  return { app, fake, cookie: access.split(';')[0]! };
}

describe('/api/providers and /api/models', () => {
  let ctx: Ctx;
  let provider: FakeProvider;

  beforeEach(async () => {
    ctx = await build();
    provider = await startFakeProvider();
  });

  afterEach(async () => {
    await provider.close();
  });

  describe('authentication', () => {
    it('refuses every route on both prefixes without a session', async () => {
      await expect(request(ctx.app).get('/api/providers')).resolves.toMatchObject({ status: 401 });
      await expect(
        request(ctx.app).post('/api/providers').send({ name: 'x', type: 'openai' }),
      ).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).get('/api/providers/pvd_1')).resolves.toMatchObject({
        status: 401,
      });
      await expect(request(ctx.app).post('/api/providers/pvd_1/test')).resolves.toMatchObject({
        status: 401,
      });
      await expect(request(ctx.app).post('/api/providers/pvd_1/sync')).resolves.toMatchObject({
        status: 401,
      });

      await expect(request(ctx.app).get('/api/models')).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).get('/api/models/mdl_1')).resolves.toMatchObject({ status: 401 });
      await expect(
        request(ctx.app).patch('/api/models/mdl_1').send({ enabled: false }),
      ).resolves.toMatchObject({ status: 401 });
    });
  });

  describe('adding a provider', () => {
    it('verifies and syncs against the provider, and never returns the key', async () => {
      const res = await request(ctx.app).post('/api/providers').set('Cookie', ctx.cookie).send({
        name: 'Local OpenAI',
        type: 'openai-compatible',
        baseUrl: provider.url,
        apiKey: 'sk-test-abcdefghijklmnop',
      });

      expect(res.status).toBe(201);
      expect(res.body.provider).toMatchObject({
        name: 'Local OpenAI',
        slug: 'local-openai',
        type: 'openai-compatible',
        enabled: true,
        hasCredential: true,
        // Masked: first four and last four, with the middle gone. This is the only trace of the
        // key that is allowed to exist on the wire.
        keyPrefix: 'sk-t…mnop',
      });

      // The probe ran and found the provider healthy, so the create also synced.
      expect(res.body.test).toMatchObject({ status: 'healthy', httpStatus: 200 });
      expect(res.body.sync).toMatchObject({ created: 2, existing: 0, total: 2, warning: null });

      // The row reflects what the verification wrote, not the state before it.
      expect(res.body.provider.modelCount).toBe(2);
      expect(res.body.provider.lastModelSync).not.toBeNull();

      // The whole body, not named fields — the failure being guarded against is a field nobody
      // thought to check.
      expect(JSON.stringify(res.body)).not.toContain('sk-test-abcdefghijklmnop');
      // And the credential id itself is a pointer, not a secret, but it should not be on the wire.
      expect(res.body.provider).not.toHaveProperty('apiKeyRef');
      expect(res.body.provider).not.toHaveProperty('metadata');
    });

    it('probes the models endpoint and nothing that would cost money', async () => {
      await request(ctx.app)
        .post('/api/providers')
        .set('Cookie', ctx.cookie)
        .send({ name: 'No Spend', type: 'openai-compatible', baseUrl: provider.url, apiKey: 'sk-abcdefghijklmnop' });

      // A health check that billed would be worse than no health check — see
      // `ProviderHealthService`. Both requests are catalogue reads.
      expect(provider.requests).toEqual(['GET /v1/models', 'GET /v1/models']);
      expect(provider.requests.some((r) => r.includes('chat/completions'))).toBe(false);
    });

    it('creates the row even when the provider is unreachable, and reports the failure', async () => {
      const res = await request(ctx.app)
        .post('/api/providers')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Nowhere',
          type: 'openai-compatible',
          // Port 1 is reserved and never listening, so this fails fast rather than hanging.
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'sk-abcdefghijklmnop',
        });

      // 201, not 5xx: the row is real, and an operator needs to see it and its error.
      expect(res.status).toBe(201);
      expect(res.body.test.status).toBe('error');
      expect(res.body.sync).toBeNull();
      expect(res.body.provider).toMatchObject({ name: 'Nowhere', status: 'error' });

      // `lastError` is lifted out of `metadata` rather than the blob being returned.
      expect(typeof res.body.provider.lastError).toBe('string');
      expect(res.body.provider).not.toHaveProperty('metadata');
    });

    it('accepts and creates a google (Gemini) provider', async () => {
      const res = await request(ctx.app)
        .post('/api/providers')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Gemini', type: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });

      expect(res.status).toBe(201);
      expect(res.body.provider.type).toBe('google');
      expect(res.body.provider.name).toBe('Gemini');
    });

    it('refuses a base URL that is not absolute http(s)', async () => {
      const res = await request(ctx.app)
        .post('/api/providers')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Typo', type: 'openai', baseUrl: 'api.openai.com' });

      expect(res.status).toBe(400);
    });

    it('refuses a duplicate slug rather than creating a second row', async () => {
      const body = { name: 'Twin', type: 'openai-compatible', baseUrl: provider.url };
      const first = await request(ctx.app).post('/api/providers').set('Cookie', ctx.cookie).send(body);
      expect(first.status).toBe(201);

      const second = await request(ctx.app).post('/api/providers').set('Cookie', ctx.cookie).send(body);
      expect(second.status).toBe(409);
    });
  });

  describe('syncing is additive', () => {
    it('does not overwrite a correction an operator made', async () => {
      const created = await request(ctx.app)
        .post('/api/providers')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Additive', type: 'openai-compatible', baseUrl: provider.url, apiKey: 'sk-abcdefghijklmnop' });
      const providerId = created.body.provider.id as string;

      const models = await request(ctx.app)
        .get(`/api/models?providerId=${providerId}`)
        .set('Cookie', ctx.cookie);
      const embedding = models.body.models.find(
        (m: { externalModelId: string }) => m.externalModelId === 'text-embedding-3-small',
      );
      expect(embedding.type).toBe('embedding');

      // The operator renames it and annotates it. Note that `type` is *not* in the body: the API
      // does not accept it (see `updateModelSchema`), so a correction to a guessed type is a
      // deliberate non-feature rather than something these tests should paper over.
      const patched = await request(ctx.app)
        .patch(`/api/models/${embedding.id}`)
        .set('Cookie', ctx.cookie)
        .send({ name: 'Our embedding model', capabilities: ['read_only'] });

      expect(patched.status).toBe(200);
      expect(patched.body.model.name).toBe('Our embedding model');
      expect(patched.body.model.capabilities).toEqual(['read_only']);
      expect(patched.body.model.type).toBe('embedding');

      // A second sync finds everything already present and changes nothing.
      const resynced = await request(ctx.app)
        .post(`/api/providers/${providerId}/sync`)
        .set('Cookie', ctx.cookie);
      expect(resynced.status).toBe(200);
      expect(resynced.body.sync).toMatchObject({ created: 0, existing: 2, total: 2 });

      const after = await request(ctx.app).get(`/api/models/${embedding.id}`).set('Cookie', ctx.cookie);
      expect(after.body.model.name).toBe('Our embedding model');
      expect(after.body.model.capabilities).toEqual(['read_only']);
    });

    it('warns when the provider answers with an empty catalogue', async () => {
      const empty = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
      });
      await new Promise<void>((resolve) => empty.listen(0, '127.0.0.1', resolve));
      const port = (empty.address() as AddressInfo).port;

      try {
        const created = await request(ctx.app)
          .post('/api/providers')
          .set('Cookie', ctx.cookie)
          .send({
            name: 'Empty Catalogue',
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: 'sk-abcdefghijklmnop',
          });

        expect(created.body.sync.warning).toContain('empty catalogue');
        expect(created.body.sync.total).toBe(0);
      } finally {
        await new Promise<void>((resolve) => empty.close(() => resolve()));
      }
    });
  });

  describe('the model catalogue', () => {
    it('guesses an embedding model from its id and leaves chat as the default', async () => {
      const created = await request(ctx.app)
        .post('/api/providers')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Types', type: 'openai-compatible', baseUrl: provider.url, apiKey: 'sk-abcdefghijklmnop' });

      const models = await request(ctx.app)
        .get(`/api/models?providerId=${created.body.provider.id}`)
        .set('Cookie', ctx.cookie);

      const byId = Object.fromEntries(
        models.body.models.map((m: { externalModelId: string; type: string }) => [m.externalModelId, m.type]),
      );
      expect(byId['gpt-4o-2024-08-06']).toBe('chat');
      expect(byId['text-embedding-3-small']).toBe('embedding');

      // Nothing invented. The catalogue endpoint does not state a context window, so the field is
      // null rather than a plausible-looking constant.
      for (const model of models.body.models) {
        expect(model.contextWindow).toBeNull();
        expect(model.capabilities).toEqual([]);
      }
    });

    it('refuses a model that falls back to itself', async () => {
      const created = await request(ctx.app)
        .post('/api/providers')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Chains', type: 'openai-compatible', baseUrl: provider.url, apiKey: 'sk-abcdefghijklmnop' });

      const models = await request(ctx.app)
        .get(`/api/models?providerId=${created.body.provider.id}`)
        .set('Cookie', ctx.cookie);
      const id = models.body.models[0].id as string;

      const res = await request(ctx.app)
        .patch(`/api/models/${id}`)
        .set('Cookie', ctx.cookie)
        .send({ fallbackOf: id });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('fall back to itself');
    });

    it('refuses a fallback that names a model which does not exist', async () => {
      const created = await request(ctx.app)
        .post('/api/providers')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Dangling', type: 'openai-compatible', baseUrl: provider.url, apiKey: 'sk-abcdefghijklmnop' });

      const models = await request(ctx.app)
        .get(`/api/models?providerId=${created.body.provider.id}`)
        .set('Cookie', ctx.cookie);
      const id = models.body.models[0].id as string;

      const res = await request(ctx.app)
        .patch(`/api/models/${id}`)
        .set('Cookie', ctx.cookie)
        .send({ fallbackOf: 'mdl_does_not_exist' });

      expect(res.status).toBe(400);
    });
  });

  describe('tenant isolation over HTTP', () => {
    it('does not expose one tenant\'s provider or models to another', async () => {
      const created = await request(ctx.app)
        .post('/api/providers')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Mine', type: 'openai-compatible', baseUrl: provider.url, apiKey: 'sk-abcdefghijklmnop' });
      const providerId = created.body.provider.id as string;

      const models = await request(ctx.app)
        .get(`/api/models?providerId=${providerId}`)
        .set('Cookie', ctx.cookie);
      const modelId = models.body.models[0].id as string;

      const other = await request(ctx.app)
        .post('/api/auth/signup')
        .send({ email: `other-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Grace' });
      const raw = other.headers['set-cookie'];
      const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
      const otherCookie = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`))!.split(';')[0]!;

      await expect(
        request(ctx.app).get(`/api/providers/${providerId}`).set('Cookie', otherCookie),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(ctx.app).get(`/api/models/${modelId}`).set('Cookie', otherCookie),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(ctx.app).patch(`/api/models/${modelId}`).set('Cookie', otherCookie).send({ enabled: false }),
      ).resolves.toMatchObject({ status: 404 });

      const listed = await request(ctx.app).get('/api/providers').set('Cookie', otherCookie);
      expect(listed.body.providers).toEqual([]);
    });
  });

  describe('removing a provider', () => {
    it('refuses while the catalogue still holds its models', async () => {
      const created = await request(ctx.app)
        .post('/api/providers')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Busy', type: 'openai-compatible', baseUrl: provider.url, apiKey: 'sk-abcdefghijklmnop' });

      const res = await request(ctx.app)
        .delete(`/api/providers/${created.body.provider.id}`)
        .set('Cookie', ctx.cookie);

      // A cascade would take the models with it — including any an agent is pinned to — so this is
      // a conflict with an instruction, not a 500 from a foreign-key violation.
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('Disable it instead');
    });

    it('removes a provider that has no models', async () => {
      const created = await request(ctx.app)
        .post('/api/providers')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Empty', type: 'openai-compatible', baseUrl: provider.url, verify: false });

      const res = await request(ctx.app)
        .delete(`/api/providers/${created.body.provider.id}`)
        .set('Cookie', ctx.cookie);
      expect(res.status).toBe(204);
    });
  });
});
