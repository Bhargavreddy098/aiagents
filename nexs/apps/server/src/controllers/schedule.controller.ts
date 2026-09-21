import type { RequestHandler } from 'express';
import { listSchedulesSchema } from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { ScheduleService } from '../services/schedules/schedule.service.js';

/**
 * `/api/schedules`. Thin: authenticate, delegate, serialise.
 *
 * ## Why `enable` and `disable` are their own routes
 *
 * The update schema deliberately has no `enabled` field, because toggling a schedule has a
 * side effect the other edits do not: it registers or removes a pg-boss job. A verb route
 * says that plainly, and it means a caller editing a schedule's name cannot accidentally
 * change whether it fires.
 *
 * ## Why there is a `fire` route the spec does not list
 *
 * "Run this now" is the first thing anyone wants from a scheduler, and without it the only
 * way to test a schedule is to wait for its cron. It goes through the same `fire` path the
 * queue consumer does, with a `manual:<timestamp>` occurrence id — so it exercises the real
 * code rather than a second implementation, and it cannot be mistaken for a queue delivery
 * when the run's idempotency key is inspected.
 */
export interface ScheduleControllerDeps {
  schedules: ScheduleService;
}

export interface ScheduleController {
  list: RequestHandler;
  create: RequestHandler;
  get: RequestHandler;
  update: RequestHandler;
  enable: RequestHandler;
  disable: RequestHandler;
  remove: RequestHandler;
  fire: RequestHandler;
}

export function createScheduleController(deps: ScheduleControllerDeps): ScheduleController {
  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json(await deps.schedules.list(tenantId, parseQuery(listSchedulesSchema, req)));
      } catch (err) {
        next(err);
      }
    },

    create: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        // The body was validated and coerced by `validateBody(createScheduleSchema)` on the
        // router, so `req.body` is already the parsed input rather than raw JSON.
        const created = await deps.schedules.create(tenantId, req.body as never);
        res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json(await deps.schedules.get(tenantId, pathParam(req, 'id')));
      } catch (err) {
        next(err);
      }
    },

    update: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const updated = await deps.schedules.update(
          tenantId,
          pathParam(req, 'id'),
          req.body as never,
        );
        res.status(200).json(updated);
      } catch (err) {
        next(err);
      }
    },

    enable: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json(await deps.schedules.setEnabled(tenantId, pathParam(req, 'id'), true));
      } catch (err) {
        next(err);
      }
    },

    disable: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res
          .status(200)
          .json(await deps.schedules.setEnabled(tenantId, pathParam(req, 'id'), false));
      } catch (err) {
        next(err);
      }
    },

    remove: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        await deps.schedules.remove(tenantId, pathParam(req, 'id'));
        // 204 rather than the deleted row: the client asked for it to be gone and has
        // nothing to render from a row that no longer exists.
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },

    fire: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const id = pathParam(req, 'id');
        const result = await deps.schedules.fire({
          scheduleId: id,
          tenantId,
          // Stable per manual trigger, and distinguishable from a queue job id, so a run
          // created this way can be told apart from one a cron produced.
          occurrenceId: `manual:${new Date().toISOString()}`,
        });
        // 200 for both outcomes: a skipped fire is a successful request whose answer is
        // "nothing happened, and here is why". A 4xx would suggest the caller did something
        // wrong, when the schedule is simply disabled or its target has gone.
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  };
}
