import { ApiError, type InvokeToolInput, type ListToolsQuery, type ToolDetail, type ToolInvocationView, type ToolSummary } from '@nexs/shared';
import type { ToolRepository } from '../../repositories/mcp.repo.js';
import type { BuiltinToolService } from './builtin-tools.service.js';
import type { ToolInvoker } from './tool-invoker.js';
import { toToolDetail, toToolSummary } from '../../mappers/registry.js';

/**
 * `/api/tools` — the registry an agent's allowlist is drawn from.
 *
 * ## The rule this service exists to enforce
 *
 * **The registry is the source of truth, and the rows are a projection of it.** `Tool` rows are
 * what the planner offers the model, but they are derived from `NativeToolRegistry` by
 * `BuiltinToolService.ensure`. That means a fresh tenant has no tool rows at all until something
 * asks for them — so every read here calls `ensure` first. Without that, a newly signed-up tenant
 * would open the Tools page and see nothing, and the obvious conclusion ("this build has no
 * tools") would be wrong.
 *
 * `ensure` is idempotent and additive: it creates missing rows and never rewrites an existing one,
 * so an operator who disabled `http_request` keeps it disabled across every page load.
 *
 * ## Why the test-invoke is guarded
 *
 * `POST /:id/invoke` runs a tool for real. For a read-only tool that is a harmless probe. For one
 * whose capabilities resolve to an effect — and the resolution depends on the *arguments*, so
 * `http_request` is only effectful when the method is a POST — running it from a test button is
 * how the same webhook fires twice. The engine's own path goes through the approval policy, which
 * is the machinery built for that question; a route that skipped it would be a hole in it. So an
 * effectful call needs `confirmSideEffects: true` and is refused with `FORBIDDEN` otherwise,
 * naming the capabilities it found.
 */

export interface ToolServiceDeps {
  tools: ToolRepository;
  builtin: BuiltinToolService;
  invoker: ToolInvoker;
}

export class ToolService {
  constructor(private readonly deps: ToolServiceDeps) {}

  /**
   * The registry.
   *
   * Filtered in memory after `ensure`, because `ToolRepository.list` takes no filters and adding
   * them would mean changing a signature `BuiltinToolService` and the engine also use. A tenant's
   * registry is bounded by what its built-ins and its MCP servers expose — tens of rows — so this
   * is a real trade rather than a careless one, and it is stated here so a registry that ever
   * grows past that gets the query-level fix instead of a mysterious slowdown.
   */
  async list(tenantId: string, query: ListToolsQuery): Promise<ToolSummary[]> {
    const rows = await this.deps.builtin.ensure(tenantId);
    const needle = query.q?.toLowerCase();

    return rows
      .filter((row) => query.type === undefined || row.type === query.type)
      .filter((row) => query.source === undefined || row.source === query.source)
      .filter((row) => query.status === undefined || row.status === query.status)
      .filter((row) => query.mcpServerId === undefined || row.mcpServerId === query.mcpServerId)
      .filter((row) => {
        if (needle === undefined) return true;
        return (
          row.name.toLowerCase().includes(needle) ||
          (row.description ?? '').toLowerCase().includes(needle)
        );
      })
      .map(toToolSummary);
  }

  async get(tenantId: string, id: string): Promise<ToolDetail> {
    // `ensure` first so a built-in tool can be fetched by id on a tenant that has never listed.
    await this.deps.builtin.ensure(tenantId);

    const tool = await this.deps.tools.findById(tenantId, id);
    if (tool === null) {
      throw new ApiError('NOT_FOUND', 'Tool not found', { toolId: id });
    }
    return toToolDetail(tool);
  }

  /**
   * Run a tool once, outside any run.
   *
   * `invoker.resolve` is called before `invoke` rather than letting the invoker decide, because the
   * decision here is about *permission*, not about execution: the capabilities have to be known
   * before the tool runs, and `invoke` would run it first and report afterwards. `resolve` also
   * produces the two errors worth distinguishing — `NOT_FOUND` for an unknown id, and
   * `UNSUPPORTED_CAPABILITY` for a tool that is disabled or whose handler is not registered.
   */
  async invoke(tenantId: string, id: string, input: InvokeToolInput): Promise<ToolInvocationView> {
    const args = input.args ?? {};

    const resolved = await this.deps.invoker.resolve(tenantId, id, args);

    if (resolved.sideEffect && input.confirmSideEffects !== true) {
      throw new ApiError(
        'FORBIDDEN',
        `"${resolved.tool.name}" has side effects for these arguments. Re-send with confirmSideEffects: true to run it.`,
        { toolId: id, name: resolved.tool.name, capabilities: resolved.capabilities },
      );
    }

    const result = await this.deps.invoker.invoke({
      tenantId,
      toolId: id,
      args,
      agentId: input.agentId ?? null,
      // No `runId` / `stepId`: this is not a run, and attributing the call to one would put a
      // tool call in a run's history that the engine never planned or verified.
    });

    return {
      toolId: id,
      name: resolved.tool.name,
      ok: result.ok,
      content: result.result.content,
      truncated: result.result.truncated,
      originalBytes: result.result.originalBytes,
      ...(result.result.ref === undefined ? {} : { ref: result.result.ref }),
      capabilities: result.capabilities,
      sideEffect: result.sideEffect,
      durationMs: result.durationMs,
    };
  }
}
