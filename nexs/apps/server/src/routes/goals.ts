import { Router, type RequestHandler } from 'express';
import { createGoalSchema, setGoalStatusSchema, updateGoalSchema } from '@nexs/shared';
import type { GoalController } from '../controllers/goal.controller.js';
import { validateBody } from '../http/middleware/validate.js';

export interface GoalsRouterDeps {
  controller: GoalController;
  authRequired: RequestHandler;
}

export function createGoalsRouter(deps: GoalsRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.post('/', validateBody(createGoalSchema), controller.create);

  router.get('/:id', controller.get);
  router.patch('/:id', validateBody(updateGoalSchema), controller.update);

  /**
   * Status changes go through a `POST` to a sub-resource rather than a `PATCH`, because
   * reaching `completed` needs a second argument — the verification id — and putting that
   * in a general update body would make it possible to send it with an unrelated change.
   */
  router.post('/:id/status', validateBody(setGoalStatusSchema), controller.setStatus);

  return router;
}
