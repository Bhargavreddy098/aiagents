import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_ACCESS, COOKIE_REFRESH, REFRESH_COOKIE_PATH } from '@nexs/shared';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * The auth surface as a client actually sees it: status codes, the error envelope,
 * and — most importantly — the cookies. The cookie attributes are asserted explicitly
 * because they are the kind of thing that regresses silently: an access token that
 * loses `HttpOnly` still passes every functional test.
 */

const config = loadConfig();

const VALID_PASSWORD = 'correct horse battery staple';

function build(): { app: ReturnType<typeof createApp>; fake: FakeDb } {
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

describe('auth HTTP surface', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it('POST /api/auth/signup returns 201, normalises the email, and sets both cookies', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/signup')
      .send({ email: '  Ada@Example.COM ', password: VALID_PASSWORD, name: 'Ada' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'ada@example.com', name: 'Ada' });

    const cookies = cookiesOf(res);
    const access = cookieNamed(cookies, COOKIE_ACCESS);
    const refresh = cookieNamed(cookies, COOKIE_REFRESH);

    // Tokens must never be readable from JavaScript.
    expect(access).toContain('HttpOnly');
    expect(refresh).toContain('HttpOnly');

    // The access token rides along on every API call…
    expect(access).toContain('Path=/');
    // …while the refresh token is scoped to the auth routes only.
    expect(refresh).toContain(`Path=${REFRESH_COOKIE_PATH}`);

    // The tokens themselves must not appear in the response body.
    expect(JSON.stringify(res.body)).not.toContain('nexs_at');
  });

  it('rejects a weak password with the standard validation envelope', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/signup')
      .send({ email: 'ada@example.com', password: 'short', name: 'Ada' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toBeInstanceOf(Array);
  });

  it('rejects a duplicate email with 409 CONFLICT', async () => {
    const body = { email: 'ada@example.com', password: VALID_PASSWORD, name: 'Ada' };
    await request(ctx.app).post('/api/auth/signup').send(body).expect(201);

    const res = await request(ctx.app).post('/api/auth/signup').send(body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects a bad login with 401 and no hint about which field was wrong', async () => {
    await request(ctx.app)
      .post('/api/auth/signup')
      .send({ email: 'ada@example.com', password: VALID_PASSWORD, name: 'Ada' })
      .expect(201);

    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'ada@example.com', password: 'wrong password here' });

    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid email or password' });
  });

  it('GET /api/users/me requires a session and then reports the caller', async () => {
    const anonymous = await request(ctx.app).get('/api/users/me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHORIZED');

    const agent = request.agent(ctx.app);
    await agent
      .post('/api/auth/signup')
      .send({ email: 'ada@example.com', password: VALID_PASSWORD, name: 'Ada' })
      .expect(201);

    const me = await agent.get('/api/users/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: 'ada@example.com', tenantName: "Ada's workspace" });
  });

  it('PATCH /api/users/me updates the profile', async () => {
    const agent = request.agent(ctx.app);
    await agent
      .post('/api/auth/signup')
      .send({ email: 'ada@example.com', password: VALID_PASSWORD, name: 'Ada' })
      .expect(201);

    const res = await agent.patch('/api/users/me').send({ name: 'Ada Lovelace' });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Ada Lovelace');

    const me = await agent.get('/api/users/me');
    expect(me.body.user.name).toBe('Ada Lovelace');
  });

  it('POST /api/auth/refresh rotates the refresh cookie', async () => {
    const agent = request.agent(ctx.app);
    const signup = await agent
      .post('/api/auth/signup')
      .send({ email: 'ada@example.com', password: VALID_PASSWORD, name: 'Ada' })
      .expect(201);

    const before = cookieNamed(cookiesOf(signup), COOKIE_REFRESH);

    const refreshed = await agent.post('/api/auth/refresh').send();
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.user.email).toBe('ada@example.com');

    const after = cookieNamed(cookiesOf(refreshed), COOKIE_REFRESH);
    expect(after).not.toBe(before);

    // The rotated cookie still authenticates.
    expect((await agent.get('/api/users/me')).status).toBe(200);
  });

  it('POST /api/auth/logout clears the cookies and kills the session', async () => {
    const agent = request.agent(ctx.app);
    await agent
      .post('/api/auth/signup')
      .send({ email: 'ada@example.com', password: VALID_PASSWORD, name: 'Ada' })
      .expect(201);

    const logout = await agent.post('/api/auth/logout').send();
    expect(logout.status).toBe(204);

    // The refresh token is revoked, so the next refresh cannot mint a new session.
    const refresh = await agent.post('/api/auth/refresh').send();
    expect(refresh.status).toBe(401);
  });

  it('accepts a Bearer token as an alternative to the cookie', async () => {
    const signup = await request(ctx.app)
      .post('/api/auth/signup')
      .send({ email: 'ada@example.com', password: VALID_PASSWORD, name: 'Ada' })
      .expect(201);

    const accessToken = cookieNamed(cookiesOf(signup), COOKIE_ACCESS).split('=')[1]!.split(';')[0]!;

    const me = await request(ctx.app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('ada@example.com');
  });

  it('rejects a tampered access token', async () => {
    const signup = await request(ctx.app)
      .post('/api/auth/signup')
      .send({ email: 'ada@example.com', password: VALID_PASSWORD, name: 'Ada' })
      .expect(201);

    const raw = cookieNamed(cookiesOf(signup), COOKIE_ACCESS).split('=')[1]!.split(';')[0]!;

    // Flip a character in the *signature*, and specifically the first one.
    //
    // Flipping the last character instead is a trap: a 32-byte HMAC encodes to 43 base64url
    // characters, so the final character carries only 4 significant bits and two characters
    // that differ only in the two ignored bits decode to identical bytes. The "tampered"
    // token then verifies and the request succeeds — so a test written that way passes or
    // fails on the luck of the draw, roughly one run in sixteen.
    //
    // The first character of a base64 group carries six significant bits, so changing it
    // always changes the decoded bytes.
    const [header, payload, signature] = raw.split('.');
    const tamperedSignature = `${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`;
    const tampered = `${header}.${payload}.${tamperedSignature}`;
    expect(tampered).not.toBe(raw);

    const res = await request(ctx.app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${tampered}`);

    expect(res.status).toBe(401);
  });

  it('password reset request answers 202 for a known and an unknown email alike', async () => {
    await request(ctx.app)
      .post('/api/auth/signup')
      .send({ email: 'ada@example.com', password: VALID_PASSWORD, name: 'Ada' })
      .expect(201);

    const known = await request(ctx.app)
      .post('/api/auth/password-reset/request')
      .send({ email: 'ada@example.com' });
    const unknown = await request(ctx.app)
      .post('/api/auth/password-reset/request')
      .send({ email: 'nobody@example.com' });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual({ ok: true });
    // Outside production the token is echoed back so the flow is completable locally.
    expect(typeof known.body.token).toBe('string');
  });

  it('completes the password reset flow and invalidates the old session', async () => {
    const agent = request.agent(ctx.app);
    await agent
      .post('/api/auth/signup')
      .send({ email: 'ada@example.com', password: VALID_PASSWORD, name: 'Ada' })
      .expect(201);

    const requested = await request(ctx.app)
      .post('/api/auth/password-reset/request')
      .send({ email: 'ada@example.com' })
      .expect(202);

    const confirm = await request(ctx.app)
      .post('/api/auth/password-reset/confirm')
      .send({ token: requested.body.token, newPassword: 'an entirely new passphrase' });

    expect(confirm.status).toBe(204);

    // The old session's refresh token was revoked by the reset.
    expect((await agent.post('/api/auth/refresh').send()).status).toBe(401);

    // The new password works; the old one does not.
    expect(
      (
        await request(ctx.app)
          .post('/api/auth/login')
          .send({ email: 'ada@example.com', password: 'an entirely new passphrase' })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(ctx.app)
          .post('/api/auth/login')
          .send({ email: 'ada@example.com', password: VALID_PASSWORD })
      ).status,
    ).toBe(401);
  });
});
