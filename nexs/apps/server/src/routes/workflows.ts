import { Router, type RequestHandler } from 'express';
import { createWorkflowSchema, runWorkflowSchema, updateWorkflowSchema } from '@nexs/shared';
import type { WorkflowController } from '../controllers/workflow.controller.js';
import { validateBody } from '../http/middleware/validate.js';

export interface WorkflowsRouterDeps {
  controller: WorkflowController;
  authRequired: RequestHandler;
}

export function createWorkflowsRouter(deps: WorkflowsRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.post('/', validateBody(createWorkflowSchema), controller.create);

  router.get('/:id', controller.get);
  // A version, not an edit: the previous one is immutable, so this is a `POST` to the
  // version collection rather than a `PATCH` of the workflow.
  router.post('/:id/versions', validateBody(updateWorkflowSchema), controller.addVersion);

  router.post('/:id/activate', controller.activate);
  router.post('/:id/disable', controller.disable);
  router.delete('/:id', controller.archive);

  router.post('/:id/run', validateBody(runWorkflowSchema), controller.run);

  return router;
}
