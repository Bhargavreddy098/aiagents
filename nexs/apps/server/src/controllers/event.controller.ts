import type { RequestHandler } from 'express';
import { listEventsSchema, listEventSubscriptionsSchema } from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { EventService } from '../services/events/event.service.js';

/**
 * `/api/events` and `/api/events/subscriptions`. Thin: authenticate, delegate, serialise.
 *
 * ## Why ingest is a `POST` on the collection rather than a separate `/webhooks` path
 *
 * The spec names `POST /api/events` as the ingestion point, and it is the same endpoint for
 * a webhook and for anything else that wants to raise a signal. A second path would mean two
 * entry points with two sets of validation that must stay in step, for no gain — the
 * dedupe, matching and marking are identical either way.
 *
 * ## Why the subscription routes are nested under `/events`
 *
 * A subscription is meaningless without a topic that events carry. Nesting it says so, and
 * it keeps the auth story to one router: everything under `/api/events` is tenant-scoped
 * behind the same middleware.
 */
export interface EventControllerDeps {
  events: EventService;
}

export interface EventController {
  ingest: RequestHandler;
  list: RequestHandler;
  get: RequestHandler;
  listSubscriptions: RequestHandler;
  createSubscription: RequestHandler;
  updateSubscription: RequestHandler;
  deleteSubscription: RequestHandler;
}

export function createEventController(deps: EventControllerDeps): EventController {
  return {
    ingest: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const result = await deps.events.ingest(tenantId, req.body as never);
        // 202, not 201: the event is stored and the matcher has run, but the *effect* is a
        // run that executes later in a worker. 201 would claim a resource was created and
        // ready, which is not what the caller can rely on.
        res.status(202).json(result);
      } catch (err) {
        next(err);
      }
    },

    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json(await deps.events.list(tenantId, parseQuery(listEventsSchema, req)));
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json(await deps.events.get(tenantId, pathParam(req, 'id')));
      } catch (err) {
        next(err);
      }
    },

    listSubscriptions: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res
          .status(200)
          .json(
            await deps.events.listSubscriptions(
              tenantId,
              parseQuery(listEventSubscriptionsSchema, req),
            ),
          );
      } catch (err) {
        next(err);
      }
    },

    createSubscription: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(201).json(await deps.events.createSubscription(tenantId, req.body as never));
      } catch (err) {
        next(err);
      }
    },

    updateSubscription: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res
          .status(200)
          .json(
            await deps.events.updateSubscription(
              tenantId,
              pathParam(req, 'id'),
              req.body as never,
            ),
          );
      } catch (err) {
        next(err);
      }
    },

    deleteSubscription: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        await deps.events.deleteSubscription(tenantId, pathParam(req, 'id'));
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  };
}
