import type { MCPTool, McpServer, Tool } from '@prisma/client';
import {
  ApiError,
  mayAutoReconnect,
  type McpCallResult,
  type ToolResult,
} from '@nexs/shared';
import type { Logger } from '../../logger.js';
import type { EngineEmitter } from '../engine/execution-engine.js';
import type {
  JsonInput,
  MCPToolRepository,
  McpServerRepository,
  ToolRepository,
} from '../../repositories/mcp.repo.js';
import type { StorageService } from '../storage/storage.service.js';
import { capToolResult } from '../tools/tool-result.js';
import { createProcessReaper, reapOrphan, type ProcessReaper } from './orphans.js';
import { Semaphore } from './semaphore.js';
import {
  capabilitiesFromAnnotations,
  type McpServerSpec,
  type McpSession,
  type McpSessionFactory,
} from './session.js';

/**
 * `MCPManager` — the only module in the codebase that talks to an MCP server.
 *
 * Its job is to make a third-party tool look exactly like a native one. Everything above
 * it deals in canonical `Tool` rows and `ToolResult`s; nothing above it knows whether the
 * tool ran in a child process, over HTTP, or not at all.
 *
 * Three decisions are worth stating up front, because they are the ones that are wrong in
 * most implementations:
 *
 * **1. `callTool` never retries on its own.** One attempt, one answer. A transport that
 * died after the request was written may or may not have applied the effect, and the only
 * honest thing to report is "unknown". Silent retries are how a crash turns one `send_email`
 * into two. The *only* retry this class performs is the one the caller explicitly asks for
 * via `allowReconnectOnCrash`, and that path refuses to run for anything that is not
 * `read_only` — so replay can never repeat an observable effect.
 *
 * **2. A crash is a state change, not an error message.** The session is torn down, the row
 * is marked `crashed` with the pid cleared, and every canonical tool on that server flips to
 * `error`. A leaked pid in the column is how an operator finds a process we failed to reap.
 *
 * **3. Capabilities can be narrowed by a server, never widened.** Rediscovery re-reads the
 * server's annotations, but a server that starts claiming `readOnlyHint: true` for a tool we
 * already recorded as side-effecting does not get upgraded — it gets a warning log. Otherwise
 * a malicious or buggy server could silently opt itself out of the approval policy by
 * changing its own metadata.
 */

// ── public shapes ─────────────────────────────────────────────────────────────

export interface McpManagerOptions {
  /** [gap #22 / C1] The stdio process cap; the remainder queue. */
  maxStdioServers: number;
  callTimeoutMs: number;
  connectTimeoutMs: number;
  /** [gap #18] Applied to every tool result before it reaches the model. */
  toolResultMaxBytes: number;
}

export interface McpServerSummary {
  id: string;
  name: string;
  transport: string;
  status: string;
  pid: number | null;
  toolCount: number;
  lastConnectedAt: Date | null;
  lastError: string | null;
}

export interface McpToolView {
  externalId: string;
  name: string;
  description: string | null;
  inputSchema: unknown;
  enabled: boolean;
  toolId: string | null;
  capabilities: string[];
}

export interface McpManagerDeps {
  servers: McpServerRepository;
  mcpTools: MCPToolRepository;
  tools: ToolRepository;
  storage: StorageService;
  sessionFactory: McpSessionFactory;
  /**
   * Resolves `McpServer.envRef` into the child's environment.
   *
   * Injected rather than imported so this module never holds a vault reference: the
   * decrypted values exist for exactly as long as it takes to build the spec, and the one
   * place that decrypts is the one place that has to be careful with them.
   */
  resolveEnv(tenantId: string, envRef: string | null): Promise<Record<string, string>>;
  logger: Logger;
  options: McpManagerOptions;
  /** SSE fan-out — the shared two-argument emitter; see `BrowserManagerDeps.emit`. */
  emit?: EngineEmitter;
  /** Injected by the reconciliation tests; the real one is platform-aware. */
  reaper?: ProcessReaper;
}

interface LiveSession {
  tenantId: string;
  session: McpSession;
  /** Returns the stdio permit, for stdio servers only. Idempotent. */
  release?: () => void;
}

export class MCPManager {
  private readonly deps: McpManagerDeps;
  private readonly logger: Logger;
  private readonly slots: Semaphore;
  private readonly reaper: ProcessReaper;

  /** Live sessions, keyed by server id — which is a cuid, so it is globally unique. */
  private readonly sessions = new Map<string, LiveSession>();
  /** In-flight opens, so two callers racing on one server spawn one child, not two. */
  private readonly opening = new Map<string, Promise<McpSession>>();
  /** In-flight crash teardowns, so `onerror` + `onclose` do not double-report. */
  private readonly settling = new Map<string, Promise<void>>();

  constructor(deps: McpManagerDeps) {
    this.deps = deps;
    this.logger = deps.logger;
    this.slots = new Semaphore(deps.options.maxStdioServers);
    this.reaper = deps.reaper ?? createProcessReaper();
  }

  // ── observability for tests and the health sweep ────────────────────────────

  get liveSessionCount(): number {
    return this.sessions.size;
  }

  get stdioSlots(): { total: number; inUse: number; queued: number } {
    return { total: this.slots.total, inUse: this.slots.inUse, queued: this.slots.queued };
  }

  isConnected(serverId: string): boolean {
    return this.sessions.has(serverId);
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Open a session and register whatever the server advertises.
   *
   * Idempotent, and routed through `ensureSession` so that two callers racing on the same
   * server share one handshake. The API layer calls this from `POST /api/mcp` and from
   * `POST /:id/reconnect`; a double-click must not leave two children behind.
   */
  async connect(tenantId: string, serverId: string): Promise<McpServerSummary> {
    const server = await this.requireServer(tenantId, serverId);
    await this.ensureSession(tenantId, server);
    return this.summarise(tenantId, server);
  }

  /**
   * Close the session and mark the server down.
   *
   * Deliberately marks the canonical tools `disabled` rather than `error`: a crash and an
   * operator pressing Disconnect are different events, and the UI distinguishes them. What
   * they share — and what the primer insists on — is that the tools are never deleted, so a
   * run that referenced one can still render its history.
   */
  async disconnect(tenantId: string, serverId: string): Promise<void> {
    await this.requireServer(tenantId, serverId);
    await this.closeSession(serverId);

    await this.deps.servers.markStatus(tenantId, serverId, 'disconnected', {
      pid: null,
      lastError: null,
    });
    await this.deps.tools.setStatusForServer(tenantId, serverId, 'disabled');
  }

  /** `disconnect` then `connect`, with discovery re-run so a changed tool list is picked up. */
  async reconnect(tenantId: string, serverId: string): Promise<McpServerSummary> {
    const server = await this.requireServer(tenantId, serverId);
    await this.closeSession(serverId);
    await this.openSession(tenantId, server);
    return this.summarise(tenantId, server);
  }

  /**
   * Remove a server.
   *
   * The canonical `Tool` rows are disabled, not deleted: `ToolCall.toolId` is a foreign key
   * and a run's history has to survive the tool being unregistered. `MCPTool` rows cascade
   * with the server, which is fine — they are pure discovery cache with no history behind
   * them.
   */
  async deleteServer(tenantId: string, serverId: string): Promise<void> {
    await this.requireServer(tenantId, serverId);
    await this.closeSession(serverId);
    await this.deps.tools.setStatusForServer(tenantId, serverId, 'disabled');
    await this.deps.servers.delete(tenantId, serverId);
  }

  /**
   * Close every session. Called from the SIGTERM handler.
   *
   * The map is cleared *before* the closes begin, so the `onclose` callbacks the SDK fires
   * on the way down find no session to report as crashed. Otherwise a clean shutdown would
   * write `crashed` to every row it touched.
   */
  async shutdown(): Promise<void> {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    // From the captured handles: the map is already empty, so anything that looks a session
    // up by id from here on would find nothing to release.
    for (const [, live] of entries) live.release?.();

    const results = await Promise.allSettled(
      entries.map(async ([serverId, live]) => {
        await live.session.close();
        // Clearing the pid is what makes the next boot's reconciliation a no-op for a
        // shutdown that went to plan.
        await this.deps.servers.markStatus(live.tenantId, serverId, 'disconnected', { pid: null });
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn({ err: String(result.reason) }, 'mcp: session failed to close cleanly');
      }
    }
  }

  /**
   * [gap #22 / C1] Kill child processes recorded by a previous process that died hard.
   *
   * Returns a per-row verdict so the health sweep can log what it did — and, more
   * importantly, what it refused to do. See `orphans.ts` for why refusing is often correct.
   */
  async reapOrphans(): Promise<
    Array<{ serverId: string; verdict: Awaited<ReturnType<typeof reapOrphan>> }>
  > {
    const rows = await this.deps.servers.listAllWithPids();
    const outcomes: Array<{ serverId: string; verdict: Awaited<ReturnType<typeof reapOrphan>> }> =
      [];

    for (const row of rows) {
      const verdict = await reapOrphan(this.reaper, { pid: row.pid!, command: row.command });

      if (verdict.action === 'skipped') {
        this.logger.warn(
          { serverId: row.id, pid: row.pid, reason: verdict.reason },
          'mcp: refusing to kill an unattributable pid; the row will be marked disconnected',
        );
      }

      await this.deps.servers.markStatus(row.tenantId, row.id, 'disconnected', {
        pid: null,
        lastError:
          verdict.action === 'killed'
            ? 'orphaned child process reaped on startup'
            : verdict.action === 'skipped'
              ? `pid ${row.pid} could not be verified as ours (${verdict.reason}) — it may still be running`
              : null,
      });

      outcomes.push({ serverId: row.id, verdict });
    }

    return outcomes;
  }

  // ── discovery ───────────────────────────────────────────────────────────────

  /** Reads the discovery cache. Works while disconnected — that is the point of caching. */
  async listTools(tenantId: string, serverId: string): Promise<McpToolView[]> {
    await this.requireServer(tenantId, serverId);
    const rows = await this.deps.mcpTools.listForServer(serverId);

    return Promise.all(
      rows.map(async (row) => {
        const capabilities = await this.capabilitiesFor(tenantId, row);
        const view: McpToolView = {
          externalId: row.externalId,
          name: row.name,
          description: row.description,
          inputSchema: row.inputSchema,
          enabled: row.enabled,
          toolId: row.toolId,
          capabilities,
        };
        return view;
      }),
    );
  }

  async listResources(tenantId: string, serverId: string): Promise<unknown> {
    const session = await this.requireSession(tenantId, serverId);
    return session.listResources();
  }

  async listPrompts(tenantId: string, serverId: string): Promise<unknown> {
    const session = await this.requireSession(tenantId, serverId);
    return session.listPrompts();
  }

  // ── invocation ──────────────────────────────────────────────────────────────

  /**
   * Call a discovered tool.
   *
   * `allowReconnectOnCrash` is the one place the "auto-reconnect only for read-only tools"
   * rule is enforced. When the caller sets it, the manager re-checks the tool's own
   * capability set and refuses — with `UNSUPPORTED_CAPABILITY`, not a silent skip — if
   * replaying could repeat an effect. The refusal is deliberate: silently *not* retrying
   * would look identical to a retry that failed, and the caller needs to know the
   * difference.
   */
  async callTool(
    tenantId: string,
    serverId: string,
    externalId: string,
    args: Record<string, unknown>,
    options: { allowReconnectOnCrash?: boolean } = {},
  ): Promise<ToolResult> {
    const server = await this.requireServer(tenantId, serverId);

    const descriptor = await this.deps.mcpTools.findByExternalId(serverId, externalId);
    if (descriptor === null) {
      throw new ApiError('NOT_FOUND', `MCP server does not expose a tool named "${externalId}"`, {
        serverId,
        externalId,
      });
    }
    if (!descriptor.enabled) {
      throw new ApiError('VALIDATION_ERROR', `MCP tool "${externalId}" is disabled`, {
        serverId,
        externalId,
      });
    }

    const capabilities = await this.capabilitiesFor(tenantId, descriptor);
    const maxAttempts = options.allowReconnectOnCrash === true ? 2 : 1;

    for (let attempt = 1; ; attempt += 1) {
      const session = await this.ensureSession(tenantId, server);

      try {
        const result = await session.callTool(externalId, args);
        return await this.toToolResult(server, externalId, result);
      } catch (cause) {
        if (!isCrash(cause)) throw cause;

        // Tear the dead session down before deciding anything. Doing it here — rather than
        // waiting for the transport's own `onclose` — is what makes the "crashed" state
        // observable to the very next line of the caller's code.
        await this.reapSession(tenantId, serverId, asError(cause));

        if (attempt >= maxAttempts) {
          throw new ApiError(
            'PROVIDER_ERROR',
            `MCP tool "${externalId}" failed: the server connection dropped mid-call`,
            {
              serverId,
              externalId,
              crashed: true,
              // Read by the engine: the request may already have been applied, so this
              // step must not be replayed unless the tool is read-only.
              outcomeUnknown: true,
            },
          );
        }

        if (!mayAutoReconnect(capabilities)) {
          throw new ApiError(
            'UNSUPPORTED_CAPABILITY',
            `Refusing to replay MCP tool "${externalId}": it may have applied an effect before the connection dropped`,
            { serverId, externalId, capabilities, crashed: true, outcomeUnknown: true },
          );
        }
      }
    }
  }

  // ── internals: sessions ─────────────────────────────────────────────────────

  private async openSession(tenantId: string, server: McpServer): Promise<McpSession> {
    await this.deps.servers.markStatus(tenantId, server.id, 'connecting');

    // The permit is taken before the spawn, not after: acquiring afterwards would let N
    // concurrent connects all spawn a child and only then queue, which is the leak the cap
    // exists to prevent.
    const release = server.transport === 'stdio' ? await this.slots.acquire() : undefined;

    let session: McpSession;
    try {
      session = await this.deps.sessionFactory.open(await this.buildSpec(tenantId, server));
    } catch (cause) {
      release?.();
      const message = asError(cause).message;
      await this.deps.servers.markStatus(tenantId, server.id, 'error', {
        pid: null,
        lastError: message,
      });
      await this.deps.tools.setStatusForServer(tenantId, server.id, 'error');
      throw cause instanceof ApiError
        ? cause
        : new ApiError('PROVIDER_ERROR', `Could not connect to MCP server "${server.name}": ${message}`, {
            serverId: server.id,
          });
    }

    this.sessions.set(server.id, { tenantId, session, ...(release === undefined ? {} : { release }) });

    // Registered after the session is in the map, so a crash that fires immediately still
    // finds something to tear down.
    session.onCrash((error) => {
      void this.reapSession(tenantId, server.id, error);
    });

    await this.deps.servers.markConnected(tenantId, server.id, session.pid);

    const registered = await this.discoverTools(tenantId, server, session);

    this.logger.info(
      { serverId: server.id, transport: server.transport, toolCount: registered.length },
      'mcp: server connected',
    );
    this.deps.emit?.(tenantId, { name: 'mcp.connected', payload: { serverId: server.id, toolCount: registered.length } });

    return session;
  }

  private async closeSession(serverId: string): Promise<void> {
    const live = this.sessions.get(serverId);
    if (live === undefined) return;

    this.sessions.delete(serverId);
    // Released from the captured handle, not by id: the entry is already out of the map, and
    // looking it up again would silently return the permit to nobody — leaking one slot per
    // disconnect until the cap stops bounding anything.
    live.release?.();
    // `LiveSession.close` clears its own crash handlers, so the SDK's `onclose` on the way
    // down cannot re-enter `reapSession`.
    await live.session.close().catch(() => undefined);
  }

  private async ensureSession(tenantId: string, server: McpServer): Promise<McpSession> {
    const live = this.sessions.get(server.id);
    if (live !== undefined) return live.session;

    // Two concurrent steps on one server must not each spawn a child. Sharing the in-flight
    // promise is what makes the second caller wait for the first connect rather than race it.
    const inFlight = this.opening.get(server.id);
    if (inFlight !== undefined) return inFlight;

    const promise = this.openSession(tenantId, server).finally(() => {
      this.opening.delete(server.id);
    });
    this.opening.set(server.id, promise);
    return promise;
  }

  private async requireSession(tenantId: string, serverId: string): Promise<McpSession> {
    const server = await this.requireServer(tenantId, serverId);
    const live = this.sessions.get(serverId);
    if (live === undefined) {
      // Not connected on demand: these back a GET, and a GET must not spawn a process.
      throw new ApiError('PROVIDER_ERROR', 'MCP server is not connected', {
        serverId,
        serverName: server.name,
      });
    }
    return live.session;
  }

  /**
   * The crash path. Idempotent, and awaited rather than fire-and-forget.
   *
   * The synchronous half — removing the session and returning the permit — runs before any
   * `await`, so a second signal arriving in the same tick sees the session already gone.
   * The returned promise is shared, which is what lets `callTool` await the *same* teardown
   * the transport's `onclose` started, instead of racing it.
   */
  private reapSession(tenantId: string, serverId: string, error: Error): Promise<void> {
    const existing = this.settling.get(serverId);
    if (existing !== undefined) return existing;

    const live = this.sessions.get(serverId);
    if (live === undefined) return Promise.resolve();

    this.sessions.delete(serverId);
    live.release?.();

    const work = this.recordCrash(tenantId, serverId, error).finally(() => {
      this.settling.delete(serverId);
    });
    this.settling.set(serverId, work);
    return work;
  }

  private async recordCrash(tenantId: string, serverId: string, error: Error): Promise<void> {
    this.logger.warn({ serverId, err: error.message }, 'mcp: server crashed');

    await this.deps.servers.markStatus(tenantId, serverId, 'crashed', {
      // Clearing the pid stops the next startup from trying to reap a process that the
      // transport has already killed.
      pid: null,
      lastError: error.message,
    });
    await this.deps.tools.setStatusForServer(tenantId, serverId, 'error');
  }

  // ── internals: discovery ────────────────────────────────────────────────────

  private async discoverTools(
    tenantId: string,
    server: McpServer,
    session: McpSession,
  ): Promise<Tool[]> {
    // A server that does not declare the `tools` capability is not asked for a tool list —
    // `tools/list` against it is a protocol error, not an empty result.
    const descriptors = session.capabilities.tools ? await session.listTools() : [];

    const canonical: Tool[] = [];
    const kept: string[] = [];

    for (const descriptor of descriptors) {
      const capabilities = capabilitiesFromAnnotations(descriptor.annotations);

      // The discovery cache row. Its id is not needed here — the canonical tool is linked
      // back by `(serverId, externalId)`, which is the pair the server itself uses.
      await this.deps.mcpTools.upsert({
        serverId: server.id,
        externalId: descriptor.name,
        name: descriptor.name,
        description: descriptor.description ?? null,
        inputSchema: asJsonInput(descriptor.inputSchema),
      });

      const tool = await this.deps.tools.upsert({
        tenantId,
        source: `mcp:${server.id}`,
        name: canonicalToolName(server.name, descriptor.name),
        description:
          descriptor.description ?? `MCP tool "${descriptor.name}" on server "${server.name}"`,
        type: 'mcp',
        provider: server.id,
        inputSchema: asJsonInput(descriptor.inputSchema),
        capabilities,
        mcpServerId: server.id,
        metadata: { externalId: descriptor.name, serverId: server.id, serverName: server.name },
      });

      await this.applyCapabilitiesNarrowing(tenantId, tool, capabilities);
      await this.deps.mcpTools.linkTool(server.id, descriptor.name, tool.id);

      canonical.push(tool);
      kept.push(descriptor.name);
    }

    // Tools the server stopped advertising are disabled, never deleted.
    await this.deps.mcpTools.disableMissing(server.id, kept);
    await this.deps.tools.disableMissingForServer(
      tenantId,
      server.id,
      canonical.map((tool) => tool.id),
    );

    return canonical;
  }

  /**
   * Apply the asymmetric capability rule.
   *
   * `upsert` leaves `capabilities` alone on update, so this is the only writer after
   * creation. Narrowing (side-effecting → read-only is a *widening*, so read it as: the new
   * set drops something) is applied; widening is logged and dropped. The direction that
   * matters is a server claiming a tool became harmless, because that is what removes an
   * approval gate.
   */
  private async applyCapabilitiesNarrowing(
    tenantId: string,
    tool: Tool,
    next: readonly string[],
  ): Promise<void> {
    const previous = tool.capabilities;
    if (sameSet(previous, next)) return;

    const widens = next.includes('read_only') && !previous.includes('read_only');

    if (widens) {
      this.logger.warn(
        { toolId: tool.id, toolName: tool.name, previous, declared: next },
        'mcp: server widened a tool capability; keeping the recorded value',
      );
      return;
    }

    await this.deps.tools.setCapabilities(tenantId, tool.id, [...next]);
  }

  // ── internals: results ──────────────────────────────────────────────────────

  private async toToolResult(
    server: McpServer,
    externalId: string,
    result: McpCallResult,
  ): Promise<ToolResult> {
    const capped = await capToolResult(
      { storage: this.deps.storage },
      result.content,
      {
        maxBytes: this.deps.options.toolResultMaxBytes,
        tenantId: server.tenantId,
        category: 'tool-results',
        label: `mcp:${server.name}/${externalId}`,
      },
    );

    // `isError` rides along rather than being folded into the content: a tool that reports
    // failure is a *successful call* with a negative answer, and the engine's retry policy
    // must not treat it like a transport failure.
    return result.isError ? { ...capped, isError: true } : capped;
  }

  // ── internals: plumbing ─────────────────────────────────────────────────────

  private async buildSpec(tenantId: string, server: McpServer): Promise<McpServerSpec> {
    const env = await this.deps.resolveEnv(tenantId, server.envRef);
    const headers = readStringRecord(server.headers);

    const spec: McpServerSpec = {
      serverId: server.id,
      transport: server.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
      args: server.args,
      headers,
      env,
      connectTimeoutMs: this.deps.options.connectTimeoutMs,
      callTimeoutMs: this.deps.options.callTimeoutMs,
    };

    if (server.command !== null) spec.command = server.command;
    if (server.url !== null) spec.url = server.url;
    return spec;
  }

  private async requireServer(tenantId: string, serverId: string): Promise<McpServer> {
    const server = await this.deps.servers.findById(tenantId, serverId);
    if (server === null) {
      // 404 for "exists but belongs to another tenant" as well as "does not exist": the
      // difference is itself information a caller should not be able to extract.
      throw new ApiError('NOT_FOUND', 'MCP server not found', { serverId });
    }
    return server;
  }

  private async capabilitiesFor(tenantId: string, descriptor: MCPTool): Promise<string[]> {
    if (descriptor.toolId === null) {
      // Discovery has not linked this row yet. Assume an effect — the safe default, and the
      // same one `capabilitiesFromAnnotations` reaches for an unannotated tool.
      return ['external_side_effect'];
    }
    const tool = await this.deps.tools.findById(tenantId, descriptor.toolId);
    return tool?.capabilities ?? ['external_side_effect'];
  }

  private async summarise(tenantId: string, server: McpServer): Promise<McpServerSummary> {
    const tools = await this.deps.mcpTools.listForServer(server.id);
    // Re-read the row: the caller passed us a snapshot from before the connect, and `pid`
    // and `status` have both changed since.
    const fresh = (await this.deps.servers.findById(tenantId, server.id)) ?? server;

    return {
      id: fresh.id,
      name: fresh.name,
      transport: fresh.transport,
      status: fresh.status,
      pid: fresh.pid,
      toolCount: tools.filter((tool) => tool.enabled).length,
      lastConnectedAt: fresh.lastConnectedAt,
      lastError: fresh.lastError,
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isCrash(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return false;
  const details = cause.details;
  return (
    details !== null &&
    typeof details === 'object' &&
    (details as Record<string, unknown>)['crashed'] === true
  );
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Order-insensitive set equality for capability lists.
 *
 * Exported because `ConnectorService` applies the same asymmetric capability rule this file does,
 * and two hand-written comparisons would be two chances to disagree about whether `['a','b']` and
 * `['b','a']` are the same set — a disagreement that would show up as a capability set being
 * rewritten on every discovery pass, or never updated when it should be.
 */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/**
 * The model-facing name for a discovered tool.
 *
 * MCP gives no uniqueness guarantee across servers, and a provider's function-calling API
 * needs one name per function. Namespacing by the server's display name makes the tool
 * self-describing in a trace, and the hash suffix keeps the result stable and collision-free
 * when the combined name would exceed the 64-character ceiling that OpenAI and Anthropic
 * both impose. The *authoritative* mapping back to the server's own name lives in
 * `Tool.metadata.externalId` — this string is never parsed back.
 */
export function canonicalToolName(serverName: string, externalId: string): string {
  const combined = `${slug(serverName)}__${slug(externalId)}`;
  if (combined.length <= 64) return combined;

  const suffix = shortHash(`${serverName}\u0000${externalId}`);
  return `${combined.slice(0, 64 - suffix.length - 1)}_${suffix}`;
}

function slug(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');
  // A name made entirely of punctuation collapses to nothing; `tool` keeps the shape valid
  // rather than producing a leading double underscore.
  return cleaned.length === 0 ? 'tool' : cleaned.slice(0, 48);
}

function shortHash(input: string): string {
  // FNV-1a, not SHA-256: this only has to be stable and well-spread, and it has to run
  // synchronously inside a pure name-building function.
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Coerce arbitrary JSON from a third-party server into something a `Json` column accepts.
 *
 * Round-tripping through `JSON.stringify` strips prototypes and functions, so a server that
 * sends a schema with a `toJSON` hook cannot smuggle behaviour into the stored value.
 */
function asJsonInput(value: unknown): JsonInput {
  if (value === null || value === undefined) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as JsonInput;
  } catch {
    return {};
  }
}

function readStringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

/**
 * `KEY=value` lines, the format `McpServer.envRef` credentials are stored in.
 *
 * Blank lines and `#` comments are skipped so an operator can paste a `.env` file straight
 * into the credential field. Exported because the composition root has to parse with the
 * same rules the manager expects — two parsers that disagree is a bug waiting to happen.
 */
/**
 * The inverse of `parseEnvBlock`, for the write path.
 *
 * The two live together on purpose. An env block is stored as a single encrypted string, so the
 * format is a contract between whatever writes it and `parseEnvBlock` — and the writer used to
 * not exist. Splitting them across two modules is how a writer learns to emit JSON while the
 * reader still expects `KEY=value`, which fails as a server that starts with no environment and
 * no error anyone can see.
 *
 * **A value containing a newline is refused by the schema rather than escaped here.** The format
 * cannot express one: `parseEnvBlock` splits on newlines before it looks for `=`, so a multi-line
 * value would come back as a truncated secret plus a junk key. Silently truncating a credential
 * is the worst possible failure, so it is a 400 at the boundary — see `createMcpServerSchema`.
 */
export function formatEnvBlock(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export function parseEnvBlock(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    // Strip one layer of matching quotes, which is what a `.env` file's syntax means.
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      const quote = value[0]!;
      if (value.endsWith(quote)) value = value.slice(1, -1);
    }
    if (key.length > 0) out[key] = value;
  }
  return out;
}
