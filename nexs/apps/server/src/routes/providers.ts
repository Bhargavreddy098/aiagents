import { Router, type RequestHandler } from 'express';
import { createProviderSchema, updateProviderSchema } from '@nexs/shared';
import { validateBody } from '../http/middleware/validate.js';
import type { ProviderController } from '../controllers/provider.controller.js';

export interface ProvidersRouterDeps {
  controller: ProviderController;
  authRequired: RequestHandler;
}

export function createProvidersRouter(deps: ProvidersRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.post('/', validateBody(createProviderSchema), controller.create);

  router.get('/:id', controller.get);
  router.patch('/:id', validateBody(updateProviderSchema), controller.update);
  router.delete('/:id', controller.remove);

  // The two actions the spec names. Both are POST rather than GET even though `test` is
  // conceptually a read, because both have effects: `test` writes `status` and
  // `lastHealthCheck` onto the row, and `sync` writes `Model` rows. A GET that mutates is a
  // GET a crawler can trigger.
  router.post('/:id/test', controller.test);
  router.post('/:id/sync', controller.sync);

  return router;
}
