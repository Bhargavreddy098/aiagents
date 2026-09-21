import { Router, type RequestHandler } from 'express';
import { createMemorySchema } from '@nexs/shared';
import { validateBody } from '../http/middleware/validate.js';
import type { MemoryController } from '../controllers/memory.controller.js';

export interface MemoryRouterDeps {
  controller: MemoryController;
  authRequired: RequestHandler;
}

export function createMemoryRouter(deps: MemoryRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.post('/', validateBody(createMemorySchema), controller.create);

  /**
   * `/search` is declared before `/:id`, and that ordering is load-bearing.
   *
   * Express matches in declaration order, so a later `GET /:id` would capture `search` as an id
   * and every search would 404 with "the memory does not exist". The same trap the notifications
   * router documents for `/unread-count`.
   */
  router.get('/search', controller.search);

  router.get('/:id', controller.get);
  router.delete('/:id', controller.remove);

  return router;
}
