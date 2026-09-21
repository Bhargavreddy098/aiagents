import type { RequestHandler } from 'express';
import { listModelsSchema, type UpdateModelInput } from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { ModelService } from '../services/providers/model.service.js';

/**
 * `/api/models` — the catalogue page.
 *
 * The only write here is an operator correction (enable, capabilities, status, fallback). Rows
 * arrive through `POST /api/providers/:id/sync`, which is additive and lives with the provider
 * because that is what it is scoped to — see `ModelService` for why the two must not both write.
 */
export interface ModelControllerDeps {
  models: ModelService;
}

export interface ModelController {
  list: RequestHandler;
  get: RequestHandler;
  update: RequestHandler;
}

export function createModelController(deps: ModelControllerDeps): ModelController {
  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ models: await deps.models.list(tenantId, parseQuery(listModelsSchema, req)) });
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ model: await deps.models.get(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    update: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const model = await deps.models.update(
          tenantId,
          pathParam(req, 'id'),
          req.body as UpdateModelInput,
        );
        res.status(200).json({ model });
      } catch (err) {
        next(err);
      }
    },
  };
}
