/**
 * Notification queries.
 *
 * `NotificationListResult` is returned **flat** — `{ notifications, unreadCount }` at the top
 * level — so this uses `api`, not `apiOf`. The count travels with the list deliberately (see
 * `types/approvals.ts`): two endpoints would let the bell show three while the panel shows
 * two, and that disagreement is exactly what an operator notices and cannot explain.
 *
 * The same query feeds the bell's badge and the panel's rows, so they cannot drift.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationListResult } from '@nexs/shared';
import { api, request } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

export function useNotifications() {
  return useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => api<NotificationListResult>('/notifications'),
    // Notifications arrive over SSE, which invalidates this key. Polling as well would be a
    // second, slower source of truth for the same badge.
    staleTime: 60_000,
  });
}

export function useMarkNotificationRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request(`/notifications/${id}/read`, { method: 'PATCH' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.notifications }),
  });
}

export function useMarkAllNotificationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request('/notifications/read-all', { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.notifications }),
  });
}
