import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_ACCESS, type SkillDetail } from '@nexs/shared';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * `/api/skills` as a client sees it.
 *
 * ## The rule these tests exist to pin down
 *
 * **A version is published, never edited.** So the assertions are mostly about version *numbers*:
 * that the first publish is 1, that the second is 2, that a caller cannot choose one, and that
 * changing what a skill says produces a new row rather than rewriting the old one. That is the
 * property that lets a run which used version 1 keep showing what version 1 said.
 *
 * ## One thing this suite deliberately does not assert
 *
 * `q` is a case-insensitive substring match — `mode: 'insensitive'`, which Postgres implements as
 * `ILIKE`. The in-memory fake accepts the option and **treats it as case-sensitive** (see the
 * `mode` case in `helpers/fake-db.ts`). So the assertions below use a case-matching query and the
 * insensitivity itself is left uncovered rather than asserted against a fake that cannot model it.
 * A test that claimed to prove `ILIKE` here would be proving something about the fake.
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
    .send({ email: `skills-${Date.now()}-${Math.random()}@example.com`, password: VALID_PASSWORD, name: 'Ada' });

  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const access = cookies.find((c) => c.startsWith(`${COOKIE_ACCESS}=`));
  if (access === undefined) throw new Error('signup did not set an access cookie');

  return { app, fake, cookie: access.split(';')[0]! };
}

/** Create a skill and return its detail. `SkillDetail` carries `id`, so callers can destructure. */
async function createSkill(
  ctx: Ctx,
  overrides: Record<string, unknown> = {},
): Promise<SkillDetail> {
  const res = await request(ctx.app)
    .post('/api/skills')
    .set('Cookie', ctx.cookie)
    .send({ name: 'Summarise', promptTemplate: 'Summarise {{text}}', ...overrides });

  expect(res.status).toBe(201);
  return res.body.skill as SkillDetail;
}

describe('/api/skills', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await build();
  });

  // ── auth ────────────────────────────────────────────────────────────────────

  describe('authentication', () => {
    it('refuses every route without a session', async () => {
      await expect(request(ctx.app).get('/api/skills')).resolves.toMatchObject({ status: 401 });
      await expect(
        request(ctx.app).post('/api/skills').send({ name: 'x', promptTemplate: 'y' }),
      ).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).get('/api/skills/skl_1')).resolves.toMatchObject({
        status: 401,
      });
      await expect(
        request(ctx.app).patch('/api/skills/skl_1').send({ name: 'x' }),
      ).resolves.toMatchObject({ status: 401 });
      await expect(request(ctx.app).delete('/api/skills/skl_1')).resolves.toMatchObject({
        status: 401,
      });
      await expect(request(ctx.app).get('/api/skills/skl_1/versions')).resolves.toMatchObject({
        status: 401,
      });
      await expect(
        request(ctx.app).post('/api/skills/skl_1/versions').send({ promptTemplate: 'y' }),
      ).resolves.toMatchObject({ status: 401 });
    });
  });

  // ── creating ────────────────────────────────────────────────────────────────

  describe('creating a skill', () => {
    it('publishes version 1 immediately, so a created skill is usable', async () => {
      const created = await createSkill(ctx);

      expect(created).toMatchObject({
        name: 'Summarise',
        status: 'active',
        latestVersion: 1,
        versionCount: 1,
      });
      expect(created.versions).toHaveLength(1);
      expect(created.versions[0]!.version).toBe(1);
      // A prompt is not a secret — unlike a connector token this is the whole point of the row.
      expect(created.versions[0]!.promptTemplate).toBe('Summarise {{text}}');
    });

    it('refuses a skill with no template, because it would exist and do nothing', async () => {
      const res = await request(ctx.app)
        .post('/api/skills')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Empty' });

      expect(res.status).toBe(400);
    });

    it('refuses a duplicate name, naming the skill in the way', async () => {
      const first = await createSkill(ctx);

      const res = await request(ctx.app)
        .post('/api/skills')
        .set('Cookie', ctx.cookie)
        .send({ name: 'Summarise', promptTemplate: 'another' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.details.skillId).toBe(first.id);
    });

    it('refuses an unknown field', async () => {
      const res = await request(ctx.app)
        .post('/api/skills')
        .set('Cookie', ctx.cookie)
        .send({ name: 'X', promptTemplate: 'y', version: 99 });

      expect(res.status).toBe(400);
    });
  });

  // ── versions ────────────────────────────────────────────────────────────────

  describe('publishing versions', () => {
    it('increments the version rather than rewriting the previous one', async () => {
      const skill = await createSkill(ctx);
      const firstVersionId = skill.versions[0]!.id;

      const res = await request(ctx.app)
        .post(`/api/skills/${skill.id}/versions`)
        .set('Cookie', ctx.cookie)
        .send({ promptTemplate: 'Summarise {{text}} in {{language}}' });

      expect(res.status).toBe(201);
      expect(res.body.skill.latestVersion).toBe(2);
      expect(res.body.skill.versionCount).toBe(2);
      // Newest first.
      expect(res.body.skill.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);

      // The first version is untouched — that is what makes a historical run renderable.
      const original = res.body.skill.versions.find((v: { version: number }) => v.version === 1);
      expect(original.id).toBe(firstVersionId);
      expect(original.promptTemplate).toBe('Summarise {{text}}');
    });

    it('does not let a caller choose the version number', async () => {
      const { id } = await createSkill(ctx);

      const res = await request(ctx.app)
        .post(`/api/skills/${id}/versions`)
        .set('Cookie', ctx.cookie)
        .send({ promptTemplate: 'x', version: 42 });

      // The next version is the repository's to choose, inside a transaction. A caller-supplied
      // number would let two publishes both claim the same one.
      expect(res.status).toBe(400);
    });

    it('keeps every version in the list endpoint', async () => {
      const { id } = await createSkill(ctx);
      await request(ctx.app)
        .post(`/api/skills/${id}/versions`)
        .set('Cookie', ctx.cookie)
        .send({ promptTemplate: 'v2' });

      const res = await request(ctx.app)
        .get(`/api/skills/${id}/versions`)
        .set('Cookie', ctx.cookie);

      expect(res.status).toBe(200);
      expect(res.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(res.body.versions[1].promptTemplate).toBe('Summarise {{text}}');
    });

    it('refuses to publish to an unknown skill', async () => {
      const res = await request(ctx.app)
        .post('/api/skills/skl_missing/versions')
        .set('Cookie', ctx.cookie)
        .send({ promptTemplate: 'x' });

      expect(res.status).toBe(404);
    });

    it('publishes to a disabled skill, because preparing one is not the same as offering it', async () => {
      const { id } = await createSkill(ctx);
      await request(ctx.app).patch(`/api/skills/${id}`).set('Cookie', ctx.cookie).send({ status: 'disabled' });

      const res = await request(ctx.app)
        .post(`/api/skills/${id}/versions`)
        .set('Cookie', ctx.cookie)
        .send({ promptTemplate: 'prepared while off' });

      expect(res.status).toBe(201);
      expect(res.body.skill.latestVersion).toBe(2);
      // Still disabled: publishing a version does not re-enable anything.
      expect(res.body.skill.status).toBe('disabled');
    });
  });

  // ── editing ─────────────────────────────────────────────────────────────────

  describe('editing a skill', () => {
    it('changes metadata without touching the versions', async () => {
      const { id } = await createSkill(ctx);

      const res = await request(ctx.app)
        .patch(`/api/skills/${id}`)
        .set('Cookie', ctx.cookie)
        .send({ description: 'Condenses a document', status: 'disabled' });

      expect(res.status).toBe(200);
      expect(res.body.skill).toMatchObject({
        description: 'Condenses a document',
        status: 'disabled',
        latestVersion: 1,
      });
    });

    it('refuses a rename onto an existing name', async () => {
      await createSkill(ctx, { name: 'Taken' });
      const { id } = await createSkill(ctx, { name: 'Mine' });

      const res = await request(ctx.app)
        .patch(`/api/skills/${id}`)
        .set('Cookie', ctx.cookie)
        .send({ name: 'Taken' });

      expect(res.status).toBe(409);
    });

    it('allows a rename to the name it already has', async () => {
      const { id } = await createSkill(ctx, { name: 'Same' });

      const res = await request(ctx.app)
        .patch(`/api/skills/${id}`)
        .set('Cookie', ctx.cookie)
        .send({ name: 'Same' });

      // A no-op rename is not a conflict with itself.
      expect(res.status).toBe(200);
    });

    it('refuses to rewrite the template through a patch', async () => {
      const { id } = await createSkill(ctx);

      const res = await request(ctx.app)
        .patch(`/api/skills/${id}`)
        .set('Cookie', ctx.cookie)
        .send({ promptTemplate: 'silently different' });

      // Changing what a skill says is a new version. A PATCH that rewrote version 1 in place would
      // falsify every run that already used it.
      expect(res.status).toBe(400);
    });
  });

  // ── listing ─────────────────────────────────────────────────────────────────

  describe('listing', () => {
    it('reports counts and the latest version per skill', async () => {
      const { id } = await createSkill(ctx, { name: 'Alpha' });
      await request(ctx.app)
        .post(`/api/skills/${id}/versions`)
        .set('Cookie', ctx.cookie)
        .send({ promptTemplate: 'second' });
      await createSkill(ctx, { name: 'Beta' });

      const res = await request(ctx.app).get('/api/skills').set('Cookie', ctx.cookie);

      expect(res.status).toBe(200);
      const byName = Object.fromEntries(
        res.body.skills.map((s: { name: string; latestVersion: number; versionCount: number }) => [
          s.name,
          { latestVersion: s.latestVersion, versionCount: s.versionCount },
        ]),
      );

      expect(byName.Alpha).toEqual({ latestVersion: 2, versionCount: 2 });
      expect(byName.Beta).toEqual({ latestVersion: 1, versionCount: 1 });
    });

    it('filters by status', async () => {
      const { id } = await createSkill(ctx, { name: 'Off' });
      await request(ctx.app).patch(`/api/skills/${id}`).set('Cookie', ctx.cookie).send({ status: 'disabled' });
      await createSkill(ctx, { name: 'On' });

      const res = await request(ctx.app).get('/api/skills?status=disabled').set('Cookie', ctx.cookie);

      expect(res.body.skills.map((s: { name: string }) => s.name)).toEqual(['Off']);
    });

    it('filters by name substring', async () => {
      await createSkill(ctx, { name: 'Summarise document' });
      await createSkill(ctx, { name: 'Translate' });

      const res = await request(ctx.app).get('/api/skills?q=Summarise').set('Cookie', ctx.cookie);

      expect(res.body.skills).toHaveLength(1);
      expect(res.body.skills[0].name).toBe('Summarise document');
    });

    it('refuses an unknown status value', async () => {
      const res = await request(ctx.app).get('/api/skills?status=archived').set('Cookie', ctx.cookie);
      expect(res.status).toBe(400);
    });
  });

  // ── deleting ────────────────────────────────────────────────────────────────

  describe('deleting a skill', () => {
    it('removes the skill and its versions', async () => {
      const { id } = await createSkill(ctx);

      const removed = await request(ctx.app)
        .delete(`/api/skills/${id}`)
        .set('Cookie', ctx.cookie);
      expect(removed.status).toBe(204);

      await expect(
        request(ctx.app).get(`/api/skills/${id}`).set('Cookie', ctx.cookie),
      ).resolves.toMatchObject({ status: 404 });

      // Deleted explicitly by the service, not by the schema's cascade — the in-memory fake does
      // not model cascades, so this assertion is only meaningful because the delete is a real
      // repository call. See `SkillService.remove`.
      expect(ctx.fake.tables.skillVersion!.length).toBe(0);
    });
  });

  // ── isolation and 404s ──────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('does not show one tenant a skill belonging to another', async () => {
      const mine = await createSkill(ctx, { name: 'Private' });
      const other = await build();

      await expect(
        request(other.app).get(`/api/skills/${mine.id}`).set('Cookie', other.cookie),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(other.app)
          .patch(`/api/skills/${mine.id}`)
          .set('Cookie', other.cookie)
          .send({ name: 'stolen' }),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(other.app).delete(`/api/skills/${mine.id}`).set('Cookie', other.cookie),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(other.app)
          .post(`/api/skills/${mine.id}/versions`)
          .set('Cookie', other.cookie)
          .send({ promptTemplate: 'x' }),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        request(other.app).get(`/api/skills/${mine.id}/versions`).set('Cookie', other.cookie),
      ).resolves.toMatchObject({ status: 404 });

      const theirs = await request(other.app).get('/api/skills').set('Cookie', other.cookie);
      expect(theirs.body.skills).toHaveLength(0);
    });

    it('lets two tenants use the same skill name', async () => {
      await createSkill(ctx, { name: 'Shared name' });
      const other = await build();

      const res = await request(other.app)
        .post('/api/skills')
        .set('Cookie', other.cookie)
        .send({ name: 'Shared name', promptTemplate: 'theirs' });

      // The unique index is `[tenantId, name]`, not `[name]`.
      expect(res.status).toBe(201);
    });
  });

  describe('unknown skills', () => {
    it('answers 404 rather than an empty object', async () => {
      const missing = 'skl_does_not_exist';
      await expect(request(ctx.app).get(`/api/skills/${missing}`).set('Cookie', ctx.cookie)).resolves.toMatchObject({ status: 404 });
      await expect(request(ctx.app).patch(`/api/skills/${missing}`).set('Cookie', ctx.cookie).send({ name: 'x' })).resolves.toMatchObject({ status: 404 });
      await expect(request(ctx.app).delete(`/api/skills/${missing}`).set('Cookie', ctx.cookie)).resolves.toMatchObject({ status: 404 });
      await expect(request(ctx.app).get(`/api/skills/${missing}/versions`).set('Cookie', ctx.cookie)).resolves.toMatchObject({ status: 404 });
    });
  });
});
