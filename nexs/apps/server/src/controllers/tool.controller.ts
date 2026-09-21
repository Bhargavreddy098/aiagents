import type { RequestHandler } from 'express';
import { listToolsSchema, type InvokeToolInput } from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { ToolService } from '../services/tools/tool.service.js';

/**
 * `/api/tools` — the registry page.
 *
 * Thin by design: authenticate, parse, delegate, serialise. The one rule worth restating is that
 * `invoke` is not a read — see `ToolService` for the confirmation it requires before running a
 * tool that has side effects for the arguments supplied.
 */
export interface ToolControllerDeps {
  tools: ToolService;
}

export interface ToolController {
  list: RequestHandler;
  get: RequestHandler;
  invoke: RequestHandler;
}

export function createToolController(deps: ToolControllerDeps): ToolController {
  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ tools: await deps.tools.list(tenantId, parseQuery(listToolsSchema, req)) });
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ tool: await deps.tools.get(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    /**
     * Run a tool once.
     *
     * 200 whether or not the tool reported success, because `ok: false` with a body is a *result*
     * — the tool ran and said it failed — and the two need different retry treatment downstream.
     * A call that could not be performed at all is an error response, thrown by the service.
     */
    invoke: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const view = await deps.tools.invoke(
          tenantId,
          pathParam(req, 'id'),
          req.body as InvokeToolInput,
        );
        res.status(200).json({ invocation: view });
      } catch (err) {
        next(err);
      }
    },
  };
}
