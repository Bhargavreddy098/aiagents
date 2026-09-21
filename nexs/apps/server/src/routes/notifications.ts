import { Router, type RequestHandler } from 'express';
import type { NotificationController } from '../controllers/notification.controller.js';

export interface NotificationsRouterDeps {
  controller: NotificationController;
  authRequired: RequestHandler;
}

export function createNotificationsRouter(deps: NotificationsRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  // `/unread-count` is declared before `/:id` deliberately. Express matches in declaration
  // order, so a later `GET /:id` would capture `unread-count` as an id — and every badge
  // poll would 404 with "the notification does not exist".
  router.get('/', controller.list);
  router.get('/unread-count', controller.unreadCount);

  router.patch('/:id/read', controller.markRead);

  /**
   * `POST /read-all` rather than `PATCH /` with a body.
   *
   * A bulk update expressed as a collection-level `PATCH` has to say *which* field and to
   * what value, which invites `{ readAt: null }` — marking everything unread, an operation
   * nothing needs and nobody would mean to request. The verb form has exactly one meaning.
   */
  router.post('/read-all', controller.markAllRead);

  return router;
}
