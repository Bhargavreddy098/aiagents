import type { McpServer, MCPTool, Prisma, PrismaClient, Tool } from '@prisma/client';

export type JsonInput = Prisma.InputJsonValue;

/**
 * Persistence for MCP servers and the tools discovered on them.
 *
 * `McpServer.status` and `pid` live on the row rather than in a manager's memory on
 * purpose: a crash-and-restart must not forget that a server was running, and an
 * operator has to be able to see a leaked pid in order to kill it.
 */

export interface McpServerCreateInput {
  tenantId: string;
  name: string;
  transport: string;
  command?: string | null;
  args?: string[];
  url?: string | null;
  headers?: JsonInput;
  envRef?: string | null;
}

export class McpServerRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: McpServerCreateInput): Promise<McpServer> {
    return this.db.mcpServer.create({ data });
  }

  /** Tenant-scoped: the tenant is the first argument and is always in the where. */
  async findById(tenantId: string, id: string): Promise<McpServer | null> {
    return this.db.mcpServer.findFirst({ where: { id, tenantId } });
  }

  async list(tenantId: string): Promise<McpServer[]> {
    return this.db.mcpServer.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
  }

  /** Servers the process believes are running — used by the startup reconciliation. */
  async listWithPids(tenantId: string): Promise<McpServer[]> {
    return this.db.mcpServer.findMany({
      where: { tenantId, pid: { not: null } },
    });
  }

  /**
   * Every tenant's rows that still claim a live pid.
   *
   * The one deliberately unscoped read in this file. Startup reconciliation is a
   * maintenance path that has no request context to derive a tenant from, and it must see
   * every leaked child or it will miss exactly the leak it exists to catch. It is never
   * reachable from a request handler, and it returns only rows that carry a pid.
   */
  async listAllWithPids(): Promise<McpServer[]> {
    return this.db.mcpServer.findMany({ where: { pid: { not: null } } });
  }

  async delete(tenantId: string, id: string): Promise<number> {
    const { count } = await this.db.mcpServer.deleteMany({ where: { id, tenantId } });
    return count;
  }

  /**
   * Edit a server's configuration.
   *
   * **`transport` is not editable here, and that is a decision rather than an omission.** Changing
   * it is not an edit — a stdio server and an http one share no configuration at all, so a PATCH
   * that switched transports would have to guess which fields to clear. Deleting and re-adding is
   * the honest operation, and `MCPManager.deleteServer` already unregisters the canonical tools.
   *
   * `status` and `pid` are likewise absent: they are the manager's to write, through
   * `markConnected` and `markStatus`. A PATCH that could set `pid` would let an operator point the
   * reaper at a process that is not the server's.
   *
   * Edits take effect on the next connect — nothing here restarts a running session, because a
   * silent restart would drop in-flight tool calls.
   */
  async update(
    tenantId: string,
    id: string,
    data: {
      name?: string;
      command?: string | null;
      args?: string[];
      url?: string | null;
      headers?: JsonInput;
      envRef?: string | null;
    },
  ): Promise<number> {
    const { count } = await this.db.mcpServer.updateMany({ where: { id, tenantId }, data });
    return count;
  }

  async markConnected(tenantId: string, id: string, pid: number | null): Promise<number> {
    const { count } = await this.db.mcpServer.updateMany({
      where: { id, tenantId },
      data: {
        status: 'connected',
        pid,
        lastConnectedAt: new Date(),
        lastError: null,
      },
    });
    return count;
  }

  async markStatus(
    tenantId: string,
    id: string,
    status: string,
    options: { lastError?: string | null; pid?: number | null } = {},
  ): Promise<number> {
    const { count } = await this.db.mcpServer.updateMany({
      where: { id, tenantId },
      data: {
        status,
        ...(options.lastError === undefined ? {} : { lastError: options.lastError }),
        // Clearing the pid when a server stops is what stops the next startup from
        // trying to reap a process that no longer exists.
        ...(options.pid === undefined ? {} : { pid: options.pid }),
      },
    });
    return count;
  }
}

export interface McpToolUpsertInput {
  serverId: string;
  externalId: string;
  name: string;
  description?: string | null;
  inputSchema: JsonInput;
}

export class MCPToolRepository {
  constructor(private readonly db: PrismaClient) {}

  async upsert(data: McpToolUpsertInput): Promise<MCPTool> {
    return this.db.mCPTool.upsert({
      where: {
        serverId_externalId: { serverId: data.serverId, externalId: data.externalId },
      },
      create: data,
      update: {
        name: data.name,
        description: data.description ?? null,
        inputSchema: data.inputSchema,
        // A tool the server is advertising right now is by definition enabled. Without this
        // a tool that was withdrawn and then brought back would stay disabled forever,
        // because the disable pass only ever writes `false`.
        enabled: true,
      },
    });
  }

  async listForServer(serverId: string): Promise<MCPTool[]> {
    return this.db.mCPTool.findMany({ where: { serverId }, orderBy: { name: 'asc' } });
  }

  /**
   * How many tools each of these servers contributed, keyed by server id.
   *
   * One grouped query rather than a `listForServer` per server: the dashboard renders a row
   * per connected service and every row needs its own count, so the obvious loop would be a
   * query per server on every page load. `_count` is the count of *rows*, which is what the
   * dashboard labels "tools" — deliberately not the count of enabled ones, because a server
   * whose tools were all withdrawn is a different problem from a server that contributed few,
   * and only the total distinguishes them.
   *
   * `MCPTool` carries no `tenantId` — its ownership is the server it belongs to — so the
   * caller passes ids from a tenant-scoped read of `McpServer`. Same ownership proof as
   * `listForServer`, and the reason this method takes ids rather than a tenant.
   */
  async countsByServer(serverIds: readonly string[]): Promise<Map<string, number>> {
    if (serverIds.length === 0) return new Map();
    const groups = await this.db.mCPTool.groupBy({
      by: ['serverId'],
      where: { serverId: { in: [...serverIds] } },
      _count: true,
    });
    return new Map(
      groups.map((group) => [
        group.serverId,
        typeof group._count === 'number' ? group._count : 0,
      ]),
    );
  }

  async findByExternalId(serverId: string, externalId: string): Promise<MCPTool | null> {
    return this.db.mCPTool.findFirst({ where: { serverId, externalId } });
  }

  /**
   * The discovered tool behind a canonical `Tool` row.
   *
   * The engine holds a `Tool` and needs the *server's own* name for it, because that is
   * what `tools/call` takes. The canonical name is a namespaced, length-capped label for
   * the model's benefit and is not something a server will recognise.
   */
  async findByToolId(toolId: string): Promise<MCPTool | null> {
    return this.db.mCPTool.findFirst({ where: { toolId } });
  }

  /** Tools the server no longer advertises — disabled rather than deleted, so history holds. */
  async disableMissing(serverId: string, keepExternalIds: readonly string[]): Promise<number> {
    const { count } = await this.db.mCPTool.updateMany({
      where: {
        serverId,
        ...(keepExternalIds.length === 0 ? {} : { externalId: { notIn: [...keepExternalIds] } }),
      },
      data: { enabled: false },
    });
    return count;
  }

  async linkTool(serverId: string, externalId: string, toolId: string): Promise<number> {
    const { count } = await this.db.mCPTool.updateMany({
      where: { serverId, externalId },
      data: { toolId },
    });
    return count;
  }
}

/** The canonical `Tool` rows every tool source funnels into. */
export class ToolRepository {
  constructor(private readonly db: PrismaClient) {}

  async upsert(data: {
    tenantId: string;
    source: string;
    name: string;
    description?: string | null;
    type: string;
    provider?: string | null;
    inputSchema?: JsonInput;
    capabilities?: string[];
    mcpServerId?: string | null;
    /**
     * The account a connector tool is invoked as.
     *
     * On the row rather than in `metadata` because it is a *binding*, not a note: the invoker reads
     * it to decide which credential to decrypt, and a value it has to parse out of a JSON blob is a
     * value that can be absent in a way nothing notices until a run fails.
     */
    connectorAccountId?: string | null;
    metadata?: JsonInput;
  }): Promise<Tool> {
    return this.db.tool.upsert({
      where: {
        tenantId_source_name: {
          tenantId: data.tenantId,
          source: data.source,
          name: data.name,
        },
      },
      create: data,
      update: {
        description: data.description ?? null,
        inputSchema: data.inputSchema ?? {},
        // Re-pointed on every discovery, unlike `capabilities`. An account can be removed and
        // replaced, and the tool must follow the account that currently exists — a stale binding
        // here is a tool that calls with a credential the operator has already revoked.
        ...(data.connectorAccountId === undefined
          ? {}
          : { connectorAccountId: data.connectorAccountId }),
        // `capabilities` is deliberately absent. Writing the freshly-derived set here would
        // apply it *before* the manager's asymmetry rule could compare it against what was
        // recorded, turning that rule into dead code — a server could widen its own tool to
        // `read_only` on reconnect and silently opt itself out of the approval policy.
        // `ToolRepository.setCapabilities` is the only post-creation writer.
        status: 'enabled',
      },
    });
  }

  async findById(tenantId: string, id: string): Promise<Tool | null> {
    return this.db.tool.findFirst({ where: { id, tenantId } });
  }

  async findBySourceAndName(tenantId: string, source: string, name: string): Promise<Tool | null> {
    return this.db.tool.findFirst({ where: { tenantId, source, name } });
  }

  async list(tenantId: string): Promise<Tool[]> {
    return this.db.tool.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
  }

  async listForServer(tenantId: string, mcpServerId: string): Promise<Tool[]> {
    return this.db.tool.findMany({ where: { tenantId, mcpServerId }, orderBy: { name: 'asc' } });
  }

  async setStatus(tenantId: string, id: string, status: string): Promise<number> {
    const { count } = await this.db.tool.updateMany({ where: { id, tenantId }, data: { status } });
    return count;
  }

  /**
   * Rewrite a tool's capability set.
   *
   * Separate from `upsert` on purpose. `upsert` never touches `capabilities` after creation,
   * because the manager applies an asymmetric rule — a server may narrow its own tool's
   * capabilities but never widen them — and that decision belongs in the manager, not
   * hidden inside a generic write.
   */
  async setCapabilities(
    tenantId: string,
    id: string,
    capabilities: string[],
  ): Promise<number> {
    const { count } = await this.db.tool.updateMany({
      where: { id, tenantId },
      data: { capabilities },
    });
    return count;
  }

  /** Every canonical tool belonging to one MCP server — used to flip a whole server's tools. */
  async setStatusForServer(
    tenantId: string,
    mcpServerId: string,
    status: string,
  ): Promise<number> {
    const { count } = await this.db.tool.updateMany({
      where: { tenantId, mcpServerId },
      data: { status },
    });
    return count;
  }

  /**
   * Canonical tools for a server that the latest `tools/list` no longer mentions.
   *
   * Disabled rather than deleted, for the same reason `MCPTool` rows are: a run that
   * already referenced the tool must still be able to render its history, and a server
   * that re-advertises the tool on the next reconnect flips it straight back to `enabled`
   * through `upsert`.
   */
  async disableMissingForServer(
    tenantId: string,
    mcpServerId: string,
    keepIds: readonly string[],
  ): Promise<number> {
    const { count } = await this.db.tool.updateMany({
      where: {
        tenantId,
        mcpServerId,
        ...(keepIds.length === 0 ? {} : { id: { notIn: [...keepIds] } }),
      },
      data: { status: 'disabled' },
    });
    return count;
  }

  /**
   * Every canonical tool one connector contributed.
   *
   * Keyed by `source` (`connector:<id>`) rather than by a foreign key, because `Tool` has no
   * `connectorId` column — a connector tool's account binding is `connectorAccountId`, which is a
   * per-account link and therefore not a connector-level one. `source` is the connector-level
   * identifier, and it is set by the connector service and by nothing else.
   */
  async listForSource(tenantId: string, source: string): Promise<Tool[]> {
    return this.db.tool.findMany({ where: { tenantId, source }, orderBy: { name: 'asc' } });
  }

  /**
   * Canonical tools for a connector that the latest discovery no longer advertises.
   *
   * Disabled rather than deleted, for the same reason as the MCP equivalent: a run that already
   * referenced the tool must still render its history, and a connector that re-advertises an action
   * flips it straight back to `enabled` through `upsert`.
   *
   * An empty `keepIds` disables everything from that source, which is how removing a connector
   * retires its tools without a dedicated delete path.
   */
  async disableMissingForSource(
    tenantId: string,
    source: string,
    keepIds: readonly string[],
  ): Promise<number> {
    const { count } = await this.db.tool.updateMany({
      where: {
        tenantId,
        source,
        ...(keepIds.length === 0 ? {} : { id: { notIn: [...keepIds] } }),
      },
      data: { status: 'disabled' },
    });
    return count;
  }
}
