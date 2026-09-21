import { Router, type RequestHandler } from 'express';
import { createSkillSchema, createSkillVersionSchema, updateSkillSchema } from '@nexs/shared';
import { validateBody } from '../http/middleware/validate.js';
import type { SkillController } from '../controllers/skill.controller.js';

export interface SkillsRouterDeps {
  controller: SkillController;
  authRequired: RequestHandler;
}

export function createSkillsRouter(deps: SkillsRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.post('/', validateBody(createSkillSchema), controller.create);

  // Declared before `/:id`, the same ordering rule the files router's `/grants` follows: two
  // segments cannot be shadowed by one, but a single-segment sibling added above it later could,
  // and the symptom would be a 404 rather than a conflict.
  router.get('/:id/versions', controller.listVersions);
  router.post('/:id/versions', validateBody(createSkillVersionSchema), controller.publishVersion);

  router.get('/:id', controller.get);
  router.patch('/:id', validateBody(updateSkillSchema), controller.update);
  router.delete('/:id', controller.remove);

  return router;
}
