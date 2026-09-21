/**
 * Skills, as the UI sees them.
 *
 * A skill is a **versioned prompt template** — a named, reusable instruction block an agent can be
 * pointed at, with a JSON Schema for its arguments. It is not a tool: a tool *does* something, and a
 * skill changes what the model is asked to do. That distinction is why a skill has no capability
 * set and never appears in the approval path.
 *
 * ## Versions are immutable, and `latestVersion` is derived
 *
 * Editing a skill means publishing version N+1. The same rule `AgentVersion` and `WorkflowVersion`
 * already follow, and for the same reason: a run that used version 3 must still be able to show
 * what version 3 said, so a version row is a record and records are never rewritten.
 *
 * `latestVersion` is therefore *not* a column. It is the highest `version` among the skill's rows,
 * computed on read. A cached column would be a second source of truth for a fact the rows already
 * determine, and the failure mode — a "latest" that names a version that does not exist — is
 * exactly the kind of wrong number the honesty rule exists to prevent.
 */

// ── vocabularies ──────────────────────────────────────────────────────────────

/**
 * A skill is either usable or not.
 *
 * `disabled` is a soft state: the versions stay, runs that referenced them stay readable, and the
 * skill simply stops being offered. Deleting is for a mistake; disabling is for a decision.
 */
export const SKILL_STATUSES = ['active', 'disabled'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

// ── versions ──────────────────────────────────────────────────────────────────

export interface SkillVersionSummary {
  id: string;
  version: number;
  /** The template itself. A prompt is not a secret, so unlike a connector token this is returned. */
  promptTemplate: string;
  /** Raw JSON Schema for the template's arguments, passed through unchanged. */
  argsSchema: unknown;
  createdAt: string;
}

// ── skills ────────────────────────────────────────────────────────────────────

export interface SkillSummary {
  id: string;
  name: string;
  description: string | null;
  status: string;
  /**
   * The highest published version, or null when nothing has been published yet.
   *
   * Null is reachable — a skill row is created before its first version — and it is reported as
   * null rather than 0, because version numbers start at 1 and a `0` on screen would look like a
   * version that exists.
   */
  latestVersion: number | null;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SkillDetail extends SkillSummary {
  /** Every version, newest first. Inlined: a skill has a handful, and the detail page shows them. */
  versions: SkillVersionSummary[];
}
