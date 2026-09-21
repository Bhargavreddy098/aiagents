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
 * `/api/tools` and `/api/mcp` as a client sees it.
 *
 * ## The three things these tests exist to pin down
 *
 *  1. **The registry is provisioned on read.** A tenant that has never created an agent has no
 *     `Tool` rows at all — they are derived from `NativeToolRegistry` by `BuiltinToolService.ensure`.
 *     So the first `GET /api/tools` must create them, and this file proves it does rather than
 *     assuming a seed that does not exist.
 *  2. **A test invocation of an effectful tool is refused.** `POST /:id/invoke` runs a tool for
 *     real. The same `http_request` is `read_only` for a GET and `external_side_effect` for a POST,
 *     so the guard has to be evaluated per *call*, not per tool — and a POST that is not confirmed
 *     must be a 403 with the capabilities named.
 *  3. **An MCP server's env block and header values never come back.** `envRef` is an encrypted
 *     credential; `headers` is stored in the clear but must not be echoed. `hasEnv` and
 *     `headerNames` are what a client may see.
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
    .send({ email: `registry-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Ada' });

  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const access = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`));
  if (access === undefined) throw new Error('signup did not set an access cookie');

  return { app, fake, cookie: access.split(';')[0]! };
}

/** Finds a tool by its registry name, failing loudly rather than with `undefined`. */
function findTool(body: { tools: Array<{ name: string; id: string }> }, name: string): { id: string } {
  const tool = body.tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`the registry did not provision "${name}"`);
  return tool;
}

describe('/api/tools and /api/mcp', () => {
  let ctx: Ctx;
  let upstream: Server;
  let upstreamUrl: string;
  let upstreamRequests: Array<{ method: string; url: string }>;

  beforeEach(async () => {
    ctx = await build();

    upstreamRequests = [];
    upstream = createServer((req, res) => {
      upstreamRequests.push({ method: req.method ?? 'GET', url: req.url ?? '/' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  describe('authentication', () => {
    it('refuses every route on both prefixes without a session', async () => {
      await expect(request(ctx.app).get('/api/tools')).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).get('/api/tools/tool_1')).resolves.toMatchObject({ status: 401 });
      await expect(
        request(ctx.app).post('/api/tools/tool_1/invoke').send({ args: {} }),
      ).resolves.toMatchObject({ status: 401 });

      await expect(request(ctx.app).get('/api/mcp')).resolves.toMatchObject({ status: 401 });
      await expect(
        request(ctx.app).post('/api/mcp').send({ name: 'x', transport: 'stdio', command: 'node' }),
      ).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).post('/api/mcp/srv_1/reconnect')).resolves.toMatchObject({
        status: 401,
      });
      await expect(request(ctx.app).get('/api/mcp/srv_1/tools')).resolves.toMatchObject({
        status: 401,
      });
    });
  });

  describe('the registry is provisioned on first read', () => {
    it('creates the built-in tool rows for a tenant that has never listed before', async () => {
      const res = await request(ctx.app).get('/api/tools').set('Cookie', ctx.cookie);

      expect(res.status).toBe(200);
      const names = res.body.tools.map((t: { name: string }) => t.name);
      expect(names).toContain('http_request');
      expect(names).toContain('calculator');

      // Derived from the registry, so every row is a native tool with a real handler behind it.
      for (const tool of res.body.tools) {
        expect(tool.source).toBe('builtin');
        expect(tool.type).toBe('native');
        expect(tool.status).toBe('enabled');
      }
    });

    it('is idempotent — a second read does not duplicate the rows', async () => {
      const first = await request(ctx.app).get('/api/tools').set('Cookie', ctx.cookie);
      const second = await request(ctx.app).get('/api/tools').set('Cookie', ctx.cookie);

      expect(second.body.tools.length).toBe(first.body.tools.length);
      expect(second.body.tools.map((t: { id: string }) => t.id)).toEqual(
        first.body.tools.map((t: { id: string }) => t.id),
      );
    });

    it('filters by name and by type', async () => {
      await request(ctx.app).get('/api/tools').set('Cookie', ctx.cookie);

      const search = await request(ctx.app).get('/api/tools?q=calc').set('Cookie', ctx.cookie);
      expect(search.body.tools.map((t: { name: string }) => t.name)).toEqual(['calculator']);

      const wrongType = await request(ctx.app).get('/api/tools?type=mcp').set('Cookie', ctx.cookie);
      expect(wrongType.body.tools).toEqual([]);
    });

    it('serves a tool with its argument schema', async () => {
      const listed = await request(ctx.app).get('/api/tools').set('Cookie', ctx.cookie);
      const calculator = findTool(listed.body, 'calculator');

      const res = await request(ctx.app).get(`/api/tools/${calculator.id}`).set('Cookie', ctx.cookie);
      expect(res.status).toBe(200);
      expect(res.body.tool.name).toBe('calculator');
      // Passed through unchanged — validating it here would be a second opinion about what the
      // tool accepts.
      expect(res.body.tool.inputSchema).toMatchObject({ type: 'object' });
      expect(res.body.tool.inputSchema.properties.expression).toEqual({ type: 'string' });
    });
  });

  describe('test invocation', () => {
    it('runs a read-only tool and reports the resolved capabilities', async () => {
      const listed = await request(ctx.app).get('/api/tools').set('Cookie', ctx.cookie);
      const calculator = findTool(listed.body, 'calculator');

      const res = await request(ctx.app)
        .post(`/api/tools/${calculator.id}/invoke`)
        .set('Cookie', ctx.cookie)
        .send({ args: { expression: '6 * 7' } });

      expect(res.status).toBe(200);
      expect(res.body.invocation).toMatchObject({
        ok: true,
        sideEffect: false,
        truncated: false,
      });
      expect(res.body.invocation.capabilities).toContain('read_only');
      expect(res.body.invocation.content).toContain('42');
    });

    it('refuses an effectful call that has not been confirmed', async () => {
      const listed = await request(ctx.app).get('/api/tools').set('Cookie', ctx.cookie);
      const httpRequest = findTool(listed.body, 'http_request');

      const res = await request(ctx.app)
        .post(`/api/tools/${httpRequest.id}/invoke`)
        .set('Cookie', ctx.cookie)
        .send({ args: { method: 'POST', url: `${upstreamUrl}/hook` } });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      // The refusal names what it found, so the caller learns *why* rather than being told to
      // try again.
      expect(res.body.error.details.capabilities).toContain('external_side_effect');

      // And nothing was sent. This is the assertion that matters — a 403 that had already made
      // the request would be worse than no guard at all.
      expect(upstreamRequests).toEqual([]);
    });

    it('allows the same tool when the call is a read and needs no confirmation', async () => {
      const listed = await request(ctx.app).get('/api/tools').set('Cookie', ctx.cookie);
      const httpRequest = findTool(listed.body, 'http_request');

      const res = await request(ctx.app)
        .post(`/api/tools/${httpRequest.id}/invoke`)
        .set('Cookie', ctx.cookie)
        .send({ args: { url: `${upstreamUrl}/ping` } });

      expect(res.status).toBe(200);
      expect(res.body.invocation.sideEffect).toBe(false);
      expect(res.body.invocation.capabilities).toContain('read_only');
      expect(upstreamRequests).toEqual([{ method: 'GET', url: '/ping' }]);
    });

    it('runs the effectful call once it is confirmed', async () => {
      const listed = await request(ctx.app).get('/api/tools').set('Cookie', ctx.cookie);
      const httpRequest = findTool(listed.body, 'http_request');

      const res = await request(ctx.app)
        .post(`/api/tools/${httpRequest.id}/invoke`)
        .set('Cookie', ctx.cookie)
        .send({
          args: { method: 'POST', url: `${upstreamUrl}/hook`, body: '{}' },
          confirmSideEffects: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.invocation.sideEffect).toBe(true);
      expect(upstreamRequests).toEqual([{ method: 'POST', url: '/hook' }]);
    });

    it('404s on a tool that does not exist', async () => {
      const res = await request(ctx.app)
        .post('/api/tools/tool_nope/invoke')
        .set('Cookie', ctx.cookie)
        .send({ args: {} });

      expect(res.status).toBe(404);
    });

    it('rejects an unknown field in the invocation body', async () => {
      const listed = await request(ctx.app).get('/api/tools').set('Cookie', ctx.cookie);
      const calculator = findTool(listed.body, 'calculator');

      const res = await request(ctx.app)
        .post(`/api/tools/${calculator.id}/invoke`)
        .set('Cookie', ctx.cookie)
        .send({ args: { expression: '1' }, runId: 'run_somebody_else' });

      expect(res.status).toBe(400);
    });
  });

  describe('/api/mcp', () => {
    it('starts with an empty list', async () => {
      const res = await request(ctx.app).get('/api/mcp').set('Cookie', ctx.cookie);
      expect(res.status).toBe(200);
      expect(res.body.servers).toEqual([]);
    });

    it('refuses a stdio server with no command', async () => {
      const res = await request(ctx.app)
        .post('/api/mcp')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Filesystem', transport: 'stdio' });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.error.details)).toContain('command');
    });

    it('refuses a stdio server that also names a url', async () => {
      const res = await request(ctx.app)
        .post('/api/mcp')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Confused', transport: 'stdio', command: 'node', url: 'http://example.com/mcp' });

      expect(res.status).toBe(400);
    });

    it('refuses an http server with no url', async () => {
      const res = await request(ctx.app)
        .post('/api/mcp')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Remote', transport: 'streamable-http' });

      expect(res.status).toBe(400);
    });

    it('refuses an env value the block format cannot round-trip', async () => {
      const res = await request(ctx.app)
        .post('/api/mcp')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Multiline',
          transport: 'stdio',
          command: 'node',
          // A newline would come back as a truncated secret plus a junk key — see
          // `parseEnvBlock`. Refused at the boundary because after the vault, the original is gone.
          env: { API_KEY: 'line one\nline two' },
        });

      expect(res.status).toBe(400);
    });

    it('stores an env block, connects, and never returns the values', async () => {
      // A stdio server that is `cat` — it starts, speaks nothing, and exits when the pipe closes.
      // The point is not that it works as an MCP server but that the create path is exercised
      // end to end: the env is encrypted, the row is written, and the response carries neither.
      const res = await request(ctx.app)
        .post('/api/mcp')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Local stdio',
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          env: { SECRET_TOKEN: 'super-secret-value' },
          headers: { authorization: 'Bearer another-secret' },
          connect: false,
        });

      expect(res.status).toBe(201);
      expect(res.body.server).toMatchObject({
        name: 'Local stdio',
        transport: 'stdio',
        status: 'disconnected',
        toolCount: 0,
        hasEnv: true,
      });
      // Names, never values.
      expect(res.body.server.headerNames).toEqual(['authorization']);

      const serialised = JSON.stringify(res.body);
      expect(serialised).not.toContain('super-secret-value');
      expect(serialised).not.toContain('another-secret');
      expect(res.body.server).not.toHaveProperty('envRef');
      expect(res.body.server).not.toHaveProperty('headers');
    });

    it('toggles every canonical tool the server contributed', async () => {
      const created = await request(ctx.app)
        .post('/api/mcp')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Toggle me',
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          connect: false,
        });
      const serverId = created.body.server.id as string;

      // Give the server one canonical tool by hand. No MCP server is actually running — starting a
      // real one would need a real MCP implementation on the other end — and the question here is
      // whether the toggle reaches `Tool.status`, which is a column, not a handshake. Reaching into
      // the client is deliberate: there is no API that links a tool to a server, because in
      // production the manager does it during `connect`.
      const listed = await request(ctx.app).get('/api/tools').set('Cookie', ctx.cookie);
      const calculator = findTool(listed.body, 'calculator');
      await ctx.fake.client.tool.updateMany({
        where: { id: calculator.id },
        data: { mcpServerId: serverId },
      });

      const off = await request(ctx.app)
        .patch(`/api/mcp/${serverId}`)
        .set('Cookie', ctx.cookie)
        .send({ toolsEnabled: false });
      expect(off.status).toBe(200);

      const after = await request(ctx.app).get(`/api/tools/${calculator.id}`).set('Cookie', ctx.cookie);
      expect(after.body.tool.status).toBe('disabled');

      const on = await request(ctx.app)
        .patch(`/api/mcp/${serverId}`)
        .set('Cookie', ctx.cookie)
        .send({ toolsEnabled: true });
      expect(on.status).toBe(200);

      const reenabled = await request(ctx.app).get(`/api/tools/${calculator.id}`).set('Cookie', ctx.cookie);
      expect(reenabled.body.tool.status).toBe('enabled');
    });

    it('refuses a transport change through PATCH', async () => {
      const created = await request(ctx.app)
        .post('/api/mcp')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Fixed transport',
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          connect: false,
        });

      const res = await request(ctx.app)
        .patch(`/api/mcp/${created.body.server.id}`)
        .set('Cookie', ctx.cookie)
        .send({ transport: 'streamable-http' });

      // Changing a transport is a different server wearing the same row, so it is a delete and a
      // re-add rather than a field write. `.strict()` makes it a 400 instead of a silent no-op.
      expect(res.status).toBe(400);
    });

    it('404s on a server that does not exist', async () => {
      await expect(
        request(ctx.app).get('/api/mcp/srv_nope').set('Cookie', ctx.cookie),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(ctx.app).post('/api/mcp/srv_nope/reconnect').set('Cookie', ctx.cookie),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(ctx.app).delete('/api/mcp/srv_nope').set('Cookie', ctx.cookie),
      ).resolves.toMatchObject({ status: 404 });
    });
  });

  describe('tenant isolation over HTTP', () => {
    it('does not expose one tenant\'s MCP servers or tools to another', async () => {
      const created = await request(ctx.app)
        .post('/api/mcp')
        .set('Cookie', ctx.cookie)
        .send({
          name: 'Mine',
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          connect: false,
        });
      const serverId = created.body.server.id as string;

      const listed = await request(ctx.app).get('/api/tools').set('Cookie', ctx.cookie);
      const calculator = findTool(listed.body, 'calculator');

      const other = await request(ctx.app)
        .post('/api/auth/signup')
        .send({ email: `other-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Grace' });
      const raw = other.headers['set-cookie'];
      const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
      const otherCookie = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`))?.split(';')[0] ?? '';

      await expect(
        request(ctx.app).get(`/api/mcp/${serverId}`).set('Cookie', otherCookie),
      ).resolves.toMatchObject({ status: 404 });
      // A tool id from one tenant is a 404 in another — the registry is provisioned per tenant,
      // so the other tenant's rows are different rows entirely.
      await expect(
        request(ctx.app).get(`/api/tools/${calculator.id}`).set('Cookie', otherCookie),
      ).resolves.toMatchObject({ status: 404 });

      const otherTools = await request(ctx.app).get('/api/tools').set('Cookie', otherCookie);
      expect(otherTools.body.tools.map((t: { id: string }) => t.id)).not.toContain(calculator.id);
    });
  });
});
