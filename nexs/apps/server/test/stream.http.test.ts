import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { COOKIE_ACCESS } from '@nexs/shared';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';
import { createContainer, type Container } from '../src/container.js';
import { createAuthRequired } from '../src/http/middleware/auth.js';
import { createStreamRouter } from '../src/routes/stream.js';
import {
  STREAM_REPLAY_MAX_NOTIFICATIONS,
  createStreamController,
} from '../src/controllers/stream.controller.js';
import type { NotificationService } from '../src/services/notifications/notification.service.js';

/**
 * `GET /api/stream` over a real socket.
 *
 * Deliberately not supertest. The failure modes of SSE live in the transport — a
 * `Content-Type` that is missing `charset`, a `Cache-Control` without `no-transform`, a
 * `res.flushHeaders()` that never ran — and none of those are visible to a test that hands
 * the Express app a fake socket. So this file starts an actual server on an ephemeral port
 * and reads the response with `fetch`, which is what a browser does.
 */

const VALID_PASSWORD = 'correct horse battery staple';

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Accumulates a stream's text and lets a test wait for a substring to appear. */
function makeReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    get text(): string {
      return buffer;
    },
    async waitFor(needle: string, timeoutMs = 4_000): Promise<string> {
      const found = async (): Promise<string> => {
        while (!buffer.includes(needle)) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`stream ended before ${JSON.stringify(needle)}`);
          buffer += decoder.decode(chunk.value, { stream: true });
        }
        return buffer;
      };
      return withTimeout(found(), timeoutMs, JSON.stringify(needle));
    },
    /** Waits `ms` and returns whatever arrived — for asserting something did NOT arrive. */
    async settle(ms = 150): Promise<string> {
      const drain = async (): Promise<string> => {
        const chunk = await reader.read();
        if (!chunk.done) {
          buffer += decoder.decode(chunk.value, { stream: true });
          return drain();
        }
        return buffer;
      };
      await Promise.race([drain(), new Promise<void>((r) => setTimeout(r, ms))]);
      return buffer;
    },
  };
}

interface Ctx {
  app: ReturnType<typeof createApp>;
  fake: FakeDb;
  container: Container;
  server: Server;
  port: number;
  cookie: string;
  /**
   * The bare access token, without the `name=` prefix.
   *
   * The same credential the cookie carries, and the value a cross-origin `EventSource` has to
   * put in the query string because it cannot set a header.
   */
  token: string;
  tenantId: string;
  userId: string;
  /** Aborts every stream this test opened, so a failure cannot hang the run. */
  abort: AbortController;
}

async function build(env: Record<string, string> = {}): Promise<Ctx> {
  const config = loadConfig({ ...process.env, ...env } as NodeJS.ProcessEnv);
  const fake = createFakeDb();
  const logger = createLogger(config);

  // Built here rather than borrowed from the app, so the test can publish events into the
  // same SSE hub the routes stream from. `createApp` uses whatever container it is handed,
  // which is what makes "the hub I hold" and "the hub the routes use" the same hub.
  const container = createContainer({ config, logger, db: fake.client });

  const app = createApp({
    config,
    logger,
    db: fake.client,
    container,
    queueStatus: () => 'not_initialized',
    version: '0.1.0-test',
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;

  const res = await fetch(`http://127.0.0.1:${port}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `stream-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Ada' }),
  });
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_ACCESS}=`));
  if (setCookie === undefined) throw new Error('signup did not set an access cookie');

  const cookie = setCookie.split(';')[0]!;

  return {
    app,
    fake,
    container,
    server,
    port,
    cookie,
    token: cookie.slice(COOKIE_ACCESS.length + 1),
    // The signup created exactly one workspace and one user, and the harness has no other
    // rows yet — so "the newest" is "the only".
    tenantId: fake.tenants[fake.tenants.length - 1]!.id,
    userId: fake.users[fake.users.length - 1]!.id,
    abort: new AbortController(),
  };
}

async function close(ctx: Ctx): Promise<void> {
  ctx.abort.abort();
  ctx.server.closeAllConnections?.();
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
}

describe('GET /api/stream', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await build();
  });

  afterEach(async () => {
    await close(ctx);
  });

  const url = (q = ''): string => `http://127.0.0.1:${ctx.port}/api/stream${q}`;

  it('refuses an unauthenticated connection', async () => {
    const res = await fetch(url(), { signal: ctx.abort.signal });
    expect(res.status).toBe(401);
    // The refusal must be ordinary JSON, not a half-opened stream: a client that gets
    // `text/event-stream` back cannot read the error.
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('opens with the headers that make streaming actually work', async () => {
    const res = await fetch(url(), {
      headers: { cookie: ctx.cookie },
      signal: ctx.abort.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-transform');
    // Without this, nginx buffers the whole response and the client sees nothing until the
    // connection closes — the single most common "SSE works locally, not in prod" bug.
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const reader = makeReader(res);
    await reader.waitFor(': connected');
  });

  it('delivers a frame published for the caller’s tenant, with an id', async () => {
    const res = await fetch(url(), {
      headers: { cookie: ctx.cookie },
      signal: ctx.abort.signal,
    });
    const reader = makeReader(res);
    await reader.waitFor(': connected');

    const tenantId = ctx.fake.tenants[0]!.id;
    ctx.container.sseHub.publish(
      { name: 'run.started', payload: { runId: 'run_1' } },
      tenantId,
    );

    const text = await reader.waitFor('run.started');
    expect(text).toMatch(/^id: .+$/m);
    expect(text).toContain('event: run.started');
    expect(text).toContain('"runId":"run_1"');
  });

  it('does not deliver another tenant’s frame', async () => {
    const res = await fetch(url(), {
      headers: { cookie: ctx.cookie },
      signal: ctx.abort.signal,
    });
    const reader = makeReader(res);
    await reader.waitFor(': connected');

    // Same hub, different tenant. This is the assertion that would catch a fan-out that
    // forgot to filter — the highest-severity bug this endpoint could have.
    ctx.container.sseHub.publish({ name: 'run.started', payload: { runId: 'run_secret' } }, 'tnt_other');

    const text = await reader.settle();
    expect(text).not.toContain('run_secret');
    expect(text).not.toContain('run.started');
  });

  it('sends heartbeats as comments, not events', async () => {
    const res = await fetch(url(), {
      headers: { cookie: ctx.cookie },
      signal: ctx.abort.signal,
    });
    const reader = makeReader(res);
    await reader.waitFor(': connected');

    ctx.container.sseHub.beat();

    const text = await reader.waitFor(': ping');
    // A heartbeat that arrived as an `event:` would make a client's dispatch fire on every
    // ping — the reason SSE heartbeats are comments by convention.
    expect(text).not.toContain('event: ping');
  });

  it('unregisters the client when the socket closes', async () => {
    const res = await fetch(url(), {
      headers: { cookie: ctx.cookie },
      signal: ctx.abort.signal,
    });
    const reader = makeReader(res);
    await reader.waitFor(': connected');
    expect(ctx.container.sseHub.connectionCount()).toBe(1);

    ctx.abort.abort();

    // The detach happens in the server's `close` handler, so it is asynchronous with respect
    // to this process. Polling is honest here — the alternative is asserting on a race.
    await withTimeout(
      (async () => {
        while (ctx.container.sseHub.connectionCount() > 0) {
          await new Promise((r) => setTimeout(r, 10));
        }
      })(),
      3_000,
      'the hub to drop the closed client',
    );

    // A leaked entry is the classic SSE memory leak: the socket is gone but every later
    // publish still writes into it.
    expect(ctx.container.sseHub.connectionCount()).toBe(0);
  });

  it('registers the runId it was asked to tail', async () => {
    const res = await fetch(url('?runId=run_watched'), {
      headers: { cookie: ctx.cookie },
      signal: ctx.abort.signal,
    });
    const reader = makeReader(res);
    await reader.waitFor(': connected');

    const tenantId = ctx.fake.tenants[0]!.id;
    expect(ctx.container.sseHub.subscriberCount(tenantId, 'run_watched')).toBe(1);
    expect(ctx.container.sseHub.subscriberCount(tenantId, 'run_other')).toBe(0);
  });

  it('rejects an empty runId as a 400', async () => {
    // Validated before the headers are written, which is the only reason a status code is
    // still available to send.
    const res = await fetch(url('?runId='), {
      headers: { cookie: ctx.cookie },
      signal: ctx.abort.signal,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('tolerates an unknown query parameter', async () => {
    // Cache-busters are normal on a reconnecting `EventSource`; refusing them would break
    // reconnects for no gain, which is why this schema is not `.strict()`.
    const res = await fetch(url('?_t=1730000000'), {
      headers: { cookie: ctx.cookie },
      signal: ctx.abort.signal,
    });
    expect(res.status).toBe(200);

    const reader = makeReader(res);
    await reader.waitFor(': connected');
  });
});

describe('GET /api/stream — the connection cap', () => {
  it('answers 429 once one address holds too many streams', async () => {
    // Configured to 1 rather than exercised at the default of 10, and built with an explicit
    // env so this also proves `SSE_MAX_CONNECTIONS_PER_IP` is genuinely read from config
    // rather than the cap being a hardcoded number that happens to match the default.
    const ctx = await build({ SSE_MAX_CONNECTIONS_PER_IP: '1' });
    const url = `http://127.0.0.1:${ctx.port}/api/stream`;

    try {
      const first = await fetch(url, { headers: { cookie: ctx.cookie }, signal: ctx.abort.signal });
      expect(first.status).toBe(200);
      await makeReader(first).waitFor(': connected');

      const second = await fetch(url, { headers: { cookie: ctx.cookie }, signal: ctx.abort.signal });
      expect(second.status).toBe(429);

      const body = (await second.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('RATE_LIMITED');
    } finally {
      await close(ctx);
    }
  });
});

// ── the cross-origin token ────────────────────────────────────────────────────

describe('GET /api/stream — the cross-origin token', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await build();
  });

  afterEach(async () => {
    await close(ctx);
  });

  const url = (q = ''): string => `http://127.0.0.1:${ctx.port}/api/stream${q}`;

  it('accepts the access token as a query parameter', async () => {
    // The `EventSource` constructor takes a URL and nothing else, so this is the only way a
    // cross-origin client — where no cookie is sent, because there is no same-site
    // relationship to send it with — can authenticate at all.
    const res = await fetch(url(`?token=${encodeURIComponent(ctx.token)}`), {
      signal: ctx.abort.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await makeReader(res).waitFor(': connected');
  });

  it('refuses a query token that does not verify', async () => {
    const res = await fetch(url('?token=not-a-real-token'), { signal: ctx.abort.signal });

    // Same refusal as no credential at all, and the same shape: the token goes through the
    // *existing* verifier, so there is no weaker path where a bad token is treated better.
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('prefers a credential that is already in the header', async () => {
    // Both supplied, the query one invalid. The header wins, which is the value a proxy is
    // more likely to have set deliberately — and it means a stray `?token=` on an otherwise
    // authenticated request cannot downgrade it.
    const res = await fetch(url('?token=not-a-real-token'), {
      headers: { cookie: ctx.cookie },
      signal: ctx.abort.signal,
    });

    expect(res.status).toBe(200);
    await makeReader(res).waitFor(': connected');
  });

  it('still honours the other query parameters alongside the token', async () => {
    const res = await fetch(url(`?token=${encodeURIComponent(ctx.token)}&runId=run_watched`), {
      signal: ctx.abort.signal,
    });
    await makeReader(res).waitFor(': connected');

    // Removing `token` from the URL must not remove anything else from it — the rewrite
    // rebuilds the query string, so a `runId` lost in the process would show up here.
    expect(ctx.container.sseHub.subscriberCount(ctx.tenantId, 'run_watched')).toBe(1);
  });
});

/**
 * The promotion itself, observed directly.
 *
 * The tests above prove the feature works. This one proves *how*, which matters because the
 * mechanism is what keeps the credential out of two places it would otherwise reach: the
 * request log, and anything downstream that reads `req.query`. A probe app with the real
 * router and a controller that records what it was handed is the only way to see the request
 * as the handler sees it.
 */
describe('GET /api/stream — the query-token promotion', () => {
  it('moves the token into the Authorization header and out of the URL', async () => {
    const ctx = await build();

    try {
      let seen:
        | { url: string; originalUrl: string; query: unknown; authorization: string | null }
        | null = null;

      const probe = express();
      probe.use(
        '/api/stream',
        createStreamRouter({
          controller: {
            open: (req, res) => {
              seen = {
                url: req.url,
                originalUrl: req.originalUrl,
                query: req.query,
                authorization: req.header('authorization') ?? null,
              };
              res.status(200).end();
            },
          },
          authRequired: createAuthRequired({
            users: ctx.container.users,
            tokens: ctx.container.tokens,
          }),
        }),
      );

      // No cookie: the query parameter is the only credential presented, so a 200 here is
      // itself proof that the promotion happened before the verifier ran.
      const res = await request(probe).get(
        `/api/stream?token=${encodeURIComponent(ctx.token)}&runId=run_watched`,
      );

      expect(res.status).toBe(200);
      expect(seen).not.toBeNull();
      expect(seen!.authorization).toBe(`Bearer ${ctx.token}`);

      // The credential is gone from every view of the URL a later reader could take. `pino-http`
      // serializes `req` when the response finishes, so a URL still carrying the token is a live
      // credential written into the access log of a connection that may stay open for hours.
      expect(seen!.url).toBe('/?runId=run_watched');
      expect(seen!.originalUrl).toBe('/api/stream?runId=run_watched');
      expect(seen!.query).toEqual({ runId: 'run_watched' });
    } finally {
      await close(ctx);
    }
  });
});

// ── the unread-notification replay ────────────────────────────────────────────

describe('GET /api/stream — the unread-notification replay', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await build();
  });

  afterEach(async () => {
    await close(ctx);
  });

  /** The exact substring a frame carries for a notification, unambiguous between `id_5` and `id_51`. */
  const needle = (id: string): string => `"notificationId":"${id}"`;

  async function seedNotification(
    input: { userId?: string; createdAt?: Date; read?: boolean } = {},
  ): Promise<string> {
    const row = await ctx.fake.client.notification.create({
      data: {
        tenantId: ctx.tenantId,
        userId: input.userId ?? ctx.userId,
        kind: 'approval_request',
        title: 'Approve a thing',
        readAt: input.read === true ? new Date() : null,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      },
    });
    return row.id;
  }

  async function connect(): Promise<ReturnType<typeof makeReader>> {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/stream`, {
      headers: { cookie: ctx.cookie },
      signal: ctx.abort.signal,
    });
    const reader = makeReader(res);
    await reader.waitFor(': connected');
    return reader;
  }

  it('replays an unread notification as a notification.created frame', async () => {
    const id = await seedNotification();

    const text = await (await connect()).waitFor('notification.created');

    // The frame carries the row's id and nothing else — the same payload a live
    // `notification.created` carries, so a client has one handler for both.
    expect(text).toContain(`event: notification.created`);
    expect(text).toContain(needle(id));
  });

  it('replays them oldest first, so the feed reads chronologically', async () => {
    const base = Date.now();
    const older = await seedNotification({ createdAt: new Date(base - 60_000) });
    const newer = await seedNotification({ createdAt: new Date(base - 30_000) });

    const text = await (await connect()).waitFor(needle(newer));

    // The list read is newest-first, which is right for a panel and wrong for a replay: the
    // live frames that follow are newer than all of these, so a batch that arrived backwards
    // would make the feed jump into the past after its first lines.
    expect(text.indexOf(needle(older))).toBeGreaterThan(-1);
    expect(text.indexOf(needle(older))).toBeLessThan(text.indexOf(needle(newer)));
  });

  it('does not replay a notification that has already been read', async () => {
    const read = await seedNotification({ read: true });
    const unread = await seedNotification();

    const text = await (await connect()).waitFor(needle(unread));

    // Replaying read rows would resurrect a badge the operator already cleared.
    expect(text).toContain(needle(unread));
    expect(text).not.toContain(needle(read));
  });

  it('does not replay another user’s notifications', async () => {
    const colleague = await ctx.fake.client.user.create({
      data: {
        tenantId: ctx.tenantId,
        email: `colleague-${Date.now()}@example.com`,
        passwordHash: 'x',
        name: 'Grace',
      },
    });
    const theirs = await seedNotification({ userId: colleague.id });
    const mine = await seedNotification();

    const text = await (await connect()).waitFor(needle(mine));

    // The highest-severity assertion in this block. A tenant-wide replay would tell one member
    // how much unread mail another member has — and would hand them a notification id that
    // every later read of that row refuses, so the leak is small and entirely real.
    expect(text).toContain(needle(mine));
    expect(text).not.toContain(needle(theirs));
  });

  it('replays nothing for a user with no unread notifications', async () => {
    const text = await (await connect()).settle();

    expect(text).toContain(': connected');
    expect(text).not.toContain('notification.created');
  });

  it('bounds the replay instead of pushing every unread row', async () => {
    const base = Date.now();
    const total = STREAM_REPLAY_MAX_NOTIFICATIONS + 3;
    for (let i = 0; i < total; i += 1) {
      await seedNotification({ createdAt: new Date(base - (total - i) * 1_000) });
    }

    const reader = await connect();
    await reader.waitFor('notification.created');
    const text = await reader.settle(1_000);

    // A bound rather than "all of them", and safe because the replay is a nudge: the
    // authoritative list is the REST refetch, so a user past the cap still gets a correct
    // list — they just do not get every id pushed down a socket still being opened.
    const count = text.split('event: notification.created').length - 1;
    expect(count).toBe(STREAM_REPLAY_MAX_NOTIFICATIONS);
  });

  it('delivers live frames after the replay', async () => {
    await seedNotification();
    const reader = await connect();
    await reader.waitFor('notification.created');

    // The replay is written after `attach`, so it must not leave the connection in a state
    // where ordinary fan-out stops working — which is what a synchronous throw inside the
    // replay would do if it were not caught.
    ctx.container.sseHub.publish(
      { name: 'run.started', payload: { runId: 'run_after_replay' } },
      ctx.tenantId,
    );

    const text = await reader.waitFor('run_after_replay');
    expect(text).toContain('event: run.started');
  });

  it('keeps the stream usable when the replay read fails', async () => {
    // A controller whose notification read always throws, behind the real router and the real
    // auth middleware. The connection must still open and still carry live frames: a failed
    // convenience must not take down the transport it was decorating.
    const ctx2 = await build();
    const probe = express();
    // `cookieParser` is not optional here. The real app installs it before the routers, and
    // without it `req.cookies` is undefined, so the cookie this test sends is invisible, the
    // request fails authentication, and the failure surfaces as a 500 from Express's default
    // error handler rather than as the 401 it is.
    probe.use(cookieParser());
    probe.use(
      '/api/stream',
      createStreamRouter({
        controller: createStreamController({
          hub: ctx2.container.sseHub,
          notifications: {
            list: async () => {
              throw new Error('the notification store is unavailable');
            },
          } as unknown as NotificationService,
          logger: createLogger(loadConfig()),
        }),
        authRequired: createAuthRequired({
          users: ctx2.container.users,
          tokens: ctx2.container.tokens,
        }),
      }),
    );

    const server = probe.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/stream`, {
        headers: { cookie: ctx2.cookie },
        signal: ctx2.abort.signal,
      });
      expect(res.status).toBe(200);

      const reader = makeReader(res);
      await reader.waitFor(': connected');

      ctx2.container.sseHub.publish(
        { name: 'run.started', payload: { runId: 'run_despite_failure' } },
        ctx2.tenantId,
      );
      const text = await reader.waitFor('run_despite_failure');
      expect(text).toContain('event: run.started');
      expect(text).not.toContain('notification.created');
    } finally {
      ctx2.abort.abort();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await close(ctx2);
    }
  });
});
