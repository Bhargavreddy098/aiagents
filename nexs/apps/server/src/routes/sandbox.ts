import { Router, type RequestHandler } from 'express';
import { createSandboxSessionSchema, sandboxExecSchema } from '@nexs/shared';
import { validateBody } from '../http/middleware/validate.js';
import type { SandboxController } from '../controllers/sandbox.controller.js';

export interface SandboxRouterDeps {
  controller: SandboxController;
  authRequired: RequestHandler;
}

export function createSandboxRouter(deps: SandboxRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.listSessions);
  router.post('/', validateBody(createSandboxSessionSchema), controller.createSession);

  router.get('/:id', controller.getSession);
  router.get('/:id/executions', controller.listExecutions);

  // The spec's `POST /:id/exec`. A POST that runs arbitrary JavaScript is exactly the route that
  // most needs the request body validated before it reaches anything, which is why the code length
  // cap and the timeout ceiling are in the schema rather than only in the worker.
  router.post('/:id/exec', validateBody(sandboxExecSchema), controller.exec);

  return router;
}
