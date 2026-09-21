import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import type { ChatMessageDto } from '@nexs/shared';
import { createChatRouter } from '../src/routes/chat.js';
import { createChatController } from '../src/controllers/chat.controller.js';
import { ChatTurnRunner } from '../src/services/chat/chat-turn.runner.js';
import { ChatMessageRepository, ChatSessionRepository } from '../src/repositories/chat.repo.js';
import { RunRepository } from '../src/repositories/run.repo.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';
import type { GatewayChatRequest } from '../src/services/gateway/model-gateway.js';
import type { SseFrame } from '@nexs/shared';

/**
 * `POST /api/chat` over a real socket — the generation stream.
 *
 * ## The bug this file exists for
 *
 * Every chat route in this application was double-prefixed for the whole of Phase 8 and no test
 * noticed, because **no test anywhere requested a chat path**. The same shape of gap produced
 * this one: the turn runner published its frames to `SseHub`, the hub delivers to whoever called
 * `hub.attach`, and the only caller of `attach` is `GET /api/stream`. So the POST response — the
 * one the sender is reading — carried `: connected` and nothing else, for the entire turn.
 *
 * Measured on a live server before the fix: a 13-byte body, **zero frames**, on a turn that took
 * 1238 ms. The answer appeared only when the turn ended and the transcript was refetched, which
 * is why it read as "the response is getting too slow". It was never slow inference.
 *
 * ## Why this is not supertest
 *
 * Same reason `stream.http.test.ts` gives: the failure mode lives in the transport. A test that
 * hands the Express app a fake socket cannot tell "the handler wrote four frames" from "the
 * handler wrote one and the socket buffered the rest", and buffering is exactly what the old
 * behaviour looked like. So this starts a real server on an ephemeral port and reads the body
 * with `fetch`, the way a browser does.
 *
 * ## Why the dependencies are stubs but the runner is real
 *
 * The seam that was broken is `chat.controller` → `ChatTurnRunner`. Stubbing `ChatService` and
 * the runner would test nothing; stubbing the *provider* would drag an OpenAI-shaped SSE body in
 * for no benefit. So the gateway is the one hand-written stub — it is a narrow port — and
 * everything from the controller down through the runner, the repositories and the fake database
 * is the real thing.
 */

const TENANT = 'tnt_chat_stream';
const USER = 'usr_chat_stream';
const MODEL = 'mdl_chat_stream';

/** Accumulates a stream's text and lets a test wait for a substring to appear. */
function makeReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    get text(): string {
      return buffer;
    },
    async waitFor(needle: string, timeoutMs = 4_000): Promise<string> {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; body so far: ${buffer}`)),
          timeoutMs,
        );
      });

      const found = async (): Promise<string> => {
        while (!buffer.includes(needle)) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`stream ended before ${JSON.stringify(needle)}`);
          buffer += decoder.decode(chunk.value, { stream: true });
        }
        return buffer;
      };

      return Promise.race([found(), timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    },
  };
}

/**
 * A gateway that stops mid-answer until the test says otherwise.
 *
 * The gate is what makes the regression test decisive rather than probabilistic. A buffered
 * response and a streamed one look identical *after* the turn ends; they differ only while the
 * turn is still running. So the first delta is yielded, then the generator blocks — and a test
 * that can read that delta has proved the bytes left the server before the answer was finished.
 */
function gatedGateway() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  const requests: GatewayChatRequest[] = [];
  return {
    requests,
    open,
    async *stream(request: GatewayChatRequest): AsyncGenerator<unknown> {
      requests.push(request);
      yield { type: 'text', text: 'Hel' };
      await gate;
      yield { type: 'text', text: 'lo' };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

/** A gateway that fails after one delta, so the failure has to become a frame. */
function failingGateway() {
  return {
    async *stream(): AsyncGenerator<unknown> {
      yield { type: 'text', text: 'par' };
      throw new Error('provider exploded');
    },
  };
}

interface Ctx {
  server: Server;
  port: number;
  fake: FakeDb;
  messages: ChatMessageRepository;
  hubFrames: SseFrame[];
  sessionId: string;
  abort: AbortController;
  open(): void;
}

async function build(options: { gateway: ReturnType<typeof gatedGateway> | ReturnType<typeof failingGateway> }): Promise<Ctx> {
  const fake = createFakeDb();
  const at = new Date('2026-01-01T00:00:00.000Z');
  fake.tenants.push({ id: TENANT, name: 'Chat Stream', createdAt: at, updatedAt: at });

  const sessions = new ChatSessionRepository(fake.client);
  const messages = new ChatMessageRepository(fake.client);
  const runs = new RunRepository(fake.client);

  const session = await sessions.create({ tenantId: TENANT, userId: USER, agentId: null, title: null });
  const run = await runs.create({ tenantId: TENANT, kind: 'chat', agentId: null, input: {} });

  // The hub is a sink here, not a subject: `chat-turn.runner.test.ts` owns the fan-out contract.
  // It is still recorded, so this file can assert both sinks fired for the same frame.
  const hubFrames: SseFrame[] = [];
  const hub = {
    publish(frame: SseFrame) {
      hubFrames.push(frame);
    },
  };

  const runner = new ChatTurnRunner({
    gateway: options.gateway as never,
    tools: { invoke: async () => ({ ok: true, result: {} }) } as never,
    messages,
    runs,
    hub: hub as never,
    logger: pino({ level: 'silent' }),
  });

  const userMessage: ChatMessageDto = {
    id: 'msg_stub',
    sessionId: session.id,
    runId: run.id,
    role: 'user',
    content: 'hi',
    toolCalls: [],
    attachmentIds: [],
    interrupted: false,
    createdAt: at.toISOString(),
  };

  const controller = createChatController({
    chat: {
      // The pre-stream half, which has its own suite. What matters here is that it resolves
      // before a byte is written, so the ids the frames carry are real rows.
      prepareTurn: async (tenantId: string, sessionId: string) => ({
        tenantId,
        runId: run.id,
        sessionId,
        modelId: MODEL,
        history: await messages.recentBySession(tenantId, sessionId, 10),
        userMessage,
      }),
    } as never,
    runner,
    hub: hub as never,
    mentions: {} as never,
    // Never reached: `SlashCommandService.isCommand('hi')` is false, so the controller goes
    // straight to `prepareTurn`. A stub that threw would make that assumption visible.
    commands: {
      run: () => {
        throw new Error('the command path should not have been reached');
      },
    } as never,
  });

  /**
   * Authentication, stubbed down to the one field the handlers read.
   *
   * `createAuthRequired` needs a user table and a token service, and neither is what this file
   * is about. What matters is that `req.auth` is set, because `requireAuth` fails closed without
   * it — so a route mounted without the middleware still produces a 401 here, not a silent pass.
   */
  const authRequired: RequestHandler = (req, _res, next) => {
    req.auth = { userId: USER, tenantId: TENANT, tokenVersion: 1 };
    next();
  };

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/chat',
    createChatRouter({ controller, authRequired, rateLimitPerMinute: 10_000 }),
  );
  // A JSON error handler, so a wiring mistake surfaces as a readable body rather than an
  // Express HTML stack trace that a failing assertion would have to be decoded by eye.
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    res.status(500).json({ error: { message: err instanceof Error ? err.message : String(err) } });
  };
  app.use(onError);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));

  return {
    server,
    port: (server.address() as AddressInfo).port,
    fake,
    messages,
    hubFrames,
    sessionId: session.id,
    abort: new AbortController(),
    open: 'open' in options.gateway ? options.gateway.open : () => undefined,
  };
}

async function close(ctx: Ctx): Promise<void> {
  ctx.abort.abort();
  ctx.server.closeAllConnections?.();
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
}

/** One turn, sent the way the web client sends it: the session in the query, the turn in the body. */
function send(ctx: Ctx, content = 'hi'): Promise<Response> {
  return fetch(`http://127.0.0.1:${ctx.port}/api/chat?sessionId=${ctx.sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, modelId: MODEL }),
    signal: ctx.abort.signal,
  });
}

describe('POST /api/chat — the response is the stream', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await build({ gateway: gatedGateway() });
  });

  afterEach(async () => {
    await close(ctx);
  });

  it('opens with the headers that make streaming actually work', async () => {
    const res = await send(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // Without `no-transform`, a proxy is free to gzip the stream and hold it until a full block
    // accumulates — the classic "all the deltas arrive at once, at the end" bug.
    expect(res.headers.get('cache-control')).toContain('no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    ctx.open();
    await makeReader(res).waitFor('chat.completed');
  });

  it('writes deltas to the POST response while the turn is still running', async () => {
    const res = await send(ctx);
    const reader = makeReader(res);

    // THE REGRESSION. The gateway is blocked after its first delta, so this can only resolve if
    // the frame was written to *this* response before the turn finished. Against the old code
    // the body was `: connected\n\n` and this `waitFor` timed out with a 13-byte body.
    await reader.waitFor('"delta":"Hel"');
    await reader.waitFor('chat.started');

    // Now let the answer finish, and confirm the rest arrives on the same connection.
    ctx.open();
    const body = await reader.waitFor('chat.completed');

    expect(body).toContain('"delta":"lo"');
    // A frame is `event:` + `data:` because it is encoded by `encodeSseFrame` — the same
    // function the hub uses. A second hand-rolled encoder is what let the two paths drift.
    expect(body).toContain('event: chat.delta');
  });

  it('publishes the same frames to the hub, so a second watcher sees the turn', async () => {
    const res = await send(ctx);
    const reader = makeReader(res);

    await reader.waitFor('"delta":"Hel"');
    ctx.open();
    await reader.waitFor('chat.completed');

    // Both sinks carry the same frames. The hub is not a substitute for the response — that
    // belief is what caused the bug — but losing it would break every other tab.
    const names = ctx.hubFrames.map((f) => f.name);
    expect(names).toContain('chat.started');
    expect(names).toContain('chat.delta');
    expect(names).toContain('chat.completed');
  });

  it('leaves a durable assistant message that agrees with what was streamed', async () => {
    const res = await send(ctx);
    const reader = makeReader(res);

    await reader.waitFor('"delta":"Hel"');
    ctx.open();
    await reader.waitFor('chat.completed');

    const page = await ctx.messages.pageBySession(TENANT, ctx.sessionId, {});
    const assistant = page.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('Hello');
    expect(assistant?.interrupted).toBe(false);
  });
});

describe('POST /api/chat — a failure after the headers are flushed', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await build({ gateway: failingGateway() });
  });

  afterEach(async () => {
    await close(ctx);
  });

  it('reports a provider failure as a chat.error frame on the same response', async () => {
    const res = await send(ctx);

    // There is no status code left once the stream is open, so the failure has to be a frame —
    // and it has to reach the *sender*, not only the hub. Before the sink existed this error
    // went to a hub with no subscriber and the sender's stream simply ended in silence.
    expect(res.status).toBe(200);

    const body = await makeReader(res).waitFor('chat.error');
    expect(body).toContain('provider exploded');
    expect(body).toContain('"delta":"par"');
  });
});
