import type { RequestHandler } from 'express';
import {
  listProvidersSchema,
  type CreateProviderInput,
  type UpdateProviderInput,
} from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { ProviderService } from '../services/providers/provider.service.js';

/**
 * `/api/providers` — where an operator installs a key.
 *
 * Thin by design: authenticate, parse, delegate, serialise. Every rule that could be broken —
 * that a key never comes back out, that a type with no adapter is refused, that a failed probe
 * does not fail the create — lives in `ProviderService`, because a route is not the only caller
 * of a service and a rule enforced here would be a rule the other callers do not have.
 */
export interface ProviderControllerDeps {
  providers: ProviderService;
}

export interface ProviderController {
  list: RequestHandler;
  create: RequestHandler;
  get: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
  test: RequestHandler;
  sync: RequestHandler;
}

export function createProviderController(deps: ProviderControllerDeps): ProviderController {
  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ providers: await deps.providers.list(tenantId, parseQuery(listProvidersSchema, req)) });
      } catch (err) {
        next(err);
      }
    },

    /**
     * 201 with the row *and* the verification outcome.
     *
     * The two are reported separately because they are independent: a provider whose vendor was
     * briefly unreachable is still a provider that now exists, and collapsing the two into one
     * status code would either lose the row or hide the failure.
     */
    create: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        // Already parsed and replaced by `validateBody` on the route.
        const result = await deps.providers.create(tenantId, req.body as CreateProviderInput);
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ provider: await deps.providers.get(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    update: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const provider = await deps.providers.update(
          tenantId,
          pathParam(req, 'id'),
          req.body as UpdateProviderInput,
        );
        res.status(200).json({ provider });
      } catch (err) {
        next(err);
      }
    },

    remove: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        await deps.providers.remove(tenantId, pathParam(req, 'id'));
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },

    /** Probe reachability. Never spends the tenant's money — see `ProviderHealthService`. */
    test: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ test: await deps.providers.test(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    sync: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ sync: await deps.providers.sync(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },
  };
}
