import { ApiError, type CreateMcpServerInput, type ListMcpServersQuery, type McpServerDetail, type McpToolSummary, type UpdateMcpServerInput } from '@nexs/shared';
import type { CredentialRepository } from '../../repositories/credential.repo.js';
import type { McpServerRepository, MCPToolRepository, ToolRepository } from '../../repositories/mcp.repo.js';
import type { Logger } from '../../logger.js';
import type { VaultService } from '../vault/vault.service.js';
import type { MCPManager } from './mcp-manager.js';
import { formatEnvBlock } from './mcp-manager.js';
import { toJson } from '../../repositories/json.js';
import { toMcpServerDetail, toMcpServerSummary, toMcpToolSummary } from '../../mappers/registry.js';

/**
 * `/api/mcp` — connecting the system to other people's tool servers.
 *
 * ## Three things this layer is responsible for
 *
 * **1. The secret never comes back.** An `env` block is encrypted into a `Credential` row and
 * referenced by `envRef`; `McpServerDetail` reports `hasEnv` and nothing more. Header *values* are
 * a different story and are stored in the clear — the manager needs them at handshake time — so
 * the detail view returns header **names** only. That asymmetry is real and is documented in
 * `createMcpServerSchema` rather than hidden.
 *
 * **2. A failed connect does not fail the create.** Same rule as a provider: the row is real
 * either way, and an operator whose server is briefly unavailable needs to see the row and its
 * `lastError`, not an error page. The response reports the connect outcome separately.
 *
 * **3. Connect is idempotent, and this layer relies on that rather than working around it.**
 * `MCPManager.connect` routes through an in-flight map, so two callers racing on one server share
 * a single handshake — which is what makes a double-clicked button safe rather than a way to leave
 * two child processes behind.
 *
 * ## What is deliberately not here
 *
 * **No transport change.** A stdio server and an http one share no configuration, so switching is
 * a delete and a re-add, not a PATCH. See `McpServerRepository.update`.
 *
 * **No enable/disable flag.** The spec's "PATCH /:id (enable/disable)" maps onto `Tool.status` for
 * the canonical tools the server contributed — a real column with a real effect — rather than a
 * flag on `McpServer` that the schema does not have and nothing would read.
 */

export interface McpServiceDeps {
  servers: McpServerRepository;
  mcpTools: MCPToolRepository;
  tools: ToolRepository;
  credentials: CredentialRepository;
  vault: VaultService;
  manager: MCPManager;
  logger: Logger;
}

export class McpService {
  constructor(private readonly deps: McpServiceDeps) {}

  async list(tenantId: string, query: ListMcpServersQuery) {
    const rows = await this.deps.servers.list(tenantId);
    // One grouped count for the whole page rather than a `count` per server — the same reason
    // the chat list batches its counts.
    const counts = await this.deps.mcpTools.countsByServer(rows.map((row) => row.id));

    return rows
      .filter((row) => query.status === undefined || row.status === query.status)
      .map((row) => toMcpServerSummary(row, counts.get(row.id) ?? 0));
  }

  async get(tenantId: string, id: string): Promise<McpServerDetail> {
    const server = await this.requireServer(tenantId, id);
    const counts = await this.deps.mcpTools.countsByServer([id]);
    return toMcpServerDetail(server, counts.get(id) ?? 0);
  }

  /**
   * Add a server, optionally connecting it immediately.
   *
   * The env credential is written before the row, so a failure creating the server leaves an
   * orphaned credential rather than a server pointing at one that does not exist — and an
   * `envRef` that resolves to nothing makes every connect throw.
   */
  async create(
    tenantId: string,
    input: CreateMcpServerInput,
  ): Promise<{ server: McpServerDetail; connected: boolean; lastError: string | null }> {
    const envRef = await this.storeEnv(tenantId, input.name, input.env);

    const server = await this.deps.servers.create({
      tenantId,
      name: input.name,
      transport: input.transport,
      command: input.command ?? null,
      ...(input.args === undefined ? {} : { args: input.args }),
      url: input.url ?? null,
      ...(input.headers === undefined ? {} : { headers: toJson(input.headers) }),
      envRef,
    });

    // Default: connect. A server row that is not connected has no tools and is indistinguishable
    // from a broken one, and the operator's intent in adding it was clearly to use it.
    const shouldConnect = input.connect ?? true;

    if (!shouldConnect) {
      const detail = await this.get(tenantId, server.id);
      return { server: detail, connected: false, lastError: null };
    }

    return this.attemptConnect(tenantId, server.id);
  }

  /**
   * Edit a server's configuration, or flip its tools.
   *
   * The two are separate concerns and both are supported in one call because both are edits to the
   * same resource. Config changes take effect on the next connect — nothing here restarts a live
   * session, because a silent restart would drop in-flight tool calls.
   */
  async update(tenantId: string, id: string, input: UpdateMcpServerInput): Promise<McpServerDetail> {
    await this.requireServer(tenantId, id);

    if (input.env !== undefined) {
      // A rotation: a new credential, with the old row left in place as the record that one existed.
      const envRef = await this.storeEnv(tenantId, id, input.env);
      const count = await this.deps.servers.update(tenantId, id, { envRef });
      if (count !== 1) {
        throw new ApiError('NOT_FOUND', 'MCP server not found', { serverId: id });
      }
    }

    const hasConfigEdit =
      input.name !== undefined ||
      input.command !== undefined ||
      input.args !== undefined ||
      input.url !== undefined ||
      input.headers !== undefined;

    if (hasConfigEdit) {
      const count = await this.deps.servers.update(tenantId, id, {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.command === undefined ? {} : { command: input.command }),
        ...(input.args === undefined ? {} : { args: input.args }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.headers === undefined ? {} : { headers: toJson(input.headers) }),
      });
      if (count !== 1) {
        throw new ApiError('NOT_FOUND', 'MCP server not found', { serverId: id });
      }
    }

    if (input.toolsEnabled !== undefined) {
      // The spec's enable/disable, mapped to the column that actually exists and has an effect.
      const status = input.toolsEnabled ? 'enabled' : 'disabled';
      const changed = await this.deps.tools.setStatusForServer(tenantId, id, status);
      this.deps.logger.info({ serverId: id, status, changed }, 'mcp server tools toggled');
    }

    return this.get(tenantId, id);
  }

  /**
   * Remove a server and unregister what it contributed.
   *
   * Delegated to the manager rather than done with a repository delete, because the manager is the
   * thing that knows to tear the session down first, clear the pid, and disable the canonical tools
   * an agent may still reference. A repository delete would cascade the `MCPTool` rows and leave a
   * live child process with no row pointing at it — the leak the `pid` column exists to prevent.
   */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.requireServer(tenantId, id);
    await this.deps.manager.deleteServer(tenantId, id);
  }

  /** Re-open a session. Idempotent: a double-click shares one handshake. */
  async reconnect(tenantId: string, id: string): Promise<{ connected: boolean; lastError: string | null }> {
    await this.requireServer(tenantId, id);
    const outcome = await this.attemptConnect(tenantId, id);
    return { connected: outcome.connected, lastError: outcome.lastError };
  }

  /** What the server advertises, with the capability set the manager resolved for each tool. */
  async listTools(tenantId: string, id: string): Promise<McpToolSummary[]> {
    const views = await this.deps.manager.listTools(tenantId, id);
    return views.map(toMcpToolSummary);
  }

  async listResources(tenantId: string, id: string): Promise<unknown> {
    return this.deps.manager.listResources(tenantId, id);
  }

  async listPrompts(tenantId: string, id: string): Promise<unknown> {
    return this.deps.manager.listPrompts(tenantId, id);
  }

  /**
   * Try to connect and report the outcome rather than throwing.
   *
   * A connect failure is a finding about the server, not a failure of the request that asked for
   * it — the same shape `ProviderHealthService.checkOne` takes, and for the same reason. The
   * manager has already written `status` and `lastError` onto the row by the time this returns, so
   * the caller has something concrete to render either way.
   */
  private async attemptConnect(
    tenantId: string,
    id: string,
  ): Promise<{ server: McpServerDetail; connected: boolean; lastError: string | null }> {
    try {
      await this.deps.manager.connect(tenantId, id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn({ serverId: id, err: message }, 'mcp server could not be connected');

      const server = await this.get(tenantId, id);
      return { server, connected: false, lastError: server.lastError ?? message };
    }

    const server = await this.get(tenantId, id);
    return { server, connected: true, lastError: null };
  }

  /**
   * Encrypt an env block and store it, returning the credential id.
   *
   * Serialised with `formatEnvBlock`, which is the exact inverse of the `parseEnvBlock` the
   * composition root's `resolveEnv` uses. The two live in the same module so they cannot drift —
   * a writer that emitted JSON would produce a server that starts with no environment and no error
   * anyone can see.
   */
  private async storeEnv(
    tenantId: string,
    label: string,
    env: Record<string, string> | undefined,
  ): Promise<string | null> {
    if (env === undefined || Object.keys(env).length === 0) return null;

    const credential = await this.deps.credentials.create({
      tenantId,
      label: `${label} environment`,
      kind: 'mcp_env',
      encrypted: this.deps.vault.encrypt(formatEnvBlock(env)),
      // The env block is not a key and has no meaningful prefix to show. An empty prefix is
      // honest: there is nothing about it a page could render.
      keyPrefix: '',
    });

    return credential.id;
  }

  private async requireServer(tenantId: string, id: string) {
    const server = await this.deps.servers.findById(tenantId, id);
    if (server === null) {
      throw new ApiError('NOT_FOUND', 'MCP server not found', { serverId: id });
    }
    return server;
  }
}
