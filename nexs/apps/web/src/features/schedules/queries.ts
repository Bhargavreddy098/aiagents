/**
 * Schedules — `/api/schedules`, the timetable half of Phase 11.
 *
 * ## The whole `/api/schedules` prefix had no client
 *
 * Seven routes: list, create, get, patch, enable, disable, fire. None was called from the UI.
 * The consequence was concrete rather than cosmetic — `TaskService` validates a `recurring`
 * trigger by looking up the schedule it names, so a task could only be attached to a schedule
 * that had been created some other way. There was no way to create the thing the task needed.
 *
 * ## A schedule never *is* the work
 *
 * It points at a target (`task` or `workflow`) and firing it starts that target. So nothing here
 * carries a payload: the target's own configuration is the payload, and a schedule that could
 * override it would be a second place the same run is described. That is why the create form
 * asks for a target id and not for instructions.
 *
 * ## `skipped` is an outcome, not an error
 *
 * `POST /:id/fire` answers `{outcome: 'fired' | 'skipped', reason?}`. A disabled schedule, or one
 * whose target was deleted after the queue job was created, is a normal thing to meet — so the
 * page surfaces `skipped` with its reason rather than reporting a failure that would be retried
 * forever.
 *
 * ## `nextFireAt` is stored, not derived
 *
 * The column is recomputed on every fire and every edit. `null` therefore means "nothing
 * computed yet" — which is reachable for a schedule whose first fire has not been processed —
 * and never "never fires". The table says which it is rather than printing an empty cell beside
 * a one-time schedule that has already run.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ScheduleDetail,
  ScheduleFireResult,
  ScheduleSummary,
  ScheduleTargetKind,
} from '@nexs/shared';
import { api, apiOf, qs, request } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

export function useSchedules(filters: { enabled?: boolean; limit?: number } = {}) {
  return useQuery({
    queryKey: [...queryKeys.schedules, filters] as const,
    // The controller answers the *bare* `ScheduleListResult`, which happens to be `{schedules}`.
    // So the named key the client wants and the shape the server sends are the same object —
    // `api` reads it and `apiOf` would too. `api` is the honest one: it says "this route's body
    // is the result", and a `data` wrapper added later would be handled rather than fatal.
    queryFn: () =>
      apiOf<ScheduleSummary[]>(
        `/schedules${qs({ ...filters, limit: filters.limit ?? 200 })}`,
        'schedules',
      ),
  });
}

export function useSchedule(id: string | null) {
  return useQuery({
    queryKey: [...queryKeys.schedules, id ?? ''] as const,
    queryFn: () => apiOf<ScheduleDetail>(`/schedules/${id ?? ''}`, 'schedule'),
    enabled: id !== null && id !== '',
  });
}

export interface CreateScheduleInput {
  name: string;
  kind: 'one_time' | 'recurring';
  /** Required for `recurring`. */
  cron?: string;
  timezone?: string;
  /** Required for `one_time`. */
  runAt?: string;
  targetKind: ScheduleTargetKind;
  targetId: string;
  enabled?: boolean;
}

export function useCreateSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateScheduleInput) =>
      apiOf<ScheduleDetail>('/schedules', 'schedule', { method: 'POST', body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.schedules }),
  });
}

export function useUpdateSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...input
    }: {
      id: string;
      name?: string;
      cron?: string;
      timezone?: string;
    }) => apiOf<ScheduleDetail>(`/schedules/${id}`, 'schedule', { method: 'PATCH', body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.schedules }),
  });
}

/**
 * Enable and disable are their own routes rather than a `PATCH {enabled}`.
 *
 * They answer without a body, so `request` is right for both — and it is the shape that matters:
 * a 204 has nothing to unwrap, and `apiOf` against a 204 would throw `MALFORMED_RESPONSE` for a
 * request that succeeded perfectly.
 */
export function useSetScheduleEnabled() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      request(`/schedules/${id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.schedules }),
  });
}

/**
 * Fire now, bypassing the timetable.
 *
 * The body is the *bare* `ScheduleFireResult` — `{scheduleId, outcome, reason?, runId?, taskId?,
 * nextFireAt}` — with no `result` wrapper, so `api` is the correct reader. The outcome is a
 * 200 for **both** `fired` and `skipped`, because a skipped fire is a successful request whose
 * answer is "nothing happened, and here is why"; the page renders the two differently rather
 * than treating one as a failure.
 */
export function useFireSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<ScheduleFireResult>(`/schedules/${id}/fire`, { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.schedules });
      // A fire creates a run, so the run list is stale immediately.
      void client.invalidateQueries({ queryKey: queryKeys.runs.all });
    },
  });
}

export function useDeleteSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request(`/schedules/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.schedules }),
  });
}
