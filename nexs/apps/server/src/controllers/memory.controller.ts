import type { RequestHandler } from 'express';
import {
  listMemoriesSchema,
  searchMemorySchema,
  type CreateMemoryInput,
} from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { MemoryService } from '../services/memory/memory.service.js';

/**
 * `/api/memory` — the Memory page, and the store behind the `memory_*` tools.
 *
 * Thin by design: authenticate, parse, delegate, serialise. Every rule that could be broken —
 * which pools cannot be combined, what a missing embedding means, which search answered — lives
 * in `MemoryService`, because the tools call the same service and must get the same answers.
 */
export interface MemoryControllerDeps {
  memory: MemoryService;
}

export interface MemoryController {
  list: RequestHandler;
  create: RequestHandler;
  search: RequestHandler;
  get: RequestHandler;
  remove: RequestHandler;
}

export function createMemoryController(deps: MemoryControllerDeps): MemoryController {
  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json(await deps.memory.list(tenantId, parseQuery(listMemoriesSchema, req)));
      } catch (err) {
        next(err);
      }
    },

    create: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        // Already parsed and replaced by `validateBody` on the route.
        const summary = await deps.memory.create(tenantId, req.body as CreateMemoryInput);
        res.status(201).json({ memory: summary });
      } catch (err) {
        next(err);
      }
    },

    /**
     * Semantic when an embedding model is configured, keyword otherwise.
     *
     * `mode` is in the response rather than implied by the route, because the two answers are
     * not equivalent and a client that rendered them identically would be presenting a substring
     * match as a semantic one.
     */
    search: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json(await deps.memory.search(tenantId, parseQuery(searchMemorySchema, req)));
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ memory: await deps.memory.get(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    remove: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        await deps.memory.remove(tenantId, pathParam(req, 'id'));
        // 204: the client already knows which row it asked to delete, so a body would only give
        // it something to re-render.
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  };
}
