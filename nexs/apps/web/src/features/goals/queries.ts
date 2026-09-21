/**
 * Goal queries.
 *
 * `useGoalVerifications` is the interesting one. Verifications are not on the goal — they
 * hang off runs, and a `RunVerificationView` carries the `goalId` it was checked for. So
 * "did this goal's criteria pass?" is answered by reading the goal's runs and collecting the
 * verifications that name it. The fan-out is bounded by `VERIFICATION_SCAN_LIMIT` because a
 * long-lived goal accumulates runs and this is a page, not a report.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateGoalInput,
  GoalDetail,
  GoalSummary,
  RunDetail,
  RunVerificationView,
} from '@nexs/shared';
import { api, apiOf, qs } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

export interface GoalFilters {
  status?: string;
  agentId?: string;
}

export function useGoals(filters: GoalFilters = {}) {
  return useQuery({
    queryKey: [...queryKeys.goals.all, filters] as const,
    queryFn: () => apiOf<GoalSummary[]>(`/goals${qs({ ...filters })}`, 'goals'),
  });
}

export function useGoal(id: string | null) {
  return useQuery({
    queryKey: queryKeys.goals.one(id ?? ''),
    queryFn: () => apiOf<GoalDetail>(`/goals/${id ?? ''}`, 'goal'),
    enabled: id !== null && id !== '',
  });
}

export function useCreateGoal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateGoalInput) =>
      apiOf<GoalDetail>('/goals', 'goal', { method: 'POST', body: input }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.goals.all });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useGoalAction(action: 'pause' | 'resume') {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiOf<GoalDetail>(`/goals/${id}/${action}`, 'goal', { method: 'POST' }),
    onSuccess: (goal) => {
      void client.invalidateQueries({ queryKey: queryKeys.goals.all });
      void client.invalidateQueries({ queryKey: queryKeys.goals.one(goal.id) });
    },
  });
}

/** How many of a goal's runs are inspected for verifications. Newest first. */
export const VERIFICATION_SCAN_LIMIT = 20;

export interface GoalVerification {
  verification: RunVerificationView;
  runId: string;
}

/**
 * Every verification recorded against this goal, across its runs.
 *
 * Runs are read newest-first and capped, so the cost is bounded and the answer is "the
 * verifications from the most recent N runs" rather than an unbounded crawl. A goal whose
 * verification happened more than N runs ago is rare, and the run list on the page is where
 * an operator would go looking anyway.
 */
export function useGoalVerifications(goalId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.goals.one(goalId), 'verifications'] as const,
    queryFn: async (): Promise<GoalVerification[]> => {
      const list = await api<{ runs: { id: string }[]; total: number }>(
        `/runs${qs({ goalId, limit: VERIFICATION_SCAN_LIMIT })}`,
      );

      const details = await Promise.all(
        list.runs.map((run) => apiOf<RunDetail>(`/runs/${run.id}`, 'run')),
      );

      return details.flatMap((run) =>
        run.verifications
          .filter((verification) => verification.goalId === goalId)
          .map((verification) => ({ verification, runId: run.id })),
      );
    },
    enabled,
  });
}
