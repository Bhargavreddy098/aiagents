import { Router, type RequestHandler } from 'express';
import { createScheduleSchema, updateScheduleSchema } from '@nexs/shared';
import type { ScheduleController } from '../controllers/schedule.controller.js';
import { validateBody } from '../http/middleware/validate.js';

export interface SchedulesRouterDeps {
  controller: ScheduleController;
  authRequired: RequestHandler;
}

export function createSchedulesRouter(deps: SchedulesRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.post('/', validateBody(createScheduleSchema), controller.create);

  router.get('/:id', controller.get);
  router.patch('/:id', validateBody(updateScheduleSchema), controller.update);

  /**
   * Enable and disable are verbs, not `PATCH { enabled }`.
   *
   * The update schema has no `enabled` field on purpose: toggling a schedule registers or
   * removes a pg-boss job, which is a different kind of change from renaming one. A verb
   * route makes the side effect visible in the URL and keeps the two from being confused.
   */
  router.post('/:id/enable', controller.enable);
  router.post('/:id/disable', controller.disable);

  /** Manual "run now". Not in the spec's table; see the controller for why it exists. */
  router.post('/:id/fire', controller.fire);

  router.delete('/:id', controller.remove);

  return router;
}
