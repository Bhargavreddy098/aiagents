import { Router, type RequestHandler } from 'express';
import { createMcpServerSchema, updateMcpServerSchema } from '@nexs/shared';
import { validateBody } from '../http/middleware/validate.js';
import type { McpController } from '../controllers/mcp.controller.js';

export interface McpRouterDeps {
  controller: McpController;
  authRequired: RequestHandler;
}

export function createMcpRouter(deps: McpRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.post('/', validateBody(createMcpServerSchema), controller.create);

  router.get('/:id', controller.get);
  router.patch('/:id', validateBody(updateMcpServerSchema), controller.update);
  router.delete('/:id', controller.remove);

  router.post('/:id/reconnect', controller.reconnect);

  // The discovery reads. Declared after `/:id` deliberately and they cannot collide: these are
  // three segments, and `/:id` matches exactly two. The `GET /search` trap documented in
  // `routes/memory.ts` does not apply here.
  router.get('/:id/tools', controller.tools);
  router.get('/:id/resources', controller.resources);
  router.get('/:id/prompts', controller.prompts);

  return router;
}
