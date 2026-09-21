import { Router, type RequestHandler } from 'express';
import {
  createResearchProjectSchema,
  finishResearchRunSchema,
  recordResearchFindingSchema,
  recordResearchSourceSchema,
  startResearchRunSchema,
} from '@nexs/shared';
import { validateBody } from '../http/middleware/validate.js';
import type { ResearchController } from '../controllers/research.controller.js';

export interface ResearchRouterDeps {
  controller: ResearchController;
  authRequired: RequestHandler;
}

export function createResearchRouter(deps: ResearchRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.listProjects);
  router.post('/', validateBody(createResearchProjectSchema), controller.createProject);

  /**
   * The run routes are declared **before** `/:id`, and the ordering is load-bearing.
   *
   * Express matches in declaration order, so a later `GET /:id` would capture `runs` as a project
   * id and every run listing would answer 404 "the research project does not exist" — a failure
   * that reads as missing data rather than as a routing mistake. The same trap the memory router
   * documents for `/search` and the notifications router for `/unread-count`.
   */
  router.get('/runs', controller.listRuns);
  router.get('/runs/:runId', controller.getRun);
  router.post('/runs/:runId/sources', validateBody(recordResearchSourceSchema), controller.recordSource);
  router.post('/runs/:runId/findings', validateBody(recordResearchFindingSchema), controller.recordFinding);
  router.post('/runs/:runId/finish', validateBody(finishResearchRunSchema), controller.finishRun);

  router.get('/:id', controller.getProject);
  router.post('/:id/archive', controller.archiveProject);
  // A run with no body at all is valid: the project's own agent and question are the defaults.
  router.post('/:id/runs', validateBody(startResearchRunSchema), controller.startRun);
  router.delete('/:id', controller.removeProject);

  return router;
}
