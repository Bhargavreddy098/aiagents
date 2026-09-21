import type { BrowserSession, PrismaClient } from '@prisma/client';

/**
 * Persistence for browser sessions.
 *
 * The row is the UI's source of truth for "what is this agent looking at", which is why
 * `currentUrl`, `title` and `screenshotRef` are columns rather than in-memory fields: the
 * Browser tab has to be able to render after a reload, and an operator has to be able to
 * see that a session was left `active` by a process that died.
 */

export interface BrowserSessionCreateInput {
  tenantId: string;
  runId?: string | null;
  agentId?: string | null;
}

export interface BrowserSessionUpdate {
  status?: string;
  currentUrl?: string | null;
  title?: string | null;
  screenshotRef?: string | null;
}

export class BrowserSessionRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: BrowserSessionCreateInput): Promise<BrowserSession> {
    return this.db.browserSession.create({ data });
  }

  /** Tenant-scoped: the tenant is the first argument and is always in the where. */
  async findById(tenantId: string, id: string): Promise<BrowserSession | null> {
    return this.db.browserSession.findFirst({ where: { id, tenantId } });
  }

  async list(
    tenantId: string,
    options: { status?: string; runId?: string; limit?: number } = {},
  ): Promise<BrowserSession[]> {
    return this.db.browserSession.findMany({
      where: {
        tenantId,
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
      },
      orderBy: { createdAt: 'desc' },
      ...(options.limit === undefined ? {} : { take: options.limit }),
    });
  }

  /**
   * `updateMany` rather than `update`: the tenant is part of the where clause, so a caller
   * holding another tenant's session id updates nothing instead of everything.
   */
  async update(
    tenantId: string,
    id: string,
    data: BrowserSessionUpdate,
  ): Promise<number> {
    const { count } = await this.db.browserSession.updateMany({ where: { id, tenantId }, data });
    return count;
  }

  /**
   * Rows this process believes are live.
   *
   * The one deliberately unscoped read here, and it is a startup-maintenance path with no
   * request context to derive a tenant from. A context cannot survive a restart, so every
   * one of these rows is a lie the UI would otherwise repeat — "active" on a session whose
   * Chromium died with the previous process.
   */
  async listLive(): Promise<BrowserSession[]> {
    return this.db.browserSession.findMany({ where: { status: 'active' } });
  }

  /** Close every live row for a tenant, for a tenant-scoped teardown. */
  async closeAllForTenant(tenantId: string, status = 'closed'): Promise<number> {
    const { count } = await this.db.browserSession.updateMany({
      where: { tenantId, status: 'active' },
      data: { status },
    });
    return count;
  }
}
