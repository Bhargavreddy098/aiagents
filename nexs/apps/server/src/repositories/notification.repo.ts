import type { Notification, PrismaClient } from '@prisma/client';
import type { NotificationKind } from '@nexs/shared';

/**
 * Notifications — the operator-facing record that something happened.
 *
 * The one structural fact worth stating: a notification belongs to a **user**, not to a
 * tenant, and it is the only table here whose isolation predicate is a pair. Every method
 * therefore takes `tenantId` *and* `userId`, and every `where` carries both.
 *
 * The pair is not redundant. `tenantId` is what stops a query from reaching across the
 * tenancy boundary, and `userId` is what stops one member of a tenant from reading another
 * member's notifications — which would leak, for instance, that a colleague was asked to
 * approve something and what it was. Filtering on `tenantId` alone would pass every
 * tenancy test in the suite and still be wrong.
 *
 * ## Why there is no `unreadCount` on the wire type
 *
 * The count is computed here per query rather than stored as a counter column. A stored
 * counter is a second source of truth that has to be decremented on read, re-incremented
 * on unread, and reconciled when a write partially fails — and the badge disagreeing with
 * the list is the one bug an operator will definitely notice. `countUnread` is one indexed
 * count against `(tenantId, userId, readAt)`, which is exactly the index this table has.
 */

export interface CreateNotificationRow {
  tenantId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  linkRoute: string | null;
}

export interface NotificationListFilters {
  unreadOnly?: boolean;
  kind?: NotificationKind;
  limit?: number;
}

export class NotificationRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: CreateNotificationRow): Promise<Notification> {
    return this.db.notification.create({
      data: {
        tenantId: data.tenantId,
        userId: data.userId,
        kind: data.kind,
        title: data.title,
        body: data.body,
        linkRoute: data.linkRoute,
      },
    });
  }

  async findById(tenantId: string, userId: string, id: string): Promise<Notification | null> {
    return this.db.notification.findFirst({ where: { id, tenantId, userId } });
  }

  async list(
    tenantId: string,
    userId: string,
    filters: NotificationListFilters = {},
  ): Promise<Notification[]> {
    return this.db.notification.findMany({
      where: {
        tenantId,
        userId,
        ...(filters.unreadOnly === true ? { readAt: null } : {}),
        ...(filters.kind === undefined ? {} : { kind: filters.kind }),
      },
      // Newest first: a notification feed is read from the top, and the unread badge is
      // about the most recent thing, not the oldest.
      orderBy: { createdAt: 'desc' },
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
    });
  }

  async countUnread(tenantId: string, userId: string): Promise<number> {
    return this.db.notification.count({ where: { tenantId, userId, readAt: null } });
  }

  /**
   * Mark one read. Returns `false` when it was already read or does not exist.
   *
   * `readAt: null` in the `where` is what makes this idempotent without a timestamp
   * comparison: a notification that is already read is not matched, so a repeated request
   * cannot move the timestamp forward and rewrite when the operator actually saw it. The
   * distinction between `false`-because-already-read and `false`-because-not-found is not
   * made here; the service re-reads to tell the caller which it was, and only in the
   * not-found case does that turn into a 404.
   */
  async markRead(tenantId: string, userId: string, id: string, readAt: Date): Promise<boolean> {
    const { count } = await this.db.notification.updateMany({
      where: { id, tenantId, userId, readAt: null },
      data: { readAt },
    });
    return count === 1;
  }

  /**
   * Mark everything unread as read, returning how many moved.
   *
   * A single `updateMany` rather than a read-then-write loop: the loop has a window in
   * which a notification created mid-sweep is either missed or marked read though the
   * operator never saw it, and the count returned would be a lie either way.
   */
  async markAllRead(tenantId: string, userId: string, readAt: Date): Promise<number> {
    const { count } = await this.db.notification.updateMany({
      where: { tenantId, userId, readAt: null },
      data: { readAt },
    });
    return count;
  }
}
