import { beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { ChatTurnRunner } from '../src/services/chat/chat-turn.runner.js';
import { ChatMessageRepository, ChatSessionRepository } from '../src/repositories/chat.repo.js';
import { RunRepository } from '../src/repositories/run.repo.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';
import type { SseFrame } from '@nexs/shared';
import type { ChatToolCall } from '@nexs/shared';
import type { GatewayChatRequest } from '../src/services/gateway/model-gateway.js';

/**
 * The chat turn runner.
 *
 * ## What this file exists to defend
 *
 * Three behaviours, each of which fails silently in production:
 *
 *  1. **The answer is persisted.** The accumulated text has to survive to the `ChatMessage`
 *     row. An earlier draft returned the text from the generation loop's terminal branches —
 *     both of which return an empty string — so every completed turn persisted `''`. Nothing
 *     threw, nothing logged, and the user's answer simply vanished. The first test below is
 *     that assertion.
 *  2. **Exactly one generator wins.** The claim is a compare-and-swap. A second connection
 *     must get `null` and stop, or two tabs produce two assistant messages for one run.
 *  3. **A failing tool does not fail the turn.** The error is fed back to the model, which is
 *     the entire point of an agent loop.
 *
 * The gateway is a hand-written stub rather than a real `ModelGateway` over a fake `fetch`:
 * the gateway has its own suite, and driving this through OpenAI-shaped SSE bodies would bury
 * the runner's behaviour under adapter noise. The dependency is a narrow port, so the stub is
 * the shape the runner declares.
 */

const TENANT = 'tnt_a';
const MODEL = 'mdl_test';

let fake: FakeDb;
let sessions: ChatSessionRepository;
let messages: ChatMessageRepository;
let runs: RunRepository;

beforeEach(() => {
  fake = createFakeDb();
  const at = new Date('2026-01-01T00:00:00.000Z');
  fake.tenants.push(
    { id: TENANT, name: 'Tenant A', createdAt: at, updatedAt: at },
    { id: 'tnt_b', name: 'Tenant B', createdAt: at, updatedAt: at },
  );
  sessions = new ChatSessionRepository(fake.client);
  messages = new ChatMessageRepository(fake.client);
  runs = new RunRepository(fake.client);
});

/**
 * A gateway whose `stream` yields a scripted set of rounds.
 *
 * Each entry is one provider call. A round is either text (the final answer) or a list of
 * tool calls, which is how the runner decides whether to loop.
 */
class ScriptedStreamGateway {
  readonly requests: GatewayChatRequest[] = [];
  private readonly rounds: (
    | { kind: 'text'; text: string }
    | { kind: 'tools'; calls: { id: string; name: string; args: Record<string, unknown> }[] }
  )[] = [];

  text(text: string): this {
    this.rounds.push({ kind: 'text', text });
    return this;
  }

  tools(...calls: { id: string; name: string; args: Record<string, unknown> }[]): this {
    this.rounds.push({ kind: 'tools', calls });
    return this;
  }

  async *stream(request: GatewayChatRequest): AsyncGenerator<unknown> {
    this.requests.push(request);
    const round = this.rounds[this.requests.length - 1] ?? { kind: 'text', text: '' };

    if (round.kind === 'text') {
      for (const char of round.text) yield { type: 'text', text: char };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    for (const call of round.calls) yield { type: 'tool_call', toolCall: call };
    yield { type: 'done', finishReason: 'tool_calls' };
  }
}

/**
 * A gate a test can open.
 *
 * The naive version — `let release: (() => void) | null = null; const gate = new Promise(r => { release = r })` —
 * does not typecheck: the assignment happens inside a callback the compiler cannot prove runs
 * before the later use, so it narrows the variable to `null` and the call becomes a `never`.
 * Returning the resolver alongside the promise keeps the value on a single assignment that
 * the compiler can see, which is also easier to read at the call site.
 */
function createGate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

interface FakeInvoker {
  invocations: { toolId: string }[];
  /** Tool ids that should throw when invoked. */
  failing: Set<string>;
}

/**
 * The tool transcript off a stored row, as a typed list.
 *
 * `ChatMessageRepository.findById` returns the raw Prisma row, and that column is `Json` — so
 * its static type is `JsonValue` and indexing it needs a check. Narrowing here rather than
 * casting is deliberate: the assertion below is about what was actually written, and a cast
 * would let a test pass on a shape the database never held.
 */
function storedToolCalls(row: { toolCalls: unknown } | null): ChatToolCall[] {
  const value = row?.toolCalls;
  return Array.isArray(value) ? (value as ChatToolCall[]) : [];
}

function fakeInvoker(): FakeInvoker & {
  invoke(input: { toolId: string }): Promise<{ ok: boolean; result: unknown }>;
} {
  const state: FakeInvoker = { invocations: [], failing: new Set() };
  return {
    ...state,
    get invocations() {
      return state.invocations;
    },
    get failing() {
      return state.failing;
    },
    async invoke(input: { toolId: string }) {
      state.invocations.push(input);
      if (state.failing.has(input.toolId)) throw new Error(`${input.toolId} exploded`);
      return { ok: true, result: { from: input.toolId } };
    },
  };
}

function fakeHub(): { frames: SseFrame[]; publish(frame: SseFrame): void } {
  const frames: SseFrame[] = [];
  return {
    frames,
    publish(frame: SseFrame) {
      frames.push(frame);
    },
  };
}

/**
 * A queued chat run, which is the precondition every case here shares.
 *
 * The status is not parameterised: no case needs a run that is already in flight, and the
 * claim — the one thing a non-queued status would exercise — is covered by calling `run`
 * twice against the same id, which is the shape the race actually takes.
 */
async function seedRun() {
  const session = await sessions.create({ tenantId: TENANT, userId: 'usr_1', agentId: null, title: null });
  const run = await runs.create({
    tenantId: TENANT,
    kind: 'chat',
    agentId: null,
    input: {},
  });
  return { sessionId: session.id, runId: run.id };
}

function build(options: {
  gateway: ScriptedStreamGateway;
  invoker: ReturnType<typeof fakeInvoker>;
  hub: ReturnType<typeof fakeHub>;
}) {
  return new ChatTurnRunner({
    gateway: options.gateway as never,
    tools: options.invoker as never,
    messages,
    runs,
    hub: options.hub as never,
    logger: pino({ level: 'silent' }),
  });
}

describe('ChatTurnRunner — the answer survives to the database', () => {
  it('persists the assistant text it accumulated', async () => {
    const { sessionId, runId } = await seedRun();
    const gateway = new ScriptedStreamGateway().text('Hello there');
    const hub = fakeHub();
    const runner = build({ gateway, invoker: fakeInvoker(), hub });

    const history = await messages.recentBySession(TENANT, sessionId, 10);
    const result = await runner.run({
      tenantId: TENANT,
      runId,
      sessionId,
      history,
      modelId: MODEL,
    });

    expect(result?.interrupted).toBe(false);
    expect(result?.messageId).not.toBeNull();

    // The bug this test was written for: an earlier draft returned `''` from the loop's
    // terminal branches and persisted it, losing the whole answer without a single error.
    const stored = await messages.findById(TENANT, result!.messageId!);
    expect(stored?.content).toBe('Hello there');
  });

  it('streams each delta as a frame while generating', async () => {
    const { sessionId, runId } = await seedRun();
    const gateway = new ScriptedStreamGateway().text('abc');
    const hub = fakeHub();
    const runner = build({ gateway, invoker: fakeInvoker(), hub });

    await runner.run({
      tenantId: TENANT,
      runId,
      sessionId,
      history: await messages.recentBySession(TENANT, sessionId, 10),
      modelId: MODEL,
    });

    const deltas = hub.frames.filter((f) => f.name === 'chat.delta');
    expect(deltas.map((f) => (f.payload as { delta: string }).delta)).toEqual(['a', 'b', 'c']);
    expect(hub.frames.some((f) => f.name === 'chat.completed')).toBe(true);
  });

  it('marks the run completed with the message id as its output', async () => {
    const { sessionId, runId } = await seedRun();
    const runner = build({
      gateway: new ScriptedStreamGateway().text('done'),
      invoker: fakeInvoker(),
      hub: fakeHub(),
    });

    const result = await runner.run({
      tenantId: TENANT,
      runId,
      sessionId,
      history: await messages.recentBySession(TENANT, sessionId, 10),
      modelId: MODEL,
    });

    const run = await runs.findById(TENANT, runId);
    expect(run?.status).toBe('completed');
    expect(run?.output).toMatchObject({ messageId: result?.messageId });
  });
});

describe('ChatTurnRunner — the claim', () => {
  it('generates when it wins the claim', async () => {
    const { sessionId, runId } = await seedRun();
    const gateway = new ScriptedStreamGateway().text('hi');
    const runner = build({ gateway, invoker: fakeInvoker(), hub: fakeHub() });

    const result = await runner.run({
      tenantId: TENANT,
      runId,
      sessionId,
      history: await messages.recentBySession(TENANT, sessionId, 10),
      modelId: MODEL,
    });

    expect(result).not.toBeNull();
    expect(gateway.requests).toHaveLength(1);
  });

  it('returns null and calls nothing when it loses the claim', async () => {
    const { sessionId, runId } = await seedRun();
    // Another connection already took it.
    await runs.setStatus(TENANT, runId, 'completed');

    const gateway = new ScriptedStreamGateway().text('should not happen');
    const runner = build({ gateway, invoker: fakeInvoker(), hub: fakeHub() });

    const result = await runner.run({
      tenantId: TENANT,
      runId,
      sessionId,
      history: await messages.recentBySession(TENANT, sessionId, 10),
      modelId: MODEL,
    });

    expect(result).toBeNull();
    // Losing the race must cost nothing: no provider call, no frames.
    expect(gateway.requests).toHaveLength(0);
  });

  it('writes only one assistant message across two runs of the same run id', async () => {
    const { sessionId, runId } = await seedRun();
    const gateway = new ScriptedStreamGateway().text('first');
    const runner = build({ gateway, invoker: fakeInvoker(), hub: fakeHub() });

    const history = await messages.recentBySession(TENANT, sessionId, 10);
    await runner.run({ tenantId: TENANT, runId, sessionId, history, modelId: MODEL });

    // The run is now completed, so a second attempt loses the claim rather than appending.
    const second = await runner.run({ tenantId: TENANT, runId, sessionId, history, modelId: MODEL });
    expect(second).toBeNull();

    const all = await messages.pageBySession(TENANT, sessionId, {});
    const assistants = all.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
  });
});

describe('ChatTurnRunner — the tool loop', () => {
  it('invokes a tool, feeds the result back, and then answers', async () => {
    const { sessionId, runId } = await seedRun();
    const gateway = new ScriptedStreamGateway()
      .tools({ id: 'call_1', name: 'tool_search', args: { q: 'cats' } })
      .text('Found cats');
    const invoker = fakeInvoker();
    const runner = build({ gateway, invoker, hub: fakeHub() });

    const result = await runner.run({
      tenantId: TENANT,
      runId,
      sessionId,
      history: await messages.recentBySession(TENANT, sessionId, 10),
      modelId: MODEL,
    });

    expect(invoker.invocations.map((i) => i.toolId)).toEqual(['tool_search']);
    expect(gateway.requests).toHaveLength(2);

    // The second request must carry the assistant's ask and the tool's result, or the model
    // sees an output it never requested and cannot attach it to anything.
    const second = gateway.requests[1]!;
    const roles = second.messages.map((m) => m.role);
    expect(roles).toContain('assistant');
    expect(roles).toContain('tool');

    const stored = await messages.findById(TENANT, result!.messageId!);
    expect(storedToolCalls(stored)).toHaveLength(1);
    expect(storedToolCalls(stored)[0]).toMatchObject({ name: 'tool_search', ok: true });
  });

  it('feeds a failing tool back to the model instead of aborting the turn', async () => {
    const { sessionId, runId } = await seedRun();
    const gateway = new ScriptedStreamGateway()
      .tools({ id: 'call_1', name: 'tool_broken', args: {} })
      .text('It failed, so I tried something else');
    const invoker = fakeInvoker();
    invoker.failing.add('tool_broken');
    const runner = build({ gateway, invoker, hub: fakeHub() });

    const result = await runner.run({
      tenantId: TENANT,
      runId,
      sessionId,
      history: await messages.recentBySession(TENANT, sessionId, 10),
      modelId: MODEL,
    });

    // The turn completed: the model got to react to the error, which is the point of a loop.
    expect(result?.interrupted).toBe(false);
    expect(gateway.requests).toHaveLength(2);

    const stored = await messages.findById(TENANT, result!.messageId!);
    expect(storedToolCalls(stored)[0]).toMatchObject({ ok: false });
  });

  it('stops at the round bound and says so rather than looping forever', async () => {
    const { sessionId, runId } = await seedRun();
    // The model asks for a tool on every single round.
    const gateway = new ScriptedStreamGateway();
    for (let i = 0; i < 20; i += 1) {
      gateway.tools({ id: `call_${i}`, name: 'tool_search', args: {} });
    }
    const hub = fakeHub();
    const runner = build({ gateway, invoker: fakeInvoker(), hub });

    const result = await runner.run({
      tenantId: TENANT,
      runId,
      sessionId,
      history: await messages.recentBySession(TENANT, sessionId, 10),
      modelId: MODEL,
    });

    // Bounded, and the exhaustion is a reported outcome rather than a silent truncation.
    expect(hub.frames.some((f) => f.name === 'chat.limit.reached')).toBe(true);
    expect(result?.interrupted).toBe(true);
  });
});

describe('ChatTurnRunner — cancellation and failure', () => {
  it('cancels an in-flight turn', async () => {
    const { sessionId, runId } = await seedRun();
    const gate = createGate();

    const gateway = {
      requests: [] as GatewayChatRequest[],
      async *stream() {
        yield { type: 'text', text: 'partial' };
        await gate.wait;
      },
    };

    const hub = fakeHub();
    const runner = new ChatTurnRunner({
      gateway: gateway as never,
      tools: fakeInvoker() as never,
      messages,
      runs,
      hub: hub as never,
      logger: pino({ level: 'silent' }),
    });

    const pending = runner.run({
      tenantId: TENANT,
      runId,
      sessionId,
      history: await messages.recentBySession(TENANT, sessionId, 10),
      modelId: MODEL,
    });

    // Let the generator reach the gate, then abort the way the SSE hub would.
    await new Promise((resolve) => setTimeout(resolve, 5));
    runner.cancel(TENANT, runId);
    gate.open();

    const result = await pending;

    // The partial text the user already watched arrive is kept, and the message says so.
    const stored = await messages.findById(TENANT, result!.messageId!);
    expect(stored?.content).toBe('partial');
    expect(stored?.interrupted).toBe(true);
  });

  it('marks the turn interrupted when the provider closes politely on abort', async () => {
    // The shape that made the first version of the test above fail, kept as its own case
    // because it is the more dangerous one: an aborted stream can end by *returning* rather
    // than throwing, and a generator that returns looks exactly like one that answered. If
    // the runner only checked the signal at the top of a round, this path produced a message
    // marked complete with truncated text.
    const { sessionId, runId } = await seedRun();
    const gate = createGate();

    const gateway = {
      async *stream(): AsyncGenerator<unknown> {
        yield { type: 'text', text: 'half an ans' };
        await gate.wait;
        // Returns normally — no throw. This is what a clean socket close looks like.
      },
    };

    const runner = new ChatTurnRunner({
      gateway: gateway as never,
      tools: fakeInvoker() as never,
      messages,
      runs,
      hub: fakeHub() as never,
      logger: pino({ level: 'silent' }),
    });

    const pending = runner.run({
      tenantId: TENANT,
      runId,
      sessionId,
      history: await messages.recentBySession(TENANT, sessionId, 10),
      modelId: MODEL,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    runner.cancel(TENANT, runId);
    gate.open();

    const result = await pending;

    const stored = await messages.findById(TENANT, result!.messageId!);
    expect(stored?.content).toBe('half an ans');
    expect(stored?.interrupted).toBe(true);

    // And the run is cancelled, not completed — the two must agree with what the user saw.
    const run = await runs.findById(TENANT, runId);
    expect(run?.status).toBe('cancelled');
  });

  it('is a no-op to cancel a run that is not generating', () => {
    const runner = build({
      gateway: new ScriptedStreamGateway(),
      invoker: fakeInvoker(),
      hub: fakeHub(),
    });

    // Must not throw: the hub fires this for any unwatched run, including finished ones.
    expect(() => runner.cancel(TENANT, 'run_that_never_existed')).not.toThrow();
  });

  it('reports a provider failure as frames and marks the run failed', async () => {
    const { sessionId, runId } = await seedRun();
    const gateway = {
      async *stream(): AsyncGenerator<unknown> {
        yield { type: 'text', text: 'par' };
        throw new Error('provider exploded');
      },
    };

    const hub = fakeHub();
    const runner = new ChatTurnRunner({
      gateway: gateway as never,
      tools: fakeInvoker() as never,
      messages,
      runs,
      hub: hub as never,
      logger: pino({ level: 'silent' }),
    });

    const result = await runner.run({
      tenantId: TENANT,
      runId,
      sessionId,
      history: await messages.recentBySession(TENANT, sessionId, 10),
      modelId: MODEL,
    });

    expect(hub.frames.some((f) => f.name === 'chat.error')).toBe(true);
    expect(result?.interrupted).toBe(true);

    const run = await runs.findById(TENANT, runId);
    expect(run?.status).toBe('failed');
  });
});

/**
 * The sink.
 *
 * The runner's frames went to the hub and nowhere else, so `POST /api/chat` — the connection
 * that actually asked for the answer — received nothing until the turn ended. The HTTP-level
 * regression is in `chat-stream.http.test.ts`; what is asserted here is the contract the
 * controller depends on, at the unit boundary where it can be asserted precisely.
 */
describe('ChatTurnRunner — the frame sink', () => {
  it('gives the sink every frame it gives the hub, in the same order', async () => {
    const { sessionId, runId } = await seedRun();
    const gateway = new ScriptedStreamGateway().text('ab');
    const hub = fakeHub();
    const runner = build({ gateway, invoker: fakeInvoker(), hub });

    const sunk: SseFrame[] = [];
    await runner.run({
      tenantId: TENANT,
      runId,
      sessionId,
      history: await messages.recentBySession(TENANT, sessionId, 10),
      modelId: MODEL,
      onFrame: (frame) => sunk.push(frame),
    });

    // Identity, not just a count: two sinks that both fire but disagree about the payload are
    // the same bug in a different costume.
    expect(sunk).toEqual(hub.frames);
    expect(sunk.map((f) => f.name)).toContain('chat.delta');
  });

  it('completes the turn when the sink throws, because the client may have gone', async () => {
    const { sessionId, runId } = await seedRun();
    const runner = build({
      gateway: new ScriptedStreamGateway().text('kept'),
      invoker: fakeInvoker(),
      hub: fakeHub(),
    });

    // What a write to a socket the client already closed does. `res.write` after `end` throws
    // rather than returning false, so this is the realistic failure, not a contrived one.
    const result = await runner.run({
      tenantId: TENANT,
      runId,
      sessionId,
      history: await messages.recentBySession(TENANT, sessionId, 10),
      modelId: MODEL,
      onFrame: () => {
        throw new Error('write after end');
      },
    });

    // The answer is durable even though nobody could be told about it. A turn that stopped
    // generating because a socket closed would make the response, not the database, the record.
    expect(result?.interrupted).toBe(false);
    const stored = await messages.findById(TENANT, result!.messageId!);
    expect(stored?.content).toBe('kept');

    const run = await runs.findById(TENANT, runId);
    expect(run?.status).toBe('completed');
  });

  it('does not consult the fallback chain — the chosen model, or nothing', async () => {
    const { sessionId, runId } = await seedRun();
    const gateway = new ScriptedStreamGateway().text('hi');
    const runner = build({ gateway, invoker: fakeInvoker(), hub: fakeHub() });

    await runner.run({
      tenantId: TENANT,
      runId,
      sessionId,
      history: await messages.recentBySession(TENANT, sessionId, 10),
      modelId: MODEL,
    });

    // The empty array is not "no fallbacks configured" — the gateway reads it as "the caller
    // has decided", which is what stops a substituted model answering in place of the one the
    // user picked. See `streamOnce` for why an empty list and an absent one differ.
    expect(gateway.requests[0]?.fallbackModelIds).toEqual([]);
  });
});
