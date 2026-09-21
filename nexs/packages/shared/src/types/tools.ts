/**
 * Provider-neutral contracts for tools, MCP servers, storage and sandboxes.
 *
 * These shapes are what the engine sees. Nothing here mentions a transport, a child
 * process, a browser or a worker thread — those are implementation details of the
 * managers behind these interfaces, and the engine must not be able to tell which one
 * ran a given tool.
 */

// ── tool capabilities ─────────────────────────────────────────────────────────

/**
 * [gap #14] The capability vocabulary. Fixed on purpose: the engine's replay and
 * approval policy is written against these exact strings, so adding one is a contract
 * change rather than a local edit.
 */
export const TOOL_CAPABILITIES = [
  /** No observable effect outside this process. Safe to retry and to replay. */
  'read_only',
  /** Changes something outside the system — a POST, an email, a payment. */
  'external_side_effect',
  /** Writes to the filesystem or the storage service. */
  'writes_files',
  'search',
  'http',
  'browser',
  'sandbox_exec',
  'memory',
  'notify',
  'transform',
  'calculation',
] as const;

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

/**
 * The capabilities that make replay dangerous.
 *
 * This is the single definition the engine's "may I re-run this step" decision reads.
 * Getting it wrong is how a crash-resume sends the same email twice, so it is deliberately
 * a positive list: a tool must *declare* an effect to be treated as having one, and the
 * default for an unknown capability is handled by `hasSideEffects` below.
 */
const EFFECTFUL_CAPABILITIES: readonly string[] = [
  'external_side_effect',
  'writes_files',
  'notify',
];

/**
 * True when re-running this tool could repeat an observable effect.
 *
 * Unknown capabilities are treated as *not* effectful, because the vocabulary is closed
 * and a tool that declares something we do not recognise is more likely to be
 * mislabelled than to be secretly dangerous. The complementary guard — refusing to
 * auto-retry a tool that declares nothing at all — belongs to the engine's policy, not
 * here.
 */
export function hasSideEffects(capabilities: readonly string[]): boolean {
  return capabilities.some((capability) => EFFECTFUL_CAPABILITIES.includes(capability));
}

/** True only when the tool is explicitly declared free of observable effects. */
export function isReadOnly(capabilities: readonly string[]): boolean {
  return capabilities.includes('read_only') && !hasSideEffects(capabilities);
}

/**
 * [gap #22] Whether a crashed provider may be reconnected automatically.
 *
 * Only for read-only tools: reconnecting is harmless when the tool cannot have changed
 * anything, and for a side-effecting tool a silent reconnect is how a partially-applied
 * effect gets applied twice.
 */
export function mayAutoReconnect(capabilities: readonly string[]): boolean {
  return isReadOnly(capabilities);
}

// ── tool results ──────────────────────────────────────────────────────────────

/**
 * What a tool call produced.
 *
 * `ref` is an opaque key into the storage service, set when the result was too large to
 * keep inline. The engine may pass either `content` or `ref` to the model; it never
 * needs to know where the bytes live.
 */
export interface ToolResult {
  /** Inline payload. A summary when `truncated` is true. */
  content: string;
  /** Set when the full payload was moved to the storage service. */
  ref?: string;
  truncated: boolean;
  /** Size of the original payload, before any capping. */
  originalBytes: number;
  /** True when the tool itself reported failure rather than the call failing. */
  isError?: boolean;
}

export interface ToolResultCapOptions {
  maxBytes: number;
}

// ── MCP ───────────────────────────────────────────────────────────────────────

export type McpTransport = 'stdio' | 'streamable-http';

export type McpServerStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'crashed';

/**
 * MCP tool annotations, as defined by the protocol.
 *
 * A third-party tool's capabilities cannot be inferred from its name, so these hints are
 * the only evidence available. The manager's policy is to require a positive
 * `readOnlyHint` before treating a tool as safe to auto-retry — the default for anything
 * unannotated is "assume it has an effect".
 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** What a `tools/list` response gives us, before it becomes a `Tool` row. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: McpToolAnnotations;
}

/** The result of a `tools/call`, normalised across transports. */
export interface McpCallResult {
  content: string;
  isError: boolean;
  /** True when the transport died rather than the tool returning an error. */
  crashed?: boolean;
}

// ── browser ───────────────────────────────────────────────────────────────────

export interface BrowserNavigationResult {
  url: string;
  title: string;
  statusCode: number | null;
}

export interface BrowserScreenshot {
  /** Opaque storage key, not a path. */
  ref: string;
  bytes: number;
  mimeType: string;
  /**
   * True when a requested full-page capture exceeded the size cap and was replaced by a
   * viewport capture.
   *
   * Reported rather than silently applied: a viewer looking at a partial screenshot should
   * know it is partial, and a caller that needed the whole page needs to know to ask for it
   * differently rather than to trust what it got.
   */
  downscaled?: boolean;
}

// ── sandbox ───────────────────────────────────────────────────────────────────

export type SandboxExecutionStatus = 'running' | 'completed' | 'failed' | 'timeout';

export interface SandboxRunRequest {
  /** JavaScript source. The body of a function, not a whole program. */
  code: string;
  /** Passed to the code as `input`. Must be structured-cloneable. */
  input?: unknown;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SandboxRunResult {
  /** Whatever the code returned. `undefined` when it failed or timed out. */
  value?: unknown;
  stdout: string;
  stderr: string;
  exitCode: number;
  status: SandboxExecutionStatus;
  /** Wall-clock duration, measured by the manager. */
  durationMs: number;
  /** Set when the worker was killed for exceeding its resource limits or the timeout. */
  terminatedReason?: string;
  /** Set when stdout or stderr hit `maxOutputBytes`. */
  outputTruncated?: boolean;
}
