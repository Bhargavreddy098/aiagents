import { Router, type RequestHandler } from 'express';
import {
  createChatSessionSchema,
  sendChatMessageSchema,
  updateChatSessionSchema,
} from '@nexs/shared';
import { validateBody } from '../http/middleware/validate.js';
import { createRateLimiter, userKey } from '../http/middleware/rate-limit.js';
import type { ChatController } from '../controllers/chat.controller.js';

export interface ChatRouterDeps {
  controller: ChatController;
  authRequired: RequestHandler;
  /** §2.6: `/api/chat*` is limited per user, not per IP. */
  rateLimitPerMinute: number;
}

export function createChatRouter(deps: ChatRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  // Authenticate first, then limit *by the identity that was just established*. Reversing
  // these would key every request to its IP, which is the per-IP budget the spec explicitly
  // does not want here.
  router.use(deps.authRequired);
  router.use(createRateLimiter(deps.rateLimitPerMinute, { keyGenerator: userKey }));

  /**
   * The generation stream — `POST /api/chat`, per §PHASE-8.1.
   *
   * ## Why these paths carry no `/chat`
   *
   * Every router in this application is mounted under its own prefix in `app.ts`, and declares its
   * routes **relative to it**: `agents.ts` declares `/` and `/:id`, not `/agents/:id`. This router
   * is mounted at `/api/chat`, so a route declared `/chat/sessions` resolves to
   * `/api/chat/chat/sessions` — and the documented `/api/chat/sessions` resolves to nothing.
   *
   * That is what this file did until the Phase 14 security pass, and it went unnoticed for the
   * whole of Phase 8 because no test anywhere requested a chat path: the service tests call
   * `ChatService` directly and the HTTP tests cover other surfaces. It was found by the credential
   * scan, which enumerates the routes the application actually mounts — the double prefix is
   * visible in that enumeration and invisible everywhere else. Every chat endpoint answered 404 at
   * its documented path, which is the shape of breakage Phase 13 would have hit first.
   *
   * `POST` because it starts work and carries a body; it answers with an event stream, which
   * is unusual for a POST but is the only option when the payload is too large to be a query
   * string and `EventSource` can only issue a GET.
   */
  router.post('/', validateBody(sendChatMessageSchema), controller.send);

  /**
   * The session list, and opening a new conversation.
   *
   * `POST /api/chat/sessions` with no body is how the UI opens an ad-hoc conversation before
   * any message exists, which is why the body is optional. A client that would rather not
   * pre-create can omit `sessionId` on `POST /api/chat` instead and get one back.
   */
  router.get('/sessions', controller.listSessions);
  router.post('/sessions', validateBody(createChatSessionSchema), controller.createSession);
  router.get('/sessions/:id', controller.getSession);
  router.patch('/sessions/:id', validateBody(updateChatSessionSchema), controller.renameSession);
  router.delete('/sessions/:id', controller.deleteSession);

  /**
   * `GET /api/chat/messages` — the spec's own path for history (§PHASE-8.4).
   *
   * The session-scoped variant below is the same read with the session in the path; this one
   * takes it as a query parameter and is the shape the spec names. Both are kept because the
   * spec's table is the contract and the nested form is what a rendering client wants — they
   * call the same service method, so they cannot drift.
   */
  router.get('/messages', controller.listMessages);
  router.get('/sessions/:sessionId/messages', controller.listMessages);

  /**
   * `GET /api/chat/mentions` — the `@` picker (§3.9).
   *
   * Declared last because it shares no prefix with a parameterised route, so its position is a
   * matter of reading order rather than matching: no `/:something` route exists at this level
   * that could capture `mentions`.
   */
  router.get('/mentions', controller.listMentions);

  return router;
}
