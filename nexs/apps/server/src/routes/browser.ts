import { Router, type RequestHandler } from 'express';
import { actOnBrowserSessionSchema, openBrowserSessionSchema } from '@nexs/shared';
import { validateBody } from '../http/middleware/validate.js';
import type { BrowserController } from '../controllers/browser.controller.js';

export interface BrowserRouterDeps {
  controller: BrowserController;
  authRequired: RequestHandler;
}

export function createBrowserRouter(deps: BrowserRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.post('/', validateBody(openBrowserSessionSchema), controller.open);

  router.get('/:id', controller.get);

  // The spec's `POST /:id/actions`. The body is `{ action: <discriminated union> }` rather than
  // the action inline, so the action's own `type` field cannot collide with anything the wrapper
  // needs later — a shape that has already been useful once, when the outcome gained a field.
  router.post('/:id/actions', validateBody(actOnBrowserSessionSchema), controller.act);

  router.delete('/:id', controller.close);

  return router;
}
