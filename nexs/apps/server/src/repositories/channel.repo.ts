import type { Channel, ChannelAccount, Prisma, PrismaClient } from '@prisma/client';

/**
 * Channels.
 *
 * `tenantId` is the first argument of every method and appears in every `where`, exactly as
 * everywhere else in this layer. There is no unscoped read here — even the status histogram
 * is per-tenant, because "how many of *my* channels are degraded" is the only form of that
 * question the product asks.
 */

export interface CreateChannelRow {
  tenantId: string;
  type: string;
  name: string;
  dmPolicy: string;
  groupPolicy: string;
  voiceEnabled: boolean;
  metadata: Prisma.InputJsonValue;
}

export interface UpdateChannelPatch {
  name?: string;
  status?: string;
  statusDetail?: string | null;
  dmPolicy?: string;
  groupPolicy?: string;
  voiceEnabled?: boolean;
  deliveryDefault?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export interface ChannelListFilters {
  type?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export class ChannelRepository {
  constructor(private readonly db: PrismaClient) {}

  async findById(tenantId: string, id: string): Promise<Channel | null> {
    return this.db.channel.findFirst({ where: { id, tenantId } });
  }

  /**
   * A channel with its accounts.
   *
   * A real `include` rather than a second query, because the accounts are displayed together
   * with the channel and two round-trips would let a header say "2 accounts" while the list
   * under it renders one. The child carries its own `tenantId` filter even though the parent
   * was already filtered: a Prisma relation traversal does not inherit the parent's `where`.
   */
  async findWithAccounts(
    tenantId: string,
    id: string,
  ): Promise<(Channel & { accounts: ChannelAccount[] }) | null> {
    return this.db.channel.findFirst({
      where: { id, tenantId },
      include: { accounts: { where: { tenantId }, orderBy: { createdAt: 'asc' } } },
    });
  }

  async list(tenantId: string, filters: ChannelListFilters = {}): Promise<Channel[]> {
    return this.db.channel.findMany({
      where: {
        tenantId,
        ...(filters.type === undefined ? {} : { type: filters.type }),
        ...(filters.status === undefined ? {} : { status: filters.status }),
      },
      orderBy: [{ createdAt: 'asc' }],
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
      ...(filters.offset === undefined ? {} : { skip: filters.offset }),
    });
  }

  async count(tenantId: string, filters: { type?: string; status?: string } = {}): Promise<number> {
    return this.db.channel.count({
      where: {
        tenantId,
        ...(filters.type === undefined ? {} : { type: filters.type }),
        ...(filters.status === undefined ? {} : { status: filters.status }),
      },
    });
  }

  async create(data: CreateChannelRow): Promise<Channel> {
    return this.db.channel.create({ data });
  }

  /** Compare-and-swap: `count !== 1` means the row is gone or belongs to someone else. */
  async update(tenantId: string, id: string, patch: UpdateChannelPatch): Promise<Channel | null> {
    const { count } = await this.db.channel.updateMany({ where: { id, tenantId }, data: patch });
    if (count !== 1) return null;
    return this.findById(tenantId, id);
  }

  /**
   * Record connectivity.
   *
   * `lastSeenAt` moves only when the caller supplies a time, and the service supplies one
   * only for a status meaning the gateway actually reached the platform. Otherwise a channel
   * failing for a week would keep looking freshly touched, and "last seen" would be a lie
   * told by the failure reporter.
   */
  async setStatus(
    tenantId: string,
    id: string,
    status: string,
    detail: string | null,
    seenAt: Date | null,
  ): Promise<Channel | null> {
    const { count } = await this.db.channel.updateMany({
      where: { id, tenantId },
      data: {
        status,
        statusDetail: detail,
        ...(seenAt === null ? {} : { lastSeenAt: seenAt }),
      },
    });
    if (count !== 1) return null;
    return this.findById(tenantId, id);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const { count } = await this.db.channel.deleteMany({ where: { id, tenantId } });
    return count === 1;
  }

  /** Counts keyed by status, for the Pulse monitor and the Surfaces strip. */
  async countByStatus(tenantId: string): Promise<Record<string, number>> {
    const rows = await this.db.channel.groupBy({
      by: ['status'],
      where: { tenantId },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row._count._all;
    return out;
  }
}