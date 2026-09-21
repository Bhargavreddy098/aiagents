import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ApiError,
  type McpCallResult,
  type McpToolAnnotations,
  type McpToolDescriptor,
  type McpTransport,
} from '@nexs/shared';

/**
 * The seam between `MCPManager` and the official SDK.
 *
 * Two rules from the vision doc shape this file:
 *
 *  1. "`MCPManager` is the only module that talks to MCP servers." The SDK import lives
 *     here and nowhere else; the manager depends on `McpSessionFactory`, an interface it
 *     can be handed a fake for.
 *  2. A manager test must not spawn a child process or open a socket. Making the factory
 *     injectable is what turns "crash an MCP server mid-run" from an integration test that
 *     leaks processes into a unit test that does not.
 *
 * Everything above this line is transport-neutral. `McpSession` deliberately exposes no
 * JSON-RPC, no `Transport`, and no SDK type, so the manager cannot accidentally start
 * depending on protocol details.
 */

export interface McpServerInfo {
  name: string;
  version: string;
}

/** The capability exchange half of the `initialize` handshake, flattened to booleans. */
export interface McpServerCapabilities {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
  logging: boolean;
}

export interface McpServerSpec {
  serverId: string;
  transport: McpTransport;
  /** stdio only. */
  command?: string | undefined;
  args: readonly string[];
  /** streamable-http only. */
  url?: string | undefined;
  headers: Readonly<Record<string, string>>;
  /**
   * stdio only. Already decrypted from the vault by the caller — this module never sees a
   * credential id and never reads the vault, which is what keeps the plaintext in one
   * place. It is never logged: see `redactSpec`.
   */
  env: Readonly<Record<string, string>>;
  connectTimeoutMs: number;
  callTimeoutMs: number;
}

export interface McpSession {
  /** The child process id for stdio; `null` for HTTP, which owns no process. */
  readonly pid: number | null;
  readonly serverInfo: McpServerInfo | null;
  readonly capabilities: McpServerCapabilities;
  listTools(): Promise<McpToolDescriptor[]>;
  listResources(): Promise<unknown>;
  listPrompts(): Promise<unknown>;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<McpCallResult>;
  /**
   * Invoked only when the session dies on its own — a crashed child, a dropped socket, a
   * protocol error. A `close()` we initiated never fires it, because "we stopped it" and
   * "it stopped" lead to different recovery decisions.
   */
  onCrash(handler: (error: Error) => void): void;
  close(): Promise<void>;
}

export interface McpSessionFactory {
  open(spec: McpServerSpec): Promise<McpSession>;
}

// ── result normalisation ──────────────────────────────────────────────────────

/**
 * Turn a `tools/call` result into the single string a `ToolResult` can carry.
 *
 * Takes `unknown` rather than a typed shape because this is third-party data crossing a
 * protocol boundary, and because the SDK's own return type is a union that still includes
 * the 2024-10-07 compatibility shape (`{ toolResult }` instead of `{ content }`).
 *
 * Text is inlined because that is the whole point. Binary blocks are *described* rather
 * than inlined: base64 in a prompt is both enormous and useless to a text model, and the
 * honest thing is to say what arrived and how big it was. Inlining it would also push a
 * multi-megabyte string through the tool-result cap, where the head/tail summary of
 * base64 is meaningless.
 *
 * Exported for direct testing — the block shapes are the fiddliest part of the protocol
 * and deserve tests that do not need a server.
 */
export function normaliseMcpContent(value: unknown): { content: string; isError: boolean } {
  // A bare string is already the text we would want to hand the model; running it through
  // `JSON.stringify` would wrap it in quotes and make it look like a JSON literal.
  if (typeof value === 'string') return { content: value, isError: false };

  if (value === null || typeof value !== 'object') {
    return { content: safeStringify(value), isError: false };
  }

  const result = value as Record<string, unknown>;

  // Protocol 2024-10-07 compatibility: the payload sits under `toolResult`.
  if (!('content' in result) && 'toolResult' in result) {
    return { content: safeStringify(result['toolResult']), isError: false };
  }

  const blocks = Array.isArray(result['content']) ? result['content'] : [];
  const parts: string[] = [];

  for (const raw of blocks) {
    if (raw === null || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;

    switch (block['type']) {
      case 'text':
        if (typeof block['text'] === 'string') parts.push(block['text']);
        break;

      case 'image':
      case 'audio': {
        const mime = typeof block['mimeType'] === 'string' ? block['mimeType'] : 'unknown';
        const size = typeof block['data'] === 'string' ? block['data'].length : 0;
        parts.push(
          `[${String(block['type'])} ${mime} — ${size} base64 chars, not inlined into the prompt]`,
        );
        break;
      }

      case 'resource': {
        const resource = block['resource'];
        if (resource !== null && typeof resource === 'object') {
          const inner = resource as Record<string, unknown>;
          if (typeof inner['text'] === 'string') {
            parts.push(inner['text']);
            break;
          }
          const uri = typeof inner['uri'] === 'string' ? inner['uri'] : 'unknown';
          const mime = typeof inner['mimeType'] === 'string' ? inner['mimeType'] : 'unknown';
          const size = typeof inner['blob'] === 'string' ? inner['blob'].length : 0;
          parts.push(`[resource ${uri} ${mime} — ${size} base64 chars, not inlined]`);
          break;
        }
        parts.push(safeStringify(block));
        break;
      }

      case 'resource_link': {
        const uri = typeof block['uri'] === 'string' ? block['uri'] : 'unknown';
        const name = typeof block['name'] === 'string' ? block['name'] : '';
        parts.push(`[resource_link ${name} ${uri}]`);
        break;
      }

      default:
        parts.push(safeStringify(block));
    }
  }

  // Servers that return `structuredContent` typically send no text block at all. Falling
  // back to the JSON is the difference between the model seeing the answer and seeing "".
  if (parts.length === 0 && result['structuredContent'] !== undefined) {
    parts.push(safeStringify(result['structuredContent']));
  }

  return { content: parts.join('\n'), isError: result['isError'] === true };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Map the protocol's annotation hints onto our capability vocabulary. */
export function capabilitiesFromAnnotations(
  annotations: McpToolAnnotations | undefined,
): string[] {
  // Only a *positive* read-only hint, with no contradicting destructive hint, earns
  // `read_only`. Anything else — including a tool that declares nothing — is assumed to
  // have an effect. This is the conservative direction on purpose: mislabelling a
  // side-effecting tool as read-only is how a crash-resume sends the same email twice.
  const readOnly = annotations?.readOnlyHint === true && annotations.destructiveHint !== true;
  return readOnly ? ['read_only'] : ['external_side_effect'];
}

// ── the real, SDK-backed implementation ───────────────────────────────────────

/**
 * A `Promise.race` that also tells the loser to clean up.
 *
 * A plain race would leave a spawned child process running after a handshake timeout —
 * exactly the zombie leak [gap #22] exists to prevent — so the timeout path is required to
 * tear the transport down before it rejects.
 */
async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => void,
  error: () => ApiError,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(error());
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class SdkMcpSession implements McpSession {
  readonly pid: number | null;
  readonly serverInfo: McpServerInfo | null;
  readonly capabilities: McpServerCapabilities;

  private readonly client: Client;
  private readonly spec: McpServerSpec;
  private readonly crashHandlers: Array<(error: Error) => void> = [];
  /** Set before a deliberate close so `onclose` is not reported as a crash. */
  private closing = false;
  private closed = false;

  constructor(
    client: Client,
    spec: McpServerSpec,
    pid: number | null,
    serverInfo: McpServerInfo | null,
    capabilities: McpServerCapabilities,
  ) {
    this.client = client;
    this.spec = spec;
    this.pid = pid;
    this.serverInfo = serverInfo;
    this.capabilities = capabilities;

    // Assigned on the `Client`, not the transport: `Protocol.connect` chains the
    // transport's own handler and would overwrite anything we put there.
    this.client.onclose = () => {
      if (this.closing) return;
      this.fireCrash(new Error(`MCP server "${spec.serverId}" closed its connection`));
    };
    this.client.onerror = (error: Error) => {
      if (this.closing) return;
      this.fireCrash(error);
    };
  }

  onCrash(handler: (error: Error) => void): void {
    this.crashHandlers.push(handler);
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = await this.request(() =>
      this.client.listTools(undefined, { timeout: this.spec.callTimeoutMs }),
    );

    const tools = Array.isArray(result.tools) ? result.tools : [];
    return tools.map((tool) => {
      const annotations = tool.annotations;
      const descriptor: McpToolDescriptor = {
        name: tool.name,
        inputSchema: tool.inputSchema ?? {},
      };
      if (typeof tool.description === 'string') descriptor.description = tool.description;
      if (annotations !== undefined) {
        // Copied field by field rather than spread: the SDK's shape is a superset (it also
        // carries `title`), and letting extra keys through would silently widen our type.
        const copy: McpToolAnnotations = {};
        if (annotations.readOnlyHint !== undefined) copy.readOnlyHint = annotations.readOnlyHint;
        if (annotations.destructiveHint !== undefined) {
          copy.destructiveHint = annotations.destructiveHint;
        }
        if (annotations.idempotentHint !== undefined) copy.idempotentHint = annotations.idempotentHint;
        if (annotations.openWorldHint !== undefined) copy.openWorldHint = annotations.openWorldHint;
        descriptor.annotations = copy;
      }
      return descriptor;
    });
  }

  listResources(): Promise<unknown> {
    return this.request(() =>
      this.client.listResources(undefined, { timeout: this.spec.callTimeoutMs }),
    );
  }

  listPrompts(): Promise<unknown> {
    return this.request(() =>
      this.client.listPrompts(undefined, { timeout: this.spec.callTimeoutMs }),
    );
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request(() =>
      this.client.callTool({ name, arguments: arguments_ }, undefined, {
        timeout: this.spec.callTimeoutMs,
      }),
    );

    const normalised = normaliseMcpContent(result);
    return { content: normalised.content, isError: normalised.isError };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    this.crashHandlers.length = 0;

    // The SDK escalates stdin.end → SIGTERM → SIGKILL internally, with its own bounded
    // waits, so a wedged child cannot hold the shutdown open indefinitely.
    await this.client.close().catch(() => undefined);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Wrap a request so that a transport death is reported as `crashed` rather than as a
   * bare protocol error.
   *
   * The distinction is the whole reason the flag exists: a call that failed *before* the
   * request left the process definitely did not happen, while a call whose transport died
   * after sending may or may not have been applied. The engine treats the second as an
   * unknown outcome and refuses to replay it unless the tool is read-only.
   */
  private async request<T>(send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (cause) {
      if (this.closing) {
        throw new ApiError('PROVIDER_ERROR', 'MCP session is closing', {
          serverId: this.spec.serverId,
        });
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      // An error surfaced by the client's `onerror` handler means the transport is gone.
      // A tool that answered with `isError` never reaches this path — that is a normal
      // result, not a failure.
      throw new ApiError('PROVIDER_ERROR', `MCP call failed: ${message}`, {
        serverId: this.spec.serverId,
        crashed: true,
      });
    }
  }

  private fireCrash(error: Error): void {
    for (const handler of [...this.crashHandlers]) {
      try {
        handler(error);
      } catch {
        // A throwing crash handler must not stop the remaining handlers, and must never
        // escape into the transport's event emitter — an unhandled throw there takes the
        // process down.
      }
    }
  }
}

export class SdkMcpSessionFactory implements McpSessionFactory {
  private readonly clientName: string;
  private readonly clientVersion: string;

  constructor(options: { clientName?: string; clientVersion?: string } = {}) {
    this.clientName = options.clientName ?? 'nexs-control-plane';
    this.clientVersion = options.clientVersion ?? '0.1.0';
  }

  async open(spec: McpServerSpec): Promise<McpSession> {
    const transport = this.buildTransport(spec);
    const client = new Client(
      { name: this.clientName, version: this.clientVersion },
      { capabilities: {} },
    );

    try {
      await withTimeout(
        client.connect(transport),
        spec.connectTimeoutMs,
        // Order matters: read the pid *before* closing, because the SDK nulls its process
        // handle as the first step of `close()`.
        () => {
          const pid = readPid(transport);
          void transport.close().catch(() => undefined);
          void pid;
        },
        () =>
          new ApiError('PROVIDER_ERROR', 'MCP server did not complete the initialize handshake', {
            serverId: spec.serverId,
            timeoutMs: spec.connectTimeoutMs,
          }),
      );
    } catch (cause) {
      // Covers both the handshake timeout above and a spawn failure (`ENOENT` for a bad
      // command). Either way the child, if one was created, is now gone.
      await transport.close().catch(() => undefined);
      throw cause;
    }

    const capabilities = readCapabilities(client);
    const version = client.getServerVersion();
    const serverInfo: McpServerInfo | null =
      version === undefined
        ? null
        : { name: String(version.name), version: String(version.version) };

    return new SdkMcpSession(client, spec, readPid(transport), serverInfo, capabilities);
  }

  private buildTransport(spec: McpServerSpec) {
    if (spec.transport === 'stdio') {
      if (spec.command === undefined || spec.command.length === 0) {
        throw new ApiError('VALIDATION_ERROR', 'A stdio MCP server needs a command');
      }
      return new StdioClientTransport({
        command: spec.command,
        args: [...spec.args],
        env: { ...spec.env },
        // `pipe` rather than `inherit`: a server that chatters on stderr would otherwise
        // interleave with our own logs, and the protocol reserves stderr for diagnostics
        // precisely so a client can choose to capture it.
        stderr: 'pipe',
      });
    }

    if (spec.url === undefined || spec.url.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'A streamable-http MCP server needs a url');
    }

    let url: URL;
    try {
      url = new URL(spec.url);
    } catch {
      throw new ApiError('VALIDATION_ERROR', 'MCP server url is not a valid URL', {
        serverId: spec.serverId,
      });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ApiError('VALIDATION_ERROR', 'MCP server url must use http or https');
    }

    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { ...spec.headers } },
    });
  }
}

function readPid(transport: unknown): number | null {
  if (transport instanceof StdioClientTransport) {
    return transport.pid ?? null;
  }
  return null;
}

function readCapabilities(client: Client): McpServerCapabilities {
  const declared = client.getServerCapabilities() as Record<string, unknown> | undefined;
  return {
    tools: declared?.['tools'] !== undefined,
    resources: declared?.['resources'] !== undefined,
    prompts: declared?.['prompts'] !== undefined,
    logging: declared?.['logging'] !== undefined,
  };
}
