import type { RequestHandler } from 'express';
import { z } from 'zod';
import {
  ApiError,
  createChatSessionSchema,
  encodeSseFrame,
  listChatMessagesSchema,
  listChatSessionsSchema,
  listMentionsSchema,
  sendChatMessageSchema,
  updateChatSessionSchema,
  type ChatMessageDto,
  type SseFrame,
} from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { ChatService } from '../services/chat/chat.service.js';
import type { ChatTurnRunner } from '../services/chat/chat-turn.runner.js';
import type { MentionResolver } from '../services/chat/mention.resolver.js';
import { SlashCommandService } from '../services/chat/slash-command.service.js';
import type { SseHub } from '../services/sse/sse-hub.js';

/**
 * `/api/chat` — sessions, history, and the generation stream.
 *
 * ## Why the generation endpoint is a POST that answers with `text/event-stream`
 *
 * `EventSource` can only GET, so the streaming endpoint cannot be `EventSource`-shaped: the
 * message body has to be sent, and a GET would put a 32,000-character prompt in a query
 * string. So the client POSTs and reads the response body as a stream (fetch + `ReadableStream`),
 * which means this handler does not use `SseHub.attach` — that registry exists for the
 * long-lived per-tenant `GET /api/stream` tail.
 *
 * ## The response is a sink, and that is the whole point of the endpoint
 *
 * The turn's frames are written **to this response**, by passing the runner an `onFrame` sink
 * that encodes each frame with `encodeSseFrame` — the same function the hub uses, so a frame
 * arriving here is validated exactly as one arriving over `GET /api/stream`. They are *also*
 * published to the hub by the runner, so a second tab watching `GET /api/stream?runId=…` sees
 * the same frames the sender sees.
 *
 * This was the bug, and it was invisible because it looked like a design. The runner published
 * to the hub; the only caller of `hub.attach` is `stream.controller.ts`; so this response
 * carried `: connected` and nothing else, and the answer appeared only when the turn ended and
 * the transcript was refetched. Measured on a live turn: a 13-byte body, zero frames, and a
 * 1.2-second wait that looked like slow inference. It was never inference.
 *
 * ## The ordering, which is the whole design
 *
 * The user message and the run are persisted **before a single byte of the response is
 * written**, by `ChatService.sendMessage`. Only then are the SSE headers flushed. This is what
 * makes a mid-response disconnect recoverable: whatever happens to the connection, the question
 * is already durable and the client can refetch it. Reversing these two — flushing first for
 * lower latency — would create a window where a client sees a 200 and a stream, dies, and finds
 * nothing to resume from.
 *
 * A validation failure is therefore an ordinary JSON 400, because it happens before the
 * response is committed. Once the headers are flushed there is no status code left, so every
 * later failure becomes a `chat.error` frame — see the runner, which owns that half.
 */

/**
 * The generation stream's query parameters.
 *
 * `modelId` is deliberately *not* here even though `sendMessage` accepts one: it belongs to the
 * turn being created, and the body is where the turn lives. Accepting it in both places would
 * mean two sources for one value.
 *
 * `sessionId` is optional because §3.5's `chatMessageSchema` carries the session in `context`
 * for clients that keep one there, and a client with no conversation yet has nothing to name.
 * When it is absent a session is created on the spot — see `send`.
 */
const generateStreamSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
});

/**
 * Where a session id can arrive, in precedence order: the path, then the query.
 *
 * One helper because four handlers need the same answer, and because the two spellings are
 * the same read — the nested route exists so a rendering client can put the session in the
 * path, and the flat route so the spec's `/api/chat/messages?sessionId=…` works.
 */
function sessionIdFrom(req: Parameters<RequestHandler>[0]): string | undefined {
  const fromPath = req.params.sessionId;
  if (typeof fromPath === 'string' && fromPath.length > 0) return fromPath;
  return parseQuery(generateStreamSchema, req).sessionId;
}

export interface ChatControllerDeps {
  chat: ChatService;
  runner: ChatTurnRunner;
  hub: SseHub;
  mentions: MentionResolver;
  /** Answers `/`-prefixed turns without reaching the model (§PHASE-8.3). */
  commands: SlashCommandService;
}

export interface ChatController {
  listSessions: RequestHandler;
  createSession: RequestHandler;
  getSession: RequestHandler;
  renameSession: RequestHandler;
  deleteSession: RequestHandler;
  listMessages: RequestHandler;
  /** `@` autocomplete (§3.9). */
  listMentions: RequestHandler;
  send: RequestHandler;
}

export function createChatController(deps: ChatControllerDeps): ChatController {
  return {
    listSessions: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ data: await deps.chat.listSessions(tenantId, parseQuery(listChatSessionsSchema, req)) });
      } catch (err) {
        next(err);
      }
    },

    createSession: async (req, res, next) => {
      try {
        const auth = requireAuth(req);
        const session = await deps.chat.createSession(
          auth.tenantId,
          auth.userId,
          // Already parsed and replaced by `validateBody` on the route.
          req.body as z.infer<typeof createChatSessionSchema>,
        );
        res.status(201).json({ session });
      } catch (err) {
        next(err);
      }
    },

    getSession: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res
          .status(200)
          .json(await deps.chat.getSession(tenantId, pathParam(req, 'id'), parseQuery(listChatMessagesSchema, req)));
      } catch (err) {
        next(err);
      }
    },

    renameSession: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const { title } = req.body as z.infer<typeof updateChatSessionSchema>;
        res.status(200).json({ session: await deps.chat.renameSession(tenantId, pathParam(req, 'id'), title) });
      } catch (err) {
        next(err);
      }
    },

    deleteSession: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        await deps.chat.deleteSession(tenantId, pathParam(req, 'id'));
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },

    /**
     * A session's messages, newest first.
     *
     * Session-scoped rather than run-scoped, because the conversation is what the UI renders —
     * a run is an implementation detail of one turn within it.
     */
    listMessages: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const sessionId = sessionIdFrom(req);
        if (sessionId === undefined) {
          throw new ApiError('VALIDATION_ERROR', 'A session id is required', {
            field: 'sessionId',
          });
        }

        const detail = await deps.chat.getSession(
          tenantId,
          sessionId,
          parseQuery(listChatMessagesSchema, req),
        );
        res.status(200).json({ data: detail.messages, hasMore: detail.hasMore });
      } catch (err) {
        next(err);
      }
    },

    /**
     * `GET /api/chat/mentions?q=…&kind=…` — the `@` picker's data source (§3.9).
     *
     * Every entry is a live row: an agent the user has, a model they have enabled, a run that
     * really exists. The alternative — a static list of "things you might mention" — would
     * offer tokens that resolve to nothing, which is exactly the bug this endpoint exists to
     * make impossible.
     */
    listMentions: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json(await deps.mentions.resolve(tenantId, parseQuery(listMentionsSchema, req)));
      } catch (err) {
        next(err);
      }
    },

    send: async (req, res, next) => {
      let prepared;
      /** Set when the body was a slash command, which is answered without generating. */
      let command: {
        sessionId: string;
        userMessage: ChatMessageDto;
        assistantMessage: ChatMessageDto;
      } | null = null;
      try {
        const auth = requireAuth(req);
        const body = req.body as z.infer<typeof sendChatMessageSchema>;
        const sessionId = sessionIdFrom(req);

        // A turn with no session opens one, which is what lets a client send its first message
        // without a separate round-trip. The session is created here, inside the try, so a
        // failure to create it is still an ordinary 4xx rather than a half-open stream.
        const opened =
          sessionId === undefined
            ? await deps.chat.createSession(auth.tenantId, auth.userId, {})
            : null;
        const turnSessionId = opened?.id ?? sessionId;

        // `turnSessionId` is `string` here: `opened` is null only when `sessionId` was defined.
        // Asserted through a guard rather than a cast so the invariant is visible and checked.
        if (turnSessionId === undefined) {
          throw new Error('unreachable: a session was neither supplied nor created');
        }

        // §PHASE-8.2: `parse → slash command? handler : …`. A command is answered by the
        // server and never reaches the model — no provider call, no run. This happens before
        // `prepareTurn` so a command cannot create a run it would then have to abandon.
        if (SlashCommandService.isCommand(body.content)) {
          const outcome = await deps.commands.run(
            { tenantId: auth.tenantId, userId: auth.userId, sessionId: turnSessionId },
            body.content,
          );

          if (outcome !== null) {
            const recorded = await deps.chat.recordCommand(auth.tenantId, turnSessionId, {
              userText: body.content,
              reply: outcome.reply,
            });
            command = { sessionId: turnSessionId, ...recorded };
          }
        }

        // Everything that can be a 400 happens here, before the response is committed. The
        // user message and run are durable the moment this resolves.
        if (command === null) {
          prepared = await deps.chat.prepareTurn(auth.tenantId, turnSessionId, body);
        }
      } catch (err) {
        next(err);
        return;
      }

      // A command is a complete answer that already exists. It is flushed as one frame on the
      // same stream shape as a generation, so the client renders both identically rather than
      // needing a second code path — and it is flushed *after* the persistence above, so the
      // ids in the frames are real rows.
      if (command !== null) {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        res.write(`: connected\n\n`);
        try {
          // The reply first, then the frame that closes the turn. `chat.completed` names the
          // message as final — a delta arriving after it would be text the client has already
          // been told there is no more of. For a command the whole reply is one delta, because
          // it was never generated incrementally.
          res.write(
            encodeSseFrame('chat.delta', {
              runId: command.userMessage.id,
              delta: command.assistantMessage.content,
            }),
          );
          res.write(
            encodeSseFrame('chat.completed', {
              runId: command.userMessage.id,
              messageId: command.assistantMessage.id,
            }),
          );
        } finally {
          if (!res.writableEnded) res.end();
        }
        return;
      }

      // Past this point there is no status code left, so failures become frames. Reaching here
      // with no `prepared` would mean the branch above neither answered a command nor built a
      // turn — a programming error, not a request error, so it fails loudly rather than
      // streaming an empty response.
      if (prepared === undefined) {
        next(new Error('unreachable: a chat turn was neither prepared nor answered by a command'));
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      // `no-transform` is load-bearing: without it a proxy may gzip the stream and buffer it
      // until a full block accumulates, which is the "all deltas arrive at once at the end" bug.
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.setTimeout(0);
      res.socket?.setNoDelay(true);

      // The created turn, sent as the first frame so the client has the ids it needs to render
      // optimistically and to attach the following frames to.
      res.write(`: connected\n\n`);

      const abort = new AbortController();
      res.on('close', () => {
        // Fires on a clean end and on a client that vanished. Aborting here is what makes the
        // provider fetch stop rather than generate into a socket nobody reads (gap #21).
        abort.abort();
      });

      /**
       * The sink that makes this response a stream rather than a placeholder.
       *
       * `writableEnded` is checked rather than relying on `write` to throw: a frame can be
       * emitted from a timer after the client disconnected and the handler already ended the
       * response, and `write` on an ended response raises `ERR_STREAM_WRITE_AFTER_END` — which
       * the runner would log as a warning on every frame of a turn nobody is watching. The
       * guard turns that into the one thing it actually is: a frame with nowhere to go.
       */
      const onFrame = (streamFrame: SseFrame): void => {
        if (res.writableEnded || res.destroyed) return;
        res.write(encodeSseFrame(streamFrame.name, streamFrame.payload));
      };

      try {
        await deps.runner.run({
          tenantId: prepared.tenantId,
          runId: prepared.runId,
          sessionId: prepared.sessionId,
          history: prepared.history,
          ...(prepared.instructions === undefined ? {} : { instructions: prepared.instructions }),
          modelId: prepared.modelId,
          ...(prepared.toolDefinitions === undefined ? {} : { toolDefinitions: prepared.toolDefinitions }),
          signal: abort.signal,
          onFrame,
        });
      } catch (err) {
        // The runner reports its own failures as frames; reaching here means something outside
        // its contract broke, and the client must not be left with a stream that never ends.
        req.log?.error({ err }, 'chat stream handler failed');
      } finally {
        if (!res.writableEnded) res.end();
      }

      // Deliberately no `next()`: the response was written by hand and the Express chain must
      // not advance past a handler that owned the socket.
    },
  };
}
