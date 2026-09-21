import request from 'supertest';
import type { Express } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_ACCESS, COOKIE_REFRESH } from '@nexs/shared';
import { loadConfig, type Config } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * The transport-level policies the security pass names, checked where they are actually observable.
 *
 * Each of these is a setting that is *present in the code* and would keep passing every functional
 * test if it were removed. That is the whole reason this file exists: `cors({ origin })` becoming
 * `cors()`, `sameSite: 'lax'` becoming the default, `secure` ceasing to follow `NODE_ENV` — none of
 * those change a single status code or response body, and all three are silent regressions of a
 * deliberate decision.
 *
 * ## Why the assertions look the way they do
 *
 * Three of them are written against a *property* rather than against an expected literal, because
 * the literal is not what protects anything:
 *
 *  - **CORS.** The `cors` package with a string origin stamps `Access-Control-Allow-Origin: <that
 *    origin>` on every response, including one from a hostile page. That is still safe — the
 *    browser compares the header to the page's own origin and refuses a mismatch — so a test
 *    asserting "no header for an unknown origin" would fail against correct code. What matters is
 *    that the header is never `*` and never echoes the requester.
 *  - **Cookies.** `Secure` is asserted in *both* directions. A cookie that is always `Secure` and
 *    one that never is are different bugs, and only checking production would miss the second.
 *  - **Rate limits.** The interesting claim about `/api/chat` is not that the 31st request fails —
 *    it is that the budget is keyed on the **user**, so a second user behind the same address is
 *    unaffected. A per-IP limiter passes a naive "it eventually 429s" test and fails that one.
 */

const testConfig = loadConfig();
const VALID_PASSWORD = 'correct horse battery staple';

function build(config: Config): { app: Express; fake: FakeDb } {
  const fake = createFakeDb();
  const app = createApp({
    config,
    logger: createLogger(config),
    db: fake.client,
    queueStatus: () => 'not_initialized',
    version: '0.1.0-test',
  });
  return { app, fake };
}

async function signup(app: Express, email: string): Promise<string> {
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ email, password: VALID_PASSWORD, name: 'Ada' });

  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const access = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`));
  if (access === undefined) throw new Error(`signup for ${email} did not set an access cookie`);
  return access.split(';')[0]!;
}

function cookiesOf(res: { headers: Record<string, string | string[] | undefined> }): string[] {
  const raw = res.headers['set-cookie'];
  if (Array.isArray(raw)) return raw;
  return typeof raw === 'string' ? [raw] : [];
}

function cookieNamed(cookies: string[], name: string): string {
  const found = cookies.find((c) => c.startsWith(`${name}=`));
  if (found === undefined) throw new Error(`expected a ${name} cookie, got: ${cookies.join(' | ')}`);
  return found;
}

// ── CORS ──────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build(testConfig);
  });

  it('allows exactly the configured web origin, with credentials', async () => {
    const res = await request(ctx.app).get('/api/health').set('Origin', testConfig.WEB_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBe(testConfig.WEB_ORIGIN);
    // Without this the browser refuses to attach the auth cookies, and every authenticated call
    // from the SPA fails with a 401 that looks like a session bug.
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('never answers with a wildcard', async () => {
    // `*` and `credentials: true` are mutually exclusive in the spec, and a wildcard would let any
    // page on the internet read this API with the user's cookies attached.
    for (const origin of [testConfig.WEB_ORIGIN, 'https://evil.example', undefined]) {
      const res = await request(ctx.app)
        .get('/api/health')
        .set(origin === undefined ? {} : { Origin: origin });

      expect(res.headers['access-control-allow-origin'], String(origin)).not.toBe('*');
    }
  });

  it('never echoes the requesting origin back', async () => {
    // The property that actually protects the API. Reflecting the requester — the classic
    // `origin: true` misconfiguration — would make every page on the internet a permitted reader.
    const res = await request(ctx.app)
      .get('/api/health')
      .set('Origin', 'https://evil.example');

    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('answers a preflight for the methods and headers the app serves', async () => {
    const res = await request(ctx.app)
      .options('/api/providers')
      .set('Origin', testConfig.WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(testConfig.WEB_ORIGIN);

    const methods = String(res.headers['access-control-allow-methods']);
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(methods, method).toContain(method);
    }
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('content-type');
  });
});

// ── cookie attributes ─────────────────────────────────────────────────────────

describe('auth cookie attributes', () => {
  it('marks both cookies HttpOnly and SameSite=Lax', async () => {
    // HttpOnly is asserted in `auth.http.test.ts` too. SameSite is asserted only here, and it is
    // the attribute that carries the CSRF story for a cookie-based session: `lax` is what stops a
    // cross-site POST from arriving with the session attached.
    const { app } = build(testConfig);
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'cookies@example.com', password: VALID_PASSWORD, name: 'Ada' });

    const cookies = cookiesOf(res);
    for (const name of [COOKIE_ACCESS, COOKIE_REFRESH]) {
      const cookie = cookieNamed(cookies, name);
      expect(cookie, name).toContain('HttpOnly');
      expect(cookie, name).toContain('SameSite=Lax');
    }
  });

  it('omits Secure outside production, so local development over http works', async () => {
    // `secure: true` on a plain-http origin means the browser stores the cookie and never sends it,
    // which presents as "login silently does nothing". The test environment is not production, so
    // this is the branch a developer is on.
    const { app } = build(testConfig);
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'dev@example.com', password: VALID_PASSWORD, name: 'Ada' });

    expect(cookieNamed(cookiesOf(res), COOKIE_ACCESS)).not.toContain('Secure');
  });

  it('adds Secure in production, so the token never crosses plain http', async () => {
    // The other direction, and the one that matters in a deployment. Asserted by building the app
    // with a production config rather than by reading the option, because the branch is what could
    // regress — a `secure: false` that nobody noticed would ship a token over http.
    const { app } = build(loadConfig({ ...process.env, NODE_ENV: 'production' }));

    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'prod@example.com', password: VALID_PASSWORD, name: 'Ada' });

    for (const name of [COOKIE_ACCESS, COOKIE_REFRESH]) {
      expect(cookieNamed(cookiesOf(res), name), name).toContain('Secure');
    }
  });
});

// ── rate limits ───────────────────────────────────────────────────────────────

describe('rate limits', () => {
  it('refuses the attempt past the auth budget with the API error envelope', async () => {
    const { app } = build(testConfig);
    const limit = testConfig.RATE_LIMIT_AUTH_PER_MIN;

    // A failed login counts. That is the point of the limit: the traffic it exists to cap is
    // precisely the traffic that never succeeds, so a limiter that only counted successes would
    // leave the password-guessing oracle it was added for wide open.
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: VALID_PASSWORD });
      expect(res.status, `attempt ${attempt + 1} of ${limit}`).toBe(401);
    }

    const blocked = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: VALID_PASSWORD });

    expect(blocked.status).toBe(429);
    // The API's own envelope, not the library's plain-text body — a client cannot branch on a
    // string, and every other failure in this API is shaped like this.
    expect(blocked.body.error?.code).toBe('RATE_LIMITED');
  });

  it('spends one auth budget across every auth route', async () => {
    // One limiter instance is shared by signup, login, refresh and both password-reset routes.
    // Per-route instances would make the budget trivially bypassable by moving to a sibling
    // endpoint — and would multiply the allowance by the number of routes.
    const { app } = build(testConfig);
    const limit = testConfig.RATE_LIMIT_AUTH_PER_MIN;

    for (let attempt = 0; attempt < limit; attempt += 1) {
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: VALID_PASSWORD });
    }

    const sibling = await request(app)
      .post('/api/auth/password-reset/request')
      .send({ email: 'nobody@example.com' });

    expect(sibling.status).toBe(429);
  });

  it('limits chat per user, so one person cannot lock out a shared address', async () => {
    // §2.6 asks for a per-*user* budget here, and the difference is invisible unless the second
    // user is tested: everyone behind one office NAT shares an address, so a per-IP limit would
    // have the first person pasting into a chat lock out their colleagues. A naive
    // "eventually it returns 429" test passes against that broken version.
    const { app } = build(testConfig);
    const first = await signup(app, 'first@example.com');
    const second = await signup(app, 'second@example.com');

    const limit = testConfig.RATE_LIMIT_CHAT_PER_MIN;
    for (let request_ = 0; request_ < limit; request_ += 1) {
      const res = await request(app).get('/api/chat/sessions').set('Cookie', first);
      expect(res.status, `request ${request_ + 1} of ${limit}`).toBe(200);
    }

    const blocked = await request(app).get('/api/chat/sessions').set('Cookie', first);
    expect(blocked.status).toBe(429);

    // Same address, different identity — and the budget is theirs.
    const other = await request(app).get('/api/chat/sessions').set('Cookie', second);
    expect(other.status).toBe(200);
  });
});

// ── the surface is where the spec says it is ──────────────────────────────────

describe('the chat surface', () => {
  it('answers at the paths the spec names, rather than at a doubled prefix', async () => {
    // A regression guard for a bug this pass found and fixed, and it is here because the reason
    // the bug survived is exactly the reason a test like this has to exist: **nothing requested a
    // chat path**. `routes/chat.ts` declared `/chat/sessions` while being mounted at `/api/chat`,
    // so every endpoint resolved to `/api/chat/chat/...` and the documented path answered 404 —
    // for the whole of Phase 8. The service tests call `ChatService` directly, the HTTP tests
    // cover other surfaces, and the double prefix is visible only in an enumeration of the routes
    // the application actually mounts.
    //
    // The paths below are the ones the spec's API table names (`nexs-build-spec.md`, `/api/chat`
    // row): `POST /`, `GET /messages`, `GET /mentions`, relative to the mount.
    const { app } = build(testConfig);
    const cookie = await signup(app, 'chatpaths@example.com');

    // `POST /` is the SSE stream, so its presence is checked by validation rather than by calling
    // it: an empty body must be refused by the schema, which only happens if the route is reached.
    expect((await request(app).post('/api/chat').set('Cookie', cookie).send({})).status).toBe(400);

    // `messages` needs a session id, so a 400 is the route being reached and validating — a 404
    // would mean it is not there at all.
    expect((await request(app).get('/api/chat/messages').set('Cookie', cookie)).status).toBe(400);

    expect((await request(app).get('/api/chat/mentions?q=a').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get('/api/chat/sessions').set('Cookie', cookie)).status).toBe(200);

    // And the doubled form is gone, so nothing can quietly go on depending on it.
    for (const path of ['/api/chat/chat/sessions', '/api/chat/chat/mentions', '/api/chat/chat/messages']) {
      expect((await request(app).get(path).set('Cookie', cookie)).status, path).toBe(404);
    }
  });
});
