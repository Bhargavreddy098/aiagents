import type { Skill, SkillVersion } from '@prisma/client';
import type { SkillDetail, SkillSummary, SkillVersionSummary } from '@nexs/shared';

/**
 * Row-to-wire mapping for skills.
 *
 * The whole file exists because of one field: `latestVersion`. It is **not a column** — it is the
 * highest `version` among the skill's rows, and it is passed in rather than read here. Two reasons
 * that matters:
 *
 * - A mapper must not query. Reading the versions here would make rendering a list of skills an
 *   N+1, and the count and the maximum are already available from one grouped query.
 * - A cached `latestVersion` column would be a second source of truth for a fact the version rows
 *   already determine, and its failure mode — a "latest" naming a version that does not exist — is
 *   precisely the wrong number the honesty rule exists to prevent.
 *
 * `null` is a reachable value and is preserved. Version numbers start at 1, so a skill with no
 * published version reports `null` rather than `0`, which on screen would look like a real version.
 */

export function toSkillVersionSummary(version: SkillVersion): SkillVersionSummary {
  return {
    id: version.id,
    version: version.version,
    // A prompt is not a secret. Unlike a connector token this is the whole point of the row.
    promptTemplate: version.promptTemplate,
    argsSchema: version.argsSchema,
    createdAt: version.createdAt.toISOString(),
  };
}

export function toSkillSummary(
  skill: Skill,
  counts: { versionCount: number; latestVersion: number | null },
): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    status: skill.status,
    latestVersion: counts.latestVersion,
    versionCount: counts.versionCount,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

export function toSkillDetail(
  skill: Skill,
  counts: { versionCount: number; latestVersion: number | null },
  versions: SkillVersion[],
): SkillDetail {
  return {
    ...toSkillSummary(skill, counts),
    // Already newest-first from the repository; re-sorted here would be a second opinion about
    // ordering that could disagree with the query.
    versions: versions.map(toSkillVersionSummary),
  };
}
