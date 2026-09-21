import { ApiError, hasSideEffects, type ToolResult } from '@nexs/shared';
import type { Tool } from '@prisma/client';
import type { Logger } from '../../logger.js';
import type { MCPToolRepository, ToolRepository } from '../../repositories/mcp.repo.js';
import type { BrowserManager } from '../browser/browser-manager.js';
import type { ConnectorService } from '../connectors/connector.service.js';
import type { MCPManager } from '../mcp/mcp-manager.js';
import type { SandboxProvider } from '../sandbox/node-worker.provider.js';
import type { StorageService } from '../storage/storage.service.js';
import type { NativeToolRegistry } from './native-tools.js';
import { capToolResult } from './tool-result.js';

/**
 * The single place a step's work actually happens.
 *
 * The engine holds a `Tool` row and an argument bag; it does not know whether that tool
 * is a function in this process, a child process speaking MCP, a Playwright page, or a
 * worker thread. This class is where that question is answered, and it is the only place
 * the answer is written down. Everything above it — the engine, the verifier, the planner
 * — is written against the `Tool` row, which is what makes a plan portable across tool
 * kinds and what lets the tool allowlist in the validation ladder be a single check.
 *
 * Two boundaries are worth stating.
 *
 * **It does not persist anything.** The engine writes the `ToolCall` row *before* calling
 * `invoke` and the `ExecutionReceipt` *after* it returns, because the ordering of those
 * two writes relative to the call is the entire exactly-once guarantee. If the invoker
 * owned the writes, that ordering would be a convention spread across five dispatch
 * branches instead of a property of one loop.
 *
 * **It throws when the call could not be performed, and returns when it was.** A missing
 * tool, a disabled tool, a crashed MCP server, an unreachable sandbox — those are throws.
 * A tool that ran and reported its own failure comes back with `ok: false`, because "the
 * endpoint returned 500" and "the tool never ran" need different retry treatment and
 * collapsing them would lose that.
 */

export interface ToolInvocationRequest {
  tenantId: string;
  runId?: string | null;
  stepId?: string | null;
  agentId?: string | null;
  toolId: string;
  args: Record<string, unknown>;
  /** The engine's per-step timeout. Passed down to whichever provider runs. */
  signal?: AbortSignal;
}

export interface ToolInvocationResult {
  ok: boolean;
  result: ToolResult;
  durationMs: number;
  /** Capabilities resolved for *these* arguments, not for the tool in the abstract. */
  capabilities: string[];
  sideEffect: boolean;
  /** The tool ran and reported failure itself, as opposed to the call not happening. */
  toolReportedError: boolean;
}

/**
 * The provider surfaces this class actually uses, as `Pick`-derived ports.
 *
 * Each is a single method or two, and naming them is what keeps the invoker honest about
 * how much of each manager it depends on: a change that made it want `MCPManager.connect`
 * or `BrowserManager.reconcile` would show up as a port change rather than as a quiet new
 * coupling. It also means a test can drive the whole dispatch table with four small
 * objects instead of a Playwright launcher and a child-process supervisor.
 */
export type McpToolCaller = Pick<MCPManager, 'callTool'>;
export type BrowserActor = Pick<BrowserManager, 'act' | 'list' | 'open'>;
export type ConnectorExecutor = Pick<ConnectorService, 'executeAction'>;

export interface ToolInvokerDeps {
  tools: ToolRepository;
  mcpTools: MCPToolRepository;
  native: NativeToolRegistry;
  mcp: McpToolCaller;
  browser: BrowserActor;
  /** Connector actions. One method, named here so the invoker cannot reach into the rest. */
  connectors: ConnectorExecutor;
  sandbox: SandboxProvider;
  storage: StorageService;
  logger: Logger;
  now: () => number;
  options: { toolResultMaxBytes: number };
}

/**
 * The browser action vocabulary, mirrored from `BrowserActionType`.
 *
 * Held here rather than imported so that a model-supplied argument bag is checked against
 * a literal list before it reaches the browser manager. The manager would reject an
 * unknown action anyway, but it would do so as an unhandled case rather than as a
 * validation error the engine can attribute to the step.
 */
const BROWSER_ACTIONS: readonly string[] = [
  'navigate',
  'click',
  'type',
  'select',
  'extract',
  'upload',
  'download',
  'screenshot',
  'wait',
  'inspect',
  'close',
];

export class ToolInvoker {
  constructor(private readonly deps: ToolInvokerDeps) {}

  /**
   * Load a tool and its resolved capabilities without running it.
   *
   * The engine needs this before the call so it can write the `ToolCall` row with the
   * right `sideEffect` flag, and so the approval policy can be consulted. Resolving
   * capabilities twice — once here and once inside `invoke` — would be the kind of
   * duplication that drifts; the engine passes the resolved set back in.
   */
  async resolve(
    tenantId: string,
    toolId: string,
    args: Record<string, unknown>,
  ): Promise<{ tool: Tool; capabilities: string[]; sideEffect: boolean }> {
    const tool = await this.deps.tools.findById(tenantId, toolId);
    if (tool === null) {
      throw new ApiError('NOT_FOUND', 'Tool not found', { toolId });
    }
    if (tool.status !== 'enabled') {
      throw new ApiError('UNSUPPORTED_CAPABILITY', `Tool is ${tool.status}`, {
        toolId,
        name: tool.name,
        status: tool.status,
      });
    }

    const capabilities = this.capabilitiesFor(tool, args);
    return { tool, capabilities, sideEffect: hasSideEffects(capabilities) };
  }

  /**
   * Capabilities for this call.
   *
   * A native tool computes them from its arguments (a GET is read-only, a POST is not);
   * every other kind reads the set recorded on the row. The asymmetry is deliberate: for
   * a native tool we can see the code, so the classification is derived rather than
   * declared and cannot go stale. For an MCP or connector tool the row is the only
   * evidence available, and `MCPManager` is responsible for never letting it widen.
   */
  capabilitiesFor(tool: Tool, args: Record<string, unknown>): string[] {
    if (tool.type === 'native') {
      if (this.deps.native.has(tool.name)) {
        return this.deps.native.capabilitiesFor(tool.name, args);
      }
      // A `native` row whose name is not in the registry is a row we cannot honour. Falling
      // back to the row's stored capabilities would be wrong for the same reason the MCP
      // manager refuses to widen: a stale declaration is not evidence.
      throw new ApiError('UNSUPPORTED_CAPABILITY', `Native tool "${tool.name}" is not implemented`, {
        name: tool.name,
      });
    }
    return [...tool.capabilities];
  }

  async invoke(request: ToolInvocationRequest): Promise<ToolInvocationResult> {
    const startedAt = this.deps.now();
    const { tool, capabilities, sideEffect } = await this.resolve(
      request.tenantId,
      request.toolId,
      request.args,
    );

    const raw = await this.dispatch(tool, request);

    const result = await capToolResult(
      { storage: this.deps.storage },
      raw.payload,
      {
        maxBytes: this.deps.options.toolResultMaxBytes,
        tenantId: request.tenantId,
        category: 'tool-results',
        label: tool.name,
      },
    );

    if (raw.isError === true) result.isError = true;

    return {
      ok: raw.isError !== true,
      result,
      durationMs: this.deps.now() - startedAt,
      capabilities,
      sideEffect,
      toolReportedError: raw.isError === true,
    };
  }

  // ── dispatch ────────────────────────────────────────────────────────────────

  private async dispatch(
    tool: Tool,
    request: ToolInvocationRequest,
  ): Promise<{ payload: unknown; isError?: boolean }> {
    switch (tool.type) {
      case 'native':
        return { payload: await this.runNative(tool, request) };

      case 'mcp':
        return this.runMcp(tool, request);

      case 'browser':
        return { payload: await this.runBrowser(tool, request) };

      case 'sandbox':
        return this.runSandbox(tool, request);

      case 'connector':
        // The adapter's result shape is `{ payload, isError? }` — deliberately the same shape this
        // dispatch returns, so there is no translation here. `ConnectorService` resolves the
        // connector, the account and the credential from the `Tool` row alone; the invoker does not
        // know what a connector is, which is the whole point of the canonical `Tool` row.
        return this.deps.connectors.executeAction(request.tenantId, tool, request.args);

      default:
        throw new ApiError('UNSUPPORTED_CAPABILITY', `Unknown tool type "${tool.type}"`, {
          toolId: tool.id,
          type: tool.type,
        });
    }
  }

  private async runNative(tool: Tool, request: ToolInvocationRequest): Promise<unknown> {
    return this.deps.native.execute(tool.name, request.args, {
      tenantId: request.tenantId,
      runId: request.runId ?? null,
      stepId: request.stepId ?? null,
      // The agent is threaded through because `memory_store` attributes a memory to it: without
      // it every memory an agent writes would be workspace-wide, which is a silent widening of
      // who can recall it.
      agentId: request.agentId ?? null,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  private async runMcp(
    tool: Tool,
    request: ToolInvocationRequest,
  ): Promise<{ payload: unknown; isError?: boolean }> {
    const serverId = tool.mcpServerId;
    if (serverId === null) {
      throw new ApiError('INTERNAL_ERROR', 'MCP tool has no server', { toolId: tool.id });
    }

    // The canonical name is a namespaced, length-capped label for the model. The server
    // knows the tool by its own name, so the mapping has to come from the discovered row.
    const discovered = await this.deps.mcpTools.findByToolId(tool.id);
    if (discovered === null) {
      throw new ApiError('INTERNAL_ERROR', 'MCP tool has no discovered counterpart', {
        toolId: tool.id,
        serverId,
      });
    }

    const result = await this.deps.mcp.callTool(
      request.tenantId,
      serverId,
      discovered.externalId,
      request.args,
      // Reconnection is the engine's decision, not the invoker's: the engine knows whether
      // this step has already been attempted and whether a retry would be a repeat.
      { allowReconnectOnCrash: false },
    );

    return { payload: result.content, isError: result.isError };
  }

  private async runBrowser(tool: Tool, request: ToolInvocationRequest): Promise<unknown> {
    const action = request.args['action'];
    if (action === null || typeof action !== 'object' || Array.isArray(action)) {
      throw new ApiError('VALIDATION_ERROR', 'Browser tools take an "action" object', {
        toolId: tool.id,
      });
    }
    const type = (action as Record<string, unknown>)['type'];
    if (typeof type !== 'string' || !BROWSER_ACTIONS.includes(type)) {
      throw new ApiError('VALIDATION_ERROR', 'Unknown browser action', {
        allowed: [...BROWSER_ACTIONS],
        received: type,
      });
    }

    const sessionId = await this.browserSessionFor(request);
    const outcome = await this.deps.browser.act(
      request.tenantId,
      sessionId,
      action as Parameters<BrowserActor['act']>[2],
    );

    return {
      sessionId: outcome.sessionId,
      action: outcome.action,
      url: outcome.currentUrl,
      title: outcome.title,
      screenshotRef: outcome.screenshotRef,
      output: outcome.output ?? null,
      durationMs: outcome.durationMs,
    };
  }

  /**
   * The run's browser session, opened on first use.
   *
   * A browser tool step does not name a session, because a plan should not have to know
   * one exists — "go to this page and read the price" is the intent, and the session is
   * how it is carried out. Reusing the run's live session across steps is what makes a
   * multi-step browse (navigate, then click, then extract) work at all; cookies and
   * `localStorage` live in the context, so a fresh context per step would lose the login.
   */
  private async browserSessionFor(request: ToolInvocationRequest): Promise<string> {
    if (request.runId !== undefined && request.runId !== null) {
      const existing = await this.deps.browser.list(request.tenantId, {
        runId: request.runId,
        status: 'active',
        limit: 1,
      });
      const session = existing[0];
      if (session !== undefined) return session.id;
    }

    const opened = await this.deps.browser.open(request.tenantId, {
      runId: request.runId ?? null,
      agentId: request.agentId ?? null,
    });
    return opened.id;
  }

  private async runSandbox(
    tool: Tool,
    request: ToolInvocationRequest,
  ): Promise<{ payload: unknown; isError?: boolean }> {
    const code = request.args['code'];
    if (typeof code !== 'string' || code.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'Sandbox tools take a "code" string', {
        toolId: tool.id,
      });
    }

    const timeoutMs = request.args['timeoutMs'];
    const maxOutputBytes = request.args['maxOutputBytes'];

    const outcome = await this.deps.sandbox.run({
      code,
      input: request.args['input'],
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      ...(typeof maxOutputBytes === 'number' ? { maxOutputBytes } : {}),
    });

    return {
      payload: {
        status: outcome.status,
        value: outcome.value ?? null,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        ...(outcome.terminatedReason === undefined ? {} : { terminatedReason: outcome.terminatedReason }),
        ...(outcome.outputTruncated === undefined ? {} : { outputTruncated: outcome.outputTruncated }),
      },
      // A sandbox that timed out or exited non-zero is a tool that ran and failed, not a
      // call that did not happen: the code executed, and the result says so.
      isError: outcome.status !== 'completed' || outcome.exitCode !== 0,
    };
  }
}
