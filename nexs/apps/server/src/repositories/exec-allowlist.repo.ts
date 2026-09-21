import type { ExecAllowlistRule, PrismaClient } from '@prisma/client';

/**
 * Standing exec permissions (UI/UX v2 §4.4).
 *
 * A rule is what `allow_always` writes: "run *this* command, in *this* directory, from now
 * on". It is a **policy** row rather than a record, which is why revoking mutates it — see the
 * model comment in `schema.prisma` for why deriving the rule from decided `Approval` rows
 * would break the "a record stays a record" rule.
 *
 * `tenantId` is the first argument of every method and appears in every `where`, as
 * everywhere else in this layer. A rule is a capability, so possessing one from another tenant
 * must not authorise anything.
 */
export interface CreateExecRuleRow {
  tenantId: string;
  agentId: string | null;
  command: string;
  args: string[];
  cwd: string;
  createdBy: string;
  expiresAt: Date | null;
}

export interface ExecRuleListFilters {
  agentId?: string;
  /** Include revoked and lapsed rules — the audit view, not the authorisation view. */
  includeInactive?: boolean;
  limit?: number;
}

export class ExecAllowlistRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: CreateExecRuleRow): Promise<ExecAllowlistRule> {
    return this.db.execAllowlistRule.create({ data });
  }

  async findById(tenantId: string, id: string): Promise<ExecAllowlistRule | null> {
    return this.db.execAllowlistRule.findFirst({ where: { id, tenantId } });
  }

  async list(
    tenantId: string,
    filters: ExecRuleListFilters = {},
  ): Promise<ExecAllowlistRule[]> {
    return this.db.execAllowlistRule.findMany({
      where: {
        tenantId,
        ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
        // Revoked rules are hidden unless explicitly asked for. Expiry is *not* filtered here:
        // a lapsed rule is still a fact about the workspace and belongs in the audit list, and
        // the mapper marks it inactive rather than the repository hiding it.
        ...(filters.includeInactive === true ? {} : { revokedAt: null }),
      },
      orderBy: [{ createdAt: 'desc' }],
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
    });
  }

  /**
   * Rules that *could* cover a request: same command, same cwd, live, and either tenant-wide
   * (`agentId: null`) or scoped to this agent.
   *
   * The **arg comparison is deliberately not done here.** A prefix match over an array cannot
   * be expressed in a Prisma `where`, and writing a weaker SQL approximation (say, `has` on the
   * first element) would mean two implementations of one security rule — which is exactly the
   * drift `execCommandMatches` exists to prevent. The database narrows on the three columns it
   * can compare exactly; the caller applies the one real rule.
   *
   * The two `OR` clauses are wrapped in `AND` because a single object cannot carry two `OR`
   * keys — the agent filter and the expiry filter are independent conditions, not alternatives,
   * and collapsing them would let an expired rule for another agent authorise a command.
   */
  async findCandidates(
    tenantId: string,
    command: string,
    cwd: string,
    agentId: string | null,
    now: Date,
  ): Promise<ExecAllowlistRule[]> {
    return this.db.execAllowlistRule.findMany({
      where: {
        tenantId,
        command,
        cwd,
        revokedAt: null,
        AND: [
          ...(agentId === null ? [] : [{ OR: [{ agentId: null }, { agentId }] }]),
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        ],
      },
      orderBy: [{ createdAt: 'asc' }],
    });
  }

  /** Record that a rule was used. Best-effort: a failure here must not block the command. */
  async touchLastUsed(tenantId: string, id: string, now: Date): Promise<boolean> {
    const { count } = await this.db.execAllowlistRule.updateMany({
      where: { id, tenantId },
      data: { lastUsedAt: now },
    });
    return count === 1;
  }

  /**
   * Revoke a standing permission. **Compare-and-swap** on `revokedAt: null`, so a second
   * revoke reports a loss instead of quietly moving the timestamp — the same rule the approval
   * decisions follow, and for the same reason: "who revoked this, and when" is an audit fact.
   */
  async revoke(tenantId: string, id: string, now: Date): Promise<boolean> {
    const { count } = await this.db.execAllowlistRule.updateMany({
      where: { id, tenantId, revokedAt: null },
      data: { revokedAt: now },
    });
    return count === 1;
  }

  /** Live rules for the workspace — the number the Settings page and Pulse both show. */
  async countActive(tenantId: string, now: Date): Promise<number> {
    return this.db.execAllowlistRule.count({
      where: {
        tenantId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
  }
}