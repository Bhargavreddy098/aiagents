/**
 * The dashboard query.
 *
 * `GET /api/dashboard` returns the snapshot **flat** — the controller does
 * `res.json(await dashboard.get(...))`, so there is no envelope key and `api` (not `apiOf`)
 * is correct. The shape is `DashboardSummary`.
 */

import { useQuery } from '@tanstack/react-query';
import type { DashboardSummary } from '@nexs/shared';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: () => api<DashboardSummary>('/dashboard'),
    // The SSE map invalidates this key on every `run.*`, `step.*`, `approval.*` and
    // `schedule.*` frame, so the snapshot refreshes when something actually changes.
    staleTime: 10_000,
  });
}
