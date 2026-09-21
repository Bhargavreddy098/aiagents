import { Router, type RequestHandler } from 'express';
import type { DashboardController } from '../controllers/dashboard.controller.js';

export interface DashboardRouterDeps {
  controller: DashboardController;
  authRequired: RequestHandler;
}

/**
 * `/api/dashboard` — one `GET`, one snapshot.
 *
 * Behind the same shared `authRequired` as every other control-plane router, so a route added
 * here cannot forget it.
 *
 * On the general limiter rather than a budget of its own. The handler fans out to roughly a
 * dozen aggregate queries, which is more than most routes here — but the spec's design is that
 * the dashboard is rendered once and then *kept* current by `GET /api/stream`, so it is not
 * polled. A client that polls it anyway is exactly what the default limiter is for.
 */
export function createDashboardRouter(deps: DashboardRouterDeps): Router {
  const router = Router();

  router.use(deps.authRequired);
  router.get('/', deps.controller.get);

  return router;
}
