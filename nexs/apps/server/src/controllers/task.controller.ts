import type { RequestHandler } from 'express';
import type { CreateTaskInput, TaskStatus } from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { pathParam } from '../http/middleware/validate.js';
import type { TaskService } from '../services/tasks/task.service.js';

/** `/api/tasks`. */
export interface TaskControllerDeps {
  tasks: TaskService;
}

export interface TaskController {
  list: RequestHandler;
  create: RequestHandler;
  get: RequestHandler;
  cancel: RequestHandler;
}

export function createTaskController(deps: TaskControllerDeps): TaskController {
  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const read = (key: string): string | undefined =>
          typeof req.query[key] === 'string' ? (req.query[key] as string) : undefined;

        const status = read('status');
        const goalId = read('goalId');
        const agentId = read('agentId');
        const workflowId = read('workflowId');

        res.status(200).json({
          tasks: await deps.tasks.list(tenantId, {
            ...(status === undefined ? {} : { status: status as TaskStatus }),
            ...(goalId === undefined ? {} : { goalId }),
            ...(agentId === undefined ? {} : { agentId }),
            ...(workflowId === undefined ? {} : { workflowId }),
          }),
        });
      } catch (err) {
        next(err);
      }
    },

    create: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        // 201 whether or not this delivery created the task. The caller asked for the task
        // to exist and it does; distinguishing "created" from "already existed" would leak
        // whether another delivery happened, and the idempotency key is the caller's own.
        const task = await deps.tasks.create(tenantId, req.body as CreateTaskInput);
        res.status(201).json({ task });
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ task: await deps.tasks.get(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    cancel: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ task: await deps.tasks.cancel(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },
  };
}
