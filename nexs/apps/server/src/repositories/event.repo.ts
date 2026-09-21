import type { Event, EventSubscription, PrismaClient } from '@prisma/client';
import { isUniqueViolation } from '../db-errors.js';
import { toJson } from './json.js';

/**
 * Events and event subscriptions — the "something happened, so start that" half.
 *
 * Both models carry their own `tenantId`, so this is an ordinary tenant-owned repository:
 * `tenantId` is the first argument of every method and appears in every `where`.
 *
 * ## Webhook replay protection
 *
 * `Event` has a unique index on `(tenantId, source, externalId)`. The database is the
 * arbiter rather than a check-then-insert, for the same reason `RunRepository.create` does
 * it that way: two concurrent deliveries of the same webhook would both pass a pre-check
 * and both insert, and a webhook producer that retries on a slow response is the normal
 * case rather than the pathological one. A duplicate therefore surfaces as a P2002, and
 * `createDeduplicated` turns that into "here is the event you already sent" instead of an
 * error — and, crucially, into `created: false` so the caller does not trigger the
 * subscribers a second time.
 *
 * `externalId` is nullable and a NULL never collides (in Postgres, and in the in-memory
 * fake, which models that deliberately). An event sent without a producer id is therefore
 * always stored. Refusing it would drop real signals in order to protect against a replay
 * the producer has not asked us to detect.
 *
 * ## Why matching is not a query
 *
 * A subscription's `filter` is `{source?, subject?}` inside a `Json` column, and the honest
 * way to match a *partial* object against it in Prisma is a JSON `path`/`equals` query that
 * only Postgres implements — so it would be untestable against the in-memory fake, which is
 * the only database available here. `listSubscriptionsByTopic` narrows to the topic (an
 * indexed scalar column) and the service applies the filter in memory. The number of
 * subscriptions on one topic is small and bounded by what a tenant has configured, so the
 * cost of doing it in code is a few object comparisons rather than a table scan.
 */

// ── events ────────────────────────────────────────────────────────────────────

export interface EventCreateInput {
  tenantId: string;
  type: string;
  source: string;
  subject: string | null;
  externalId: string | null;
  payload: unknown;
  metadata: unknown;
  occurredAt: Date;
}

export interface EventListFilters {
  type?: string;
  source?: string;
  subject?: string;
  processed?: boolean;
  since?: Date;
  until?: Date;
  limit?: number;
}

export class EventRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Store an event, or return the one already stored for this `(source, externalId)`.
   *
   * `created` is what tells the caller whether to trigger subscribers. Returning the row
   * alone would make a replay indistinguishable from a first delivery, and the whole point
   * of the index is that a replay must not start a second workflow.
   */
  async createDeduplicated(input: EventCreateInput): Promise<{ event: Event; created: boolean }> {
    try {
      const event = await this.db.event.create({
        data: {
          tenantId: input.tenantId,
          type: input.type,
          source: input.source,
          subject: input.subject,
          externalId: input.externalId,
          payload: toJson(input.payload),
          metadata: toJson(input.metadata),
          occurredAt: input.occurredAt,
        },
      });
      return { event, created: true };
    } catch (err) {
      if (
        isUniqueViolation(err) &&
        input.externalId !== null &&
        input.externalId.length > 0
      ) {
        const existing = await this.findByExternalId(input.tenantId, input.source, input.externalId);
        if (existing !== null) return { event: existing, created: false };
      }
      throw err;
    }
  }

  async findByExternalId(
    tenantId: string,
    source: string,
    externalId: string,
  ): Promise<Event | null> {
    return this.db.event.findFirst({ where: { tenantId, source, externalId } });
  }

  async findEventById(tenantId: string, id: string): Promise<Event | null> {
    return this.db.event.findFirst({ where: { id, tenantId } });
  }

  async listEvents(tenantId: string, filters: EventListFilters = {}): Promise<Event[]> {
    return this.db.event.findMany({
      where: {
        tenantId,
        ...(filters.type === undefined ? {} : { type: filters.type }),
        ...(filters.source === undefined ? {} : { source: filters.source }),
        ...(filters.subject === undefined ? {} : { subject: filters.subject }),
        ...(filters.processed === undefined
          ? {}
          : filters.processed
            ? { processedAt: { not: null } }
            : { processedAt: null }),
        ...(filters.since === undefined && filters.until === undefined
          ? {}
          : {
              occurredAt: {
                ...(filters.since === undefined ? {} : { gte: filters.since }),
                ...(filters.until === undefined ? {} : { lt: filters.until }),
              },
            }),
      },
      // Newest occurrence first — an event log is read from the top.
      orderBy: { occurredAt: 'desc' },
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
    });
  }

  async countEvents(tenantId: string, filters: EventListFilters = {}): Promise<number> {
    const rows = await this.listEvents(tenantId, filters);
    return rows.length;
  }

  /**
   * Mark the matcher as finished with this event.
   *
   * `processedAt: null` in the `where` keeps it idempotent: a redelivered ingest cannot
   * move the timestamp forward and rewrite when the event was actually handled.
   */
  async markProcessed(tenantId: string, id: string, processedAt: Date): Promise<boolean> {
    const { count } = await this.db.event.updateMany({
      where: { id, tenantId, processedAt: null },
      data: { processedAt },
    });
    return count === 1;
  }

  // ── subscriptions ───────────────────────────────────────────────────────────

  async createSubscription(data: {
    tenantId: string;
    topic: string;
    filter: unknown;
    targetKind: string;
    targetId: string;
    secret: string | null;
    enabled: boolean;
  }): Promise<EventSubscription> {
    return this.db.eventSubscription.create({
      data: {
        tenantId: data.tenantId,
        topic: data.topic,
        filter: toJson(data.filter),
        targetKind: data.targetKind,
        targetId: data.targetId,
        secret: data.secret,
        enabled: data.enabled,
        // `EventSubscription.eventId` is a leftover single-event pointer in the schema. A
        // subscription is a standing rule, not a link to one occurrence, so it is written
        // as NULL and never read. Noted here so the column's presence does not look like an
        // invariant something depends on.
        eventId: null,
      },
    });
  }

  async findSubscriptionById(tenantId: string, id: string): Promise<EventSubscription | null> {
    return this.db.eventSubscription.findFirst({ where: { id, tenantId } });
  }

  async listSubscriptions(
    tenantId: string,
    filters: { topic?: string; enabled?: boolean; targetKind?: string; targetId?: string; limit?: number } = {},
  ): Promise<EventSubscription[]> {
    return this.db.eventSubscription.findMany({
      where: {
        tenantId,
        ...(filters.topic === undefined ? {} : { topic: filters.topic }),
        ...(filters.enabled === undefined ? {} : { enabled: filters.enabled }),
        ...(filters.targetKind === undefined ? {} : { targetKind: filters.targetKind }),
        ...(filters.targetId === undefined ? {} : { targetId: filters.targetId }),
      },
      orderBy: { createdAt: 'asc' },
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
    });
  }

  /**
   * The candidates for one event, narrowed by topic.
   *
   * Topic is an exact scalar match — that is what makes "which subscriptions could this
   * event possibly concern?" an indexed lookup rather than a scan of every subscription in
   * the tenant. The `source`/`subject` filter is applied by the service afterwards; see the
   * file header for why.
   */
  async listSubscriptionsByTopic(
    tenantId: string,
    topic: string,
    options: { enabledOnly?: boolean } = {},
  ): Promise<EventSubscription[]> {
    return this.db.eventSubscription.findMany({
      where: {
        tenantId,
        topic,
        ...(options.enabledOnly === true ? { enabled: true } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateSubscription(
    tenantId: string,
    id: string,
    data: { topic?: string; filter?: unknown; enabled?: boolean; secret?: string | null },
  ): Promise<EventSubscription | null> {
    const patch: Record<string, unknown> = {};
    if (data.topic !== undefined) patch['topic'] = data.topic;
    if (data.filter !== undefined) patch['filter'] = toJson(data.filter);
    if (data.enabled !== undefined) patch['enabled'] = data.enabled;
    if (data.secret !== undefined) patch['secret'] = data.secret;

    if (Object.keys(patch).length > 0) {
      const { count } = await this.db.eventSubscription.updateMany({
        where: { id, tenantId },
        data: patch,
      });
      if (count !== 1) return null;
    }

    return this.findSubscriptionById(tenantId, id);
  }

  async deleteSubscription(tenantId: string, id: string): Promise<boolean> {
    const { count } = await this.db.eventSubscription.deleteMany({ where: { id, tenantId } });
    return count === 1;
  }

  /** How many subscriptions point at a target — used to refuse deleting a target in use. */
  async countSubscriptionsForTarget(
    tenantId: string,
    targetKind: string,
    targetId: string,
  ): Promise<number> {
    return this.db.eventSubscription.count({ where: { tenantId, targetKind, targetId } });
  }
}
