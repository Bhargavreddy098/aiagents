import type { RequestHandler } from 'express';
import {
  listMcpServersSchema,
  type CreateMcpServerInput,
  type UpdateMcpServerInput,
} from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { McpService } from '../services/mcp/mcp.service.js';

/**
 * `/api/mcp` — the connected-servers page.
 *
 * Thin by design: authenticate, parse, delegate, serialise. Every rule that could be broken —
 * that an env block never comes back out, that a failed connect does not fail the create, that a
 * delete tears the session down before the row — lives in `McpService`, because the manager and
 * the reconciliation sweep are callers too and a rule enforced in a route is a rule they do not
 * have.
 */
export interface McpControllerDeps {
  mcp: McpService;
}

export interface McpController {
  list: RequestHandler;
  create: RequestHandler;
  get: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
  reconnect: RequestHandler;
  tools: RequestHandler;
  resources: RequestHandler;
  prompts: RequestHandler;
}

export function createMcpController(deps: McpControllerDeps): McpController {
  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ servers: await deps.mcp.list(tenantId, parseQuery(listMcpServersSchema, req)) });
      } catch (err) {
        next(err);
      }
    },

    /**
     * 201 with the row *and* the connect outcome.
     *
     * The two are reported separately because they are independent: a server whose process failed
     * to start is still a server that now exists, with a `lastError` to show and a reconnect button
     * to press. Failing the request would leave the operator with nothing to retry.
     */
    create: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        // Already parsed and replaced by `validateBody` on the route.
        const result = await deps.mcp.create(tenantId, req.body as CreateMcpServerInput);
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ server: await deps.mcp.get(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    update: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const server = await deps.mcp.update(
          tenantId,
          pathParam(req, 'id'),
          req.body as UpdateMcpServerInput,
        );
        res.status(200).json({ server });
      } catch (err) {
        next(err);
      }
    },

    remove: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        await deps.mcp.remove(tenantId, pathParam(req, 'id'));
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },

    reconnect: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json(await deps.mcp.reconnect(tenantId, pathParam(req, 'id')));
      } catch (err) {
        next(err);
      }
    },

    /**
     * The three discovery reads.
     *
     * All three require a live session, so a server that is disconnected answers with the
     * manager's error rather than an empty list — "there are no tools" and "I could not ask" are
     * different sentences and only one of them is true.
     */
    tools: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ tools: await deps.mcp.listTools(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    resources: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ resources: await deps.mcp.listResources(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    prompts: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ prompts: await deps.mcp.listPrompts(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },
  };
}
