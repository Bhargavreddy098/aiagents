import type { RequestHandler } from 'express';
import type { CreateGoalInput, GoalStatus, SetGoalStatusInput, UpdateGoalInput } from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { pathParam } from '../http/middleware/validate.js';
import type { GoalService } from '../services/goals/goal.service.js';

/** `/api/goals`. Thin: authenticate, delegate, serialise. */
export interface GoalControllerDeps {
  goals: GoalService;
}

export interface GoalController {
  list: RequestHandler;
  create: RequestHandler;
  get: RequestHandler;
  update: RequestHandler;
  setStatus: RequestHandler;
}

export function createGoalController(deps: GoalControllerDeps): GoalController {
  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        // The status filter is read off the raw query rather than parsed with zod: it is a
        // single optional enum, and `GoalService` narrows it. A schema here would be a
        // second declaration of `GOAL_STATUSES` to keep in step.
        const status = typeof req.query['status'] === 'string'
          ? (req.query['status'] as GoalStatus)
          : undefined;
        const agentId = typeof req.query['agentId'] === 'string' ? req.query['agentId'] : undefined;
        res.status(200).json({
          goals: await deps.goals.list(tenantId, {
            ...(status === undefined ? {} : { status }),
            ...(agentId === undefined ? {} : { agentId }),
          }),
        });
      } catch (err) {
        next(err);
      }
    },

    create: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const goal = await deps.goals.create(tenantId, req.body as CreateGoalInput);
        res.status(201).json({ goal });
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ goal: await deps.goals.get(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    update: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const goal = await deps.goals.update(
          tenantId,
          pathParam(req, 'id'),
          req.body as UpdateGoalInput,
        );
        res.status(200).json({ goal });
      } catch (err) {
        next(err);
      }
    },

    setStatus: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const goal = await deps.goals.setStatus(
          tenantId,
          pathParam(req, 'id'),
          req.body as SetGoalStatusInput,
        );
        res.status(200).json({ goal });
      } catch (err) {
        next(err);
      }
    },
  };
}
