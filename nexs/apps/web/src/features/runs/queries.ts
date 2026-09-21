/**
 * Run queries.
 *
 * The run detail is one request: `GET /api/runs/:id` composes steps, tool calls, receipts,
 * verifications and model usage. That is deliberate on the server's part — the workspace has
 * nine tabs and fetching per tab would mean nine spinners for one page.
 *
 * The two tabs that are **not** in that payload are browser sessions and sandbox
 * executions, because they are their own resources with their own lifecycles. Both accept a
 * `runId` filter, so those two tabs issue their own requests.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApprovalSummary,
  BrowserSessionSummary,
  RunDetail,
  RunListResponse,
  SandboxExecutionSummary,
  SandboxSessionSummary,
} from '@nexs/shared';
import { api, apiOf, qs, request } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

export interface RunFilters {
  status?: string;
  agentId?: string;
  goalId?: string;
  taskId?: string;
  workflowId?: string;
  limit?: number;
  offset?: number;
}

export function useRuns(filters: RunFilters = {}) {
  return useQuery({
    // The filters are part of the key, so two different filter sets are two cache entries
    // rather than one entry that flickers between them.
    queryKey: [...queryKeys.runs.all, filters] as const,
    queryFn: () => api<RunListResponse>(`/runs${qs({ ...filters })}`),
  });
}

export function useRun(id: string | null) {
  return useQuery({
    queryKey: queryKeys.runs.one(id ?? ''),
    queryFn: () => apiOf<RunDetail>(`/runs/${id ?? ''}`, 'run'),
    enabled: id !== null && id !== '',
  });
}

export function useRunBrowserSessions(runId: string) {
  return useQuery({
    queryKey: ['browser', 'sessions', { runId }] as const,
    queryFn: () =>
      apiOf<BrowserSessionSummary[]>(`/browser${qs({ runId, limit: 100 })}`, 'sessions'),
    enabled: runId !== '',
  });
}

export function useRunSandboxSessions(runId: string) {
  return useQuery({
    queryKey: ['sandbox', 'sessions', { runId }] as const,
    queryFn: () =>
      apiOf<SandboxSessionSummary[]>(`/sandbox${qs({ runId, limit: 100 })}`, 'sessions'),
    enabled: runId !== '',
  });
}

/**
 * Every execution across a run's sandbox sessions.
 *
 * A session has no executions in its summary — they are a separate collection — so this
 * fans out one request per session. Sessions per run are few (usually one), which is why
 * the fan-out is acceptable rather than needing an endpoint that does not exist.
 */
export function useRunSandboxExecutions(runId: string) {
  const sessions = useRunSandboxSessions(runId);
  const sessionIds = (sessions.data ?? []).map((session) => session.id);

  return useQuery({
    queryKey: ['sandbox', 'executions', { runId, sessionIds }] as const,
    queryFn: async (): Promise<SandboxExecutionSummary[]> => {
      const batches = await Promise.all(
        sessionIds.map((id) =>
          apiOf<SandboxExecutionSummary[]>(`/sandbox/${id}/executions`, 'executions'),
        ),
      );
      // Newest first across sessions: an execution's `startedAt` is the only ordering that
      // makes sense once two sessions are interleaved.
      return batches
        .flat()
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    },
    enabled: sessionIds.length > 0,
  });
}

export function useRunApprovals(runId: string) {
  return useQuery({
    queryKey: [...queryKeys.approvals.all, { runId }] as const,
    queryFn: () =>
      api<{ approvals: ApprovalSummary[]; pendingCount: number }>(
        `/approvals${qs({ runId })}`,
      ),
    enabled: runId !== '',
  });
}

/** Cancel, pause and resume differ only in the verb, so they share one mutation shape. */
function useRunVerb(verb: 'cancel' | 'pause' | 'resume') {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiOf<RunDetail>(`/runs/${id}/${verb}`, 'run', { method: 'POST' }),
    onSuccess: (run) => {
      client.setQueryData(queryKeys.runs.one(run.id), run);
      void client.invalidateQueries({ queryKey: queryKeys.runs.all });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useCancelRun() {
  return useRunVerb('cancel');
}

export function usePauseRun() {
  return useRunVerb('pause');
}

export function useResumeRun() {
  return useRunVerb('resume');
}

/** A bare POST for the workflow-run action, which lives on the workflow route. */
export function useStartWorkflowRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (workflowId: string) =>
      request(`/workflows/${workflowId}/run`, { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.runs.all });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}
