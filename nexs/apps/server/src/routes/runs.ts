import { Router, type RequestHandler } from 'express';
import type { RunController } from '../controllers/run.controller.js';

export interface RunsRouterDeps {
  controller: RunController;
  authRequired: RequestHandler;
}

export function createRunsRouter(deps: RunsRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.get('/:id', controller.get);

  // POST, not PATCH: these are commands, not field assignments. `PATCH {status}` would let
  // a client set `completed` on a run that is still executing, which is a claim about the
  // world rather than an instruction.
  router.post('/:id/cancel', controller.cancel);
  router.post('/:id/pause', controller.pause);
  router.post('/:id/resume', controller.resume);

  return router;
}
