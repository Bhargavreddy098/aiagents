/**
 * The built-in tools (§3.6), as the engine sees them.
 *
 * Three decisions in this file are load-bearing and are worth stating before the code.
 *
 * **`http_request` does not throw on a non-2xx status.** A 404 is a *result*, not a
 * failure. The engine's acceptance test is literally "GET example.com and verify status
 * 200" — if the tool threw on a non-2xx the verifier would never see the status it is
 * supposed to judge, and the only way to express "this endpoint is returning 500" would
 * be to crash the step. Failures that *are* errors — DNS, TLS, a refused connection, a
 * timeout — still throw, because those mean the call did not happen.
 *
 * **`calculator` parses; it does not `eval`.** The expression comes from a language model
 * reading untrusted text, and `eval` here would be arbitrary code execution inside the
 * server process. A sandbox exists for code that genuinely needs to run; arithmetic needs
 * a parser. The grammar is small, so the parser is too.
 *
 * **A tool is only registered when its dependencies exist.** `notify` needs a
 * notification sink (Phase 7), `web_search` needs a search provider (spec §3.6; never
 * implemented — it is the one tool-table entry with no home), and the memory tools need
 * the memory service (Phase 10). Registering them early so the list
 * "looks complete" would put tools in front of the model that can only fail, and a model
 * that is offered a tool will use it. They appear in `list()` when, and only when, they
 * can actually work.
 */
import { ApiError, MEMORY_SCOPES, parseMemoryScope, type MemoryScope } from '@nexs/shared';
import type { FetchLike } from '../gateway/adapters/types.js';
import type { FileService } from '../files/file.service.js';
import type { MemoryService } from '../memory/memory.service.js';
import type { SearchPort } from '../search/search-provider.js';
import type { Logger } from '../../logger.js';
import { byteLength, sliceUtf8 } from './tool-result.js';

// ── seams ─────────────────────────────────────────────────────────────────────

/**
 * Where a `notify` call lands. Owned by Phase 7; the engine only needs the shape.
 *
 * `userId` is not on the `Run`, so the sink is responsible for resolving the recipient —
 * an agent acting on a goal notifies the goal's owner, not "the tenant".
 */
export interface NotificationSink {
  create(input: {
    tenantId: string;
    userId: string;
    kind: string;
    title: string;
    body?: string;
    linkRoute?: string;
  }): Promise<{ id: string }>;
}

/**
 * The memory store the `memory_*` tools write to and read from.
 *
 * A `Pick` of two methods rather than the whole service, for the same reason the engine takes
 * `PlannerGateway` as a `Pick`: it states exactly how much of memory the tool layer is allowed to
 * know, and it lets a test drive both tools with a small object instead of a repository, a model
 * catalog and a gateway. Crucially it is the *same* service the `/api/memory` routes call, so a
 * memory stored by an agent and one stored from the Memory page cannot diverge.
 */
export type MemoryPort = Pick<MemoryService, 'create' | 'search'>;

/**
 * The memory tools, by name.
 *
 * Exported so `AgentService` can grant them without repeating the two literals: an agent with
 * `memoryEnabled` gets exactly these, and a name that drifted in one place but not the other would
 * grant an agent a tool that is not registered — a plan step that fails at execution rather than
 * at configuration.
 */
export const MEMORY_TOOL_NAMES = ['memory_store', 'memory_search'] as const;

/**
 * The search tool, by name (spec §3.6).
 *
 * Exported for the same reason `MEMORY_TOOL_NAMES` is: the Research protocol grants it to the
 * agent it runs as, and a literal repeated at two call sites is a name that can drift into a plan
 * step referencing a tool that is not registered.
 */
export const SEARCH_TOOL_NAME = 'web_search';

export interface NativeToolContext {
  tenantId: string;
  runId: string | null;
  stepId: string | null;
  /**
   * The agent this step belongs to, when it has one.
   *
   * `memory_store` needs it: a memory written by an agent that did not record *which* agent would
   * be workspace-wide, and every agent in the tenant would recall another agent's working notes.
   * An ad-hoc run has no agent, and then `null` is the honest answer — the memory is the
   * workspace's.
   */
  agentId: string | null;
  /** The engine's per-step timeout. Long calls must observe it. */
  signal?: AbortSignal;
}

export interface NativeToolDeps {
  files: FileService;
  fetch: FetchLike;
  logger: Logger;
  now: () => number;
  /** Bound on a single response body, so a hostile URL cannot exhaust memory. */
  httpMaxBytes: number;
  notifications?: NotificationSink;
  /** When absent, `memory_store` / `memory_search` are not registered at all. */
  memory?: MemoryPort;
  /** When absent, `web_search` is not registered at all — there is no provider to search with. */
  search?: SearchPort;
}

export interface NativeToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Handler {
  descriptor: NativeToolDescriptor;
  /** Capabilities for *these* arguments — `http_request`'s depend on the method. */
  capabilities(args: Record<string, unknown>): string[];
  run(args: Record<string, unknown>, ctx: NativeToolContext): Promise<unknown>;
}

// ── argument helpers ──────────────────────────────────────────────────────────

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError('VALIDATION_ERROR', `"${key}" must be a non-empty string`, { key });
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ApiError('VALIDATION_ERROR', `"${key}" must be a string`, { key });
  }
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError('VALIDATION_ERROR', `"${key}" must be a finite number`, { key });
  }
  return value;
}

function stringRecord(value: unknown, key: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('VALIDATION_ERROR', `"${key}" must be an object`, { key });
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new ApiError('VALIDATION_ERROR', `"${key}.${k}" must be a string`, { key: `${key}.${k}` });
    }
    out[k] = v;
  }
  return out;
}

/**
 * An arbitrary JSON object, rejected when it is anything else.
 *
 * Distinct from `stringRecord` because a memory's `metadata` is genuinely open — it carries
 * whatever the writer wants alongside the memory — while a request header is a string map. An
 * array is refused rather than accepted as an object: `typeof [] === 'object'`, and letting one
 * through would store `metadata: []` where every reader expects named keys.
 */
function objectRecord(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError('VALIDATION_ERROR', `"${key}" must be an object`, { key });
  }
  return value as Record<string, unknown>;
}

// ── calculator: a real parser ─────────────────────────────────────────────────

/**
 * Tokenise, then parse, then evaluate.
 *
 * The alternative — `Function('return ' + expr)()` — is a one-liner, and it is also a
 * remote code execution primitive: `process.exit(0)` is a valid "arithmetic expression"
 * to it. Nothing here is clever; it is a recursive-descent parser for a grammar that has
 * about a dozen productions, which is the smallest thing that is actually safe.
 */

type Token = { kind: 'number'; value: number } | { kind: 'name'; value: string } | { kind: 'op'; value: string };

const OPERATORS = new Set(['+', '-', '*', '/', '%', '^', '(', ')', ',']);

function tokenise(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index]!;

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }

    if (OPERATORS.has(char)) {
      tokens.push({ kind: 'op', value: char });
      index += 1;
      continue;
    }

    if (char >= '0' && char <= '9') {
      let end = index;
      while (end < input.length && /[0-9]/.test(input[end]!)) end += 1;
      if (input[end] === '.') {
        end += 1;
        while (end < input.length && /[0-9]/.test(input[end]!)) end += 1;
      }
      // Exponent, but only when it is actually followed by digits — otherwise `2e` would
      // swallow the `e` and then fail on a number that the user meant as `2 * e`.
      if (input[end] === 'e' || input[end] === 'E') {
        let probe = end + 1;
        if (input[probe] === '+' || input[probe] === '-') probe += 1;
        if (probe < input.length && /[0-9]/.test(input[probe]!)) {
          end = probe;
          while (end < input.length && /[0-9]/.test(input[end]!)) end += 1;
        }
      }
      const text = input.slice(index, end);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new ApiError('VALIDATION_ERROR', `"${text}" is not a finite number`);
      }
      tokens.push({ kind: 'number', value });
      index = end;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < input.length && /[A-Za-z0-9_]/.test(input[end]!)) end += 1;
      tokens.push({ kind: 'name', value: input.slice(index, end) });
      index = end;
      continue;
    }

    throw new ApiError('VALIDATION_ERROR', `Unexpected character "${char}" in expression`, { index });
  }

  return tokens;
}

const FUNCTIONS: Record<string, { arity: number | [number, number]; apply: (args: number[]) => number }> = {
  abs: { arity: 1, apply: ([a]) => Math.abs(a!) },
  ceil: { arity: 1, apply: ([a]) => Math.ceil(a!) },
  floor: { arity: 1, apply: ([a]) => Math.floor(a!) },
  round: { arity: 1, apply: ([a]) => Math.round(a!) },
  sqrt: { arity: 1, apply: ([a]) => Math.sqrt(a!) },
  exp: { arity: 1, apply: ([a]) => Math.exp(a!) },
  ln: { arity: 1, apply: ([a]) => Math.log(a!) },
  log10: { arity: 1, apply: ([a]) => Math.log10(a!) },
  min: { arity: [1, 16], apply: (args) => Math.min(...args) },
  max: { arity: [1, 16], apply: (args) => Math.max(...args) },
  pow: { arity: 2, apply: ([a, b]) => Math.pow(a!, b!) },
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

class Parser {
  private position = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.expression();
    if (this.position < this.tokens.length) {
      const token = this.tokens[this.position]!;
      throw new ApiError('VALIDATION_ERROR', `Unexpected "${String(token.value)}" after the expression`);
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private eatOperator(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'op' && token.value === value) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private expression(): number {
    let left = this.term();
    for (;;) {
      if (this.eatOperator('+')) left += this.term();
      else if (this.eatOperator('-')) left -= this.term();
      else return left;
    }
  }

  private term(): number {
    let left = this.unary();
    for (;;) {
      if (this.eatOperator('*')) left *= this.unary();
      else if (this.eatOperator('/')) left /= this.unary();
      else if (this.eatOperator('%')) left %= this.unary();
      else return left;
    }
  }

  private unary(): number {
    if (this.eatOperator('-')) return -this.unary();
    if (this.eatOperator('+')) return this.unary();
    return this.power();
  }

  /** Right-associative: `2^3^2` is `2^(3^2)`, which is the conventional reading. */
  private power(): number {
    const base = this.primary();
    if (this.eatOperator('^')) return Math.pow(base, this.unary());
    return base;
  }

  private primary(): number {
    const token = this.peek();
    if (token === undefined) throw new ApiError('VALIDATION_ERROR', 'Unexpected end of expression');

    if (token.kind === 'number') {
      this.position += 1;
      return token.value;
    }

    if (token.kind === 'name') {
      this.position += 1;
      const constant = CONSTANTS[token.value.toLowerCase()];
      if (constant !== undefined && !this.eatOperator('(')) return constant;

      const fn = FUNCTIONS[token.value.toLowerCase()];
      if (fn === undefined) {
        throw new ApiError('VALIDATION_ERROR', `Unknown function "${token.value}"`, {
          known: Object.keys(FUNCTIONS),
        });
      }
      if (!this.eatOperator('(')) {
        throw new ApiError('VALIDATION_ERROR', `"${token.value}" must be called as a function`);
      }

      const args: number[] = [];
      if (!this.eatOperator(')')) {
        args.push(this.expression());
        while (this.eatOperator(',')) args.push(this.expression());
        if (!this.eatOperator(')')) {
          throw new ApiError('VALIDATION_ERROR', `Missing ")" after the arguments to "${token.value}"`);
        }
      }

      const arity = fn.arity;
      const ok = Array.isArray(arity) ? args.length >= arity[0] && args.length <= arity[1] : args.length === arity;
      if (!ok) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `"${token.value}" takes ${Array.isArray(arity) ? `${arity[0]}–${arity[1]}` : arity} argument(s), got ${args.length}`,
        );
      }

      return fn.apply(args);
    }

    if (this.eatOperator('(')) {
      const value = this.expression();
      if (!this.eatOperator(')')) throw new ApiError('VALIDATION_ERROR', 'Missing ")"');
      return value;
    }

    throw new ApiError('VALIDATION_ERROR', `Unexpected "${token.value}"`);
  }
}

export function evaluateExpression(expression: string): number {
  if (expression.trim().length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'expression must not be empty');
  }
  const value = new Parser(tokenise(expression)).parse();
  if (!Number.isFinite(value)) {
    // NaN and ±Infinity are not representable in JSON, so returning one would put `null`
    // in the tool result and the model would read that as a successful answer.
    throw new ApiError('VALIDATION_ERROR', `"${expression}" does not evaluate to a finite number`, {
      value: String(value),
    });
  }
  return value;
}

// ── the registry ──────────────────────────────────────────────────────────────

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/**
 * Methods that do not change state, and are therefore safe to replay after a crash.
 *
 * The trade-off is real and worth naming. A GET *can* have an effect on a badly designed
 * endpoint, so treating it as read-only is not free. The alternative — treating every
 * HTTP call as effectful — makes every crash-resume of an agent that reads a URL park for
 * human approval, and an approval prompt that appears for ordinary reads is one that
 * operators learn to click through, which costs far more than the hypothetical. A tool
 * that genuinely needs stronger treatment can be registered with a stricter capability
 * set; the classification here follows the method's contract.
 */
const SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];

export class NativeToolRegistry {
  private readonly handlers: Map<string, Handler>;

  constructor(private readonly deps: NativeToolDeps) {
    const handlers: Handler[] = [
      this.httpRequest(),
      this.calculator(),
      this.dateTime(),
      this.fileRead(),
      this.fileWrite(),
    ];
    if (deps.notifications !== undefined) handlers.push(this.notify(deps.notifications));
    // The one tool-table entry that had no home until a provider existed. Its absence is not a
    // gap to paper over: a `web_search` with nothing to search would fail every call, and a model
    // offered a tool uses it, so the run would spend its steps discovering the config.
    if (deps.search !== undefined) handlers.push(this.webSearch(deps.search));
    // Registered as a **pair**. `memory_search` over a store nothing ever writes to is useless,
    // and a model handed only the search tool concludes the agent cannot remember anything —
    // which is a worse failure than not offering the tools at all, because it is invisible.
    if (deps.memory !== undefined) {
      handlers.push(this.memoryStore(deps.memory), this.memorySearch(deps.memory));
    }

    this.handlers = new Map(handlers.map((handler) => [handler.descriptor.name, handler]));
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /** The tools that are actually available, for building the model's tool definitions. */
  list(): NativeToolDescriptor[] {
    return [...this.handlers.values()].map((handler) => handler.descriptor);
  }

  capabilitiesFor(name: string, args: Record<string, unknown>): string[] {
    const handler = this.handlers.get(name);
    if (handler === undefined) {
      throw new ApiError('UNSUPPORTED_CAPABILITY', `Unknown native tool "${name}"`, { tool: name });
    }
    return handler.capabilities(args);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: NativeToolContext,
  ): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (handler === undefined) {
      throw new ApiError('UNSUPPORTED_CAPABILITY', `Unknown native tool "${name}"`, { tool: name });
    }
    return handler.run(args, ctx);
  }

  // ── http_request ────────────────────────────────────────────────────────────

  private httpRequest(): Handler {
    const deps = this.deps;
    return {
      descriptor: {
        name: 'http_request',
        description:
          'Perform an HTTP request and return the status, headers and body. A non-2xx ' +
          'status is returned as a normal result, not as an error.',
        inputSchema: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: [...HTTP_METHODS], default: 'GET' },
            url: { type: 'string', description: 'Absolute http(s) URL.' },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            body: { type: 'string' },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
      capabilities: (args) => {
        const method = (optionalString(args, 'method') ?? 'GET').toUpperCase();
        return SAFE_METHODS.includes(method) ? ['http', 'read_only'] : ['http', 'external_side_effect'];
      },
      run: async (args, ctx) => {
        const url = requireString(args, 'url');
        const method = (optionalString(args, 'method') ?? 'GET').toUpperCase();
        const headers = stringRecord(args['headers'], 'headers');
        const body = optionalString(args, 'body');

        if (!HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) {
          throw new ApiError('VALIDATION_ERROR', `Unsupported HTTP method "${method}"`, {
            allowed: [...HTTP_METHODS],
          });
        }

        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new ApiError('VALIDATION_ERROR', 'url must be an absolute URL', { url });
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new ApiError('VALIDATION_ERROR', 'url must use http or https', {
            protocol: parsed.protocol,
          });
        }

        const startedAt = deps.now();
        const response = await deps.fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: 'follow',
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        });

        const text = await readBounded(response, deps.httpMaxBytes);

        return {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          headers: Object.fromEntries(response.headers.entries()),
          body: text.value,
          bodyTruncated: text.truncated,
          bodyBytes: text.bytes,
          durationMs: deps.now() - startedAt,
        };
      },
    };
  }

  // ── calculator ──────────────────────────────────────────────────────────────

  private calculator(): Handler {
    return {
      descriptor: {
        name: 'calculator',
        description:
          'Evaluate an arithmetic expression. Supports + - * / % ^, parentheses, the ' +
          'constants pi and e, and abs, ceil, floor, round, sqrt, exp, ln, log10, min, max, pow.',
        inputSchema: {
          type: 'object',
          properties: { expression: { type: 'string' } },
          required: ['expression'],
          additionalProperties: false,
        },
      },
      capabilities: () => ['calculation', 'read_only'],
      run: async (args) => {
        const expression = requireString(args, 'expression');
        return { expression, result: evaluateExpression(expression) };
      },
    };
  }

  // ── date_time ───────────────────────────────────────────────────────────────

  private dateTime(): Handler {
    const deps = this.deps;
    return {
      descriptor: {
        name: 'date_time',
        description:
          'Return the current time, or format a timestamp. Operation "now" returns the ' +
          'current instant; "format" renders a timestamp using an IANA timezone.',
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['now', 'format'], default: 'now' },
            timestamp: { type: 'string', description: 'ISO 8601. Defaults to the current time.' },
            timezone: { type: 'string', description: 'IANA name, e.g. Europe/London.' },
            format: {
              type: 'object',
              properties: {
                locale: { type: 'string' },
                dateStyle: { type: 'string', enum: ['full', 'long', 'medium', 'short'] },
                timeStyle: { type: 'string', enum: ['full', 'long', 'medium', 'short'] },
              },
            },
          },
          additionalProperties: false,
        },
      },
      capabilities: () => ['read_only'],
      run: async (args) => {
        const operation = optionalString(args, 'operation') ?? 'now';
        if (operation !== 'now' && operation !== 'format') {
          throw new ApiError('VALIDATION_ERROR', `Unsupported operation "${operation}"`, {
            allowed: ['now', 'format'],
          });
        }

        const timestamp = optionalString(args, 'timestamp');
        const instant = timestamp === undefined ? new Date(deps.now()) : new Date(timestamp);
        if (Number.isNaN(instant.getTime())) {
          throw new ApiError('VALIDATION_ERROR', 'timestamp is not a valid date', { timestamp });
        }

        const timezone = optionalString(args, 'timezone');
        const formatArgs = (args['format'] ?? {}) as Record<string, unknown>;
        const locale = typeof formatArgs['locale'] === 'string' ? formatArgs['locale'] : 'en-GB';
        const dateStyle = typeof formatArgs['dateStyle'] === 'string' ? formatArgs['dateStyle'] : 'medium';
        const timeStyle = typeof formatArgs['timeStyle'] === 'string' ? formatArgs['timeStyle'] : 'medium';

        let formatted: string;
        try {
          formatted = new Intl.DateTimeFormat(locale, {
            dateStyle: dateStyle as 'medium',
            timeStyle: timeStyle as 'medium',
            ...(timezone === undefined ? {} : { timeZone: timezone }),
          }).format(instant);
        } catch (cause) {
          throw new ApiError('VALIDATION_ERROR', 'Could not format the timestamp', {
            timezone,
            locale,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        }

        return {
          iso: instant.toISOString(),
          epochMs: instant.getTime(),
          formatted,
          timezone: timezone ?? 'UTC',
        };
      },
    };
  }

  // ── file_read / file_write ──────────────────────────────────────────────────

  private fileRead(): Handler {
    const deps = this.deps;
    return {
      descriptor: {
        name: 'file_read',
        description: 'Read a UTF-8 text file from this tenant\u2019s workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to the workspace root.' },
            maxBytes: { type: 'number' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      capabilities: () => ['filesystem_read', 'read_only'],
      run: async (args, ctx) => {
        const path = requireString(args, 'path');
        const maxBytes = optionalNumber(args, 'maxBytes');
        const buffer = await deps.files.readFile(
          ctx.tenantId,
          path,
          maxBytes === undefined ? {} : { maxBytes },
        );
        const text = buffer.toString('utf8');
        return {
          path,
          bytes: buffer.byteLength,
          content: text,
          // A UTF-8 decode of binary content is not an error, but it is not text either.
          // Saying so is cheaper than letting the model reason about mojibake.
          validUtf8: !text.includes('\uFFFD'),
        };
      },
    };
  }

  private fileWrite(): Handler {
    const deps = this.deps;
    return {
      descriptor: {
        name: 'file_write',
        description: 'Write a UTF-8 text file into this tenant\u2019s workspace, creating directories as needed.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            mode: { type: 'string', enum: ['overwrite', 'append'], default: 'overwrite' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
      capabilities: () => ['filesystem_write', 'writes_files'],
      run: async (args, ctx) => {
        const path = requireString(args, 'path');
        const content = args['content'];
        if (typeof content !== 'string') {
          throw new ApiError('VALIDATION_ERROR', '"content" must be a string');
        }
        const mode = optionalString(args, 'mode') ?? 'overwrite';
        if (mode !== 'overwrite' && mode !== 'append') {
          throw new ApiError('VALIDATION_ERROR', `Unsupported mode "${mode}"`, {
            allowed: ['overwrite', 'append'],
          });
        }

        const payload =
          mode === 'append'
            ? `${await deps.files.readFile(ctx.tenantId, path).then(
                (existing) => existing.toString('utf8'),
                // A first append to a file that does not exist yet is a create, not a failure.
                () => '',
              )}${content}`
            : content;

        const absolute = await deps.files.writeFile(ctx.tenantId, path, payload);
        return { path, bytesWritten: byteLength(payload), mode, stored: absolute.length > 0 };
      },
    };
  }

  // ── notify ──────────────────────────────────────────────────────────────────

  private notify(sink: NotificationSink): Handler {
    return {
      descriptor: {
        name: 'notify',
        description: 'Raise a notification for the operator of this run.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            kind: { type: 'string', default: 'agent_message' },
            userId: { type: 'string', description: 'Recipient. Defaults to the tenant owner.' },
            linkRoute: { type: 'string' },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
      capabilities: () => ['notify', 'external_side_effect'],
      run: async (args, ctx) => {
        const title = requireString(args, 'title');
        const userId = optionalString(args, 'userId');
        if (userId === undefined) {
          throw new ApiError(
            'VALIDATION_ERROR',
            'notify requires "userId" — the engine does not infer a recipient from the run',
          );
        }
        const notification = await sink.create({
          tenantId: ctx.tenantId,
          userId,
          kind: optionalString(args, 'kind') ?? 'agent_message',
          title,
          ...(optionalString(args, 'body') === undefined ? {} : { body: optionalString(args, 'body')! }),
          ...(optionalString(args, 'linkRoute') === undefined
            ? {}
            : { linkRoute: optionalString(args, 'linkRoute')! }),
        });
        return { notificationId: notification.id };
      },
    };
  }

  // ── web_search ──────────────────────────────────────────────────────────────

  /**
   * Search the web (spec §3.6).
   *
   * `external_side_effect` is the spec's own classification, and it is worth defending because a
   * search feels read-only. It is not: the query leaves the deployment and reaches a third party,
   * and what the tenant asked is itself information. The capability flag is what lets an approval
   * policy gate a search on a sensitive tenant without gating `http_request` on the same grounds.
   *
   * The provider is reported back in the result. A run that cites a source should be able to say
   * *how* it found it, and a result set with no provenance for its own origin is a small version
   * of the problem the Research protocol exists to solve.
   */
  private webSearch(search: SearchPort): Handler {
    return {
      descriptor: {
        name: SEARCH_TOOL_NAME,
        description:
          'Search the web and return the top results, each with a title, a URL and a snippet. ' +
          'Use this to find sources; read a result with http_request or the browser to get its ' +
          'full text.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query.' },
            maxResults: {
              type: 'number',
              description: 'How many results to return. Clamped to the deployment ceiling.',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      capabilities: () => ['search', 'external_side_effect'],
      run: async (args, ctx) => {
        const query = requireString(args, 'query');
        const maxResults = optionalNumber(args, 'maxResults');

        const results = await search.search({
          query,
          ...(maxResults === undefined ? {} : { maxResults }),
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        });

        return {
          query,
          provider: search.name,
          results: results.map((result) => ({
            title: result.title,
            url: result.url,
            snippet: result.snippet,
          })),
        };
      },
    };
  }

  // ── memory_store / memory_search ────────────────────────────────────────────

  /**
   * Store a memory (spec §3.6).
   *
   * `external_side_effect` is the spec's own classification and it is load-bearing rather than
   * bookkeeping: the row outlives the run and changes what a *later* run recalls, so a
   * crash-resume must not quietly write it a second time. That flag is what lets the approval
   * policy see it as the state change it is.
   *
   * The agent is taken from the run context, never from the arguments. A model that could name an
   * `agentId` here could write into another agent's memory, and it would look like an ordinary
   * successful call — the kind of hole that is only found by someone who already suspected it.
   */
  private memoryStore(memory: MemoryPort): Handler {
    return {
      descriptor: {
        name: 'memory_store',
        description:
          'Store a memory to be recalled in a future run: a preference, a decision, or a fact ' +
          'learned about this workspace. Use "agent" scope for something only this agent needs.',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: [...MEMORY_SCOPES], description: 'What the memory is about.' },
            content: { type: 'string' },
            metadata: { type: 'object', description: 'Optional structured detail to keep with it.' },
          },
          required: ['scope', 'content'],
          additionalProperties: false,
        },
      },
      capabilities: () => ['memory', 'external_side_effect'],
      run: async (args, ctx) => {
        const content = requireString(args, 'content');
        const scope = requireMemoryScope(args, 'scope');
        const metadata = args['metadata'];

        const summary = await memory.create(ctx.tenantId, {
          content,
          scope,
          agentId: ctx.agentId,
          ...(metadata === undefined ? {} : { metadata: objectRecord(metadata, 'metadata') }),
        });

        return { memoryId: summary.id };
      },
    };
  }

  /**
   * Search stored memories (spec §3.6).
   *
   * Two details are deliberate.
   *
   * **`includeWorkspace` is always on.** A memory stored without an agent is the tenant's shared
   * pool — that is what `agentId: null` means — and an agent that could not see it would make
   * every memory written from the Memory page invisible to the agents it was written for. The
   * agent's *own* memories still come first; widening the pool does not reorder it.
   *
   * **`mode` is returned alongside the results.** The tool contract asks only for `results`, and
   * a `null` score with no explanation reads as a bug. `mode` is what makes the difference between
   * "this is a weak semantic match" and "this deployment has no embedding model, so this is a
   * substring match" visible to the model rather than something it has to guess.
   */
  private memorySearch(memory: MemoryPort): Handler {
    return {
      descriptor: {
        name: 'memory_search',
        description:
          'Search stored memories. Returns the closest matches, each with a relevance score when ' +
          'semantic search is available and a null score when only keyword matching is.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            scope: { type: 'string', enum: [...MEMORY_SCOPES] },
            agentId: { type: 'string', description: "Defaults to this run's agent." },
            limit: { type: 'number', description: 'Maximum matches to return (1-50).' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      capabilities: () => ['memory'],
      run: async (args, ctx) => {
        const query = requireString(args, 'query');
        const scopeArg = optionalString(args, 'scope');
        const scope = scopeArg === undefined ? undefined : requireMemoryScope(args, 'scope');
        // A caller-supplied agent wins over the run's own, so an agent can deliberately look at
        // what a teammate remembered; within the tenant this is a read, not a privilege.
        const agentId = optionalString(args, 'agentId') ?? ctx.agentId ?? undefined;
        const limit = clampLimit(optionalNumber(args, 'limit'));

        const result = await memory.search(ctx.tenantId, {
          q: query,
          ...(agentId === undefined ? {} : { agentId }),
          includeWorkspace: true,
          ...(scope === undefined ? {} : { scope }),
          ...(limit === undefined ? {} : { limit }),
        });

        return {
          results: result.memories.map((match) => ({
            id: match.id,
            content: match.content,
            score: match.score,
            metadata: match.metadata,
          })),
          mode: result.mode,
        };
      },
    };
  }
}

/**
 * A scope argument, narrowed to the vocabulary.
 *
 * `parseMemoryScope` rather than a cast: `scope` decides where a memory is allowed to be recalled
 * from, so a value this build has never heard of has to be a validation error rather than a string
 * that silently becomes a new pool.
 */
function requireMemoryScope(args: Record<string, unknown>, key: string): MemoryScope {
  const value = requireString(args, key);
  const scope = parseMemoryScope(value);
  if (scope === null) {
    throw new ApiError('VALIDATION_ERROR', `Unknown memory scope "${value}"`, {
      [key]: value,
      allowed: [...MEMORY_SCOPES],
    });
  }
  return scope;
}

/**
 * A tool-supplied limit, floored and capped.
 *
 * The cap matches the search endpoint's own: a recall feeds a prompt, and a model that asked for
 * 10 000 memories would spend the run's whole context budget on background it did not need.
 * Non-integers are floored rather than rejected — a limit of `3.7` clearly means three, and
 * failing the call over it would cost a round trip to say nothing.
 */
function clampLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(1, Math.min(50, Math.floor(value)));
}

// ── bounded body read ─────────────────────────────────────────────────────────

/**
 * Read at most `maxBytes` of a response body.
 *
 * `response.text()` would buffer the whole thing first, which is the failure mode this
 * guard exists to prevent: a tool call pointed at a multi-gigabyte endpoint should be
 * capped, not allowed to exhaust the process. The stream is cancelled once the budget is
 * spent so the socket is released rather than left draining in the background.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ value: string; bytes: number; truncated: boolean }> {
  const body = response.body;
  if (body === null) return { value: '', bytes: 0, truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      total += value.byteLength;
      if (total >= maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const decoded = Buffer.from(merged).toString('utf8');
  // Re-slicing on a character boundary keeps the reported byte count honest: a decode that
  // ended mid-character would otherwise report more bytes than the string can hold.
  const value = truncated ? sliceUtf8(decoded, maxBytes) : decoded;
  return { value, bytes: byteLength(value), truncated };
}
