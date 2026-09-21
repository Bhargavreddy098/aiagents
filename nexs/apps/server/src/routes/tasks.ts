import { Router, type RequestHandler } from 'express';
import { createTaskSchema } from '@nexs/shared';
import type { TaskController } from '../controllers/task.controller.js';
import { validateBody } from '../http/middleware/validate.js';

export interface TasksRouterDeps {
  controller: TaskController;
  authRequired: RequestHandler;
}

export function createTasksRouter(deps: TasksRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.post('/', validateBody(createTaskSchema), controller.create);

  router.get('/:id', controller.get);
  router.post('/:id/cancel', controller.cancel);

  return router;
}
