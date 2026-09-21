import type { Event, EventSubscription, Schedule } from '@prisma/client';
import type {
  EventSubscriptionSummary,
  EventSummary,
  ScheduleDetail,
  ScheduleKind,
  ScheduleSummary,
  ScheduleTargetKind,
  EventTargetKind,
} from '@nexs/shared';

/**
 * Row → wire for schedules, events and subscriptions.
 *
 * Two of these carry a rule worth stating rather than leaving implicit.
 *
 * **`EventSubscriptionSummary` has `hasSecret`, never the secret.** The column is an HMAC
 * key used to verify inbound webhooks. A response that could return it would turn any read
 * of the subscription list into a way to forge a webhook — so the mapper answers the only
 * question the UI actually has ("is this subscription signed?") and nothing more.
 *
 * **`deliveryTarget` is passed through as-is.** It is an open-ended Json bag owned by the
 * v2 delivery feature, and this layer has no opinion about its shape. Narrowing it here
 * would mean every addition to the delivery vocabulary needs a change in a mapper that does
 * not care.
 */

function toIso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

function requiredIso(value: Date): string {
  return value.toISOString();
}

export function toScheduleSummary(row: Schedule): ScheduleSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ScheduleKind,
    cron: row.cron,
    timezone: row.timezone,
    runAt: toIso(row.runAt),
    targetKind: row.targetKind as ScheduleTargetKind,
    targetId: row.targetId,
    enabled: row.enabled,
    lastFiredAt: toIso(row.lastFiredAt),
    nextFireAt: toIso(row.nextFireAt),
    createdAt: requiredIso(row.createdAt),
    updatedAt: requiredIso(row.updatedAt),
  };
}

export function toScheduleDetail(row: Schedule): ScheduleDetail {
  return {
    ...toScheduleSummary(row),
    eventSubscriptionId: row.eventSubscriptionId,
    deliveryTarget: row.deliveryTarget ?? null,
  };
}

export function toEventSummary(row: Event): EventSummary {
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    subject: row.subject,
    externalId: row.externalId,
    payload: row.payload,
    metadata: row.metadata,
    occurredAt: requiredIso(row.occurredAt),
    processedAt: toIso(row.processedAt),
  };
}

export function toEventSubscriptionSummary(row: EventSubscription): EventSubscriptionSummary {
  return {
    id: row.id,
    topic: row.topic,
    filter: readFilter(row.filter),
    targetKind: row.targetKind as EventTargetKind,
    targetId: row.targetId,
    enabled: row.enabled,
    // The key itself never leaves the server. See the file header.
    hasSecret: row.secret !== null && row.secret.length > 0,
    createdAt: requiredIso(row.createdAt),
  };
}

/**
 * The stored filter, narrowed to the two fields the matcher honours.
 *
 * A Json column can hold anything, and an older or hand-edited row may hold keys this
 * version does not read. Returning only the known keys means the wire type cannot advertise
 * a filter that the matcher will ignore — which would look like a subscription that does not
 * work rather than one whose condition was never supported.
 */
function readFilter(value: unknown): { source?: string; subject?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const filter: { source?: string; subject?: string } = {};
  if (typeof record['source'] === 'string') filter.source = record['source'];
  if (typeof record['subject'] === 'string') filter.subject = record['subject'];
  return filter;
}
