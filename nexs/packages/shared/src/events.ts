/**
 * SSE event catalog — the complete contract.
 * Nothing may be emitted over SSE that is not declared here, and every payload is
 * validated before it leaves the hub (no non-serializable values cross the wire).
 *
 * Frame format:  data: {"name":"run.started","payload":{...}}\n\n
 *
 * ## What "validated" means, and where it happens
 *
 * Both sentences above are enforced at one place — `encodeSseFrame`, the function that turns a
 * frame into the bytes a client receives. It is the only such function, so a rule applied there
 * cannot be bypassed: the hub's fan-out, its `closeTenant` goodbye and the controller's
 * connect-time replay all go through it, and the bus subscription that feeds the hub cannot
 * reach a socket without it either.
 *
 * The check is structural rather than schema-based. There is no per-event zod schema and there
 * deliberately is not one: the payload types are already derived from this catalog
 * (`SsePayload<N>`), so a second runtime description of the same shape would be a copy that can
 * drift from the types it duplicates. What a schema could catch — a missing field, a wrong type
 * — the compiler already catches at the emit site. What it *cannot* catch is everything the
 * compiler is erased before: a value that TypeScript is happy with and `JSON.stringify` is not.
 * That is the gap this closes, and it is not hypothetical:
 *
 *  - `undefined` is dropped by `JSON.stringify`, so `{ runId: undefined }` leaves the server as
 *    `{}` — a frame whose declared field is simply absent, with nothing anywhere reporting it.
 *  - A `bigint` or a circular reference makes `JSON.stringify` **throw**, and the throw happens
 *    inside the hub's fan-out, where the bus's subscriber guard turns it into a log line and the
 *    frame reaches nobody. The emitter believes it succeeded.
 *  - `NaN` and `Infinity` have no JSON literal and arrive as `null`.
 *  - A `Date`, `Map`, `Set`, `Buffer` or class instance is not what the declared shape says: a
 *    `Buffer` becomes `{"0":137,"1":80,…}` and a `Date` becomes a string that a `number` field
 *    will happily accept downstream.
 *
 * The last group is refused rather than coerced because coercion is silent. An emitter that wants
 * an ISO string should say `toISOString()` — the catalog declares `string` for exactly those
 * fields, so a `Date` here is a mismatch between the payload and its own declaration, and the
 * honest moment to find that out is at the emitter, not in a browser.
 *
 * A cycle is a hard error; a *repeated* reference is not. `seen` tracks the current path rather
 * than every value visited, so a payload that legitimately shares a sub-object between two keys
 * still encodes — only a reference back into its own ancestry is refused.
 */

export interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export interface PlanStepPayload {
  id: string;
  description: string;
  stepType: string;
  config: Record<string, unknown>;
  dependsOn?: string[];
}

export const SSE_EVENTS = {
  // ── run lifecycle ───────────────────────────────────────────────────────
  'run.created': (p: { runId: string; kind: string; status: string }) => p,
  'run.started': (p: { runId: string }) => p,
  /**
   * The agent version this run is pinned to — gap #15.
   *
   * Emitted because the pin is the answer to "why did this run behave differently from the
   * agent I am looking at now?", and a question that can only be answered by reading
   * `Run.agentVersionId` in a database console is one an operator will not ask. It fires
   * once, on the execution that wins the pin, and never again for that run.
   */
  'run.version_pinned': (p: { runId: string; agentId: string; agentVersionId: string }) => p,
  'run.plan_ready': (p: { runId: string; plan: PlanStepPayload[] }) => p,
  'run.paused': (p: { runId: string }) => p,
  'run.resumed': (p: { runId: string }) => p,
  'run.completed': (p: { runId: string; output?: unknown }) => p,
  'run.failed': (p: { runId: string; error: ErrorPayload }) => p,
  'run.cancelled': (p: { runId: string }) => p,

  // ── steps ───────────────────────────────────────────────────────────────
  'step.started': (p: { runId: string; stepId: string; seq: number; stepType: string; name: string }) => p,
  'step.completed': (p: { runId: string; stepId: string; durationMs?: number }) => p,
  'step.failed': (p: { runId: string; stepId: string; error: ErrorPayload; retryCount: number }) => p,

  // ── tools ───────────────────────────────────────────────────────────────
  'tool.started': (p: { runId?: string; toolName: string; args?: unknown }) => p,
  'tool.completed': (p: { runId?: string; toolName: string; ok: boolean; durationMs?: number }) => p,
  'tool.failed': (p: { runId?: string; toolName: string; error: ErrorPayload }) => p,

  // ── approvals ───────────────────────────────────────────────────────────
  'approval.created': (p: {
    approvalId: string;
    title: string;
    risk: { level: string; reasons: string[] };
    expiresAt?: string;
  }) => p,
  /**
   * An approval was answered.
   *
   * `outcome` is the fine-grained exec answer (`allow_once` | `allow_always` | `deny`) and is
   * absent for a tool approval, where the decision *is* the answer. It travels on this event
   * rather than in a second one because every consumer of `approval.resolved` — the in-chat
   * card, the inbox drawer, the channel message, the typewriter — has to settle **one** row,
   * and a second event would let a client settle the status while never learning whether a
   * standing permission had just been granted.
   */
  'approval.resolved': (p: {
    approvalId: string;
    decision: 'approved' | 'rejected';
    decidedBy?: string;
    outcome?: string;
  }) => p,
  'approval.expired': (p: { approvalId: string }) => p,

  // ── chat ────────────────────────────────────────────────────────────────
  'chat.started': (p: { runId: string }) => p,
  'chat.delta': (p: { runId: string; delta: string }) => p,
  'chat.tool_call': (p: { runId: string; toolName: string; args: unknown }) => p,
  'chat.tool_result': (p: { runId: string; toolName: string; ok: boolean; result?: unknown }) => p,
  'chat.completed': (p: { runId: string; messageId: string }) => p,
  'chat.error': (p: { runId: string; error: ErrorPayload }) => p,
  'chat.limit.reached': (p: { runId: string; limit: string }) => p,

  // ── browser & sandbox ───────────────────────────────────────────────────
  'browser.started': (p: { sessionId: string; url?: string }) => p,
  'browser.updated': (p: { sessionId: string; url?: string; title?: string; screenshotRef?: string }) => p,
  'browser.closed': (p: { sessionId: string }) => p,
  'sandbox.exec_started': (p: { executionId: string; command: string }) => p,
  'sandbox.exec_completed': (p: { executionId: string; status: string; exitCode?: number }) => p,

  // ── entity changes (drive live list updates) ────────────────────────────
  'agent.created': (p: { agentId: string }) => p,
  'agent.updated': (p: { agentId: string }) => p,
  'agent.deleted': (p: { agentId: string }) => p,
  'goal.created': (p: { goalId: string }) => p,
  'goal.updated': (p: { goalId: string }) => p,
  'task.created': (p: { taskId: string }) => p,
  'task.updated': (p: { taskId: string }) => p,
  'provider.synced': (p: { providerId: string; modelCount: number }) => p,
  'provider.health': (p: { providerId: string; ok: boolean; status: string }) => p,
  'mcp.connected': (p: { serverId: string; toolCount: number }) => p,
  'connector.connected': (p: { connectorId: string }) => p,
  'notification.created': (p: { notificationId: string }) => p,

  // ── surfaces: channels, pairing, devices, bindings, plugins (UI/UX v2 §5) ──
  //
  // These drive the Surfaces strip (§2.3), the channel grid and the pending-count pills on
  // the sidebar. Each carries the id of the row that changed, so a client can invalidate
  // exactly one query instead of refetching the whole surface list on every event.
  'channel.created': (p: { channelId: string; type: string }) => p,
  'channel.updated': (p: { channelId: string }) => p,
  /**
   * A channel's connectivity changed.
   *
   * `detail` carries the verbatim reason when there is one. §3 requires status to be colour
   * **plus** label plus icon, and a transition with no reason attached is exactly the case
   * where the UI would otherwise have to invent one.
   */
  'channel.status': (p: { channelId: string; status: string; detail?: string }) => p,
  /**
   * Someone the channel does not know has asked to be let in.
   *
   * `code` is in the payload because the pairing surface must display the same code the
   * requester was shown — and because the CLI's `nexs pairing approve <channel> <CODE>`
   * takes it, so the web UI and the terminal agree by construction rather than by luck.
   */
  'pairing.requested': (p: {
    requestId: string;
    channelType: string;
    senderId: string;
    code: string;
    expiresAt: string;
  }) => p,
  'pairing.resolved': (p: {
    requestId: string;
    status: string;
    decidedBy?: string;
    madeOwner?: boolean;
  }) => p,
  /**
   * A device is waiting for approval — the `waiting` pill on the Channels row.
   *
   * `scopes` travels with it rather than being fetched separately, because the one question
   * an operator has about a pending device is "what is it asking for?", and an approve button
   * rendered before that answer is loaded is a button nobody should press.
   */
  'device.pending': (p: { deviceId: string; role: string; scopes: string[] }) => p,
  'device.paired': (p: { deviceId: string; access: string; scopes: string[] }) => p,
  'device.revoked': (p: { deviceId: string }) => p,
  'binding.updated': (p: { bindingId: string; matchKey: string; agentId: string }) => p,
  'binding.deleted': (p: { bindingId: string }) => p,
  'plugin.updated': (p: { pluginId: string; enabled: boolean; status: string }) => p,
  /** A skill became available as `/skill <name>` on every surface (§7). */
  'skill.installed': (p: { skillId: string; name: string; version: number }) => p,

  // ── schedules & events (the two ways work starts by itself) ─────────────
  //
  // These drive the Schedules list and the event log. `schedule.fired` carries the id of
  // whatever it started, because the one thing an operator watching a schedule wants is to
  // get from the schedule to the run it produced without going through the run list.
  'schedule.created': (p: { scheduleId: string; kind: string }) => p,
  'schedule.updated': (p: { scheduleId: string }) => p,
  'schedule.deleted': (p: { scheduleId: string }) => p,
  'schedule.fired': (p: {
    scheduleId: string;
    runId?: string;
    taskId?: string;
    nextFireAt: string | null;
  }) => p,
  /**
   * An event arrived.
   *
   * `deduplicated` is in the payload rather than being implied, because a replay that
   * silently looked like a fresh delivery is exactly the case a webhook operator needs to
   * see — it is the difference between "the retry was absorbed" and "the workflow ran twice".
   */
  'event.received': (p: {
    eventId: string;
    type: string;
    source: string;
    deduplicated: boolean;
  }) => p,
  'event.processed': (p: {
    eventId: string;
    matchedSubscriptions: number;
    triggered: number;
  }) => p,

  // ── stream lifecycle ────────────────────────────────────────────────────
  'stream.closing': (p: { reason: string }) => p,
} as const;

export type SSEEventName = keyof typeof SSE_EVENTS;

/** Payload type for a given event name, inferred from the catalog above. */
export type SsePayload<N extends SSEEventName> = ReturnType<(typeof SSE_EVENTS)[N]>;

export interface SseFrame<N extends SSEEventName = SSEEventName> {
  name: N;
  payload: SsePayload<N>;
}

export const SSE_HEARTBEAT = ': ping\n\n';

/** One reason a payload cannot be put on the wire. `path` is relative to the payload. */
export interface SseFrameIssue {
  /** Dotted path to the offending value (`plan[0].config`), or `name`/`payload`. */
  path: string;
  /** A sentence that completes "*path* …", written to be read in a log line. */
  message: string;
}

/**
 * Thrown by `encodeSseFrame` when a frame would not survive the wire.
 *
 * A plain `Error` subclass rather than an `ApiError`, for the same reason `PlanValidationError`
 * is one: this never crosses HTTP — it is a defect in an emitter, not a condition of a request —
 * and reporting it as an HTTP status would invite somebody to handle it as one.
 *
 * `issues` is carried rather than only formatted into the message so a caller can assert on the
 * specific defect instead of on the wording of a string.
 */
export class SseFrameError extends Error {
  constructor(
    readonly eventName: string,
    readonly issues: readonly SseFrameIssue[],
  ) {
    super(
      `SSE frame "${eventName}" cannot be encoded: ` +
        issues.map((issue) => `${issue.path} ${issue.message}`).join('; '),
    );
    this.name = 'SseFrameError';
  }
}

/**
 * How deep a payload may nest before it is refused.
 *
 * Generous — the deepest declared payload (`run.plan_ready`'s plan, or a tool result carried on
 * `run.completed`) is a handful of levels — but finite, so a structure built by a loop cannot
 * turn encoding into a stack overflow. The cycle check is what prevents the unbounded case; this
 * is the backstop for a structure that is deep rather than circular.
 */
const MAX_SSE_PAYLOAD_DEPTH = 64;

/**
 * Cap on how many defects are reported.
 *
 * A malformed payload is usually malformed in one way repeated across many keys. Reporting the
 * first few keeps the message readable, and the count that is dropped is stated rather than
 * silently truncated.
 */
const MAX_SSE_ISSUES = 10;

/** A key of the catalog, checked without trusting the prototype chain. */
export function isSseEventName(name: unknown): name is SSEEventName {
  // `Object.prototype.hasOwnProperty` rather than `in` or a truthiness test: `'constructor' in
  // SSE_EVENTS` is true, and `SSE_EVENTS['toString']` is a function — so a payload naming either
  // would otherwise be accepted as a declared event and emitted to a client listening for
  // nothing.
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(SSE_EVENTS, name);
}

/**
 * A plain data object — not a `Date`, `Map`, `Set`, `Buffer`, or class instance.
 *
 * A `null` prototype is accepted because `Object.create(null)` is a legitimate way to build a
 * record and is still plain JSON; `JSON.parse` never produces one, so the only way it arrives
 * here is deliberately.
 */
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The constructor's name, for a message that says *what* was found rather than only that it is wrong. */
function describeContainer(value: object): string {
  const ctor: unknown = (value as { constructor?: unknown }).constructor;
  if (typeof ctor === 'function' && ctor.name.length > 0) return ctor.name;
  return 'object';
}

function inspectValue(
  value: unknown,
  path: string,
  depth: number,
  seen: Set<object>,
  issues: SseFrameIssue[],
): void {
  if (issues.length >= MAX_SSE_ISSUES) return;
  if (value === null) return;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;

    case 'number':
      if (!Number.isFinite(value)) {
        issues.push({
          path,
          message: `is ${String(value)}, which JSON has no literal for and would arrive as null`,
        });
      }
      return;

    case 'undefined':
      issues.push({
        path,
        message: 'is undefined, which JSON.stringify drops — the key would vanish silently',
      });
      return;

    case 'bigint':
      issues.push({ path, message: 'is a bigint, which JSON.stringify cannot serialize' });
      return;

    case 'function':
      issues.push({
        path,
        message: 'is a function, which JSON.stringify drops — the key would vanish silently',
      });
      return;

    case 'symbol':
      issues.push({
        path,
        message: 'is a symbol, which JSON.stringify drops — the key would vanish silently',
      });
      return;

    default:
      inspectContainer(value as object, path, depth, seen, issues);
  }
}

function inspectContainer(
  value: object,
  path: string,
  depth: number,
  seen: Set<object>,
  issues: SseFrameIssue[],
): void {
  if (seen.has(value)) {
    issues.push({
      path,
      message: 'is a circular reference, which JSON.stringify cannot serialize',
    });
    return;
  }

  if (depth >= MAX_SSE_PAYLOAD_DEPTH) {
    issues.push({ path, message: `nests deeper than ${MAX_SSE_PAYLOAD_DEPTH} levels` });
    return;
  }

  // Ancestors only, and removed on the way back out: a value reachable by two paths is valid
  // JSON and stays valid here, while a reference back into its own ancestry is not.
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        // Indexed rather than `for…of`, so a sparse array's hole is read as the `undefined` it
        // is: `JSON.stringify` turns `[1, , 3]` into `[1,null,3]` without a word.
        inspectValue(value[index], `${path}[${index}]`, depth + 1, seen, issues);
      }
      return;
    }

    if (!isPlainObject(value)) {
      issues.push({
        path,
        message:
          `is a ${describeContainer(value)}, not a plain object — JSON.stringify would not ` +
          'round-trip it as the declared shape',
      });
      return;
    }

    for (const [key, nested] of Object.entries(value)) {
      inspectValue(nested, path === '' ? key : `${path}.${key}`, depth + 1, seen, issues);
    }
  } finally {
    seen.delete(value);
  }
}

/**
 * Every reason `payload` cannot be emitted as event `name`, or an empty array when it can.
 *
 * Exported so a test can assert the *specific* defect rather than catching a message string.
 */
export function inspectSsePayload(name: unknown, payload: unknown): SseFrameIssue[] {
  const issues: SseFrameIssue[] = [];

  if (!isSseEventName(name)) {
    issues.push({
      path: 'name',
      message: `"${String(name)}" is not declared in SSE_EVENTS`,
    });
    // Nothing below could be trusted: the payload's shape is defined by the event.
    return issues;
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    issues.push({
      path: 'payload',
      message: 'must be a plain object, because every declared payload is one',
    });
    return issues;
  }

  const seen = new Set<object>([payload]);
  for (const [key, value] of Object.entries(payload)) {
    inspectValue(value, key, 1, seen, issues);
  }

  return issues;
}

/** Throws `SseFrameError` unless `payload` is emittable as event `name`. */
export function assertSseFrame(name: string, payload: unknown): void {
  const issues = inspectSsePayload(name, payload);
  if (issues.length > 0) throw new SseFrameError(name, issues);
}

/**
 * The only function that turns a frame into bytes.
 *
 * Validates first (see the catalog header) and then serializes. The validation is not optional
 * and cannot be skipped by a caller: there is no second encoder, and a frame that reaches a
 * client has necessarily been through here.
 *
 * Throwing rather than dropping is deliberate, and the choice is about *where the defect is
 * reported*. Every emitter already wraps its own emission — the engine's `emit` catches and
 * warns, and the bus's fan-out catches per subscriber — so a throw does not take down a run; it
 * converts "a frame nobody received, for a reason nobody recorded" into a log line that names
 * the event and the offending field. Silently dropping here would leave those wrappers with
 * nothing to report, which is the failure this validation exists to remove.
 */
export function encodeSseFrame<N extends SSEEventName>(
  name: N,
  payload: SsePayload<N>,
  id?: string,
): string {
  assertSseFrame(name, payload);

  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${name}`);
  lines.push(`data: ${JSON.stringify({ name, payload })}`);
  return lines.join('\n') + '\n\n';
}
