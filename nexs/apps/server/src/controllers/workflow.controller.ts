import type { RequestHandler } from 'express';
import type {
  CreateWorkflowInput,
  RunWorkflowInput,
  UpdateWorkflowInput,
  WorkflowStatus,
} from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { pathParam } from '../http/middleware/validate.js';
import type { WorkflowService } from '../services/workflows/workflow.service.js';

/** `/api/workflows`. */
export interface WorkflowControllerDeps {
  workflows: WorkflowService;
}

export interface WorkflowController {
  list: RequestHandler;
  create: RequestHandler;
  get: RequestHandler;
  addVersion: RequestHandler;
  activate: RequestHandler;
  disable: RequestHandler;
  archive: RequestHandler;
  run: RequestHandler;
}

export function createWorkflowController(deps: WorkflowControllerDeps): WorkflowController {
  const setStatus =
    (status: WorkflowStatus): RequestHandler =>
    async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const workflow = await deps.workflows.setStatus(tenantId, pathParam(req, 'id'), status);
        res.status(200).json({ workflow });
      } catch (err) {
        next(err);
      }
    };

  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const status = typeof req.query['status'] === 'string'
          ? (req.query['status'] as WorkflowStatus)
          : undefined;
        res.status(200).json({
          workflows: await deps.workflows.list(tenantId, {
            ...(status === undefined ? {} : { status }),
          }),
        });
      } catch (err) {
        next(err);
      }
    },

    create: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const workflow = await deps.workflows.create(tenantId, req.body as CreateWorkflowInput);
        res.status(201).json({ workflow });
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const workflow = await deps.workflows.get(tenantId, pathParam(req, 'id'));
        res.status(200).json({ workflow });
      } catch (err) {
        next(err);
      }
    },

    addVersion: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const workflow = await deps.workflows.addVersion(
          tenantId,
          pathParam(req, 'id'),
          req.body as UpdateWorkflowInput,
        );
        res.status(201).json({ workflow });
      } catch (err) {
        next(err);
      }
    },

    activate: setStatus('active'),
    disable: setStatus('disabled'),
    archive: setStatus('archived'),

    run: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const result = await deps.workflows.run(
          tenantId,
          pathParam(req, 'id'),
          (req.body ?? {}) as RunWorkflowInput,
        );
        // 202: the run exists and has been handed to the executor, but has not executed.
        // 201 would imply the work happened, and the run id is what the caller follows.
        res.status(202).json(result);
      } catch (err) {
        next(err);
      }
    },
  };
}
