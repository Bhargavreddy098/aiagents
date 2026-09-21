import { z } from 'zod';
import { MCP_TRANSPORTS } from '../types/registry.js';
import { httpUrl } from './url.js';

/**
 * Tool registry and MCP input schemas.
 *
 * Two rules here are load-bearing and neither is about validation for its own sake:
 *
 *  1. **An MCP server's transport determines its configuration, and the schema enforces it.**
 *     A `stdio` server with no `command` is a row that can never connect; an `http` server with
 *     a `command` is a row that connects over a URL and silently ignores the command someone
 *     thought they were editing. Both are 400s here rather than a `lastError` nobody reads.
 *  2. **A test invocation of a side-effecting tool requires explicit confirmation.** See
 *     `invokeToolSchema` — this is the one place the API can send an email from a button that
 *     says "Test".
 */

const id = z.string().trim().min(1);

/**
 * An MCP server's environment block.
 *
 * ## Why a newline is a validation error
 *
 * The block is stored as one encrypted string and read back by `parseEnvBlock`, which splits on
 * newlines *before* it looks for `=`. A value containing a newline therefore cannot round-trip: it
 * comes back as a truncated secret plus a junk key, and the server starts with a credential that
 * is silently wrong. Refusing it at the boundary is the only place this can be caught — by the
 * time it is in the vault, the original value is gone.
 *
 * The key pattern is also enforced, for the same class of reason: a key with a space or an `=`
 * in it parses back as something else entirely.
 */
const envBlock = z.record(
  z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an environment variable name must be letters, digits and underscores')
    .max(256),
  z
    .string()
    .max(8192)
    .refine((value) => !/[\r\n]/.test(value), 'an environment value cannot contain a newline'),
);

/**
 * The registry's filters.
 *
 * `q` is a substring match on the tool's name and description, kept deliberately dumb: the
 * registry is small enough that a real search index would be ceremony, and a page that filtered
 * on the server is one where the count it shows is the count that matched.
 */
export const listToolsSchema = z
  .object({
    type: z.enum(['native', 'mcp', 'connector', 'browser', 'sandbox', 'plugin']).optional(),
    source: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['enabled', 'disabled', 'error']).optional(),
    mcpServerId: id.optional(),
    q: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/**
 * A test invocation.
 *
 * ## `confirmSideEffects` is not a formality
 *
 * `POST /api/tools/:id/invoke` exists so an operator can check that a tool works without
 * building a whole run. For a `read_only` tool that is a free probe. For a tool whose
 * capabilities resolve to `external_side_effect` — and the resolution depends on the *arguments*,
 * so `http_request` is only effectful when the method is a POST — running it from a test button
 * is how the same webhook fires twice.
 *
 * So the flag is required to be exactly `true` before an effectful call runs, and the service
 * refuses with `FORBIDDEN` otherwise. The refusal names the resolved capabilities, so a caller
 * learns *why* rather than being told to try again. The engine's own path is unaffected: it goes
 * through the approval policy, which is the machinery built for this question.
 *
 * `args` is a free-form object because each tool's schema is its own — validating here would mean
 * this schema owning a second copy of every tool's `inputSchema`, which would drift from the copy
 * the invoker actually checks against.
 */
export const invokeToolSchema = z
  .object({
    args: z.record(z.unknown()).optional(),
    /** Must be `true` for a tool that resolves to a side-effecting capability. */
    confirmSideEffects: z.boolean().optional(),
    /** Attributed to the `ToolCall` row when the engine is not the caller. */
    agentId: id.nullable().optional(),
  })
  .strict();

/**
 * Adding an MCP server.
 *
 * `env` is write-only, exactly like a provider's `apiKey`: it is encrypted into a `Credential`
 * row and referenced by `envRef`. Nothing returns it, and `McpServerDetail` reports only whether
 * one is attached.
 *
 * `headers` is **not** write-only — the manager needs the plaintext values at handshake time and
 * the column is a plain JSON one. That asymmetry is real and is stated rather than hidden:
 * a header set here is stored in the clear, so a server that authenticates with a bearer token
 * should use `env` (stdio) or a vault-backed credential instead. `McpServerDetail.headerNames`
 * is what stops the values being echoed back to a browser.
 */
export const createMcpServerSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    transport: z.enum(MCP_TRANSPORTS),
    command: z.string().trim().min(1).max(2048).nullable().optional(),
    args: z.array(z.string().max(2048)).max(128).optional(),
    url: httpUrl.nullable().optional(),
    headers: z.record(z.string().max(4096)).optional(),
    env: envBlock.optional(),
    /** Connect immediately after creating the row. The service defaults this to true. */
    connect: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.transport === 'stdio') {
      if (value.command === undefined || value.command === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['command'],
          message: 'a stdio server needs a command to launch',
        });
      }
      if (value.url !== undefined && value.url !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: 'a stdio server is launched, not dialled — remove url or use transport "streamable-http"',
        });
      }
      return;
    }

    if (value.url === undefined || value.url === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'a streamable-http server needs a url',
      });
    }
    if (value.command !== undefined && value.command !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command'],
        message: 'a streamable-http server is dialled, not launched — remove command or use transport "stdio"',
      });
    }
  });

/**
 * Editing an MCP server.
 *
 * **`transport` is absent on purpose.** Changing it is not an edit, it is a different server
 * wearing the same row — the configuration that made the old one work is meaningless to the new
 * one, and a PATCH that switched transports would have to guess which fields to clear. Deleting
 * and re-adding is the honest operation, and the delete already unregisters the canonical tools.
 *
 * `toolsEnabled` is what the spec calls enable/disable. It maps to `Tool.status` on every
 * canonical tool the server contributed — a real column with a real effect, rather than a flag
 * on `McpServer` that the schema does not have and nothing would read.
 */
export const updateMcpServerSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    command: z.string().trim().min(1).max(2048).nullable().optional(),
    args: z.array(z.string().max(2048)).max(128).optional(),
    url: z.string().trim().min(1).max(2048).nullable().optional(),
    headers: z.record(z.string().max(4096)).optional(),
    /** Rotating the env block: a new encrypted credential, with the old row left in place. */
    env: envBlock.optional(),
    /** Flips every canonical tool this server contributed. Applied immediately. */
    toolsEnabled: z.boolean().optional(),
  })
  .strict();

export const listMcpServersSchema = z
  .object({
    status: z.enum(['disconnected', 'connecting', 'connected', 'error', 'crashed']).optional(),
  })
  .strict();

export type ListToolsQuery = z.infer<typeof listToolsSchema>;
export type InvokeToolInput = z.infer<typeof invokeToolSchema>;
export type CreateMcpServerInput = z.infer<typeof createMcpServerSchema>;
export type UpdateMcpServerInput = z.infer<typeof updateMcpServerSchema>;
export type ListMcpServersQuery = z.infer<typeof listMcpServersSchema>;
