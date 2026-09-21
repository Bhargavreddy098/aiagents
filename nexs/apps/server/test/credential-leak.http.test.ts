import request from 'supertest';
import type { Express } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_ACCESS } from '@nexs/shared';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * Nothing a tenant stored as a credential may come back out of any GET.
 *
 * ## The property, and why it is checked this way
 *
 * The spec's security pass asks for one thing here: *"no key in any GET response (scan with mock
 * vault)"*. The existing tests cover the rule **per surface** — `providers.http.test.ts` and
 * `connectors.http.test.ts` each scan their own POST response for their own plaintext — and that
 * is the right test for each of those files. It is not the right test for the rule, because the
 * rule is about the *whole* API: a new mapper, a new detail field, a `...row` spread in a
 * controller, and a credential is on the wire through a route neither of those files knows about.
 *
 * So this file scans the way an attacker would: **every GET route the application has mounted**,
 * with a credential actually stored, looking for the plaintext in the serialized body.
 *
 * ## Why the route list is read out of the application rather than written down
 *
 * A hand-written list of paths is a list that goes stale the moment somebody adds a router — and
 * it goes stale *silently*, which is the worst property a security test can have. Express exposes
 * its own route table, so the list is derived from the thing being tested. The cost is that the
 * derivation depends on Express internals (`router.stack`, and `matchers` to recover a mount
 * prefix), which is why there is an explicit guard below: a mounted router whose prefix cannot be
 * resolved **fails** the scan rather than being skipped. An Express upgrade that changes the
 * internals therefore breaks this file loudly, which is the outcome to want.
 *
 * ## What makes the scan have teeth
 *
 * A scan that walks a hundred routes which all return 404 proves nothing — every one of those
 * bodies is the error handler's. Two assertions keep it honest: the credential-bearing endpoints
 * must answer **200** (so the mappers actually ran), and one of them must return a **masked** form
 * of the planted key (so a response that has a key-derived field on it was really read). Without
 * those, this file would keep passing after the leak it exists to catch. The first draft of it did
 * exactly that: a bug in the id plumbing sent `nexs_probe_id` to every `:param` route, every one of
 * them 404'd, and the leak assertions below were green on an API that had never been read.
 *
 * ## Three things are hunted, not one
 *
 * The plaintext is the obvious one. The **vault master key** is worse — it decrypts every tenant's
 * credentials, so it must never be reachable from any request. And the **stored ciphertext** is the
 * quiet one: useless today, and a full disclosure the moment the master key is ever rotated and
 * the old one retained, which is exactly what a rotation procedure does.
 */

const config = loadConfig();
const VALID_PASSWORD = 'correct horse battery staple';

/**
 * The planted secrets.
 *
 * Shaped like real credentials rather than like `"secret"`, so a scanner looking for a key-like
 * pattern in a log or a response would find these the way it would find a real one.
 */
const SECRETS = {
  providerKey: 'sk-proj-LEAKCANARY0000000000000000abcd',
  connectorToken: 'ghp_LEAKCANARY000000000000000000000000',
  mcpHeaderValue: 'Bearer mcp-LEAKCANARY-header-value',
  mcpEnvValue: 'mcp-LEAKCANARY-env-value',
} as const;

/** Every route prefix `app.ts` mounts. Kept here so a mount that cannot be resolved is caught. */
const MOUNT_PREFIXES = [
  '/api/health',
  '/api/auth',
  '/api/users',
  '/api/agents',
  '/api/goals',
  '/api/tasks',
  '/api/workflows',
  '/api/runs',
  '/api/approvals',
  '/api/notifications',
  '/api/chat',
  '/api/memory',
  '/api/research',
  '/api/events',
  '/api/schedules',
  '/api/providers',
  '/api/models',
  '/api/tools',
  '/api/mcp',
  '/api/browser',
  '/api/sandbox',
  '/api/files',
  '/api/connectors',
  '/api/skills',
  '/api/dashboard',
  '/api/stream',
] as const;

/**
 * The one route the scan does not call.
 *
 * `GET /api/stream` does not answer — it opens a connection and holds it until the client goes
 * away, so a request against it would hang this file rather than scan it. Its frames are covered
 * where they belong: `stream.http.test.ts` drives the real controller and `sse-frame.test.ts`
 * checks the encoding. It is listed as a mount above and excluded here rather than omitted, so the
 * exclusion is visible and the router is still accounted for.
 */
const STREAM_PATH = '/api/stream';

/** Stands in for a `:param` with no seeded row behind it — a 404 body is still worth scanning. */
const PROBE_ID = 'nexs_probe_id';

/**
 * The GET routes that answer 5xx *by design*, and the only ones the "no server errors" check
 * tolerates.
 *
 * `GET /api/mcp/:id/resources` and `/prompts` read *through* the MCP session, so against a server
 * that has never been connected they report an upstream failure (`PROVIDER_ERROR` → 502) rather
 * than an empty list. That is the honest answer — "I could not ask" and "there is nothing" are
 * different facts, and only one of them is true — and it is deliberate rather than a crash: the
 * error handler builds it from a thrown `ApiError`.
 *
 * They are listed rather than excluded so the check stays exact. A 5xx anywhere else fails the
 * test, which is the property worth protecting: a route that broke before it could be read is a
 * route this scan never actually covered. Status exempts nothing from the leak assertions below —
 * these two bodies are scanned for secrets like every other response.
 */
const EXPECTED_UPSTREAM_FAILURES = ['resources', 'prompts'] as const;

interface RouteLayer {
  route?: { path?: string; methods?: Record<string, boolean> };
}

interface RouterLayer {
  name?: string;
  matchers?: Array<(path: string) => unknown>;
  handle?: { stack?: RouteLayer[] };
}

/** One GET route, with the mount prefix it belongs to kept alongside it. */
interface GetRoute {
  prefix: string;
  /** The path as declared, `:params` and all. */
  path: string;
}

/** The app's own route table, as the GET routes it has mounted. */
function collectGetRoutes(app: Express): { routes: GetRoute[]; unresolvedRouters: number } {
  const root = (app as unknown as { router?: { stack?: RouterLayer[] } }).router;
  const layers = root?.stack ?? [];

  const routes: GetRoute[] = [];
  let unresolvedRouters = 0;

  for (const layer of layers) {
    if (layer.name !== 'router') continue;

    // A mounted sub-router does not carry its prefix as a string, so it is recovered by asking
    // each candidate to match. This is the only piece of Express internals the file depends on,
    // and the guard in the caller is what keeps a change here from silently shrinking the scan.
    const prefix = MOUNT_PREFIXES.find((candidate) =>
      (layer.matchers ?? []).some((match) => Boolean(match(candidate))),
    );

    if (prefix === undefined) {
      unresolvedRouters += 1;
      continue;
    }

    for (const inner of layer.handle?.stack ?? []) {
      const route = inner.route;
      if (route?.path === undefined) continue;
      if (route.methods?.['get'] !== true) continue;
      routes.push({ prefix, path: prefix + (route.path === '/' ? '' : route.path) });
    }
  }

  return { routes, unresolvedRouters };
}

/**
 * The lookup key for a seeded row's id.
 *
 * Scoped to the mount, because `:id` means a provider id under `/api/providers` and an MCP server
 * id under `/api/mcp`. A flat `:id` → id map would send one route's id to another route's
 * endpoint, which is precisely the mistake that made the first draft of this file scan nothing.
 */
function idKey(prefix: string, param: string): string {
  return `${prefix}|${param}`;
}

/** Substitute `:params` with the real id of a seeded row, so a mapper runs instead of a 404. */
function fillParams(route: GetRoute, ids: Record<string, string>): string {
  return route.path.replace(
    /:([A-Za-z0-9_]+)/g,
    (whole) => ids[idKey(route.prefix, whole)] ?? PROBE_ID,
  );
}

interface Scanned {
  path: string;
  status: number;
  /** The serialized body, whatever its content type. */
  body: string;
}

interface Ctx {
  app: Express;
  fake: FakeDb;
  cookie: string;
  ids: Record<string, string>;
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

  const signup = await request(app)
    .post('/api/auth/signup')
    .send({ email: `leak-${Date.now()}@example.com`, password: VALID_PASSWORD, name: 'Ada' });

  const raw = signup.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const access = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`));
  if (access === undefined) throw new Error('signup did not set an access cookie');

  const cookie = access.split(';')[0]!;

  // ── plant a credential on every surface that has a vault ────────────────────
  //
  // Each points at port 1, which is reserved and never listening. That is deliberate: a probe
  // against an unreachable vendor fails fast, so the *row and its credential* are written without
  // any test needing a fake vendor server, and what is being scanned is the read path rather than
  // a successful integration.
  const provider = await request(app).post('/api/providers').set('Cookie', cookie).send({
    name: 'Leak Canary',
    type: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: SECRETS.providerKey,
  });
  expect(provider.status, 'the provider fixture must be created for the scan to mean anything').toBe(201);

  const connector = await request(app).post('/api/connectors').set('Cookie', cookie).send({
    name: 'Leak Canary REST',
    type: 'rest',
    token: SECRETS.connectorToken,
    config: {
      baseUrl: 'http://127.0.0.1:1/v1',
      actions: [{ action: 'ping', name: 'Ping', method: 'GET', path: '/ping' }],
    },
  });
  expect(connector.status, 'the connector fixture must be created for the scan to mean anything').toBe(201);

  // `connect: false` — this row is a *record* of a server, and starting a child process to prove
  // that would make the scan depend on something outside it.
  const mcp = await request(app).post('/api/mcp').set('Cookie', cookie).send({
    name: 'Leak Canary MCP',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:1/mcp',
    headers: { 'X-Canary-Token': SECRETS.mcpHeaderValue },
    env: { NEXS_CANARY_TOKEN: SECRETS.mcpEnvValue },
    connect: false,
  });
  expect(mcp.status, 'the mcp fixture must be created for the scan to mean anything').toBe(201);

  const ids: Record<string, string> = {
    [idKey('/api/providers', ':id')]: String(provider.body.provider.id),
    [idKey('/api/connectors', ':id')]: String(connector.body.connector.id),
    [idKey('/api/mcp', ':id')]: String(mcp.body.server.id),
  };

  return { app, fake, cookie, ids };
}

/** GET every route the app mounts, and record what came back. */
async function scanEveryGet(ctx: Ctx): Promise<{ scanned: Scanned[]; unresolvedRouters: number }> {
  const { routes, unresolvedRouters } = collectGetRoutes(ctx.app);
  const scanned: Scanned[] = [];

  for (const route of routes) {
    if (route.path === STREAM_PATH) continue;

    const filled = fillParams(route, ctx.ids);
    const res = await request(ctx.app).get(filled).set('Cookie', ctx.cookie);

    scanned.push({
      path: filled,
      status: res.status,
      // `res.text` for every content type: a JSON body and an HTML body are both places a field
      // can be echoed back, and a scan that only read `res.body` would miss a plain-text one.
      body: typeof res.text === 'string' ? res.text : JSON.stringify(res.body ?? null),
    });
  }

  return { scanned, unresolvedRouters };
}

let ctx: Ctx;
let scanned: Scanned[];
let unresolvedRouters: number;

beforeEach(async () => {
  ctx = await build();
  ({ scanned, unresolvedRouters } = await scanEveryGet(ctx));
});

// ── the scan is complete ──────────────────────────────────────────────────────

describe('the scan itself', () => {
  it('resolves every mounted router', () => {
    // The guard that keeps this file from silently shrinking. If Express changes how a mount
    // prefix is stored, the routes under that router stop being scanned — and without this
    // assertion the file would go on passing while checking less.
    expect(unresolvedRouters, 'a mounted router could not be resolved to a prefix').toBe(0);
  });

  it('covers a plausible share of the API', () => {
    // A floor rather than an exact count, so adding a route does not fail the suite but losing
    // the ability to enumerate them does.
    expect(scanned.length).toBeGreaterThanOrEqual(40);
    expect(
      new Set(scanned.map((r) => r.path.split('/').slice(0, 3).join('/'))).size,
    ).toBeGreaterThanOrEqual(20);
  });

  it('does not answer any GET with an unexpected server error', () => {
    // A 5xx is a route that failed before it could be read. Tolerating one would mean a leak
    // behind a broken endpoint is invisible to this file, so only the two documented upstream
    // failures are allowed through — anything else is a route this scan did not really cover.
    const broken = scanned
      .filter((r) => r.status >= 500)
      .filter((r) => !EXPECTED_UPSTREAM_FAILURES.some((suffix) => r.path.endsWith(`/${suffix}`)));

    expect(broken.map((r) => `${r.status} ${r.path}`)).toEqual([]);
  });

  it('reports a disconnected MCP server as an upstream failure, which is why those two are allowed', () => {
    // Pins the reason the allowance above exists, so it cannot quietly become dead code covering
    // for something else. A disconnected server answers 502 rather than 200-with-nothing, because
    // "I could not ask" and "there is nothing" are different answers.
    const byPath = new Map(scanned.map((r) => [r.path, r.status]));
    const mcpId = ctx.ids[idKey('/api/mcp', ':id')];

    expect(byPath.get(`/api/mcp/${mcpId}/resources`)).toBe(502);
    expect(byPath.get(`/api/mcp/${mcpId}/prompts`)).toBe(502);
  });

  it('reaches the mappers rather than 404ing its way to a pass', () => {
    // The anti-vacuity check. These are the endpoints that can carry a credential, so they are the
    // ones that have to have answered — a scan whose credential routes all returned 404 would pass
    // for the wrong reason, and would keep passing after a real leak was introduced.
    const byPath = new Map(scanned.map((r) => [r.path, r.status]));
    const providerId = ctx.ids[idKey('/api/providers', ':id')];
    const connectorId = ctx.ids[idKey('/api/connectors', ':id')];
    const mcpId = ctx.ids[idKey('/api/mcp', ':id')];

    for (const path of [
      '/api/providers',
      `/api/providers/${providerId}`,
      '/api/connectors',
      `/api/connectors/${connectorId}`,
      `/api/connectors/${connectorId}/accounts`,
      '/api/mcp',
      `/api/mcp/${mcpId}`,
    ]) {
      expect(byPath.get(path), `${path} was not scanned`).toBeDefined();
      expect(byPath.get(path), path).toBe(200);
    }
  });

  it('proves a key-derived field was actually read', () => {
    // The other half of the anti-vacuity check, and the sharper one. It is not enough that the
    // provider list answered 200 — it has to have carried the masked key, which is the only trace
    // of the credential allowed on the wire. If that field ever disappears from the mapper, the
    // scan below stops having anything to find and this assertion says so.
    const list = scanned.find((r) => r.path === '/api/providers');
    const parsed = JSON.parse(list!.body) as {
      providers: Array<{ keyPrefix: string | null; hasCredential: boolean }>;
    };

    const row = parsed.providers[0]!;
    expect(row.hasCredential).toBe(true);
    expect(row.keyPrefix).not.toBeNull();

    // A masked key is a *truncation* of the real one — first four and last four — so it is neither
    // the secret nor a value unrelated to it.
    const masked = row.keyPrefix!;
    expect(masked).not.toBe(SECRETS.providerKey);
    expect(masked.startsWith(SECRETS.providerKey.slice(0, 4))).toBe(true);
    expect(masked.endsWith(SECRETS.providerKey.slice(-4))).toBe(true);
  });
});

// ── nothing leaked ────────────────────────────────────────────────────────────

describe('what came back', () => {
  it('never contains a stored plaintext credential', () => {
    for (const [label, secret] of Object.entries(SECRETS)) {
      const leaking = scanned.filter((r) => r.body.includes(secret));
      expect(leaking.map((r) => `${label} in ${r.path}`)).toEqual([]);
    }
  });

  it('never contains the signing secret the vault key is derived from', () => {
    // Worse than any single credential. `JWT_SECRET` is now the *only* key material in the app:
    // the vault key is derived from it, so it opens every tenant's stored secrets, and it also
    // signs every access token. It is reachable only through configuration, so its appearance in
    // a response would mean a config object had been spread into a body somewhere.
    const leaking = scanned.filter((r) => r.body.includes(config.JWT_SECRET));
    expect(leaking.map((r) => r.path)).toEqual([]);
  });

  it('never contains a stored ciphertext', async () => {
    // The quiet one. A ciphertext is useless without the master key — until a rotation retires the
    // key, which is precisely when an old ciphertext becomes a disclosure. Reading it from the
    // database is the only way to check for it, because the vault's output is non-deterministic
    // (a fresh nonce per encryption), so there is no value the test could construct to look for.
    const credentials = await ctx.fake.client.credential.findMany({});
    expect(credentials.length).toBeGreaterThan(0);

    for (const credential of credentials) {
      const leaking = scanned.filter((r) => r.body.includes(credential.encrypted));
      expect(leaking.map((r) => r.path), `ciphertext of ${credential.id}`).toEqual([]);
    }
  });

  it('never contains the credential id, which is a pointer rather than a secret', async () => {
    // Not a secret in itself — but it names a row in the vault, and a pointer on the wire is a
    // thing to probe with. `toProviderSummary` already strips `apiKeyRef`; this holds that.
    const credentials = await ctx.fake.client.credential.findMany({});

    for (const credential of credentials) {
      const leaking = scanned.filter((r) => r.body.includes(credential.id));
      expect(leaking.map((r) => r.path), `credential id ${credential.id}`).toEqual([]);
    }
  });
});
