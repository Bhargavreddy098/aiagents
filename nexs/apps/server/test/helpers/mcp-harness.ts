import pino from 'pino';
import { ApiError, type McpCallResult, type McpToolDescriptor } from '@nexs/shared';
import type { Logger } from '../../src/logger.js';
import type {
  McpServerCapabilities,
  McpServerSpec,
  McpSession,
  McpSessionFactory,
} from '../../src/services/mcp/session.js';

/**
 * Test doubles for the MCP layer.
 *
 * The acceptance test for Phase 4 is *"crash an MCP server mid-run → step marked failed, no
 * zombie process, no double-fired side effect on resume"*. Proving that against a real
 * child process would make the suite slow, flaky, and — on Windows, where there is no
 * `SIGKILL` semantics to speak of — unreliable. Injecting the session factory instead means
 * the crash is deterministic and instant, and the assertions are about the manager's
 * behaviour rather than about the operating system's.
 *
 * What these doubles deliberately do *not* do is simulate the protocol. `session.ts` owns
 * the SDK boundary, and its normalisation helpers are tested directly.
 */

export interface FakeSessionOptions {
  pid?: number | null;
  tools?: McpToolDescriptor[];
  capabilities?: Partial<McpServerCapabilities>;
  /** Produces each `tools/call` response. `callIndex` is 1-based. */
  respond?: (
    name: string,
    args: Record<string, unknown>,
    callIndex: number,
  ) => McpCallResult | Promise<McpCallResult>;
  resources?: unknown;
  prompts?: unknown;
}

export class FakeMcpSession implements McpSession {
  readonly pid: number | null;
  readonly serverInfo = { name: 'fake-mcp', version: '1.2.3' };
  readonly capabilities: McpServerCapabilities;

  /** Every `tools/call` that reached the wire, in order. */
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  /** Every method invocation, including discovery. Used to prove nothing extra happened. */
  readonly invocations: string[] = [];
  closed = false;
  closeCount = 0;

  /**
   * Kill this session *during* its next `tools/call`, after the request has been written.
   *
   * The scenario the whole crash-recovery policy exists for: the effect may already have
   * been applied, and nothing in the response tells us whether it was.
   */
  crashOnNextCall: Error | null = null;

  private readonly serverId: string;
  private tools: McpToolDescriptor[];
  private readonly resources: unknown;
  private readonly prompts: unknown;
  private readonly respond: NonNullable<FakeSessionOptions['respond']>;

  private crashError: Error | null = null;
  private handlers: Array<(error: Error) => void> = [];

  constructor(serverId: string, options: FakeSessionOptions = {}) {
    this.serverId = serverId;
    this.pid = options.pid === undefined ? 4242 : options.pid;
    this.tools = options.tools ?? [];
    this.resources = options.resources ?? { resources: [] };
    this.prompts = options.prompts ?? { prompts: [] };
    this.respond = options.respond ?? (() => ({ content: 'ok', isError: false }));
    this.capabilities = {
      tools: options.capabilities?.tools ?? true,
      resources: options.capabilities?.resources ?? false,
      prompts: options.capabilities?.prompts ?? false,
      logging: options.capabilities?.logging ?? false,
    };
  }

  onCrash(handler: (error: Error) => void): void {
    this.handlers.push(handler);
  }

  /** Swap the advertised tool list, for testing a server that changes its mind. */
  setTools(tools: McpToolDescriptor[]): void {
    this.tools = tools;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    this.invocations.push('listTools');
    this.throwIfCrashed();
    return this.tools;
  }

  async listResources(): Promise<unknown> {
    this.invocations.push('listResources');
    this.throwIfCrashed();
    return this.resources;
  }

  async listPrompts(): Promise<unknown> {
    this.invocations.push('listPrompts');
    this.throwIfCrashed();
    return this.prompts;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    this.invocations.push(`callTool:${name}`);
    this.calls.push({ name, args });
    this.throwIfCrashed();

    if (this.crashOnNextCall !== null) {
      const error = this.crashOnNextCall;
      this.crashOnNextCall = null;
      // The request is already in `calls`; the server dies before answering it.
      this.crash(error);
      throw this.crashedError();
    }

    try {
      return await this.respond(name, args, this.calls.length);
    } catch (cause) {
      // A responder that killed the session mid-call must surface the same error shape the
      // real session does — the manager detects a crash by inspecting the error, so a
      // double that throws a bare `Error` would silently exercise the wrong code path.
      if (this.crashError !== null) throw this.crashedError();
      throw cause;
    }
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.closed = true;
    // Mirrors `SdkMcpSession`: a close we initiated must not be reported as a crash.
    this.handlers = [];
  }

  /**
   * Kill the server, the way a real one dies: the transport's close handler fires, and any
   * in-flight or subsequent request fails.
   */
  crash(error: Error = new Error('MCP server process exited with code 1')): void {
    this.crashError = error;
    for (const handler of [...this.handlers]) handler(error);
  }

  /** A crash that does *not* notify the manager — simulates a transport that dies silently. */
  crashSilently(error: Error = new Error('silent death')): void {
    this.crashError = error;
  }

  get dead(): boolean {
    return this.crashError !== null;
  }

  private throwIfCrashed(): void {
    if (this.crashError !== null) throw this.crashedError();
  }

  /** The exact error `SdkMcpSession.request` raises when the transport is gone. */
  private crashedError(): ApiError {
    return new ApiError(
      'PROVIDER_ERROR',
      `MCP call failed: ${this.crashError?.message ?? 'connection lost'}`,
      { serverId: this.serverId, crashed: true },
    );
  }
}

export interface FakeSessionFactoryOptions {
  /** Applied to every session this factory opens. Mutable so a test can change a server's story. */
  session?: FakeSessionOptions;
  /** Applied per-spec, overriding `session`. */
  forServer?: (spec: McpServerSpec) => FakeSessionOptions;
  /** When set, the next `open` rejects with this and the flag clears. */
  failNextOpenWith?: Error | null;
  /** When set, every `open` rejects with this. */
  failAllOpensWith?: Error;
  /**
   * When set, `open` waits on this promise before resolving. Used to observe the
   * concurrency queue, where the interesting moment is *between* the permit being taken and
   * the session existing.
   */
  gate?: Promise<void> | null;
}

export class FakeMcpSessionFactory implements McpSessionFactory {
  readonly sessions: FakeMcpSession[] = [];
  readonly specs: McpServerSpec[] = [];
  openCount = 0;
  /** Mutable: reassign to change what every subsequent session advertises. */
  options: FakeSessionFactoryOptions;

  private failNext: Error | null;

  constructor(options: FakeSessionFactoryOptions = {}) {
    this.options = options;
    this.failNext = options.failNextOpenWith ?? null;
  }

  setGate(gate: Promise<void> | null): void {
    this.options.gate = gate;
  }

  async open(spec: McpServerSpec): Promise<McpSession> {
    this.openCount += 1;
    this.specs.push(spec);

    if (this.options.failAllOpensWith !== undefined) throw this.options.failAllOpensWith;
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }

    if (this.options.gate !== undefined && this.options.gate !== null) await this.options.gate;

    const perServer = this.options.forServer?.(spec) ?? {};
    const session = new FakeMcpSession(spec.serverId, {
      // A stdio server owns a child process; an HTTP one owns a socket. The pid has to
      // reflect that, or a test could "prove" the manager tracks a pid it never had.
      pid: spec.transport === 'stdio' ? 4242 : null,
      ...this.options.session,
      ...perServer,
    });
    this.sessions.push(session);
    return session;
  }

  /** The session the manager most recently obtained. */
  get latest(): FakeMcpSession {
    const session = this.sessions.at(-1);
    if (session === undefined) throw new Error('no session was opened');
    return session;
  }
}

/** A promise plus its resolver, for tests that need to hold a step open. */
export { deferred, flush } from './async.js';

/**
 * A logger that records structured records instead of writing them.
 *
 * Needed because two of the manager's decisions are *log-only* — refusing to kill an
 * unattributable pid, and refusing to let a server widen its own tool capabilities — and a
 * behaviour that is only observable in a log still has to be tested.
 */
export function createRecordingLogger(): {
  logger: Logger;
  records: Array<Record<string, unknown>>;
  messagesAt: (level: number) => string[];
} {
  const records: Array<Record<string, unknown>> = [];

  const logger = pino(
    { level: 'trace', base: undefined, timestamp: false },
    {
      write(line: string) {
        try {
          records.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          records.push({ msg: line });
        }
      },
    },
  ) as unknown as Logger;

  return {
    logger,
    records,
    messagesAt: (level: number) =>
      records
        .filter((record) => record['level'] === level)
        .map((record) => String(record['msg'] ?? '')),
  };
}

/** pino's numeric levels, so assertions do not have to hard-code magic numbers. */
export const PINO_WARN = 40;
