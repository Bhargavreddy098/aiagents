/**
 * Events and their subscriptions — §7's other half.
 *
 * A schedule is a timetable, an event is a signal, and both end in the same place: a task or a
 * workflow that starts without anyone clicking. The spec describes them together for that reason
 * and so does this module; the sidebar groups them separately because an operator looking for
 * "what fired this" and one looking for "what is listening" are asking different questions.
 *
 * ## The shape each call answers with
 *
 * The event controller is not consistent about its envelope, and that is a fact about the server
 * rather than a style choice here: `POST /events` (ingest) answers the *bare* `EventIngestResult`,
 * while the list, the subscription list and the subscription create all answer **named** keys.
 * So `api` is right for the first and `apiOf` for the rest — and using the wrong one for the
 * list would render "no events" against a request that succeeded, which is the failure this
 * client exists to prevent.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EventIngestResult,
  EventListResult,
  EventSubscriptionListResult,
  EventSubscriptionSummary,
} from '@nexs/shared';
import { api, apiOf, qs, request } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

/** The ingestion log, newest first. */
export function useEvents(options: { type?: string; source?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: [...queryKeys.events.all, 'list', options] as const,
    queryFn: () =>
      api<EventListResult>(
        `/events${qs({
          type: options.type,
          source: options.source,
          limit: options.limit ?? 100,
        })}`,
      ),
  });
}

export function useEvent(id: string | null) {
  return useQuery({
    queryKey: queryKeys.events.one(id ?? ''),
    queryFn: () => apiOf<EventIngestResult['event']>(`/events/${id ?? ''}`, 'event'),
    enabled: id !== null && id !== '',
  });
}

/**
 * The standing subscriptions — "when an event like this arrives, start that".
 *
 * `hasSecret` rather than the secret: the HMAC key is never readable once written, because a
 * response that could return it would turn any read of this list into a way to forge a webhook.
 * The page states that rather than showing an empty value field.
 */
export function useEventSubscriptions() {
  return useQuery({
    queryKey: queryKeys.events.subscriptions,
    queryFn: () => api<EventSubscriptionListResult>('/events/subscriptions'),
  });
}

export interface CreateSubscriptionInput {
  topic: string;
  filter?: { source?: string; subject?: string };
  targetKind: string;
  targetId: string;
  enabled?: boolean;
  /** Write-only. It appears in no response; see the type's own comment. */
  secret?: string;
}

export function useCreateEventSubscription() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSubscriptionInput) =>
      apiOf<EventSubscriptionSummary>('/events/subscriptions', 'subscription', {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.events.subscriptions }),
  });
}

export function useDeleteEventSubscription() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request(`/events/subscriptions/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.events.subscriptions }),
  });
}

/**
 * Ingest an event by hand.
 *
 * The endpoint exists for the same reason `POST /schedules/:id/fire` does: a working webhook
 * needs a way to be *tested*, and without this the only way to find out whether a subscription
 * matched would be to make the external producer send something. The result reports
 * `deduplicated`, `matchedSubscriptions` and `triggered` separately, so "it was a replay" and
 * "nothing was listening" are distinguishable — which is the difference between a broken
 * subscription and a working one that just ingested a repeat.
 */
export function useIngestEvent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { type: string; source: string; subject?: string; externalId?: string; payload?: unknown }) =>
      api<EventIngestResult>('/events', { method: 'POST', body: input }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.events.all });
      // A matched subscription starts a run, so the run list is stale after an ingest.
      void client.invalidateQueries({ queryKey: queryKeys.runs.all });
    },
  });
}
