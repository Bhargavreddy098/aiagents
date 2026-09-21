import type { RequestHandler } from 'express';
import {
  listBrowserSessionsSchema,
  type ActOnBrowserSessionInput,
  type OpenBrowserSessionInput,
} from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { BrowserService } from '../services/browser/browser.service.js';

/**
 * `/api/browser` — the Browser tab.
 *
 * Thin by design: authenticate, parse, delegate, serialise. The action body is validated as a
 * discriminated union before it reaches the service, which is what turns "the browser did nothing"
 * into "a click needs a selector".
 */
export interface BrowserControllerDeps {
  browser: BrowserService;
}

export interface BrowserController {
  list: RequestHandler;
  open: RequestHandler;
  get: RequestHandler;
  act: RequestHandler;
  close: RequestHandler;
}

export function createBrowserController(deps: BrowserControllerDeps): BrowserController {
  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res
          .status(200)
          .json({ sessions: await deps.browser.list(tenantId, parseQuery(listBrowserSessionsSchema, req)) });
      } catch (err) {
        next(err);
      }
    },

    open: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        // Already parsed and replaced by `validateBody` on the route.
        const session = await deps.browser.open(tenantId, req.body as OpenBrowserSessionInput);
        res.status(201).json({ session });
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ session: await deps.browser.get(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    act: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const outcome = await deps.browser.act(
          tenantId,
          pathParam(req, 'id'),
          req.body as ActOnBrowserSessionInput,
        );
        res.status(200).json({ outcome });
      } catch (err) {
        next(err);
      }
    },

    close: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        await deps.browser.close(tenantId, pathParam(req, 'id'));
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  };
}
