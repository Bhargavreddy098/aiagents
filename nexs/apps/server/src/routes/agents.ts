import { Router, type RequestHandler } from 'express';
import { createAgentSchema, updateAgentSchema } from '@nexs/shared';
import type { AgentController } from '../controllers/agent.controller.js';
import { validateBody } from '../http/middleware/validate.js';

export interface AgentsRouterDeps {
  controller: AgentController;
  /** Applied once for the whole router, so a new route cannot forget it. */
  authRequired: RequestHandler;
}

export function createAgentsRouter(deps: AgentsRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.post('/', validateBody(createAgentSchema), controller.create);

  router.get('/:id', controller.get);
  router.patch('/:id', validateBody(updateAgentSchema), controller.update);

  // The lifecycle actions are separate verbs rather than a `PATCH {status}`. Each has its
  // own preconditions — activation needs a model, archiving is terminal — and a single
  // status endpoint would have to guess which rules apply from the value alone.
  router.post('/:id/activate', controller.activate);
  router.post('/:id/pause', controller.pause);
  router.post('/:id/resume', controller.resume);
  router.post('/:id/disable', controller.disable);
  router.post('/:id/duplicate', controller.duplicate);
  router.delete('/:id', controller.archive);

  return router;
}
