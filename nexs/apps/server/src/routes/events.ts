import { Router, type RequestHandler } from 'express';
import { createEventSubscriptionSchema, ingestEventSchema, updateEventSubscriptionSchema } from '@nexs/shared';
import type { EventController } from '../controllers/event.controller.js';
import { validateBody } from '../http/middleware/validate.js';

export interface EventsRouterDeps {
  controller: EventController;
  authRequired: RequestHandler;
}

export function createEventsRouter(deps: EventsRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  /**
   * Ingestion. The one write here that is expected to be called by something other than a
   * user — a webhook producer — which is why it returns 202 and reports `deduplicated` in
   * the body: a producer that retries needs to be able to tell "absorbed" from "triggered".
   */
  router.post('/', validateBody(ingestEventSchema), controller.ingest);

  /**
   * Declared **before** `/:id`, and this is not cosmetic.
   *
   * Express matches in declaration order, so a later `GET /:id` would capture
   * `subscriptions` as an event id and every subscription list request would 404 with "the
   * event does not exist". The same trap the notifications router documents for
   * `unread-count`.
   */
  router.get('/subscriptions', controller.listSubscriptions);
  router.post(
    '/subscriptions',
    validateBody(createEventSubscriptionSchema),
    controller.createSubscription,
  );
  router.patch(
    '/subscriptions/:id',
    validateBody(updateEventSubscriptionSchema),
    controller.updateSubscription,
  );
  router.delete('/subscriptions/:id', controller.deleteSubscription);

  router.get('/', controller.list);
  router.get('/:id', controller.get);

  return router;
}
