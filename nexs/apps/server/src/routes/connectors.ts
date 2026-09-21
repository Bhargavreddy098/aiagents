import { Router, type RequestHandler } from 'express';
import {
  createConnectorAccountSchema,
  createConnectorSchema,
  updateConnectorSchema,
} from '@nexs/shared';
import { validateBody } from '../http/middleware/validate.js';
import type { ConnectorController } from '../controllers/connector.controller.js';

export interface ConnectorsRouterDeps {
  controller: ConnectorController;
  authRequired: RequestHandler;
}

export function createConnectorsRouter(deps: ConnectorsRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.post('/', validateBody(createConnectorSchema), controller.create);

  // Two segments, so this cannot be shadowed by `/:id` — but it is still declared before it, for
  // the same reason `/grants` is on the files router: a future single-segment `/:something` added
  // above would silently swallow it, and the failure would be a 404 rather than a route conflict.
  router.get('/:id/accounts', controller.listAccounts);
  router.post('/:id/accounts', validateBody(createConnectorAccountSchema), controller.addAccount);
  router.delete('/:id/accounts/:accountId', controller.removeAccount);

  router.get('/:id', controller.get);
  router.patch('/:id', validateBody(updateConnectorSchema), controller.update);
  router.delete('/:id', controller.remove);

  // POST rather than GET even though `test` is conceptually a read: it writes `status`,
  // `capabilityDiscovery` and the canonical `Tool` rows. A GET that mutates is a GET a crawler can
  // trigger, and this one would register tools for whatever a vendor happened to advertise.
  router.post('/:id/test', controller.test);

  return router;
}
