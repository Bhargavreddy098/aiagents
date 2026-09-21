import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { encodeSseFrame, type AuthContext } from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery } from '../http/middleware/validate.js';
import type { SseHub } from '../services/sse/sse-hub.js';
import type { NotificationService } from '../services/notifications/notification.service.js';
import type { Logger } from '../logger.js';

/**
 * `GET /api/stream` — the live tail.
 *
 * ## The reconnect contract this endpoint implements
 *
 * There is no server-side replay *buffer* — no ring of recent frames keyed by event id, and
 * `Last-Event-ID` is not honoured (see `sse-hub.ts` for why that stays optional). The contract
 * is therefore: **on reconnect, refetch via REST, then resume the stream.** That only works
 * because every streamed frame is an *echo of state that is already durable* — a
 * `chat.completed` names a message id that is already in Postgres, a `run.failed` names a run
 * row that already reads `failed`. A client that misses frames loses nothing it cannot
 * re-read; it only loses the animation.
 *
 * The consequence is a rule worth stating plainly, because violating it is silent: **never
 * emit a frame that is the only record of something.** If a fact exists solely in a frame,
 * a disconnect destroys it, and the refetch contract cannot recover it.
 *
 * ## The one exception to "no replay", and why it is not a buffer
 *
 * The spec's §3.1 rule is *"on connect, the hub replays unread `Notification` rows as
 * `notification.created` frames"*, and that is a different thing from a frame buffer: it
 * replays **rows**, re-read from the database at connect time, not frames captured in memory.
 * Nothing is retained, nothing expires, and a server that restarted a second ago can still
 * replay — which a ring buffer could not.
 *
 * It exists because a notification is the one frame whose *absence* is invisible. Every other
 * frame is an echo of a page the client is about to load anyway; a missed `notification.created`
 * leaves a stale unread badge until something else prompts a refetch, and "you were asked to
 * approve something four hours ago" is exactly the fact that must not be silently lost.
 */

/**
 * `runId` is optional: absent means "everything this tenant emits".
 *
 * Unknown query parameters are permitted, unlike the run-filter schema which is `.strict()`.
 * The reason for strictness there does not apply here — a dropped *filter* makes a client
 * believe it is seeing a subset when it is seeing everything, whereas an unknown parameter on
 * a stream can only be a cache-buster, which is a normal thing for an `EventSource` client to
 * add. Refusing it would break reconnects for no gain.
 *
 * `token` is not declared here even though the route accepts it, because the route promotes it
 * into the `Authorization` header and rewrites it out of the URL before this schema ever sees
 * the query — see `routes/stream.ts`.
 */
const openStreamSchema = z.object({
  runId: z.string().min(1).optional(),
});

/** Sent before anything else so the client's `open` handler fires without waiting a heartbeat. */
const CONNECTED_COMMENT = ': connected\n\n';

/**
 * How many unread notifications a connect replays.
 *
 * A bound rather than "all of them", and the bound is safe precisely because of the contract
 * above: the replay is a nudge for the badge, while the authoritative list is the REST
 * refetch. A user with more unread notifications than this still gets a correct list — they
 * just do not get every id pushed down a socket they have not finished opening.
 */
export const STREAM_REPLAY_MAX_NOTIFICATIONS = 50;

export interface StreamControllerDeps {
  hub: SseHub;
  /**
   * The source of the connect-time replay.
   *
   * A service rather than the repository, because the controller's job here is to ask "what
   * has this user not read" and not to know how notifications are stored — and because the
   * user-scoping this needs is the service's existing contract, not a predicate re-derived
   * here and liable to drift from it.
   */
  notifications: NotificationService;
  /** Mints the `id:` on a replayed frame. Injectable so a test can assert exact bytes. */
  newEventId?: () => string;
  logger: Logger;
}

export interface StreamController {
  open: RequestHandler;
}

/**
 * The source address used for the per-address connection cap.
 *
 * Falls back rather than returning `undefined`: a shared `undefined` key would put every
 * client on the server in one bucket, so the cap would trip after N connections *globally* —
 * the opposite of what a per-IP limit is for.
 */
function sourceIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function createStreamController(deps: StreamControllerDeps): StreamController {
  const newEventId = deps.newEventId ?? randomUUID;

  /**
   * Write the connecting user's unread notifications, oldest first.
   *
   * **Scoped to the connecting user, not to the tenant.** A tenant-wide replay would tell one
   * member how much unread mail another member has, and — because the frame names a
   * notification id — would hand them a key to a row `NotificationRepository.findById` will
   * then refuse. The narrower scope is the only correct one; it is also the cheaper query,
   * because `(tenantId, userId, readAt)` is the index this table has.
   *
   * **Written after `attach`, never before.** A frame published between the read and the
   * attach would be lost if the replay came first; arriving after means the worst case is a
   * frame that appears out of order, which a client can sort because every frame carries the
   * id of a row it can re-read. Losing a notification is permanent; reordering one is not.
   *
   * **Oldest first, so the batch reads chronologically** — the live frames that follow are
   * newer than all of these, and a feed that jumps backwards after the first few lines looks
   * like a bug in the client.
   *
   * A failed replay is logged and swallowed. The connection is still perfectly usable, and
   * the client's REST refetch is the documented fallback, so tearing down a working stream
   * over a failed convenience would be the wrong trade.
   */
  async function replayUnread(
    tenantId: string,
    userId: string,
    write: (chunk: string) => void,
    isClosed: () => boolean,
  ): Promise<void> {
    try {
      const { notifications } = await deps.notifications.list(tenantId, userId, {
        unreadOnly: true,
        limit: STREAM_REPLAY_MAX_NOTIFICATIONS,
      });

      // `list` returns newest first, which is right for a feed and wrong for a replay.
      for (const notification of [...notifications].reverse()) {
        if (isClosed()) return;
        write(
          encodeSseFrame(
            'notification.created',
            { notificationId: notification.id },
            newEventId(),
          ),
        );
      }
    } catch (err) {
      deps.logger.warn({ err, userId }, 'unread-notification replay failed');
    }
  }

  return {
    open: (req, res, next) => {
      let handle;
      let principal: AuthContext | undefined;
      try {
        const auth = requireAuth(req);
        principal = auth;
        // Parsed before any header is written, so a bad `runId` is still an ordinary JSON 400.
        // Once the response is `text/event-stream` there is no status code left to send — the
        // client is already committed to reading frames.
        const query = parseQuery(openStreamSchema, req);

        // Attached before the headers are flushed, which is what lets the connection cap be a
        // real 429. If this ran after `flushHeaders()`, the only thing left to do with an
        // over-cap client would be to open a stream and immediately close it — a 200 followed
        // by a mystery.
        handle = deps.hub.attach(
          {
            tenantId: auth.tenantId,
            userId: auth.userId,
            ip: sourceIp(req),
            runId: query.runId ?? null,
          },
          {
            write: (chunk) => {
              res.write(chunk);
            },
            end: () => {
              res.end();
            },
          },
        );
      } catch (err) {
        next(err);
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      // `no-transform` is the load-bearing half: without it a proxy is free to gzip the
      // stream, and a compressed stream is buffered until the compressor has a full block —
      // which is exactly the "deltas all arrive in one lump at the end" bug.
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // nginx-specific, and the one header that makes streaming work behind it.
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // A long-lived response must not be reaped by the server's own socket timeout. Node's
      // `server.timeout` is already 0, but `res.setTimeout` is the per-response guarantee and
      // costs nothing to state.
      res.setTimeout(0);
      res.socket?.setNoDelay(true);

      res.write(CONNECTED_COMMENT);

      let closed = false;

      // `close` fires on both a clean `res.end` and a client that vanishes. Detaching is
      // idempotent, so this and the hub's own write-guard cannot double-count — which matters
      // because the detach is also what fires `onRunUnwatched` for a chat run.
      res.on('close', () => {
        closed = true;
        handle.detach();
      });

      // Always defined when control reaches here: the `try` above returns on any throw and
      // `requireAuth` is its first statement. The guard is what keeps the compiler from having
      // to know that, rather than an assertion that could be wrong at runtime.
      if (principal !== undefined) {
        void replayUnread(
          principal.tenantId,
          principal.userId,
          (chunk) => {
            if (closed) return;
            try {
              res.write(chunk);
            } catch (err) {
              deps.logger.warn({ err }, 'unread-notification replay write failed; dropping client');
              handle.detach();
            }
          },
          () => closed,
        );
      }

      // Deliberately no `next()`: the response stays open for the life of the connection, and
      // Express's chain must not advance past a handler that is still writing.
    },
  };
}
