import type { Prisma, PrismaClient, Skill, SkillVersion } from '@prisma/client';

export type JsonInput = Prisma.InputJsonValue;

/**
 * Persistence for skills and their versions.
 *
 * `Skill` is tenant-owned; `SkillVersion` is not. A version row carries no `tenantId`, so its
 * ownership is the skill it belongs to — the caller reads the skill through
 * `SkillRepository.findById(tenantId, …)` first and passes the resulting id, exactly as
 * `ConnectorAccount` is proven through its connector.
 */
export class SkillRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: {
    tenantId: string;
    name: string;
    description?: string | null;
    status?: string;
  }): Promise<Skill> {
    return this.db.skill.create({ data });
  }

  /** Tenant-scoped: the tenant is the first argument and is always in the where. */
  async findById(tenantId: string, id: string): Promise<Skill | null> {
    return this.db.skill.findFirst({ where: { id, tenantId } });
  }

  /**
   * Look a skill up by name.
   *
   * `Skill` has a `@@unique([tenantId, name])`, so this is how a duplicate is detected before an
   * insert rather than by catching the constraint violation afterwards — the service turns it into
   * a `CONFLICT` naming the existing skill, which is a better error than a raw unique violation.
   */
  async findByName(tenantId: string, name: string): Promise<Skill | null> {
    return this.db.skill.findFirst({ where: { tenantId, name } });
  }

  /**
   * List a tenant's skills, newest first.
   *
   * `q` is a case-insensitive substring match on the name, because §5.3's mention picker resolves
   * `kind=skill` from a live query. `mode: 'insensitive'` is a Prisma-level option that the
   * Postgres provider implements with `ILIKE`; the in-memory fake applies the same rule, so a test
   * that passes here describes the real query.
   */
  async list(
    tenantId: string,
    filters: { status?: string; q?: string } = {},
  ): Promise<Skill[]> {
    return this.db.skill.findMany({
      where: {
        tenantId,
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.q === undefined ? {} : { name: { contains: filters.q, mode: 'insensitive' } }),
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Edit a skill's metadata.
   *
   * There is no `promptTemplate` here and there never will be: the template lives on a *version*,
   * and rewriting it in place would falsify every run that already used that version.
   */
  async update(
    tenantId: string,
    id: string,
    data: { name?: string; description?: string | null; status?: string },
  ): Promise<number> {
    const { count } = await this.db.skill.updateMany({ where: { id, tenantId }, data });
    return count;
  }

  async delete(tenantId: string, id: string): Promise<number> {
    const { count } = await this.db.skill.deleteMany({ where: { id, tenantId } });
    return count;
  }
}

/**
 * Versions of a skill.
 *
 * **No method here takes a tenant** — see the file header. The one method that matters is
 * `publish`, and it is the reason this repository has a transaction at all.
 */
export class SkillVersionRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Publish the next version.
   *
   * The version number is **read and incremented inside the transaction**, never supplied by a
   * caller. A caller-chosen number would let two concurrent publishes both claim version 4 — and
   * the `@@unique([skillId, version])` constraint would turn that into a 500 rather than a
   * correct second version.
   *
   * The read is `orderBy version desc, take 1` rather than `aggregate _max`: both are correct, and
   * this one is expressed in the same vocabulary as every other query in this directory.
   *
   * The transaction is what makes the number safe under concurrency. The constraint is the
   * backstop — if two transactions somehow interleave, the second fails loudly rather than
   * overwriting, which is the correct failure for a record that must never be rewritten.
   */
  async publish(
    skillId: string,
    data: { promptTemplate: string; argsSchema?: JsonInput },
  ): Promise<SkillVersion> {
    return this.db.$transaction(async (tx) => {
      const latest = await tx.skillVersion.findFirst({
        where: { skillId },
        orderBy: { version: 'desc' },
      });

      return tx.skillVersion.create({
        data: {
          skillId,
          version: (latest?.version ?? 0) + 1,
          promptTemplate: data.promptTemplate,
          ...(data.argsSchema === undefined ? {} : { argsSchema: data.argsSchema }),
        },
      });
    });
  }

  /** Newest first: the detail page shows the current version at the top. */
  async listForSkill(skillId: string): Promise<SkillVersion[]> {
    return this.db.skillVersion.findMany({ where: { skillId }, orderBy: { version: 'desc' } });
  }

  async findById(id: string): Promise<SkillVersion | null> {
    return this.db.skillVersion.findFirst({ where: { id } });
  }

  /**
   * Every version of a skill.
   *
   * Called explicitly when a skill is deleted rather than relying on the schema's
   * `onDelete: Cascade`. The cascade is real and stays as a backstop, but a version row has no
   * `tenantId` and is only reachable through its skill — so if the cascade ever did not fire,
   * orphaned versions would accumulate where nothing could see them. The same reasoning
   * `ConnectorService.remove` applies to accounts.
   */
  async deleteForSkill(skillId: string): Promise<number> {
    const { count } = await this.db.skillVersion.deleteMany({ where: { skillId } });
    return count;
  }

  async latestForSkill(skillId: string): Promise<SkillVersion | null> {
    return this.db.skillVersion.findFirst({ where: { skillId }, orderBy: { version: 'desc' } });
  }

  /**
   * How many versions each of these skills has, keyed by skill id.
   *
   * One grouped query for the list page, for the same reason `countsByConnector` exists: a row per
   * skill each wanting its own count is a query per row otherwise. The ids come from a
   * tenant-scoped read of `Skill`, which is what makes the unscoped `where` safe.
   */
  async countsBySkill(skillIds: readonly string[]): Promise<Map<string, number>> {
    if (skillIds.length === 0) return new Map();
    const groups = await this.db.skillVersion.groupBy({
      by: ['skillId'],
      where: { skillId: { in: [...skillIds] } },
      _count: true,
    });
    return new Map(
      groups.map((group) => [
        group.skillId,
        typeof group._count === 'number' ? group._count : 0,
      ]),
    );
  }

  /**
   * The highest version per skill, for the list page's `latestVersion`.
   *
   * `groupBy` with `_max` rather than fetching every version: a skill with forty versions should
   * cost the same as one with two, and the list page needs one number from each.
   */
  async latestVersionsBySkill(skillIds: readonly string[]): Promise<Map<string, number>> {
    if (skillIds.length === 0) return new Map();
    const groups = await this.db.skillVersion.groupBy({
      by: ['skillId'],
      where: { skillId: { in: [...skillIds] } },
      _max: { version: true },
    });
    return new Map(
      groups
        .filter((group) => group._max.version !== null)
        .map((group) => [group.skillId, group._max.version as number]),
    );
  }
}
