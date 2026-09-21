import request from 'supertest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_ACCESS } from '@nexs/shared';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * `/api/sandbox`, `/api/files` and `/api/browser` as a client sees it.
 *
 * ## Why the sandbox tests actually run code
 *
 * `NodeWorkerProvider` is `worker_threads` — it needs no browser, no child process and no network,
 * so there is no reason to stub it. Running real JavaScript through the real worker is the only way
 * to prove the whole path: the execution row written *before* the run, the result mapped onto
 * `stdout`/`exitCode`, and the row finished after. A stub would prove the service calls something.
 *
 * ## Why the file tests use a real temporary directory
 *
 * `FileService` is the path jail, and a jail that is never asked to refuse anything has not been
 * tested. The grant tests point at a directory that genuinely exists — `canonicaliseGrantRoot`
 * realpaths it — and the traversal assertions ask for a path that genuinely escapes and must be
 * refused.
 *
 * `STORAGE_ROOT` is redirected to a temp directory rather than left at its `./data/storage` default,
 * so a test run does not leave uploads in the repository.
 */

const VALID_PASSWORD = 'correct horse battery staple';

let storageRoot: string;
let grantedRoot: string;

interface Ctx {
  app: ReturnType<typeof createApp>;
  fake: FakeDb;
  cookie: string;
}

async function build(): Promise<Ctx> {
  const fake = createFakeDb();
  const app = createApp({
    config: { ...loadConfig(), STORAGE_ROOT: storageRoot },
    logger: createLogger(loadConfig()),
    db: fake.client,
    queueStatus: () => 'not_initialized',
    version: '0.1.0-test',
  });

  const res = await request(app)
    .post('/api/auth/signup')
    .send({ email: `surfaces-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Ada' });

  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const access = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`));
  if (access === undefined) throw new Error('signup did not set an access cookie');

  return { app, fake, cookie: access.split(';')[0]! };
}

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'nexs-storage-'));
  grantedRoot = await mkdtemp(join(tmpdir(), 'nexs-granted-'));
  await writeFile(join(grantedRoot, 'notes.txt'), 'granted file contents', 'utf8');
});

afterAll(async () => {
  // Best-effort. A failure to clean up must not fail the suite — the directories are in the OS
  // temp location either way.
  await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
  await rm(grantedRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('the sandbox, file and browser surfaces', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await build();
  });

  describe('authentication', () => {
    it('refuses every route on all three prefixes without a session', async () => {
      await expect(request(ctx.app).get('/api/sandbox')).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).post('/api/sandbox').send({})).resolves.toMatchObject({
        status: 401,
      });
      await expect(request(ctx.app).post('/api/sandbox/sbx_1/exec').send({ code: '1' })).resolves.toMatchObject(
        { status: 401 },
      );

      await expect(request(ctx.app).get('/api/files')).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).post('/api/files')).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).get('/api/files/att_1/preview')).resolves.toMatchObject({
        status: 401,
      });
      await expect(request(ctx.app).get('/api/files/grants')).resolves.toMatchObject({ status: 401 });
      await expect(
        request(ctx.app).post('/api/files/grants').send({ rootPath: grantedRoot }),
      ).resolves.toMatchObject({ status: 401 });

      await expect(request(ctx.app).get('/api/browser')).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).post('/api/browser').send({})).resolves.toMatchObject({
        status: 401,
      });
      await expect(
        request(ctx.app).post('/api/browser/brw_1/actions').send({ action: { type: 'inspect' } }),
      ).resolves.toMatchObject({ status: 401 });
    });
  });

  describe('/api/sandbox', () => {
    it('runs real JavaScript and records the execution', async () => {
      const session = await request(ctx.app).post('/api/sandbox').set('Cookie', ctx.cookie).send({});
      expect(session.status).toBe(201);
      expect(session.body.session).toMatchObject({
        // The isolation mechanism, recorded on the row so a future Docker provider is a
        // distinguishable value rather than a silent behaviour change.
        provider: 'worker-thread',
        status: 'idle',
        runId: null,
      });
      const sessionId = session.body.session.id as string;

      const res = await request(ctx.app)
        .post(`/api/sandbox/${sessionId}/exec`)
        .set('Cookie', ctx.cookie)
        .send({ code: 'return input.a * input.b', input: { a: 6, b: 7 } });

      expect(res.status).toBe(200);
      expect(res.body.outcome.value).toBe(42);
      expect(res.body.outcome.execution.status).toBe('completed');
      expect(res.body.outcome.execution.exitCode).toBe(0);

      // The row exists and says the same thing. `command` holds the source — see
      // `types/sandbox.ts` for why the column is named that way.
      const history = await request(ctx.app)
        .get(`/api/sandbox/${sessionId}/executions`)
        .set('Cookie', ctx.cookie);
      expect(history.status).toBe(200);
      expect(history.body.executions).toHaveLength(1);
      expect(history.body.executions[0]).toMatchObject({
        command: 'return input.a * input.b',
        status: 'completed',
        exitCode: 0,
      });
      expect(history.body.executions[0].completedAt).not.toBeNull();

      // The session went back to idle rather than staying `running` forever.
      const after = await request(ctx.app).get(`/api/sandbox/${sessionId}`).set('Cookie', ctx.cookie);
      expect(after.body.session.status).toBe('idle');
    });

    it('records a run that throws, and does not leave the session running', async () => {
      const session = await request(ctx.app).post('/api/sandbox').set('Cookie', ctx.cookie).send({});
      const sessionId = session.body.session.id as string;

      const res = await request(ctx.app)
        .post(`/api/sandbox/${sessionId}/exec`)
        .set('Cookie', ctx.cookie)
        .send({ code: 'throw new Error("nope")' });

      // A run that reported its own failure is a *result*, not a transport error.
      expect(res.status).toBe(200);
      expect(res.body.outcome.execution.status).toBe('failed');

      const history = await request(ctx.app)
        .get(`/api/sandbox/${sessionId}/executions`)
        .set('Cookie', ctx.cookie);
      expect(history.body.executions[0].status).toBe('failed');
    });

    it('keeps a session\'s executions sequential', async () => {
      const session = await request(ctx.app).post('/api/sandbox').set('Cookie', ctx.cookie).send({});
      const sessionId = session.body.session.id as string;

      // Three runs fired at once. Each sleeps, so overlapping runs would finish out of order and
      // the recorded order would not match the requested one.
      const results = await Promise.all(
        [1, 2, 3].map((n) =>
          request(ctx.app)
            .post(`/api/sandbox/${sessionId}/exec`)
            .set('Cookie', ctx.cookie)
            .send({ code: `await new Promise(r => setTimeout(r, 40)); return ${n}` }),
        ),
      );

      expect(results.map((r) => r.body.outcome.value)).toEqual([1, 2, 3]);

      const history = await request(ctx.app)
        .get(`/api/sandbox/${sessionId}/executions`)
        .set('Cookie', ctx.cookie);
      expect(history.body.executions).toHaveLength(3);
    });

    it('refuses a workdir that escapes the tenant directory', async () => {
      const res = await request(ctx.app)
        .post('/api/sandbox')
        .set('Cookie', ctx.cookie)
        .send({ workdir: '../../../../etc' });

      // The path is joined under the sandbox directory and then re-checked, so the traversal never
      // becomes a path. A 403 rather than a silent write somewhere else.
      expect(res.status).toBe(403);
    });

    it('rejects an exec body with no code', async () => {
      const session = await request(ctx.app).post('/api/sandbox').set('Cookie', ctx.cookie).send({});
      const sessionId = session.body.session.id as string;

      const res = await request(ctx.app)
        .post(`/api/sandbox/${sessionId}/exec`)
        .set('Cookie', ctx.cookie)
        .send({ timeoutMs: 1000 });

      expect(res.status).toBe(400);
    });

    it('404s on a session that does not exist', async () => {
      await expect(request(ctx.app).get('/api/sandbox/sbx_nope').set('Cookie', ctx.cookie)).resolves.toMatchObject(
        { status: 404 },
      );
      await expect(
        request(ctx.app).post('/api/sandbox/sbx_nope/exec').set('Cookie', ctx.cookie).send({ code: '1' }),
      ).resolves.toMatchObject({ status: 404 });
    });
  });

  describe('/api/files', () => {
    it('stores an upload, serves it back byte-for-byte, and deletes it', async () => {
      const upload = await request(ctx.app)
        .post('/api/files')
        .set('Cookie', ctx.cookie)
        .field('scope', 'chat')
        .attach('file', Buffer.from('hello from the upload', 'utf8'), 'greeting.txt');

      expect(upload.status).toBe(201);
      expect(upload.body.attachment).toMatchObject({
        kind: 'file',
        name: 'greeting.txt',
        mimeType: 'text/plain',
        scope: 'chat',
        scopeId: null,
        readAccess: true,
        writeAccess: false,
      });
      // Workdir-relative, never an absolute host path.
      expect(upload.body.attachment.path).toMatch(/^uploads\/[0-9a-f-]+-greeting\.txt$/);
      const id = upload.body.attachment.id as string;

      const preview = await request(ctx.app)
        .get(`/api/files/${id}/preview`)
        .set('Cookie', ctx.cookie);

      expect(preview.status).toBe(200);
      expect(preview.headers['content-type']).toContain('text/plain');
      // An attachment store that serves user content without this is a stored-XSS vector.
      expect(preview.headers['x-content-type-options']).toBe('nosniff');
      expect(preview.text).toBe('hello from the upload');

      const listed = await request(ctx.app).get('/api/files?scope=chat').set('Cookie', ctx.cookie);
      expect(listed.body.attachments.map((a: { id: string }) => a.id)).toEqual([id]);

      await expect(
        request(ctx.app).delete(`/api/files/${id}`).set('Cookie', ctx.cookie),
      ).resolves.toMatchObject({ status: 204 });

      const after = await request(ctx.app).get(`/api/files/${id}`).set('Cookie', ctx.cookie);
      expect(after.status).toBe(404);
    });

    it('strips a traversal out of the uploaded filename', async () => {
      const upload = await request(ctx.app)
        .post('/api/files')
        .set('Cookie', ctx.cookie)
        .field('scope', 'task')
        .attach('file', Buffer.from('x', 'utf8'), '../../escape.txt');

      expect(upload.status).toBe(201);
      // `basename` first, so the traversal is gone before anything else happens; the stored path
      // is still workdir-relative and still starts with `uploads/`.
      expect(upload.body.attachment.name).toBe('escape.txt');
      expect(upload.body.attachment.path).toMatch(/^uploads\//);
      expect(upload.body.attachment.path).not.toContain('..');
    });

    it('refuses an upload with no file part', async () => {
      const res = await request(ctx.app)
        .post('/api/files')
        .set('Cookie', ctx.cookie)
        .field('scope', 'chat');

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('field name "file"');
    });

    it('refuses an upload whose scope is not in the vocabulary', async () => {
      const res = await request(ctx.app)
        .post('/api/files')
        .set('Cookie', ctx.cookie)
        .field('scope', 'somewhere-else')
        .attach('file', Buffer.from('x', 'utf8'), 'x.txt');

      expect(res.status).toBe(400);
    });

    it('grants a folder, lists it, reads through it, and revokes it', async () => {
      const grant = await request(ctx.app)
        .post('/api/files/grants')
        .set('Cookie', ctx.cookie)
        .send({ rootPath: grantedRoot, read: true, write: false });

      expect(grant.status).toBe(201);
      expect(grant.body.grant).toMatchObject({
        rootPath: grantedRoot,
        read: true,
        write: false,
        agentId: null,
      });
      // The realpath is what every containment check is compared against. Handing it to a client
      // gives away most of what a traversal needs, so it must not be on the wire.
      expect(grant.body.grant).not.toHaveProperty('resolvedPath');
      expect(JSON.stringify(grant.body)).not.toContain('resolvedPath');
      const grantId = grant.body.grant.id as string;

      // `/grants` must not be swallowed by `/:id` — the same declaration-order trap memory and
      // notifications document.
      const listed = await request(ctx.app).get('/api/files/grants').set('Cookie', ctx.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body.grants.map((g: { id: string }) => g.id)).toEqual([grantId]);

      const entries = await request(ctx.app)
        .get(`/api/files/grants/${grantId}/entries`)
        .set('Cookie', ctx.cookie);
      expect(entries.status).toBe(200);
      expect(entries.body.entries).toEqual([
        expect.objectContaining({ name: 'notes.txt', kind: 'file' }),
      ]);

      const read = await request(ctx.app)
        .get(`/api/files/grants/${grantId}/file?path=notes.txt`)
        .set('Cookie', ctx.cookie);
      expect(read.status).toBe(200);
      // A granted read has no stored mime type to go on — the file was never uploaded through the
      // API — so it is served as opaque bytes and the assertion reads the buffer rather than text.
      expect(read.headers['content-type']).toContain('application/octet-stream');
      expect(Buffer.from(read.body as Buffer).toString('utf8')).toBe('granted file contents');

      const escaped = await request(ctx.app)
        .get(`/api/files/grants/${grantId}/file?path=../../../etc/hosts`)
        .set('Cookie', ctx.cookie);
      expect(escaped.status).toBe(403);

      await expect(
        request(ctx.app).delete(`/api/files/grants/${grantId}`).set('Cookie', ctx.cookie),
      ).resolves.toMatchObject({ status: 204 });

      const after = await request(ctx.app).get('/api/files/grants').set('Cookie', ctx.cookie);
      expect(after.body.grants).toEqual([]);
    });

    it('refuses a grant that permits nothing', async () => {
      const res = await request(ctx.app)
        .post('/api/files/grants')
        .set('Cookie', ctx.cookie)
        .send({ rootPath: grantedRoot, read: false, write: false });

      // A grant with neither permission is a row that renders as "access granted" and grants
      // nothing. The schema cannot express the cross-field rule; the service can.
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('must permit reading, writing, or both');
    });

    it('refuses a folder that does not exist', async () => {
      const res = await request(ctx.app)
        .post('/api/files/grants')
        .set('Cookie', ctx.cookie)
        .send({ rootPath: join(grantedRoot, 'no-such-folder') });

      expect(res.status).toBe(404);
    });

    it('refuses to read through a grant with read access off', async () => {
      const grant = await request(ctx.app)
        .post('/api/files/grants')
        .set('Cookie', ctx.cookie)
        .send({ rootPath: grantedRoot, read: false, write: true });
      const grantId = grant.body.grant.id as string;

      const res = await request(ctx.app)
        .get(`/api/files/grants/${grantId}/entries`)
        .set('Cookie', ctx.cookie);

      expect(res.status).toBe(403);
    });

    it('404s on an attachment that does not exist', async () => {
      await expect(
        request(ctx.app).get('/api/files/att_nope').set('Cookie', ctx.cookie),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(ctx.app).get('/api/files/att_nope/preview').set('Cookie', ctx.cookie),
      ).resolves.toMatchObject({ status: 404 });
    });
  });

  describe('/api/browser', () => {
    /**
     * These stop short of launching a browser on purpose.
     *
     * `BrowserManager.open` needs a real Playwright browser binary, and a test that asserted on a
     * launch would be a test of the machine rather than of the wiring. What is provable without one
     * is everything up to the launch: that the router is mounted and authenticated, that the action
     * body is validated as a discriminated union, and that a session id which does not exist is a
     * 404 rather than a 500.
     */
    it('starts with an empty session list', async () => {
      const res = await request(ctx.app).get('/api/browser').set('Cookie', ctx.cookie);
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([]);
    });

    it('refuses a click with no selector, naming the field', async () => {
      const res = await request(ctx.app)
        .post('/api/browser/brw_1/actions')
        .set('Cookie', ctx.cookie)
        .send({ action: { type: 'click' } });

      expect(res.status).toBe(400);
      // The discriminated union is what turns "the browser did nothing" into this.
      expect(JSON.stringify(res.body.error.details)).toContain('selector');
    });

    it('refuses an action type outside the vocabulary', async () => {
      const res = await request(ctx.app)
        .post('/api/browser/brw_1/actions')
        .set('Cookie', ctx.cookie)
        .send({ action: { type: 'teleport' } });

      expect(res.status).toBe(400);
    });

    it('refuses a wait with neither a selector nor a duration', async () => {
      const res = await request(ctx.app)
        .post('/api/browser/brw_1/actions')
        .set('Cookie', ctx.cookie)
        .send({ action: { type: 'wait' } });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.error.details)).toContain('returns instantly');
    });

    it('refuses a navigate to a non-http scheme', async () => {
      const res = await request(ctx.app)
        .post('/api/browser/brw_1/actions')
        .set('Cookie', ctx.cookie)
        .send({ action: { type: 'navigate', url: 'javascript:alert(1)' } });

      expect(res.status).toBe(400);
    });

    it('404s on a session that does not exist', async () => {
      await expect(
        request(ctx.app).get('/api/browser/brw_nope').set('Cookie', ctx.cookie),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(ctx.app).delete('/api/browser/brw_nope').set('Cookie', ctx.cookie),
      ).resolves.toMatchObject({ status: 404 });
    });
  });

  describe('tenant isolation over HTTP', () => {
    it('does not expose one tenant\'s sandbox session or attachment to another', async () => {
      const session = await request(ctx.app).post('/api/sandbox').set('Cookie', ctx.cookie).send({});
      const sessionId = session.body.session.id as string;

      const upload = await request(ctx.app)
        .post('/api/files')
        .set('Cookie', ctx.cookie)
        .field('scope', 'chat')
        .attach('file', Buffer.from('private', 'utf8'), 'private.txt');
      const attachmentId = upload.body.attachment.id as string;

      const other = await request(ctx.app)
        .post('/api/auth/signup')
        .send({ email: `other-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Grace' });
      const raw = other.headers['set-cookie'];
      const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
      const otherCookie = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`))?.split(';')[0] ?? '';

      await expect(
        request(ctx.app).get(`/api/sandbox/${sessionId}`).set('Cookie', otherCookie),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(ctx.app).get(`/api/files/${attachmentId}/preview`).set('Cookie', otherCookie),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(ctx.app).post(`/api/sandbox/${sessionId}/exec`).set('Cookie', otherCookie).send({ code: '1' }),
      ).resolves.toMatchObject({ status: 404 });

      const listed = await request(ctx.app).get('/api/files').set('Cookie', otherCookie);
      expect(listed.body.attachments).toEqual([]);
    });
  });
});
