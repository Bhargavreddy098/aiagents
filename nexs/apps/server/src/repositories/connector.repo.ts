import type { Connector, ConnectorAccount, Prisma, PrismaClient } from '@prisma/client';

export type JsonInput = Prisma.InputJsonValue;

/**
 * Persistence for connectors and their accounts.
 *
 * `Connector` is tenant-owned; `ConnectorAccount` is not. The account row carries no `tenantId`,
 * so its ownership is the connector it belongs to — the same leaf-row rule `MCPTool`,
 * `WorkflowStep` and `SandboxExecution` follow, and the reason every account method here takes a
 * `connectorId` that the caller obtained from a tenant-scoped read rather than a tenant of its own.
 *
 * ## Why `metadata` is written wholesale and `capabilityDiscovery` is not
 *
 * `capabilityDiscovery` is a column whose entire contents are produced by one operation, so
 * `setDiscovery` replaces it and there is nothing to merge. `metadata` is the opposite — it holds
 * the adapter config *and* the last error, written by different operations — so the merge belongs
 * to the caller, which has already read the row. Doing the merge here would mean this repository
 * reading a row it was not asked for, and a read-modify-write is the one thing a repository should
 * not hide from its caller.
 */
export class ConnectorRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: {
    tenantId: string;
    type: string;
    name: string;
    status?: string;
    metadata?: JsonInput;
  }): Promise<Connector> {
    return this.db.connector.create({ data });
  }

  /** Tenant-scoped: the tenant is the first argument and is always in the where. */
  async findById(tenantId: string, id: string): Promise<Connector | null> {
    return this.db.connector.findFirst({ where: { id, tenantId } });
  }

  async list(
    tenantId: string,
    filters: { type?: string; status?: string } = {},
  ): Promise<Connector[]> {
    return this.db.connector.findMany({
      where: {
        tenantId,
        ...(filters.type === undefined ? {} : { type: filters.type }),
        ...(filters.status === undefined ? {} : { status: filters.status }),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Edit a connector's name and metadata.
   *
   * `type` is absent, for the same reason `transport` is absent from `McpServerRepository.update`:
   * a `rest` connector and a `github` one share no configuration, so switching type is a delete and
   * a re-add rather than an edit. `status` is absent too — it is written by `setStatus` after a
   * probe, and a PATCH that could set it would let an operator mark a broken connector healthy.
   */
  async update(
    tenantId: string,
    id: string,
    data: { name?: string; metadata?: JsonInput },
  ): Promise<number> {
    const { count } = await this.db.connector.updateMany({ where: { id, tenantId }, data });
    return count;
  }

  /** Replace the discovered capability list. Always the whole list — it is a snapshot, not a log. */
  async setDiscovery(tenantId: string, id: string, capabilities: JsonInput): Promise<number> {
    const { count } = await this.db.connector.updateMany({
      where: { id, tenantId },
      data: { capabilityDiscovery: capabilities },
    });
    return count;
  }

  async setStatus(tenantId: string, id: string, status: string): Promise<number> {
    const { count } = await this.db.connector.updateMany({
      where: { id, tenantId },
      data: { status },
    });
    return count;
  }

  async delete(tenantId: string, id: string): Promise<number> {
    const { count } = await this.db.connector.deleteMany({ where: { id, tenantId } });
    return count;
  }
}

export interface ConnectorAccountCreateInput {
  connectorId: string;
  label: string;
  accountId?: string | null;
  credentialId?: string | null;
  scopes?: string[];
  status?: string;
}

/**
 * Accounts on a connector.
 *
 * **No method here takes a tenant.** Ownership is proven by the caller reading the parent connector
 * through `ConnectorRepository.findById(tenantId, …)` first; these methods take the resulting
 * `connectorId`. That is the two-step read the leaf-row rule requires, and it is why
 * `ConnectorAccount` carries no `tenantId` column to check instead.
 */
export class ConnectorAccountRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: ConnectorAccountCreateInput): Promise<ConnectorAccount> {
    return this.db.connectorAccount.create({ data });
  }

  async findById(id: string): Promise<ConnectorAccount | null> {
    return this.db.connectorAccount.findFirst({ where: { id } });
  }

  async listForConnector(connectorId: string): Promise<ConnectorAccount[]> {
    return this.db.connectorAccount.findMany({
      where: { connectorId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * How many accounts each of these connectors has, keyed by connector id.
   *
   * One grouped query rather than a `listForConnector` per connector, for the same reason
   * `MCPToolRepository.countsByServer` exists: the connectors list renders a count per row, and the
   * obvious loop is a query per row on every page load.
   *
   * The ids come from a tenant-scoped read of `Connector`, which is what makes the unscoped `where`
   * here safe — the ownership check already happened.
   */
  async countsByConnector(connectorIds: readonly string[]): Promise<Map<string, number>> {
    if (connectorIds.length === 0) return new Map();
    const groups = await this.db.connectorAccount.groupBy({
      by: ['connectorId'],
      where: { connectorId: { in: [...connectorIds] } },
      _count: true,
    });
    return new Map(
      groups.map((group) => [
        group.connectorId,
        typeof group._count === 'number' ? group._count : 0,
      ]),
    );
  }

  async update(
    id: string,
    data: {
      label?: string;
      accountId?: string | null;
      credentialId?: string | null;
      scopes?: string[];
      status?: string;
    },
  ): Promise<number> {
    const { count } = await this.db.connectorAccount.updateMany({ where: { id }, data });
    return count;
  }

  /** Written by a probe, never by a PATCH — the same split as a connector's own status. */
  async setStatus(id: string, status: string): Promise<number> {
    const { count } = await this.db.connectorAccount.updateMany({ where: { id }, data: { status } });
    return count;
  }

  async delete(id: string): Promise<number> {
    const { count } = await this.db.connectorAccount.deleteMany({ where: { id } });
    return count;
  }
}
