import { Router, type RequestHandler } from 'express';
import { invokeToolSchema } from '@nexs/shared';
import { validateBody } from '../http/middleware/validate.js';
import type { ToolController } from '../controllers/tool.controller.js';

export interface ToolsRouterDeps {
  controller: ToolController;
  authRequired: RequestHandler;
}

export function createToolsRouter(deps: ToolsRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.get('/:id', controller.get);

  // POST rather than GET because it runs the tool — for a tool whose capabilities resolve to an
  // effect for these arguments, it runs it *for real*. The service refuses an effectful call
  // unless the body confirms. See `ToolService`.
  router.post('/:id/invoke', validateBody(invokeToolSchema), controller.invoke);

  // No create, no update, no delete. A `Tool` row is a projection of the registry (built-ins) or
  // of what an MCP server advertised — it is not an object an operator authors. Hand-writing one
  // would produce a row whose handler does not exist, which fails at call time with
  // `UNSUPPORTED_CAPABILITY` after the planner has already offered it to a model.

  return router;
}
