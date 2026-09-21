import {
  ApiError,
  type CreateEventSubscriptionInput,
  type EventIngestResult,
  type EventListResult,
  type EventSubscriptionListResult,
  type EventSubscriptionSummary,
  type EventSummary,
  type IngestEventInput,
  type ListEventsQuery,
  type ListEventSubscriptionsQuery,
  type UpdateEventSubscriptionInput,
} from '@nexs/shared';
import type { EventRepository } from '../../repositories/event.repo.js';
import type { AgentRepository } from '../../repositories/agent.repo.js';
import type { TaskRepository } from '../../repositories/task.repo.js';
import type { WorkflowRepository } from '../../repositories/workflow.repo.js';
import type { OccurrenceStarter } from '../automation/occurrence.js';
import type { Logger } from '../../logger.js';
import type { EngineEmitter } from '../engine/execution-engine.js';
import {
  toEventSubscriptionSummary,
  toEventSummary,
} from '../../mappers/automation.js';

/**
 * Events: ingest, match, trigger, mark processed.
 *
 * ## The rule that shapes the whole service
 *
 * **A duplicate ingest must not trigger anything a second time.** Every webhook producer
 * retries, so a repeat delivery is the normal case rather than the pathological one. The
 * dedupe happens at the database (the unique index on `(tenantId, source, externalId)`), and
 * this service's job is to act on what that tells it: when `created` is false, the event is
 * returned with `deduplicated: true` and **no subscription is started**. Reporting the
 * original outcome instead would be a lie — this delivery did not cause it.
 *
 * ## Why the filter is applied here rather than in a query
 *
 * A subscription's `filter` lives in a `Json` column, and Prisma can only do a partial match
 * against it on Postgres. The repository narrows by `topic` (an indexed scalar column) and
 * this service compares `source`/`subject` in memory. See `event.repo.ts` for the full
 * reasoning; the short version is that the alternative is untestable on this machine.
 *
 * ## Partial failure is reported, not swallowed
 *
 * One subscription whose target has been deleted must not stop the others from firing, so
 * each target is started independently and a failure is collected. `triggered` counts the
 * successes and `failures` names the rest — a single `triggered: 2` for three subscriptions
 * would hide the one that did not work, which is exactly the thing an operator needs to see.
 */

export interface EventServiceDeps {
  events: EventRepository;
  tasks: TaskRepository;
  workflows: WorkflowRepository;
  agents: AgentRepository;
  occurrences: OccurrenceStarter;
  logger: Logger;
  emit?: EngineEmitter;
  now?: () => number;
}

export class EventService {
  constructor(private readonly deps: EventServiceDeps) {}

  /**
   * Store an inbound event and start whatever subscribes to it.
   *
   * The same method serves the HTTP route and any internal emitter: a signal raised from
   * inside the process must be subject to exactly the same dedupe, matching and marking as
   * one that arrived over the wire, or the two paths would diverge in the one behaviour that
   * matters.
   */
  async ingest(tenantId: string, input: IngestEventInput): Promise<EventIngestResult> {
    const { event, created } = await this.deps.events.createDeduplicated({
      tenantId,
      type: input.type,
      source: input.source,
      subject: input.subject ?? null,
      externalId: input.externalId ?? null,
      payload: input.payload ?? {},
      metadata: input.metadata ?? {},
      occurredAt: input.occurredAt ?? new Date(this.now()),
    });

    this.deps.emit?.(tenantId, {
      name: 'event.received',
      payload: {
        eventId: event.id,
        type: event.type,
        source: event.source,
        deduplicated: !created,
      },
    });

    if (!created) {
      this.deps.logger.info(
        { tenantId, eventId: event.id, source: event.source, externalId: event.externalId },
        'duplicate event delivery absorbed; no subscription triggered',
      );
      return {
        event: toEventSummary(event),
        deduplicated: true,
        matchedSubscriptions: 0,
        triggered: 0,
        failures: [],
      };
    }

    const candidates = await this.deps.events.listSubscriptionsByTopic(tenantId, event.type, {
      enabledOnly: true,
    });
    const matched = candidates.filter((subscription) =>
      matchesFilter(subscription.filter, event.source, event.subject),
    );

    const failures: Array<{ subscriptionId: string; reason: string }> = [];
    let triggered = 0;

    for (const subscription of matched) {
      try {
        await this.deps.occurrences.start({
          tenantId,
          target: {
            kind: subscription.targetKind as 'task' | 'workflow' | 'agent',
            id: subscription.targetId,
          },
          // Unique per (event, subscription). The event row is new here, so this key cannot
          // have been used before — it is a second line of defence behind the unique index,
          // for the case where one ingest somehow reaches the same subscription twice.
          occurrenceKey: `event:${event.id}:${subscription.id}`,
          payload: event.payload,
        });
        triggered += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failures.push({ subscriptionId: subscription.id, reason });
        this.deps.logger.error(
          { tenantId, eventId: event.id, subscriptionId: subscription.id, err: reason },
          'event subscription could not start its target',
        );
      }
    }

    /**
     * The mark is written, then reported.
     *
     * `createDeduplicated` handed back the row *before* `processedAt` was set, so returning
     * that row unchanged would answer `processedAt: null` for an event this call has just
     * finished processing — a response that contradicts the row it describes. Rather than
     * re-reading the row, the summary is built from the row plus the timestamp this call
     * wrote: the value is known exactly, and a second query to learn what we just wrote is
     * the kind of round trip that grows into a habit.
     */
    const processedAt = new Date(this.now());
    await this.deps.events.markProcessed(tenantId, event.id, processedAt);

    this.deps.logger.info(
      {
        tenantId,
        eventId: event.id,
        type: event.type,
        source: event.source,
        matchedSubscriptions: matched.length,
        triggered,
        failed: failures.length,
      },
      'event ingested',
    );

    this.deps.emit?.(tenantId, {
      name: 'event.processed',
      payload: {
        eventId: event.id,
        matchedSubscriptions: matched.length,
        triggered,
      },
    });

    return {
      event: toEventSummary({ ...event, processedAt }),
      deduplicated: false,
      matchedSubscriptions: matched.length,
      triggered,
      failures,
    };
  }

  async list(tenantId: string, query: ListEventsQuery = {}): Promise<EventListResult> {
    const rows = await this.deps.events.listEvents(tenantId, {
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.source === undefined ? {} : { source: query.source }),
      ...(query.subject === undefined ? {} : { subject: query.subject }),
      ...(query.processed === undefined ? {} : { processed: query.processed }),
      ...(query.since === undefined ? {} : { since: query.since }),
      ...(query.until === undefined ? {} : { until: query.until }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return { events: rows.map(toEventSummary) };
  }

  async get(tenantId: string, id: string): Promise<EventSummary> {
    const row = await this.deps.events.findEventById(tenantId, id);
    if (row === null) {
      throw new ApiError('NOT_FOUND', 'The event does not exist', { eventId: id });
    }
    return toEventSummary(row);
  }

  // ── subscriptions ───────────────────────────────────────────────────────────

  async createSubscription(
    tenantId: string,
    input: CreateEventSubscriptionInput,
  ): Promise<EventSubscriptionSummary> {
    await this.assertTargetExists(tenantId, input.targetKind, input.targetId);

    const row = await this.deps.events.createSubscription({
      tenantId,
      topic: input.topic,
      filter: input.filter ?? {},
      targetKind: input.targetKind,
      targetId: input.targetId,
      secret: input.secret ?? null,
      enabled: input.enabled ?? true,
    });

    this.deps.logger.info(
      {
        tenantId,
        subscriptionId: row.id,
        topic: row.topic,
        targetKind: row.targetKind,
        targetId: row.targetId,
        signed: row.secret !== null,
      },
      'event subscription created',
    );

    return toEventSubscriptionSummary(row);
  }

  async listSubscriptions(
    tenantId: string,
    query: ListEventSubscriptionsQuery = {},
  ): Promise<EventSubscriptionListResult> {
    const rows = await this.deps.events.listSubscriptions(tenantId, {
      ...(query.topic === undefined ? {} : { topic: query.topic }),
      ...(query.enabled === undefined ? {} : { enabled: query.enabled }),
      ...(query.targetKind === undefined ? {} : { targetKind: query.targetKind }),
      ...(query.targetId === undefined ? {} : { targetId: query.targetId }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return { subscriptions: rows.map(toEventSubscriptionSummary) };
  }

  async updateSubscription(
    tenantId: string,
    id: string,
    input: UpdateEventSubscriptionInput,
  ): Promise<EventSubscriptionSummary> {
    const existing = await this.deps.events.findSubscriptionById(tenantId, id);
    if (existing === null) {
      throw new ApiError('NOT_FOUND', 'The event subscription does not exist', {
        subscriptionId: id,
      });
    }

    const updated = await this.deps.events.updateSubscription(tenantId, id, {
      ...(input.topic === undefined ? {} : { topic: input.topic }),
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.secret === undefined ? {} : { secret: input.secret }),
    });
    if (updated === null) {
      throw new ApiError('NOT_FOUND', 'The event subscription does not exist', {
        subscriptionId: id,
      });
    }

    this.deps.logger.info({ tenantId, subscriptionId: id }, 'event subscription updated');
    return toEventSubscriptionSummary(updated);
  }

  async deleteSubscription(tenantId: string, id: string): Promise<void> {
    const deleted = await this.deps.events.deleteSubscription(tenantId, id);
    if (!deleted) {
      throw new ApiError('NOT_FOUND', 'The event subscription does not exist', {
        subscriptionId: id,
      });
    }
    this.deps.logger.info({ tenantId, subscriptionId: id }, 'event subscription deleted');
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * A subscription must point at something that exists.
   *
   * Checked at creation for the same reason a schedule's target is: the alternative is a
   * subscription that matches, fails to start anything, and reports nothing — which looks
   * exactly like a subscription whose topic never occurs. The check is repeated here rather
   * than left to fire time because by then the failure is buried in a queue consumer's logs.
   */
  private async assertTargetExists(
    tenantId: string,
    targetKind: string,
    targetId: string,
  ): Promise<void> {
    const exists = await this.targetExists(tenantId, targetKind, targetId);
    if (!exists) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `The ${targetKind} this subscription points at does not exist`,
        { field: 'targetId', targetKind, targetId },
      );
    }
  }

  private async targetExists(
    tenantId: string,
    targetKind: string,
    targetId: string,
  ): Promise<boolean> {
    if (targetKind === 'task') return (await this.deps.tasks.findById(tenantId, targetId)) !== null;
    if (targetKind === 'workflow') {
      return (await this.deps.workflows.findById(tenantId, targetId)) !== null;
    }
    if (targetKind === 'agent') return (await this.deps.agents.findById(tenantId, targetId)) !== null;
    return false;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/**
 * Whether a subscription's filter admits this event.
 *
 * An absent key means "any". An exact string comparison, deliberately: a pattern language
 * here would be a second query syntax to secure and to explain, and the spec asks only for a
 * filter on source and subject.
 */
function matchesFilter(
  filter: unknown,
  source: string,
  subject: string | null,
): boolean {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) return true;
  const record = filter as Record<string, unknown>;

  const wantSource = record['source'];
  if (typeof wantSource === 'string' && wantSource !== source) return false;

  const wantSubject = record['subject'];
  if (typeof wantSubject === 'string' && wantSubject !== (subject ?? '')) return false;

  return true;
}
