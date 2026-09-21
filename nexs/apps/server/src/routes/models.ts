import { Router, type RequestHandler } from 'express';
import { updateModelSchema } from '@nexs/shared';
import { validateBody } from '../http/middleware/validate.js';
import type { ModelController } from '../controllers/model.controller.js';

export interface ModelsRouterDeps {
  controller: ModelController;
  authRequired: RequestHandler;
}

export function createModelsRouter(deps: ModelsRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.get('/:id', controller.get);
  router.patch('/:id', validateBody(updateModelSchema), controller.update);

  // No POST and no DELETE, deliberately. Models are discovered from a provider and removed by
  // removing the provider — there is no supported way to hand-add a model, because a row whose
  // `externalModelId` the vendor does not recognise is a model that 404s on every call. The
  // catalogue is a mirror of what the providers offer, plus an operator's annotations on it.

  return router;
}
