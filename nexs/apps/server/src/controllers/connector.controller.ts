import type { RequestHandler } from 'express';
import {
  listConnectorAccountsSchema,
  listConnectorsSchema,
  type CreateConnectorAccountInput,
  type CreateConnectorInput,
  type UpdateConnectorInput,
} from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { ConnectorService } from '../services/connectors/connector.service.js';

/**
 * `/api/connectors` — where an operator authorises a third-party service.
 *
 * Thin by design: authenticate, parse, delegate, serialise. Every rule that could be broken — that
 * a token never comes back out, that a type with no adapter is refused, that a failed probe does
 * not fail the create — lives in `ConnectorService`, because a route is not the only caller of a
 * service and a rule enforced here would be a rule the other callers do not have.
 */
export interface ConnectorControllerDeps {
  connectors: ConnectorService;
}

export interface ConnectorController {
  list: RequestHandler;
  create: RequestHandler;
  get: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
  listAccounts: RequestHandler;
  addAccount: RequestHandler;
  removeAccount: RequestHandler;
  test: RequestHandler;
}

export function createConnectorController(deps: ConnectorControllerDeps): ConnectorController {
  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({
          connectors: await deps.connectors.list(tenantId, parseQuery(listConnectorsSchema, req)),
        });
      } catch (err) {
        next(err);
      }
    },

    /**
     * 201 with the row *and* the probe outcome.
     *
     * The two are reported separately because they are independent: a connector whose vendor was
     * briefly unreachable is still a connector that now exists, and collapsing them into one status
     * code would either lose the row or hide the failure. The probe always runs — discovery is what
     * registers the connector's actions as tools, so a create that skipped it would produce a row
     * that exists and can do nothing.
     */
    create: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        // Already parsed and replaced by `validateBody` on the route.
        const result = await deps.connectors.create(tenantId, req.body as CreateConnectorInput);
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({
          connector: await deps.connectors.get(tenantId, pathParam(req, 'id')),
        });
      } catch (err) {
        next(err);
      }
    },

    update: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const connector = await deps.connectors.update(
          tenantId,
          pathParam(req, 'id'),
          req.body as UpdateConnectorInput,
        );
        res.status(200).json({ connector });
      } catch (err) {
        next(err);
      }
    },

    remove: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        await deps.connectors.remove(tenantId, pathParam(req, 'id'));
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },

    listAccounts: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({
          accounts: await deps.connectors.listAccounts(
            tenantId,
            pathParam(req, 'id'),
            parseQuery(listConnectorAccountsSchema, req),
          ),
        });
      } catch (err) {
        next(err);
      }
    },

    addAccount: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const account = await deps.connectors.addAccount(
          tenantId,
          pathParam(req, 'id'),
          req.body as CreateConnectorAccountInput,
        );
        res.status(201).json({ account });
      } catch (err) {
        next(err);
      }
    },

    removeAccount: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        await deps.connectors.removeAccount(
          tenantId,
          pathParam(req, 'id'),
          pathParam(req, 'accountId'),
        );
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },

    /**
     * Probe the connector and register what it can do.
     *
     * A failed probe is a `200` carrying `ok: false` and the vendor's reason. The request was
     * performed and its answer is "this connector does not work" — a 502 describing that answer
     * would be strictly less useful than a 200 carrying it.
     */
    test: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ test: await deps.connectors.test(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },
  };
}
