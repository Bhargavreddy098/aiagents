import request from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_ACCESS } from '@nexs/shared';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * `/api/connectors` as a client sees it, and the acceptance criterion the spec names for it.
 *
 * > *"GitHub connector with token → capability discovery lists actions."*
 *
 * ## What these tests are actually proving
 *
 * Not the adapter's internals — those are pure functions of (config, credentials, args) and are
 * covered by construction. What is proved here is that the **whole chain** holds:
 * HTTP → service → adapter → `fetch` → a real socket → a `Tool` row → `/api/tools` → invocation.
 *
 * The vendor is a **real local HTTP server**, not a stubbed `fetch`. That choice matters more here
 * than anywhere else in this suite: stubbing `fetch` would skip the adapter, and the adapter is
 * where the credential is attached, where the path template is filled, and where a non-2xx is
 * turned into `isError` rather than a throw. A stub would prove the service calls something. This
 * proves the request that went out was the request that should have.
 *
 * The one rule every test re-checks is that **the token never comes back**. The assertions look at
 * `JSON.stringify(body)` rather than at named fields, because the failure being guarded against is
 * a field nobody thought to check.
 */

const config = loadConfig();
const VALID_PASSWORD = 'correct horse battery staple';
const GITHUB_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

/** How many actions `GitHubConnectorAdapter` declares. Asserted, not imported, so a change shows up here. */
const GITHUB_ACTION_COUNT = 8;

interface FakeVendor {
  url: string;
  requests: Array<{ method: string; url: string; authorization: string | null; body: string }>;
  close: () => Promise<void>;
}

/**
 * A stand-in for a vendor's API.
 *
 * Answers the GitHub endpoints the adapter calls and a small generic REST surface, so one server
 * serves both adapters. `authorization` is recorded per request rather than checked globally: the
 * assertion that matters is that the *right* requests carried the credential.
 */
async function startVendor(): Promise<FakeVendor> {
  const requests: FakeVendor['requests'] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '/';
      requests.push({
        method: req.method ?? 'GET',
        url,
        authorization: (req.headers.authorization as string | undefined) ?? null,
        body,
      });

      const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };

      // Route on the pathname, not the raw URL: a GET action's arguments arrive as a query string,
      // so `/widgets?limit=5` and `/widgets` are the same endpoint. Matching on `url` exactly would
      // 404 every request that carried an argument — which is how this fixture was written first,
      // and it produced a `false` where the test expected `true`.
      const path = url.split('?')[0] ?? '/';

      // ── GitHub ──────────────────────────────────────────────────────────────
      if (path === '/user') {
        if (req.headers.authorization === undefined) {
          json(401, { message: 'Bad credentials' });
          return;
        }
        // `x-oauth-scopes` is the only place GitHub reports scopes, which is why `connect` reads
        // response headers rather than going through `sendJson`.
        json(200, { login: 'octocat', name: 'The Octocat' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      if (path.startsWith('/repos/')) {
        if (req.method === 'GET') {
          json(200, { full_name: 'octocat/hello-world' });
          return;
        }
        if (req.method === 'POST') {
          json(201, { number: 1, title: 'from the test' });
          return;
        }
      }

      // ── generic REST ────────────────────────────────────────────────────────
      if (path === '/widgets' && req.method === 'GET') {
        json(200, { widgets: ['a', 'b'] });
        return;
      }
      if (path === '/widgets' && req.method === 'POST') {
        json(201, { created: true, received: body === '' ? null : JSON.parse(body) });
        return;
      }
      if (path === '/broken') {
        json(500, { message: 'vendor exploded' });
        return;
      }

      json(404, { message: 'Not Found' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
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
    .send({ email: `connectors-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Ada' });

  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const access = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`));
  if (access === undefined) throw new Error('signup did not set an access cookie');

  return { app, fake, cookie: access.split(';')[0]! };
}

/** The `rest` action set used by most tests: one read and one write, so the split is visible. */
function restActions() {
  return [
    { action: 'list_widgets', name: 'List widgets', method: 'GET', path: '/widgets' },
    { action: 'create_widget', name: 'Create widget', method: 'POST', path: '/widgets' },
  ];
}

describe('/api/connectors', () => {
  let ctx: Ctx;
  let vendor: FakeVendor;

  beforeEach(async () => {
    ctx = await build();
    vendor = await startVendor();
  });

  afterEach(async () => {
    await vendor.close();
  });

  // ── auth ────────────────────────────────────────────────────────────────────

  describe('authentication', () => {
    it('refuses every route without a session', async () => {
      await expect(request(ctx.app).get('/api/connectors')).resolves.toMatchObject({ status: 401 });
      await expect(
        request(ctx.app).post('/api/connectors').send({ type: 'github', name: 'x' }),
      ).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).get('/api/connectors/cnn_1')).resolves.toMatchObject({
        status: 401,
      });
      await expect(
        request(ctx.app).patch('/api/connectors/cnn_1').send({ name: 'x' }),
      ).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).delete('/api/connectors/cnn_1')).resolves.toMatchObject({
        status: 401,
      });
      await expect(request(ctx.app).get('/api/connectors/cnn_1/accounts')).resolves.toMatchObject({
        status: 401,
      });
      await expect(
        request(ctx.app).post('/api/connectors/cnn_1/accounts').send({ label: 'x' }),
      ).resolves.toMatchObject({ status: 401 });
      await expect(
        request(ctx.app).delete('/api/connectors/cnn_1/accounts/acc_1'),
      ).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).post('/api/connectors/cnn_1/test')).resolves.toMatchObject({
        status: 401,
      });
    });
  });

  // ── the acceptance criterion ────────────────────────────────────────────────

  describe('a GitHub connector with a token', () => {
    it('discovers its actions, registers them as tools, and never returns the token', async () => {
      const res = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'github',
          name: 'GitHub',
          token: GITHUB_TOKEN,
          // Pointing the adapter at the local vendor is the GitHub Enterprise path, so this also
          // proves `config.baseUrl` overrides the default rather than being decoration.
          config: { baseUrl: vendor.url },
        });

      expect(res.status).toBe(201);

      // ── the criterion ──
      expect(res.body.test.ok).toBe(true);
      expect(res.body.test.status).toBe('connected');
      expect(res.body.test.discovered).toBe(GITHUB_ACTION_COUNT);
      expect(res.body.test.registered).toBe(GITHUB_ACTION_COUNT);

      const actions = res.body.connector.capabilities.map((c: { action: string }) => c.action);
      expect(actions).toContain('create_issue');
      expect(actions).toContain('get_repo');

      // ── the rule ──
      expect(JSON.stringify(res.body)).not.toContain(GITHUB_TOKEN);
      expect(JSON.stringify(res.body)).not.toContain('ghp_');
      expect(res.body.connector).not.toHaveProperty('credentialId');

      // ── identity, learned from the vendor rather than invented ──
      expect(res.body.connector.status).toBe('connected');

      // ── the probe asked for exactly one thing ──
      expect(vendor.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /user']);
      expect(vendor.requests[0]!.authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
    });

    it('records the scopes the vendor reported on the account', async () => {
      const created = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'github',
          name: 'GitHub',
          token: GITHUB_TOKEN,
          config: { baseUrl: vendor.url },
        });

      const account = await request(ctx.app)
        .post(`/api/connectors/${created.body.connector.id}/accounts`)
        .set('Cookie', ctx.cookie)
        .send({ label: 'octocat', token: GITHUB_TOKEN });

      expect(account.status).toBe(201);
      // No credential of its own is exposed; only whether one is attached.
      expect(account.body.account.hasCredential).toBe(true);
      expect(JSON.stringify(account.body)).not.toContain(GITHUB_TOKEN);

      const probed = await request(ctx.app)
        .post(`/api/connectors/${created.body.connector.id}/test`)
        .set('Cookie', ctx.cookie);

      expect(probed.body.test.ok).toBe(true);

      const accounts = await request(ctx.app)
        .get(`/api/connectors/${created.body.connector.id}/accounts`)
        .set('Cookie', ctx.cookie);

      expect(accounts.body.accounts[0]).toMatchObject({
        accountId: 'octocat',
        scopes: ['repo', 'read:org'],
      });
    });

    it('exposes the discovered actions as canonical connector tools', async () => {
      const created = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'github',
          name: 'GitHub',
          token: GITHUB_TOKEN,
          config: { baseUrl: vendor.url },
        });

      const connectorId = created.body.connector.id as string;
      const tools = await request(ctx.app).get('/api/tools?type=connector').set('Cookie', ctx.cookie);

      expect(tools.status).toBe(200);
      const connectorTools = tools.body.tools.filter(
        (t: { source: string }) => t.source === `connector:${connectorId}`,
      );
      expect(connectorTools).toHaveLength(GITHUB_ACTION_COUNT);
      expect(connectorTools.every((t: { type: string }) => t.type === 'connector')).toBe(true);
      expect(connectorTools.every((t: { provider: string }) => t.provider === connectorId)).toBe(
        true,
      );

      // `create_issue` writes, so it must be classified as such — that is what puts it under the
      // approval policy.
      const createIssue = connectorTools.find(
        (t: { name: string }) => t.name.includes('create_issue'),
      );
      expect(createIssue.capabilities).toContain('external_side_effect');

      // …and the capability reports the tool it became, so the UI can link the two.
      const detail = await request(ctx.app)
        .get(`/api/connectors/${connectorId}`)
        .set('Cookie', ctx.cookie);
      const capability = detail.body.connector.capabilities.find(
        (c: { action: string }) => c.action === 'create_issue',
      );
      expect(capability.toolId).toBe(createIssue.id);
    });
  });

  // ── refusals at creation ────────────────────────────────────────────────────

  describe('refusing a connector that cannot work', () => {
    it('refuses a type with no adapter, naming the ones that exist', async () => {
      const res = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({ type: 'slack', name: 'Slack' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(res.body.error.details.implemented).toEqual(['github', 'rest']);
    });

    it('refuses a rest connector with no base URL', async () => {
      const res = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({ type: 'rest', name: 'Widgets', config: { actions: restActions() } });

      expect(res.status).toBe(400);
    });

    it('refuses a rest connector with no actions, because it would have nothing to do', async () => {
      const res = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({ type: 'rest', name: 'Widgets', config: { baseUrl: vendor.url } });

      expect(res.status).toBe(400);
    });

    it('refuses an action whose path is an absolute URL', async () => {
      const res = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'rest',
          name: 'Widgets',
          config: {
            baseUrl: vendor.url,
            actions: [
              { action: 'steal', name: 'Steal', method: 'GET', path: 'https://evil.example/x' },
            ],
          },
        });

      expect(res.status).toBe(400);
    });

    it('refuses a type the schema does not know at all', async () => {
      const res = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({ type: 'smtp', name: 'Mail' });

      expect(res.status).toBe(400);
    });
  });

  // ── a failed probe is not a failed create ───────────────────────────────────

  describe('when the vendor is unreachable', () => {
    it('still creates the connector, and reports the failure on it', async () => {
      // Port 1 is reserved and nothing listens there.
      const res = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'github',
          name: 'GitHub',
          token: GITHUB_TOKEN,
          config: { baseUrl: 'http://127.0.0.1:1' },
        });

      expect(res.status).toBe(201);
      expect(res.body.connector.id).toBeDefined();
      expect(res.body.test.ok).toBe(false);
      expect(res.body.test.status).toBe('error');
      expect(res.body.test.error).toBeTruthy();
      // The failure is on the row, so a later page load can show it without re-probing.
      expect(res.body.connector.status).toBe('error');
      expect(res.body.connector.lastError).toBeTruthy();
      expect(JSON.stringify(res.body)).not.toContain(GITHUB_TOKEN);
    });

    it('reports a rejected credential as the vendor described it', async () => {
      // No `authorization` is sent when the connector has no token, and the vendor answers 401.
      const created = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({ type: 'github', name: 'GitHub', config: { baseUrl: vendor.url } });

      const probed = await request(ctx.app)
        .post(`/api/connectors/${created.body.connector.id}/test`)
        .set('Cookie', ctx.cookie);

      expect(probed.status).toBe(200);
      expect(probed.body.test.ok).toBe(false);
      expect(probed.body.test.error).toContain('Bad credentials');
    });
  });

  // ── the generic rest adapter ────────────────────────────────────────────────

  describe('a config-driven rest connector', () => {
    async function createRest(): Promise<string> {
      const res = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'rest',
          name: 'Widgets',
          config: { baseUrl: vendor.url, actions: restActions() },
        });

      expect(res.status).toBe(201);
      return res.body.connector.id as string;
    }

    it('derives its side-effect classification from the HTTP method', async () => {
      const id = await createRest();

      const detail = await request(ctx.app)
        .get(`/api/connectors/${id}`)
        .set('Cookie', ctx.cookie);

      const byAction = Object.fromEntries(
        detail.body.connector.capabilities.map((c: { action: string; capabilities: string[] }) => [
          c.action,
          c.capabilities,
        ]),
      );

      // A GET is read-only because that is what a GET means. A POST is not, because a POST is a
      // write — and defaulting it to `read_only` would take it out of the approval policy.
      expect(byAction.list_widgets).toEqual(['read_only']);
      expect(byAction.create_widget).toEqual(['external_side_effect']);
    });

    it('derives the arguments it can prove from the path template', async () => {
      const res = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'rest',
          name: 'Widgets',
          config: {
            baseUrl: vendor.url,
            actions: [
              { action: 'get_widget', name: 'Get widget', method: 'GET', path: '/widgets/{id}' },
            ],
          },
        });

      const capability = res.body.connector.capabilities[0];
      // The placeholder is the only argument the adapter can *prove* is required, so it is the only
      // one it claims. `additionalProperties` stays open rather than inventing a closed set.
      expect(capability.inputSchema).toMatchObject({
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      });
    });

    it('runs a read-only action through the tool endpoint', async () => {
      const id = await createRest();
      const detail = await request(ctx.app)
        .get(`/api/connectors/${id}`)
        .set('Cookie', ctx.cookie);
      const toolId = detail.body.connector.capabilities.find(
        (c: { action: string }) => c.action === 'list_widgets',
      ).toolId as string;

      const res = await request(ctx.app)
        .post(`/api/tools/${toolId}/invoke`)
        .set('Cookie', ctx.cookie)
        .send({ args: { limit: 5 } });

      expect(res.status).toBe(200);
      expect(res.body.invocation.ok).toBe(true);
      expect(res.body.invocation.sideEffect).toBe(false);
      // The argument reached the URL, which is where a GET's arguments belong.
      expect(vendor.requests.some((r) => r.url === '/widgets?limit=5')).toBe(true);
    });

    it('refuses a side-effecting action without confirmation, and sends nothing', async () => {
      const id = await createRest();
      const detail = await request(ctx.app)
        .get(`/api/connectors/${id}`)
        .set('Cookie', ctx.cookie);
      const toolId = detail.body.connector.capabilities.find(
        (c: { action: string }) => c.action === 'create_widget',
      ).toolId as string;

      const before = vendor.requests.length;

      const res = await request(ctx.app)
        .post(`/api/tools/${toolId}/invoke`)
        .set('Cookie', ctx.cookie)
        .send({ args: { name: 'nope' } });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      // The assertion that matters: not one request left the process.
      expect(vendor.requests.length).toBe(before);
    });

    it('runs it once confirmation is given, and the vendor receives the body', async () => {
      const id = await createRest();
      const detail = await request(ctx.app)
        .get(`/api/connectors/${id}`)
        .set('Cookie', ctx.cookie);
      const toolId = detail.body.connector.capabilities.find(
        (c: { action: string }) => c.action === 'create_widget',
      ).toolId as string;

      const res = await request(ctx.app)
        .post(`/api/tools/${toolId}/invoke`)
        .set('Cookie', ctx.cookie)
        .send({ args: { name: 'gadget' }, confirmSideEffects: true });

      expect(res.status).toBe(200);
      expect(res.body.invocation.ok).toBe(true);
      expect(res.body.invocation.sideEffect).toBe(true);

      const posted = vendor.requests.find((r) => r.method === 'POST' && r.url === '/widgets');
      expect(posted).toBeDefined();
      expect(JSON.parse(posted!.body)).toEqual({ name: 'gadget' });
    });

    it('reports a vendor error as a result rather than as a transport failure', async () => {
      const res = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'rest',
          name: 'Widgets',
          config: {
            baseUrl: vendor.url,
            actions: [{ action: 'explode', name: 'Explode', method: 'GET', path: '/broken' }],
          },
        });

      const toolId = res.body.connector.capabilities[0].toolId as string;
      const invoked = await request(ctx.app)
        .post(`/api/tools/${toolId}/invoke`)
        .set('Cookie', ctx.cookie)
        .send({ args: {} });

      // 200 with `ok: false`: the call happened and the vendor answered. Throwing here would
      // collapse "the vendor said 500" into "we never reached the vendor".
      expect(invoked.status).toBe(200);
      expect(invoked.body.invocation.ok).toBe(false);
    });

    it('disables the tool of an action the connector stopped declaring', async () => {
      const created = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'rest',
          name: 'Widgets',
          config: { baseUrl: vendor.url, actions: restActions() },
        });

      const id = created.body.connector.id as string;
      const before = await request(ctx.app).get(`/api/connectors/${id}`).set('Cookie', ctx.cookie);
      const removedToolId = before.body.connector.capabilities.find(
        (c: { action: string }) => c.action === 'create_widget',
      ).toolId as string;

      // Drop `create_widget` from the declared actions, then re-probe.
      await request(ctx.app)
        .patch(`/api/connectors/${id}`)
        .set('Cookie', ctx.cookie)
        .send({
          config: {
            baseUrl: vendor.url,
            actions: [
              { action: 'list_widgets', name: 'List widgets', method: 'GET', path: '/widgets' },
            ],
          },
        });

      const reTested = await request(ctx.app)
        .post(`/api/connectors/${id}/test`)
        .set('Cookie', ctx.cookie);
      expect(reTested.body.test.discovered).toBe(1);

      const tools = await request(ctx.app).get('/api/tools?type=connector').set('Cookie', ctx.cookie);
      const removed = tools.body.tools.find((t: { id: string }) => t.id === removedToolId);

      // Disabled rather than deleted: a run that already referenced it must still render its
      // history, and re-adding the action flips it straight back through `upsert`.
      expect(removed.status).toBe('disabled');

      // …and a disabled tool cannot be invoked. 422 rather than 403: the tool is not forbidden to
      // this caller, it is unavailable — `UNSUPPORTED_CAPABILITY` is what the invoker raises for a
      // tool whose status is not `enabled`.
      const invoked = await request(ctx.app)
        .post(`/api/tools/${removedToolId}/invoke`)
        .set('Cookie', ctx.cookie)
        .send({ args: {} });
      expect(invoked.status).toBe(422);
      expect(invoked.body.error.code).toBe('UNSUPPORTED_CAPABILITY');
    });
  });

  // ── the asymmetric capability rule ──────────────────────────────────────────

  describe('a connector that claims an action became harmless', () => {
    it('keeps the recorded capabilities instead of widening', async () => {
      const created = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'rest',
          name: 'Widgets',
          config: { baseUrl: vendor.url, actions: restActions() },
        });

      const id = created.body.connector.id as string;
      const before = await request(ctx.app).get(`/api/connectors/${id}`).set('Cookie', ctx.cookie);
      const toolId = before.body.connector.capabilities.find(
        (c: { action: string }) => c.action === 'create_widget',
      ).toolId as string;

      // Re-declare the POST as read-only, which is what would remove its approval gate.
      const patched = await request(ctx.app)
        .patch(`/api/connectors/${id}`)
        .set('Cookie', ctx.cookie)
        .send({
          config: {
            baseUrl: vendor.url,
            actions: [
              { action: 'list_widgets', name: 'List widgets', method: 'GET', path: '/widgets' },
              {
                action: 'create_widget',
                name: 'Create widget',
                method: 'POST',
                path: '/widgets',
                capabilities: ['read_only'],
              },
            ],
          },
        });

      expect(patched.status).toBe(200);

      const reTested = await request(ctx.app)
        .post(`/api/connectors/${id}/test`)
        .set('Cookie', ctx.cookie);
      expect(reTested.body.test.ok).toBe(true);

      const tools = await request(ctx.app).get('/api/tools?type=connector').set('Cookie', ctx.cookie);
      const tool = tools.body.tools.find((t: { id: string }) => t.id === toolId);

      // The claim was refused, so the tool is still side-effecting and still gated.
      expect(tool.capabilities).toContain('external_side_effect');
      expect(tool.capabilities).not.toEqual(['read_only']);
    });
  });

  // ── accounts ────────────────────────────────────────────────────────────────

  describe('accounts', () => {
    it('adds, lists and removes an account', async () => {
      const created = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'rest',
          name: 'Widgets',
          token: 'connector-level-token-value',
          config: { baseUrl: vendor.url, actions: restActions() },
        });

      const id = created.body.connector.id as string;

      const added = await request(ctx.app)
        .post(`/api/connectors/${id}/accounts`)
        .set('Cookie', ctx.cookie)
        .send({ label: 'primary', accountId: 'acct-1', scopes: ['widgets:read'] });

      expect(added.status).toBe(201);
      expect(added.body.account).toMatchObject({
        label: 'primary',
        accountId: 'acct-1',
        scopes: ['widgets:read'],
        hasCredential: false,
      });

      const listed = await request(ctx.app)
        .get(`/api/connectors/${id}/accounts`)
        .set('Cookie', ctx.cookie);
      expect(listed.body.accounts).toHaveLength(1);

      const removed = await request(ctx.app)
        .delete(`/api/connectors/${id}/accounts/${added.body.account.id}`)
        .set('Cookie', ctx.cookie);
      expect(removed.status).toBe(204);

      const after = await request(ctx.app)
        .get(`/api/connectors/${id}/accounts`)
        .set('Cookie', ctx.cookie);
      expect(after.body.accounts).toHaveLength(0);
    });

    it('refuses to remove the only credential a connector has', async () => {
      // No connector-level token, so the account's own credential is the only one there is.
      const created = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'rest',
          name: 'Widgets',
          config: { baseUrl: vendor.url, actions: restActions() },
        });

      const id = created.body.connector.id as string;
      const added = await request(ctx.app)
        .post(`/api/connectors/${id}/accounts`)
        .set('Cookie', ctx.cookie)
        .send({ label: 'primary', token: 'an-account-level-token-value' });

      const res = await request(ctx.app)
        .delete(`/api/connectors/${id}/accounts/${added.body.account.id}`)
        .set('Cookie', ctx.cookie);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('reports the account count on the connector', async () => {
      const created = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'rest',
          name: 'Widgets',
          config: { baseUrl: vendor.url, actions: restActions() },
        });

      const id = created.body.connector.id as string;
      await request(ctx.app)
        .post(`/api/connectors/${id}/accounts`)
        .set('Cookie', ctx.cookie)
        .send({ label: 'one' });
      await request(ctx.app)
        .post(`/api/connectors/${id}/accounts`)
        .set('Cookie', ctx.cookie)
        .send({ label: 'two' });

      const list = await request(ctx.app).get('/api/connectors').set('Cookie', ctx.cookie);
      expect(list.body.connectors[0].accountCount).toBe(2);
    });
  });

  // ── rotation ────────────────────────────────────────────────────────────────

  describe('rotating a credential', () => {
    it('repoints the reference, keeps the old record, and clears the last failure', async () => {
      const created = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'github',
          name: 'GitHub',
          token: GITHUB_TOKEN,
          config: { baseUrl: 'http://127.0.0.1:1' },
        });

      expect(created.body.connector.lastError).toBeTruthy();

      const rotated = await request(ctx.app)
        .patch(`/api/connectors/${created.body.connector.id}`)
        .set('Cookie', ctx.cookie)
        .send({ token: 'ghp_a-completely-different-token-value', config: { baseUrl: vendor.url } });

      expect(rotated.status).toBe(200);
      // A rotation clears the failure, because it described the *previous* credential.
      expect(rotated.body.connector.lastError).toBeNull();
      expect(JSON.stringify(rotated.body)).not.toContain('ghp_');

      // Two credential rows: the old one is the record of what was in use.
      expect(ctx.fake.tables.credential!.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── isolation and 404s ──────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('does not show one tenant a connector belonging to another', async () => {
      const mine = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'rest',
          name: 'Widgets',
          config: { baseUrl: vendor.url, actions: restActions() },
        });

      const other = await build();
      const id = mine.body.connector.id as string;

      await expect(
        request(other.app).get(`/api/connectors/${id}`).set('Cookie', other.cookie),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(other.app).patch(`/api/connectors/${id}`).set('Cookie', other.cookie).send({ name: 'x' }),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(other.app).delete(`/api/connectors/${id}`).set('Cookie', other.cookie),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(other.app).post(`/api/connectors/${id}/test`).set('Cookie', other.cookie),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(other.app).get(`/api/connectors/${id}/accounts`).set('Cookie', other.cookie),
      ).resolves.toMatchObject({ status: 404 });

      const theirs = await request(other.app).get('/api/connectors').set('Cookie', other.cookie);
      expect(theirs.body.connectors).toHaveLength(0);
    });

    it('does not let one tenant remove an account on another tenant’s connector', async () => {
      const mine = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'rest',
          name: 'Widgets',
          config: { baseUrl: vendor.url, actions: restActions() },
        });

      const id = mine.body.connector.id as string;
      const account = await request(ctx.app)
        .post(`/api/connectors/${id}/accounts`)
        .set('Cookie', ctx.cookie)
        .send({ label: 'primary' });

      const other = await build();
      await expect(
        request(other.app)
          .delete(`/api/connectors/${id}/accounts/${account.body.account.id}`)
          .set('Cookie', other.cookie),
      ).resolves.toMatchObject({ status: 404 });
    });
  });

  describe('unknown connectors', () => {
    it('answers 404 rather than an empty object', async () => {
      const missing = 'cnn_does_not_exist';
      await expect(request(ctx.app).get(`/api/connectors/${missing}`).set('Cookie', ctx.cookie)).resolves.toMatchObject({ status: 404 });
      await expect(request(ctx.app).patch(`/api/connectors/${missing}`).set('Cookie', ctx.cookie).send({ name: 'x' })).resolves.toMatchObject({ status: 404 });
      await expect(request(ctx.app).delete(`/api/connectors/${missing}`).set('Cookie', ctx.cookie)).resolves.toMatchObject({ status: 404 });
      await expect(request(ctx.app).post(`/api/connectors/${missing}/test`).set('Cookie', ctx.cookie)).resolves.toMatchObject({ status: 404 });
      await expect(request(ctx.app).get(`/api/connectors/${missing}/accounts`).set('Cookie', ctx.cookie)).resolves.toMatchObject({ status: 404 });
      await expect(request(ctx.app).post(`/api/connectors/${missing}/accounts`).set('Cookie', ctx.cookie).send({ label: 'x' })).resolves.toMatchObject({ status: 404 });
    });

    it('refuses an unknown field on create', async () => {
      const res = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({ type: 'github', name: 'GitHub', nonsense: true });

      expect(res.status).toBe(400);
    });

    it('refuses to change a connector’s type through a patch', async () => {
      const created = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({ type: 'github', name: 'GitHub', config: { baseUrl: vendor.url } });

      const res = await request(ctx.app)
        .patch(`/api/connectors/${created.body.connector.id}`)
        .set('Cookie', ctx.cookie)
        .send({ type: 'rest' });

      // A different type is a different server wearing the same row.
      expect(res.status).toBe(400);
    });
  });

  // ── deletion ────────────────────────────────────────────────────────────────

  describe('deleting a connector', () => {
    it('retires its tools and removes it', async () => {
      const created = await request(ctx.app)
        .post('/api/connectors')
        .set('Cookie', ctx.cookie)
        .send({
          type: 'rest',
          name: 'Widgets',
          config: { baseUrl: vendor.url, actions: restActions() },
        });

      const id = created.body.connector.id as string;

      const removed = await request(ctx.app)
        .delete(`/api/connectors/${id}`)
        .set('Cookie', ctx.cookie);
      expect(removed.status).toBe(204);

      await expect(
        request(ctx.app).get(`/api/connectors/${id}`).set('Cookie', ctx.cookie),
      ).resolves.toMatchObject({ status: 404 });

      // The tools are disabled, not deleted: a run that already referenced one must still render.
      const tools = await request(ctx.app).get('/api/tools?type=connector').set('Cookie', ctx.cookie);
      const mine = tools.body.tools.filter(
        (t: { source: string }) => t.source === `connector:${id}`,
      );
      expect(mine).toHaveLength(2);
      expect(mine.every((t: { status: string }) => t.status === 'disabled')).toBe(true);
    });
  });
});
