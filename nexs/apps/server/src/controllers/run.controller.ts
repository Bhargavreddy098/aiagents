import type { RequestHandler } from 'express';
import { listRunsSchema } from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { RunService } from '../services/runs/run.service.js';

/** `/api/runs`. */
export interface RunControllerDeps {
  runs: RunService;
}

export interface RunController {
  list: RequestHandler;
  get: RequestHandler;
  cancel: RequestHandler;
  pause: RequestHandler;
  resume: RequestHandler;
}

export function createRunController(deps: RunControllerDeps): RunController {
  const action =
    (name: 'cancel' | 'pause' | 'resume'): RequestHandler =>
    async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const run = await deps.runs[name](tenantId, pathParam(req, 'id'));
        res.status(200).json({ run });
      } catch (err) {
        next(err);
      }
    };

  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        // `total` travels with the page so a client can say "showing 20 of 340" without a
        // second request — and from the same `where` clause, so the two cannot disagree.
        res.status(200).json(await deps.runs.list(tenantId, parseQuery(listRunsSchema, req)));
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ run: await deps.runs.get(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    cancel: action('cancel'),
    pause: action('pause'),
    resume: action('resume'),
  };
}
