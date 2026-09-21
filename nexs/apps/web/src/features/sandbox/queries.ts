/**
 * Sandbox session control — the write half of the Sandbox page.
 *
 * ## The one route here that runs arbitrary code
 *
 * `POST /:id/exec` evaluates JavaScript in the worker. It is guarded on the server (a session
 * must exist, the input is a closed schema, the worker enforces its own timeout and output cap)
 * but it is still the most direct way to make the system do something, so the page puts a
 * confirm in front of it. That is a UI judgement the route does not need and the operator does.
 *
 * ## What the response carries, and why both halves are kept
 *
 * `SandboxExecOutcome` is deliberately two things at once: the persisted `execution` row — which
 * is what the executions list re-reads — and the ephemeral `value` the code returned, which has
 * no column and is returned here or not at all. The page shows both, and labels the return value
 * as unpersisted rather than letting it look like a column that happens to be missing later.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SandboxExecutionSummary, SandboxSessionSummary } from '@nexs/shared';
import { apiOf, qs } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

/** The outcome of one exec: the durable row plus the run's own return value. */
export interface SandboxExecOutcome {
  execution: SandboxExecutionSummary;
  /** The code's return value. Not stored — see the file header. */
  value?: unknown;
  durationMs: number;
  terminatedReason?: string;
  outputTruncated: boolean;
}

export interface SandboxExecInput {
  code: string;
  input?: unknown;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export function useSandboxSessions(filters: { status?: string; runId?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: [...queryKeys.sandbox.sessions, filters] as const,
    queryFn: () =>
      apiOf<SandboxSessionSummary[]>(
        `/sandbox${qs({ ...filters, limit: filters.limit ?? 100 })}`,
        'sessions',
      ),
  });
}

export function useSandboxSession(id: string | null) {
  return useQuery({
    queryKey: [...queryKeys.sandbox.sessions, id ?? ''] as const,
    queryFn: () => apiOf<SandboxSessionSummary>(`/sandbox/${id ?? ''}`, 'session'),
    enabled: id !== null && id !== '',
  });
}

export function useSandboxExecutions(sessionId: string | null) {
  return useQuery({
    queryKey: [...queryKeys.sandbox.sessions, sessionId ?? '', 'executions'] as const,
    queryFn: () =>
      apiOf<SandboxExecutionSummary[]>(`/sandbox/${sessionId ?? ''}/executions`, 'executions'),
    enabled: sessionId !== null && sessionId !== '',
  });
}

/** Open a session. `workdir` is resolved inside the tenant's root by the server, never trusted. */
export function useCreateSandboxSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { workdir?: string; runId?: string | null } = {}) =>
      apiOf<SandboxSessionSummary>('/sandbox', 'session', { method: 'POST', body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.sandbox.sessions }),
  });
}

/**
 * Run JavaScript.
 *
 * The executions list for the session is invalidated on success, which is what makes the
 * "Executions" panel show the row from *this* call rather than the previous one. A `sandbox.started`
 * frame also arrives, but invalidating here means the panel is correct before the frame lands.
 */
export function useRunSandboxCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, ...input }: SandboxExecInput & { sessionId: string }) =>
      apiOf<SandboxExecOutcome>(`/sandbox/${sessionId}/exec`, 'outcome', { method: 'POST', body: input }),
    onSuccess: (_outcome, variables) => {
      void client.invalidateQueries({ queryKey: queryKeys.sandbox.sessions });
      void client.invalidateQueries({
        queryKey: [...queryKeys.sandbox.sessions, variables.sessionId, 'executions'],
      });
      void client.invalidateQueries({ queryKey: queryKeys.runs.all });
    },
  });
}
