/**
 * Approval queries.
 *
 * One key — `['approvals']` — for the whole inbox, with the status filter applied in memory.
 *
 * That is a deliberate departure from "put the filter in the key". The sidebar's pending
 * badge and the inbox's rows must never disagree, and the server already returns
 * `pendingCount` computed from the same clock as the rows it just mapped. Fetching a
 * filtered list *and* an unfiltered count would reintroduce exactly the two-sources
 * problem the server went out of its way to avoid. One fetch, one truth, filtered for
 * display.
 *
 * The cost is that the list is not server-paginated. `listApprovalsSchema` bounds `limit`,
 * and approvals are a queue a human drains, not a growing archive — so the honest trade is
 * to fetch the bounded list once and filter locally.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalDecision, ApprovalDetail, ApprovalSummary } from '@nexs/shared';
import { api, apiOf, qs, request } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

export interface ApprovalListResult {
  approvals: ApprovalSummary[];
  /** Pending and not past its deadline, as of the response. */
  pendingCount: number;
}

export function useApprovals() {
  return useQuery({
    queryKey: queryKeys.approvals.all,
    queryFn: () => api<ApprovalListResult>(`/approvals${qs({ actionableOnly: false })}`),
  });
}

/** The pending count on its own, for the sidebar. Reads the same query, so it is free. */
export function usePendingApprovalCount(): number {
  const query = useApprovals();
  return query.data?.pendingCount ?? 0;
}

export function useApproval(id: string | null) {
  return useQuery({
    queryKey: queryKeys.approvals.one(id ?? ''),
    queryFn: () => apiOf<ApprovalDetail>(`/approvals/${id ?? ''}`, 'approval'),
    enabled: id !== null && id !== '',
  });
}

export interface DecisionResult {
  approval: ApprovalDetail;
  /** What happened to the run the approval gated — the caller's next question. */
  runOutcome: unknown;
}

export function useDecideApproval() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: ApprovalDecision }) =>
      apiOf<ApprovalDetail>(`/approvals/${id}/decide`, 'approval', {
        method: 'POST',
        body: { decision },
      }),
    onSuccess: () => {
      // Both keys, because answering an approval moves the run that was parked on it.
      void client.invalidateQueries({ queryKey: queryKeys.approvals.all });
      void client.invalidateQueries({ queryKey: queryKeys.runs.all });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

/** Mark a notification read, from inside the approval flow. Kept here for the drawer. */
export function useDismissNotification() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request(`/notifications/${id}/read`, { method: 'PATCH' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.notifications }),
  });
}
