import type { RequestHandler } from 'express';
import { listNotificationsSchema } from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { NotificationService } from '../services/notifications/notification.service.js';

/** `/api/notifications`. Thin: authenticate, delegate, serialise. */
export interface NotificationControllerDeps {
  notifications: NotificationService;
}

export interface NotificationController {
  list: RequestHandler;
  unreadCount: RequestHandler;
  markRead: RequestHandler;
  markAllRead: RequestHandler;
}

export function createNotificationController(
  deps: NotificationControllerDeps,
): NotificationController {
  return {
    list: async (req, res, next) => {
      try {
        const { tenantId, userId } = requireAuth(req);
        const query = parseQuery(listNotificationsSchema, req);

        const result = await deps.notifications.list(tenantId, userId, {
          ...(query.unreadOnly === undefined ? {} : { unreadOnly: query.unreadOnly }),
          ...(query.kind === undefined ? {} : { kind: query.kind }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        });

        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },

    /**
     * The badge on its own.
     *
     * A separate endpoint from the list because the bell polls it on a shorter cadence than
     * the panel is opened at, and shipping a page of notifications to draw a number would be
     * wasteful. It is one indexed count.
     */
    unreadCount: async (req, res, next) => {
      try {
        const { tenantId, userId } = requireAuth(req);
        res.status(200).json({ unreadCount: await deps.notifications.unreadCount(tenantId, userId) });
      } catch (err) {
        next(err);
      }
    },

    markRead: async (req, res, next) => {
      try {
        const { tenantId, userId } = requireAuth(req);
        await deps.notifications.markRead(tenantId, userId, pathParam(req, 'id'));
        // 204 rather than the row: marking read is idempotent and the client already has the
        // notification in its cache, so returning a body would only invite it to re-render.
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },

    markAllRead: async (req, res, next) => {
      try {
        const { tenantId, userId } = requireAuth(req);
        const result = await deps.notifications.markAllRead(tenantId, userId);
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  };
}
