import type { RequestHandler } from 'express';
import { requireAuth } from '../http/middleware/auth.js';
import type { DashboardService } from '../services/dashboard/dashboard.service.js';

/**
 * `GET /api/dashboard` — the composed snapshot.
 *
 * Thin by design: authenticate, delegate, serialise. There is no query parsing because the
 * endpoint takes no input — every limit is fixed by the spec, and a caller-chosen window
 * would let a client render a label ("last 7 days") that disagrees with the data it received.
 * See the shared contract for the full reasoning.
 */
export interface DashboardControllerDeps {
  dashboard: DashboardService;
}

export interface DashboardController {
  get: RequestHandler;
}

export function createDashboardController(deps: DashboardControllerDeps): DashboardController {
  return {
    get: async (req, res, next) => {
      try {
        // Both halves of the principal are needed, and the second is not decoration: the
        // unread-notification count is per *user*, because a workspace-wide count would tell
        // one member how much unread mail another member has.
        const { tenantId, userId } = requireAuth(req);
        res.status(200).json(await deps.dashboard.get(tenantId, userId));
      } catch (err) {
        next(err);
      }
    },
  };
}
