import { ApiError, type NotificationKind, type NotificationListResult } from '@nexs/shared';
import type { NotificationRepository } from '../../repositories/notification.repo.js';
import type { UserRepository } from '../../repositories/user.repo.js';
import type { Logger } from '../../logger.js';
import type { EngineEmitter } from '../engine/execution-engine.js';
import { toNotificationSummary } from '../../mappers/approval.js';

/**
 * Notifications: what the operator is told, and the unread badge.
 *
 * This service is also the `NotificationSink` the native `notify` tool writes through. That
 * is the load-bearing connection in this file: the tool registry only registers `notify`
 * when a sink exists, so wiring this service in is what turns an agent's ability to raise a
 * notification from a described capability into a real one.
 *
 * ## Why the sink resolves its own recipient
 *
 * `notify` requires a `userId`, and the engine does not infer one from a run — see the tool's
 * own comment. `create()` therefore takes an explicit recipient and does not guess. What it
 * *does* do is verify the recipient is a real user of this tenant before writing, because
 * the alternative is a notification row pointing at a user id that does not exist: it would
 * never be delivered to anyone, and nothing would report an error. A notification nobody can
 * receive is worse than a refused one, since the caller believes the human has been told.
 *
 * ## Why every write emits
 *
 * The badge is live. A notification written without an SSE frame would sit in the database
 * until the next poll, and the whole point of the bell is that it rings when something
 * happens. The frame carries the id only — the client refetches — so this never has to
 * decide what the client already knows.
 */

export interface NotificationServiceDeps {
  notifications: NotificationRepository;
  users: UserRepository;
  logger: Logger;
  emit?: EngineEmitter;
  /** Injected so expiry-adjacent behaviour and tests are not bound to the wall clock. */
  now?: () => number;
}

export interface CreateNotificationInput {
  tenantId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  linkRoute?: string;
}

export class NotificationService {
  constructor(private readonly deps: NotificationServiceDeps) {}

  /**
   * Raise a notification for one user. The `NotificationSink` implementation.
   *
   * Returns the id so a tool can cite it as its result, which is what makes "the agent
   * notified someone" a claim with a row behind it rather than a log line.
   */
  async create(
    input: CreateNotificationInput,
  ): Promise<{ id: string }> {
    await this.assertRecipientExists(input.tenantId, input.userId);

    const notification = await this.deps.notifications.create({
      tenantId: input.tenantId,
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      linkRoute: input.linkRoute ?? null,
    });

    this.deps.logger.info(
      { tenantId: input.tenantId, notificationId: notification.id, kind: input.kind },
      'notification created',
    );

    // Emitted after the row exists, never before: a client that refetches on this frame and
    // does not find the row would show a stale badge and no way to explain it.
    this.deps.emit?.(input.tenantId, { name: 'notification.created', payload: { notificationId: notification.id } });

    return { id: notification.id };
  }

  /**
   * The list, with the unread count alongside.
   *
   * `unreadOnly` defaults to `false` here rather than to true. The bell shows unread, but
   * the notifications *page* shows everything, and a default is a value the caller never
   * sent — the caller that wants unread says so.
   */
  async list(
    tenantId: string,
    userId: string,
    filters: { unreadOnly?: boolean; kind?: NotificationKind; limit?: number } = {},
  ): Promise<NotificationListResult> {
    const [rows, unreadCount] = await Promise.all([
      this.deps.notifications.list(tenantId, userId, filters),
      this.deps.notifications.countUnread(tenantId, userId),
    ]);

    return { notifications: rows.map(toNotificationSummary), unreadCount };
  }

  async unreadCount(tenantId: string, userId: string): Promise<number> {
    return this.deps.notifications.countUnread(tenantId, userId);
  }

  /**
   * Everyone who could act on a tenant-wide notification.
   *
   * Every user of the tenant, which is the honest answer while the schema has no roles:
   * there is nothing that maps a permission to a user, so narrowing further would be a
   * guess dressed up as a policy. Callers that want a single recipient pass one explicitly
   * — this exists for the events that have no natural owner, like a run parking for
   * approval.
   */
  async listRecipients(tenantId: string): Promise<string[]> {
    const users = await this.deps.users.listByTenant(tenantId);
    return users.map((user) => user.id);
  }

  /**
   * Mark one read.
   *
   * The repository returns `false` for both "already read" and "does not exist", and this
   * tells them apart by re-reading — because the two want different answers. Already-read is
   * a success: the operator's intent is satisfied, and a double-click is not an error.
   * Not-found is a 404, because the caller named something that is not theirs or is not
   * there, and silently succeeding would hide a client bug.
   */
  async markRead(tenantId: string, userId: string, id: string): Promise<void> {
    const now = new Date(this.now());
    const changed = await this.deps.notifications.markRead(tenantId, userId, id, now);
    if (changed) return;

    const existing = await this.deps.notifications.findById(tenantId, userId, id);
    if (existing === null) {
      throw new ApiError('NOT_FOUND', 'The notification does not exist', { notificationId: id });
    }
    // Already read: idempotent success, and deliberately no second emit — the client
    // already rendered this as read, and re-emitting would make it flicker.
  }

  async markAllRead(tenantId: string, userId: string): Promise<{ markedRead: number }> {
    const markedRead = await this.deps.notifications.markAllRead(tenantId, userId, new Date(this.now()));
    this.deps.logger.info({ tenantId, userId, markedRead }, 'notifications marked read');
    return { markedRead };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Refuse a notification addressed to a user who is not here.
   *
   * Checked against `tenantId` as well as `userId`, so a caller cannot address a
   * notification to a user in another tenant. Without that, the row would carry a foreign
   * `userId` and the foreign tenant's `tenantId` predicate would never match it — an
   * undeliverable row, and a cross-tenant write besides.
   */
  private async assertRecipientExists(tenantId: string, userId: string): Promise<void> {
    const user = await this.deps.users.findById(tenantId, userId);
    if (user === null) {
      throw new ApiError('VALIDATION_ERROR', 'The notification recipient does not exist', {
        userId,
      });
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
