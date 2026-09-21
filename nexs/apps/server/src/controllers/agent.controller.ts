import type { RequestHandler } from 'express';
import {
  listAgentsSchema,
  type AgentStatus,
  type CreateAgentInput,
  type UpdateAgentInput,
} from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { AgentService } from '../services/agents/agent.service.js';

/**
 * `/api/agents`.
 *
 * Controllers stay thin on purpose: authenticate, parse, delegate, serialise. Everything
 * that decides *what happens* — the state machine, the activation preconditions, the
 * versioning — lives in the service, so it is reachable from a test without HTTP and
 * cannot be bypassed by a second caller.
 */

export interface AgentControllerDeps {
  agents: AgentService;
}

export interface AgentController {
  list: RequestHandler;
  create: RequestHandler;
  get: RequestHandler;
  update: RequestHandler;
  activate: RequestHandler;
  pause: RequestHandler;
  resume: RequestHandler;
  disable: RequestHandler;
  duplicate: RequestHandler;
  archive: RequestHandler;
}

export function createAgentController(deps: AgentControllerDeps): AgentController {
  /** A status change is the same handler five times over; the target is the only variable. */
  const setStatus =
    (status: AgentStatus): RequestHandler =>
    async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const agent = await deps.agents.setStatus(tenantId, pathParam(req, 'id'), status);
        res.status(200).json({ agent });
      } catch (err) {
        next(err);
      }
    };

  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const query = parseQuery(listAgentsSchema, req);
        res.status(200).json({ agents: await deps.agents.list(tenantId, query) });
      } catch (err) {
        next(err);
      }
    },

    create: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const agent = await deps.agents.create(tenantId, req.body as CreateAgentInput);
        res.status(201).json({ agent });
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ agent: await deps.agents.get(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    update: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const agent = await deps.agents.update(
          tenantId,
          pathParam(req, 'id'),
          req.body as UpdateAgentInput,
        );
        res.status(200).json({ agent });
      } catch (err) {
        next(err);
      }
    },

    activate: setStatus('active'),
    pause: setStatus('paused'),
    resume: setStatus('active'),
    disable: setStatus('disabled'),
    archive: setStatus('archived'),

    duplicate: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        // The name is optional. Making it required would turn a one-click action into a
        // form, and the service already produces a sensible default.
        const name = typeof req.body?.name === 'string' ? req.body.name : undefined;
        const agent = await deps.agents.duplicate(tenantId, pathParam(req, 'id'), name);
        res.status(201).json({ agent });
      } catch (err) {
        next(err);
      }
    },
  };
}
