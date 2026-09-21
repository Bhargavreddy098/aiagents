import type { RequestHandler } from 'express';
import {
  listResearchProjectsSchema,
  listResearchRunsSchema,
  type CreateResearchProjectInput,
  type FinishResearchRunInput,
  type RecordResearchFindingInput,
  type RecordResearchSourceInput,
  type StartResearchRunInput,
} from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { ResearchService } from '../services/research/research.service.js';

/**
 * `/api/research` — projects, their runs, and the evidence those runs found.
 *
 * Thin by design, like the memory controller: authenticate, parse, delegate, serialise. The rules
 * that could be broken — which project a run belongs to, whether a citation names a source this
 * run actually recorded, what finishing a run does to its project — live in `ResearchService`,
 * because the protocol driver and the HTTP surface must get the same answers.
 */
export interface ResearchControllerDeps {
  research: ResearchService;
}

export interface ResearchController {
  listProjects: RequestHandler;
  createProject: RequestHandler;
  getProject: RequestHandler;
  archiveProject: RequestHandler;
  removeProject: RequestHandler;
  listRuns: RequestHandler;
  startRun: RequestHandler;
  getRun: RequestHandler;
  recordSource: RequestHandler;
  recordFinding: RequestHandler;
  finishRun: RequestHandler;
}

export function createResearchController(deps: ResearchControllerDeps): ResearchController {
  return {
    listProjects: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res
          .status(200)
          .json(await deps.research.list(tenantId, parseQuery(listResearchProjectsSchema, req)));
      } catch (err) {
        next(err);
      }
    },

    createProject: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        // Already parsed and replaced by `validateBody` on the route.
        const project = await deps.research.createProject(
          tenantId,
          req.body as CreateResearchProjectInput,
        );
        res.status(201).json({ project });
      } catch (err) {
        next(err);
      }
    },

    getProject: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ project: await deps.research.get(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    archiveProject: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res
          .status(200)
          .json({ project: await deps.research.archive(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    removeProject: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        await deps.research.remove(tenantId, pathParam(req, 'id'));
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },

    listRuns: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res
          .status(200)
          .json({ runs: await deps.research.listRuns(tenantId, parseQuery(listResearchRunsSchema, req)) });
      } catch (err) {
        next(err);
      }
    },

    startRun: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const run = await deps.research.startRun(
          tenantId,
          pathParam(req, 'id'),
          (req.body ?? {}) as StartResearchRunInput,
        );
        res.status(201).json({ run });
      } catch (err) {
        next(err);
      }
    },

    getRun: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ run: await deps.research.getRun(tenantId, pathParam(req, 'runId')) });
      } catch (err) {
        next(err);
      }
    },

    recordSource: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const source = await deps.research.recordSource(
          tenantId,
          pathParam(req, 'runId'),
          req.body as RecordResearchSourceInput,
        );
        res.status(201).json({ source });
      } catch (err) {
        next(err);
      }
    },

    recordFinding: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const finding = await deps.research.recordFinding(
          tenantId,
          pathParam(req, 'runId'),
          req.body as RecordResearchFindingInput,
        );
        res.status(201).json({ finding });
      } catch (err) {
        next(err);
      }
    },

    finishRun: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const run = await deps.research.finishRun(
          tenantId,
          pathParam(req, 'runId'),
          req.body as FinishResearchRunInput,
        );
        res.status(200).json({ run });
      } catch (err) {
        next(err);
      }
    },
  };
}
