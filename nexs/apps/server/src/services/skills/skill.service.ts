import { ApiError } from '@nexs/shared';
import type {
  CreateSkillInput,
  CreateSkillVersionInput,
  ListSkillsQuery,
  SkillDetail,
  SkillSummary,
  SkillVersionSummary,
  UpdateSkillInput,
} from '@nexs/shared';
import type { Skill } from '@prisma/client';
import type { SkillRepository, SkillVersionRepository } from '../../repositories/skill.repo.js';
import type { Logger } from '../../logger.js';
import { toSkillDetail, toSkillSummary, toSkillVersionSummary } from '../../mappers/skills.js';

/**
 * `/api/skills` — the tenant's library of reusable prompt templates.
 *
 * ## The rule this service exists to enforce
 *
 * **A version is published, never edited.** There is no method here that takes a version number and
 * a new template, and the repository chooses the number inside a transaction. Editing a skill means
 * publishing the next version, which is what lets a run that used version 3 keep showing what
 * version 3 said.
 *
 * ## Why `create` needs a compensating delete
 *
 * Creating a skill is two writes in two repositories: the skill row, then its first version. There
 * is no transaction spanning them — each repository owns its own — so if the version write fails,
 * the skill row would survive with nothing published. That state is *representable* (the wire type
 * has `latestVersion: null` for exactly this reason) but it is not a state the create endpoint
 * should ever produce, because a caller who supplied a template and got a `201` is entitled to a
 * usable skill.
 *
 * So the delete is compensating rather than cleanup: it is safe precisely because the skill was
 * created a moment ago and nothing can reference it yet.
 */

export interface SkillServiceDeps {
  skills: SkillRepository;
  versions: SkillVersionRepository;
  logger: Logger;
}

export class SkillService {
  constructor(private readonly deps: SkillServiceDeps) {}

  // ── reading ─────────────────────────────────────────────────────────────────

  /**
   * List a tenant's skills with their version counts.
   *
   * Two grouped queries for the whole page rather than two per row: `versionCount` and
   * `latestVersion` both come from `SkillVersion`, and a skill list that issued four queries per
   * skill would be the slowest page in the product.
   */
  async list(tenantId: string, query: ListSkillsQuery): Promise<SkillSummary[]> {
    const rows = await this.deps.skills.list(tenantId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.q === undefined ? {} : { q: query.q }),
    });

    // Sliced in memory, after filtering, so the counts cover exactly the rows returned. Pushing the
    // window into SQL would need a second query to know the total.
    const page = rows.slice(query.offset, query.offset + query.limit);
    const ids = page.map((row) => row.id);
    const [counts, latest] = await Promise.all([
      this.deps.versions.countsBySkill(ids),
      this.deps.versions.latestVersionsBySkill(ids),
    ]);

    return page.map((row) =>
      toSkillSummary(row, {
        versionCount: counts.get(row.id) ?? 0,
        latestVersion: latest.get(row.id) ?? null,
      }),
    );
  }

  async get(tenantId: string, id: string): Promise<SkillDetail> {
    const skill = await this.require(tenantId, id);
    const versions = await this.deps.versions.listForSkill(skill.id);

    return toSkillDetail(
      skill,
      {
        versionCount: versions.length,
        // Read off the rows already in hand rather than a third query. The list is newest-first,
        // so the first entry is the highest version.
        latestVersion: versions[0]?.version ?? null,
      },
      versions,
    );
  }

  async listVersions(tenantId: string, id: string): Promise<SkillVersionSummary[]> {
    const skill = await this.require(tenantId, id);
    const versions = await this.deps.versions.listForSkill(skill.id);
    return versions.map(toSkillVersionSummary);
  }

  // ── writing ─────────────────────────────────────────────────────────────────

  async create(tenantId: string, input: CreateSkillInput): Promise<SkillDetail> {
    // Checked before the insert so the error names the existing skill. Catching the unique
    // violation afterwards would work, but it can only report "a skill with that name exists" —
    // this can report which one, which is what an operator needs to resolve it.
    const existing = await this.deps.skills.findByName(tenantId, input.name);
    if (existing !== null) {
      throw new ApiError('CONFLICT', `A skill named "${input.name}" already exists`, {
        skillId: existing.id,
      });
    }

    const skill = await this.deps.skills.create({
      tenantId,
      name: input.name,
      description: input.description ?? null,
      status: 'active',
    });

    try {
      await this.deps.versions.publish(skill.id, {
        promptTemplate: input.promptTemplate,
        ...(input.argsSchema === undefined ? {} : { argsSchema: input.argsSchema as never }),
      });
    } catch (error) {
      // Compensating delete — see the class comment for why this is safe rather than lossy.
      await this.deps.skills.delete(tenantId, skill.id);
      throw error;
    }

    return this.get(tenantId, skill.id);
  }

  async update(tenantId: string, id: string, input: UpdateSkillInput): Promise<SkillDetail> {
    const skill = await this.require(tenantId, id);

    // A rename must not collide with another skill. Without this the unique index would reject it
    // as a raw constraint violation, and `findByName` can point at the skill that is in the way.
    if (input.name !== undefined && input.name !== skill.name) {
      const clash = await this.deps.skills.findByName(tenantId, input.name);
      if (clash !== null && clash.id !== skill.id) {
        throw new ApiError('CONFLICT', `A skill named "${input.name}" already exists`, {
          skillId: clash.id,
        });
      }
    }

    await this.deps.skills.update(tenantId, id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });

    return this.get(tenantId, id);
  }

  /**
   * Publish the next version.
   *
   * Allowed on a disabled skill, deliberately. Disabling stops a skill being *offered*; preparing
   * its next version while it is off is a normal workflow, and refusing it would mean an operator
   * has to re-enable a skill they disabled in order to edit it — which is the kind of rule that
   * gets worked around rather than followed.
   */
  async publishVersion(
    tenantId: string,
    id: string,
    input: CreateSkillVersionInput,
  ): Promise<SkillDetail> {
    const skill = await this.require(tenantId, id);

    const version = await this.deps.versions.publish(skill.id, {
      promptTemplate: input.promptTemplate,
      ...(input.argsSchema === undefined ? {} : { argsSchema: input.argsSchema as never }),
    });

    this.deps.logger.info(
      { skillId: skill.id, version: version.version },
      'skill version published',
    );

    return this.get(tenantId, skill.id);
  }

  /**
   * Delete a skill, and its versions with it.
   *
   * The versions are deleted **explicitly** rather than left to the schema's `onDelete: Cascade`.
   * The cascade is real and stays as a backstop, but a version row carries no `tenantId` and is
   * only reachable through its skill, so if the cascade ever failed to fire the orphans would
   * accumulate somewhere nothing could see them. Deleting explicitly also makes the behaviour
   * observable in a test — which is how it was found that the in-memory fake does not model
   * cascades at all. `ConnectorService.remove` makes the same choice for accounts, for the same
   * reason.
   *
   * Order matters: versions first, so a failure part-way through leaves a skill with no versions
   * (recoverable, and visibly empty) rather than orphaned versions with no skill (invisible).
   */
  async remove(tenantId: string, id: string): Promise<void> {
    const skill = await this.require(tenantId, id);

    const versions = await this.deps.versions.deleteForSkill(skill.id);
    await this.deps.skills.delete(tenantId, skill.id);

    this.deps.logger.info(
      { skillId: skill.id, name: skill.name, versions },
      'skill deleted',
    );
  }

  private async require(tenantId: string, id: string): Promise<Skill> {
    const skill = await this.deps.skills.findById(tenantId, id);
    if (skill === null) throw new ApiError('NOT_FOUND', 'Skill not found', { id });
    return skill;
  }
}
