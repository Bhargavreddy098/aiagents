import { Router, type RequestHandler } from 'express';
import { setOwnerSchema, updateMeSchema } from '@nexs/shared';
import type { UserController } from '../controllers/user.controller.js';
import { validateBody } from '../http/middleware/validate.js';

export interface UsersRouterDeps {
  controller: UserController;
  /** Every route here is authenticated; injected so the router stays testable. */
  authRequired: RequestHandler;
}

export function createUsersRouter(deps: UsersRouterDeps): Router {
  const router = Router();

  // Applied once for the whole router: a new endpoint added below cannot forget it.
  router.use(deps.authRequired);

  router.get('/me', deps.controller.me);
  router.patch('/me', validateBody(updateMeSchema), deps.controller.updateMe);

  /**
   * The command owner (UI/UX v2 §5.6).
   *
   * A `PUT` on a singleton rather than a `POST` to a collection, because there is exactly one
   * owner per workspace — `{ ownerUserId: null }` clears it. Authorisation is in the service, not
   * here: an unowned workspace may be claimed by any member, and only the owner may transfer
   * afterwards, which is a rule about state rather than about the route.
   */
  router.put('/owner', validateBody(setOwnerSchema), deps.controller.setOwner);

  return router;
}
