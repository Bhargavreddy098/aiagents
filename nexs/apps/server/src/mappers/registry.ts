import type { McpServer, Tool } from '@prisma/client';
import type { McpServerDetail, McpServerSummary, McpToolSummary, ToolDetail, ToolSummary } from '@nexs/shared';
import type { McpToolView } from '../services/mcp/mcp-manager.js';

/**
 * Row → wire for the tool registry and MCP servers.
 *
 * Two redactions, both of which are the reason this file exists rather than a spread:
 *
 *  - **`McpServer.headers` becomes `headerNames`.** The column holds the server's request
 *    headers, which for anything authenticated is a bearer token in the clear. The edit form
 *    needs to know *that* an `Authorization` header is configured; it never needs the value.
 *    Returning the names is the whole of what a client can be told.
 *  - **`envRef` becomes `hasEnv`.** Same reasoning one step further: the env block is an
 *    encrypted `Credential` row, and whether one is attached is the only question that has an
 *    answer safe to render.
 */

function toIso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

export function toToolSummary(row: Tool): ToolSummary {
  return {
    id: row.id,
    source: row.source,
    name: row.name,
    description: row.description,
    type: row.type,
    provider: row.provider,
    // The row's *declared* set. The set resolved for a specific call comes back from
    // `POST /:id/invoke` — the two are named apart in `types/registry.ts` so they cannot be
    // rendered as if they were the same thing.
    capabilities: [...row.capabilities],
    status: row.status,
    mcpServerId: row.mcpServerId,
    connectorAccountId: row.connectorAccountId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * One tool, with its argument schema.
 *
 * `inputSchema` is passed through unchanged. Validating or reshaping it here would create a
 * second opinion about what the tool accepts, and the one that matters is the one `ToolInvoker`
 * checks against at call time.
 */
export function toToolDetail(row: Tool): ToolDetail {
  return { ...toToolSummary(row), inputSchema: row.inputSchema };
}

export function toMcpServerSummary(row: McpServer, toolCount: number): McpServerSummary {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    status: row.status,
    // On the wire deliberately: a leaked pid is what the column exists to make visible.
    pid: row.pid,
    toolCount,
    lastConnectedAt: toIso(row.lastConnectedAt),
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The header *names* of a server's configured headers.
 *
 * `headers` is a Json column and could hold anything; a non-object reads as no headers rather
 * than throwing, for the same reason `readLastError` in `mappers/providers.ts` does.
 */
export function readHeaderNames(headers: unknown): string[] {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return [];
  return Object.keys(headers as Record<string, unknown>).sort();
}

export function toMcpServerDetail(row: McpServer, toolCount: number): McpServerDetail {
  return {
    ...toMcpServerSummary(row, toolCount),
    command: row.command,
    args: [...row.args],
    url: row.url,
    // Never the values. See the file header.
    headerNames: readHeaderNames(row.headers),
    hasEnv: row.envRef !== null && row.envRef.length > 0,
  };
}

/**
 * A discovered MCP tool.
 *
 * Takes the manager's `McpToolView` rather than the raw `MCPTool` row, and that is not a
 * convenience. `capabilities` is **derived**, not stored: `MCPTool` has no such column, and the
 * manager computes the set from the server's annotations plus the asymmetric narrowing rule it
 * enforces (a server may narrow its own tool's capabilities, never widen them). Reading the row
 * directly would produce a tool view with no capabilities at all — and a capability set is what
 * the approval policy is written against, so an empty one would read as "safe to auto-retry".
 *
 * The row-level fields (`enabled`, `toolId`) are identical either way; only `capabilities` has
 * to come from the manager.
 */
export function toMcpToolSummary(view: McpToolView): McpToolSummary {
  return {
    externalId: view.externalId,
    name: view.name,
    description: view.description,
    inputSchema: view.inputSchema,
    enabled: view.enabled,
    toolId: view.toolId,
    capabilities: [...view.capabilities],
  };
}
