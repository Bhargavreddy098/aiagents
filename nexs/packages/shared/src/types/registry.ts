/**
 * The tool registry and MCP surfaces, as the UI sees them.
 *
 * Distinct from `types/tools.ts`, which holds the engine's contracts. The split is deliberate:
 * the engine's shapes describe what happens *during* a run and must stay stable for replay, while
 * these describe what a page renders and will change whenever the page does. Merging them would
 * make every UI iteration a potential replay-compatibility change.
 *
 * The one rule that shapes this file: **a capability set is reported for a concrete call, not for
 * a tool in the abstract.** `ToolInvoker` resolves capabilities from the arguments — `http_request`
 * is `read_only` for a GET and `external_side_effect` for a POST — so a `ToolSummary` that carried
 * a single `capabilities` array would be describing a tool that does not exist. The summary
 * carries the tool row's declared set, and the *invocation result* carries the resolved one, and
 * the two are named differently so they cannot be confused.
 */

// ── tools ─────────────────────────────────────────────────────────────────────

/**
 * A canonical tool.
 *
 * `source` and `provider` are both present because they answer different questions: `source` is
 * where the row came from (`builtin`, `mcp:<serverId>`, `connector:<id>`), `provider` is what
 * executes it. For a native tool they agree; for an MCP tool `source` names the server and
 * `provider` carries the same server id, which is what makes "which server is this from" a read
 * of one field rather than a parse of another.
 */
export interface ToolSummary {
  id: string;
  source: string;
  name: string;
  description: string | null;
  type: string;
  provider: string | null;
  /** The tool row's declared capabilities. See the file header for why this is not the last word. */
  capabilities: string[];
  status: string;
  mcpServerId: string | null;
  connectorAccountId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One tool, with its argument schema.
 *
 * `inputSchema` is omitted from the summary because it is the largest column on the row and the
 * list page never renders it. It is a raw JSON Schema, passed through unchanged — validating or
 * reshaping it here would be a second, weaker opinion about what the tool accepts.
 */
export interface ToolDetail extends ToolSummary {
  inputSchema: unknown;
}

/**
 * The outcome of `POST /api/tools/:id/invoke`.
 *
 * ## Why `sideEffect` is on the response and not just in the logs
 *
 * This endpoint runs a tool for real. For a `read_only` tool that is a harmless probe; for a tool
 * declaring `external_side_effect` it sends the email. The response says which of those just
 * happened, resolved from the arguments the caller supplied, so a client that rendered a test
 * button without checking first has something concrete to show afterwards.
 *
 * `ok: false` with a present `error` is the call not happening (a disabled tool, a crashed MCP
 * server) — the invoker throws for those and the controller turns it into an error response. A
 * `200` with `ok: false` means the tool *ran* and reported its own failure, which is a different
 * thing and needs different retry treatment.
 */
export interface ToolInvocationView {
  toolId: string;
  name: string;
  ok: boolean;
  /** The capped result payload, exactly as the engine would have received it. */
  content: string;
  truncated: boolean;
  originalBytes: number;
  /** Set when the payload was moved to the storage service rather than inlined. */
  ref?: string;
  /** Resolved from *these* arguments. The honest answer to "was this a side effect". */
  capabilities: string[];
  sideEffect: boolean;
  durationMs: number;
}

// ── MCP ───────────────────────────────────────────────────────────────────────

export const MCP_TRANSPORTS = ['stdio', 'streamable-http'] as const;
export type McpTransportName = (typeof MCP_TRANSPORTS)[number];

/**
 * An MCP server.
 *
 * `pid` is on the wire on purpose. It is the one field that lets an operator see a child process
 * the reaper failed to kill — the reason the column exists at all — and hiding it would mean the
 * only way to find a leak is to go looking in the database.
 */
export interface McpServerSummary {
  id: string;
  name: string;
  transport: string;
  status: string;
  pid: number | null;
  /** How many canonical tools this server contributed. A row count, not a live `tools/list`. */
  toolCount: number;
  lastConnectedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One server, with its launch configuration.
 *
 * **`headerNames` rather than `headers`.** An MCP server's headers carry its bearer tokens; the
 * values live in the vault-encrypted `headers` column and are decrypted only for the length of a
 * handshake. The names are what the edit form needs ("this server takes an `Authorization`
 * header") and the values are exactly what must not leave the process.
 */
export interface McpServerDetail extends McpServerSummary {
  command: string | null;
  args: string[];
  url: string | null;
  headerNames: string[];
  /** Whether an encrypted env block is attached, without revealing what is in it. */
  hasEnv: boolean;
}

/**
 * A tool as the MCP server itself advertises it.
 *
 * `toolId` is the link to the canonical `Tool` row: an agent is granted the canonical id, never
 * the server's own name, so a page that wanted to say "this discovered tool is available" has to
 * join through this field rather than match on `name`.
 */
export interface McpToolSummary {
  externalId: string;
  name: string;
  description: string | null;
  inputSchema: unknown;
  enabled: boolean;
  toolId: string | null;
  capabilities: string[];
}
