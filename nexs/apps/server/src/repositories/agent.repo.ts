import type { Agent, AgentVersion, Prisma, PrismaClient } from '@prisma/client';
import {
  agentConfigChanged,
  snapshotAgentConfig,
  type AgentConfigSnapshot,
  type AgentStatus,
} from '@nexs/shared';
import { toJson } from './json.js';

/**
 * Agents and their immutable version snapshots.
 *
 * ## The versioning rule
 *
 * `Agent.version` is a counter and `AgentVersion` is the history. **A version row is
 * written whenever the *behaviour* changes, and only then.** Renaming an agent does not
 * mint a version: the run list is filtered by agent, and burying the versions that changed
 * what a run did under versions that only changed what it was called would make the one
 * question this table exists to answer — "which configuration did this run use?" — harder
 * to answer, not easier.
 *
 * `AgentConfigSnapshot` decides what "behaviour" means, and `snapshotAgentConfig` builds
 * it. This file does not enumerate the fields, so adding one to the snapshot is a change in
 * one place rather than two that can disagree.
 *
 * ## Tenant isolation, and the one exception
 *
 * `AgentVersion` has **no `tenantId` column** — the schema gives it `agentId` and a unique
 * `(agentId, version)`. This is one of the documented exceptions to the rule that
 * `tenantId` is the first argument of every tenant-owned method, alongside `Step` (scoped
 * by `runId`) and `MCPTool` (scoped by `serverId`). Isolation is preserved differently
 * here: every version read goes through `assertOwnedBy`, which re-reads the owning `Agent`
 * row with the tenant in the `where` and refuses if it is not there. A version id is
 * therefore not a capability — possessing one does not let a caller read across tenants.
 *
 * Every *agent* method does take `tenantId` first and put it in the `where`, and updates
 * use `updateMany` so the tenant predicate cannot be forgotten.
 */

/** The columns a caller may set when creating an agent. */
export interface CreateAgentRow {
  tenantId: string;
  name: string;
  description?: string | null;
  instructions: string;
  modelId: string | null;
  fallbackModelId: string | null;
  toolIds: string[];
  mcpServerIds: string[];
  connectorAccountIds: string[];
  memoryEnabled: boolean;
  browserAccess: boolean;
  sandboxAccess: boolean;
  approvalPolicy: Prisma.InputJsonValue;
  executionLimits: Prisma.InputJsonValue;
  status: AgentStatus;
}

/** A partial write. Absent keys are left alone; `null` is a value, not an omission. */
export interface AgentPatch {
  name?: string;
  description?: string | null;
  instructions?: string;
  modelId?: string | null;
  fallbackModelId?: string | null;
  toolIds?: string[];
  mcpServerIds?: string[];
  connectorAccountIds?: string[];
  memoryEnabled?: boolean;
  browserAccess?: boolean;
  sandboxAccess?: boolean;
  approvalPolicy?: Prisma.InputJsonValue;
  executionLimits?: Prisma.InputJsonValue;
}

/**
 * The outcome of a write that may have versioned.
 *
 * `version` is the row this write created, or `null` when the config did not change. It is
 * returned rather than looked up afterwards so a caller reporting "version 7 published"
 * is reporting the row that was actually written, not a later read that a concurrent
 * update could have moved.
 */
export interface AgentWriteResult {
  agent: Agent;
  version: AgentVersion | null;
}

export interface AgentListFilters {
  status?: AgentStatus;
  /** Excludes `archived`, which is what a default listing should show. */
  excludeArchived?: boolean;
  limit?: number;
}

export class AgentRepository {
  constructor(private readonly db: PrismaClient) {}

  // ── reads ───────────────────────────────────────────────────────────────────

  async findById(tenantId: string, id: string): Promise<Agent | null> {
    return this.db.agent.findFirst({ where: { id, tenantId } });
  }

  /** The composed detail view: identity, config and the version history. */
  async findByIdWithVersions(
    tenantId: string,
    id: string,
  ): Promise<(Agent & { versions: AgentVersion[] }) | null> {
    return this.db.agent.findFirst({
      where: { id, tenantId },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
  }

  async list(tenantId: string, filters: AgentListFilters = {}): Promise<Agent[]> {
    return this.db.agent.findMany({
      where: {
        tenantId,
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.excludeArchived === true ? { status: { not: 'archived' } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
    });
  }

  async count(tenantId: string, filters: { status?: AgentStatus } = {}): Promise<number> {
    return this.db.agent.count({
      where: {
        tenantId,
        ...(filters.status === undefined ? {} : { status: filters.status }),
      },
    });
  }

  async listVersions(tenantId: string, agentId: string): Promise<AgentVersion[]> {
    if (!(await this.assertOwnedBy(tenantId, agentId))) return [];
    return this.db.agentVersion.findMany({
      where: { agentId },
      orderBy: { version: 'desc' },
    });
  }

  /**
   * The version a run pinned, read back by id.
   *
   * This is the read that gap #15 depends on: a run holds `agentVersionId`, and this is how
   * its configuration is recovered. It refuses a version whose agent belongs to another
   * tenant, so the id alone is not a way in.
   */
  async findVersionById(tenantId: string, versionId: string): Promise<AgentVersion | null> {
    const version = await this.db.agentVersion.findFirst({ where: { id: versionId } });
    if (version === null) return null;
    if (!(await this.assertOwnedBy(tenantId, version.agentId))) return null;
    return version;
  }

  /** The version an agent is currently pointing at, if it has one. */
  async findActiveVersion(tenantId: string, agentId: string): Promise<AgentVersion | null> {
    const agent = await this.findById(tenantId, agentId);
    if (agent === null || agent.activeVersionId === null) return null;
    return this.findVersionById(tenantId, agent.activeVersionId);
  }

  // ── writes ──────────────────────────────────────────────────────────────────

  /**
   * Create an agent and its version 1 snapshot.
   *
   * Both rows, always: an agent with no version row would be one that cannot be run, and
   * the failure would surface later as a run that could not resolve its configuration.
   * `version` is 1 and the snapshot is taken from the same data, so the two cannot
   * describe different things.
   */
  async create(data: CreateAgentRow): Promise<AgentWriteResult> {
    return this.db.$transaction(async (tx) => {
      const created = await tx.agent.create({
        data: {
          tenantId: data.tenantId,
          name: data.name,
          description: data.description ?? null,
          instructions: data.instructions,
          modelId: data.modelId,
          fallbackModelId: data.fallbackModelId,
          toolIds: data.toolIds,
          mcpServerIds: data.mcpServerIds,
          connectorAccountIds: data.connectorAccountIds,
          memoryEnabled: data.memoryEnabled,
          browserAccess: data.browserAccess,
          sandboxAccess: data.sandboxAccess,
          approvalPolicy: data.approvalPolicy,
          executionLimits: data.executionLimits,
          status: data.status,
          version: 1,
        },
      });

      const version = await tx.agentVersion.create({
        data: {
          agentId: created.id,
          version: 1,
          config: toJson(snapshotAgentConfig(created)),
        },
      });

      // `activeVersionId` is set after the version row exists, so it can never point at a
      // row that was not written.
      const agent = await tx.agent.update({
        where: { id: created.id },
        data: { activeVersionId: version.id },
      });

      return { agent, version };
    });
  }

  /**
   * Apply a partial update, minting a version if the configuration changed.
   *
   * The version bump is a compare-and-swap on the version the caller read, not a blind
   * `version + 1`. Two concurrent updates that both read version 5 would otherwise both
   * try to write version 6, and the loser would fail on the `(agentId, version)` unique
   * constraint — a 500 for what is an ordinary race. Here the loser simply matches no rows
   * and gets a conflict it can retry.
   *
   * Returns `null` when the agent does not exist for this tenant, which the caller turns
   * into a 404. It does **not** return `null` for "no change" — that is a successful write
   * with `version: null`.
   */
  async applyUpdate(
    tenantId: string,
    id: string,
    patch: AgentPatch,
  ): Promise<AgentWriteResult | null> {
    return this.db.$transaction(async (tx) => {
      const current = await tx.agent.findFirst({ where: { id, tenantId } });
      if (current === null) return null;

      // The snapshot is built from the row as it *will be*, not from the patch. A patch
      // that sets one field must not produce a snapshot missing the other ten, and the row
      // is the only place that knows what the others currently are.
      const after = snapshotAgentConfig({ ...current, ...patch });
      const changed = agentConfigChanged(snapshotAgentConfig(current), after);
      const nextVersion = changed ? current.version + 1 : current.version;

      const { count } = await tx.agent.updateMany({
        where: { id, tenantId, version: current.version },
        data: { ...patch, version: nextVersion },
      });

      if (count !== 1) {
        throw new AgentVersionConflict(id, current.version);
      }

      const agent = await tx.agent.findFirst({ where: { id, tenantId } });
      if (agent === null) return null;

      if (!changed) return { agent, version: null };

      const version = await tx.agentVersion.create({
        data: { agentId: id, version: nextVersion, config: toJson(after) },
      });

      // `activeVersionId` is set after the version row exists, so it can never point at a
      // row that was not written.
      const pointed = await tx.agent.update({
        where: { id },
        data: { activeVersionId: version.id },
      });

      return { agent: pointed, version };
    });
  }

  /**
   * Move an agent to a new status.
   *
   * The legal-transition check is the service's job; this only refuses to write a status
   * that is not a status. `archivedAt` is stamped by the caller passing it, so this method
   * does not need to know which statuses are terminal.
   */
  async setStatus(
    tenantId: string,
    id: string,
    status: AgentStatus,
    extra: { archivedAt?: Date | null } = {},
  ): Promise<Agent | null> {
    const { count } = await this.db.agent.updateMany({
      where: { id, tenantId },
      data: {
        status,
        ...(extra.archivedAt === undefined ? {} : { archivedAt: extra.archivedAt }),
      },
    });
    if (count !== 1) return null;
    return this.findById(tenantId, id);
  }

  /**
   * Copy an agent into a brand new row at version 1.
   *
   * A duplicate is a new agent, not a new version of the old one: it gets its own id, its
   * own run history and its own version numbering, which is what makes it safe to edit
   * without disturbing what the original is doing.
   */
  async duplicate(tenantId: string, id: string, name: string): Promise<AgentWriteResult | null> {
    const source = await this.findById(tenantId, id);
    if (source === null) return null;

    return this.create({
      tenantId,
      name,
      description: source.description,
      instructions: source.instructions,
      modelId: source.modelId,
      fallbackModelId: source.fallbackModelId,
      toolIds: [...source.toolIds],
      mcpServerIds: [...source.mcpServerIds],
      connectorAccountIds: [...source.connectorAccountIds],
      memoryEnabled: source.memoryEnabled,
      browserAccess: source.browserAccess,
      sandboxAccess: source.sandboxAccess,
      // Read back out of the Json column as `InputJsonValue`. `toOptionalJson` is not the
      // right tool here: these columns are non-null, and a copy that dropped them would
      // produce an agent with no approval policy rather than one that failed to copy.
      approvalPolicy: source.approvalPolicy as Prisma.InputJsonValue,
      executionLimits: source.executionLimits as Prisma.InputJsonValue,
      // A duplicate starts where a new agent starts. Carrying the source's status over
      // would mean duplicating a live agent silently creates a second live agent.
      status: 'draft',
    });
  }

  /**
   * Whether the agent exists for this tenant.
   *
   * The guard behind every `AgentVersion` read, and the reason a version id is not a
   * capability. Exported behaviourally rather than as a public `assert` so callers cannot
   * mistake it for an authorisation check on the *agent* — it is a scoping check on the
   * version.
   */
  private async assertOwnedBy(tenantId: string, agentId: string): Promise<boolean> {
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, tenantId },
      select: { id: true },
    });
    return agent !== null;
  }
}

/**
 * Raised when a concurrent update won the version race.
 *
 * A distinct class rather than an `ApiError`, so the service can decide the HTTP shape —
 * and so a caller can tell this apart from "the agent is gone", which is also a `null`.
 */
export class AgentVersionConflict extends Error {
  constructor(
    readonly agentId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `Agent ${agentId} was modified concurrently: version ${expectedVersion} is no longer current`,
    );
    this.name = 'AgentVersionConflict';
  }
}

/** Narrow a stored snapshot back into a typed one, dropping anything unrecognisable. */
export function readAgentConfigSnapshot(value: unknown): AgentConfigSnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    instructions: typeof raw['instructions'] === 'string' ? raw['instructions'] : '',
    modelId: typeof raw['modelId'] === 'string' ? raw['modelId'] : null,
    fallbackModelId: typeof raw['fallbackModelId'] === 'string' ? raw['fallbackModelId'] : null,
    toolIds: readStringArray(raw['toolIds']),
    mcpServerIds: readStringArray(raw['mcpServerIds']),
    connectorAccountIds: readStringArray(raw['connectorAccountIds']),
    memoryEnabled: raw['memoryEnabled'] !== false,
    browserAccess: raw['browserAccess'] === true,
    sandboxAccess: raw['sandboxAccess'] === true,
    approvalPolicy: raw['approvalPolicy'] ?? null,
    executionLimits: raw['executionLimits'] ?? null,
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
