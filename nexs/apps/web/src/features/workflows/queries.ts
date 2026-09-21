/**
 * Workflow queries.
 *
 * A workflow is immutable once versioned: `updateWorkflowSchema` takes the **whole** step
 * set and `POST /:id/versions` publishes it as version n+1. There is no per-step PATCH,
 * because a version that can be edited is not a version — and a run pinned to version 3 must
 * keep meaning what it meant when it started.
 *
 * So "edit" here is "publish a new version", and the hooks are named accordingly.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkflowDetail, WorkflowSummary, WorkflowStatus } from '@nexs/shared';
import { apiOf, qs, request } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

export interface WorkflowStepDraft {
  name: string;
  stepType: string;
  config: Record<string, unknown>;
  toolId?: string;
  dependsOn?: string[];
  onFail?: 'stop' | 'continue' | 'retry_then_stop';
  timeoutMs?: number;
}

export interface WorkflowVersionInput {
  name?: string;
  description?: string;
  steps: WorkflowStepDraft[];
}

export function useWorkflows(status?: WorkflowStatus) {
  return useQuery({
    queryKey: [...queryKeys.workflows.all, { status }] as const,
    queryFn: () => apiOf<WorkflowSummary[]>(`/workflows${qs({ status })}`, 'workflows'),
  });
}

export function useWorkflow(id: string | null) {
  return useQuery({
    queryKey: queryKeys.workflows.one(id ?? ''),
    queryFn: () => apiOf<WorkflowDetail>(`/workflows/${id ?? ''}`, 'workflow'),
    enabled: id !== null && id !== '',
  });
}

function invalidate(client: ReturnType<typeof useQueryClient>, id?: string): void {
  void client.invalidateQueries({ queryKey: queryKeys.workflows.all });
  void client.invalidateQueries({ queryKey: queryKeys.dashboard });
  if (id !== undefined) void client.invalidateQueries({ queryKey: queryKeys.workflows.one(id) });
}

export function useCreateWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: WorkflowVersionInput) =>
      apiOf<WorkflowDetail>('/workflows', 'workflow', { method: 'POST', body: input }),
    onSuccess: (workflow) => invalidate(client, workflow.id),
  });
}

/** Publish version n+1. */
export function usePublishWorkflowVersion(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: WorkflowVersionInput) =>
      apiOf<WorkflowDetail>(`/workflows/${id}/versions`, 'workflow', {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => invalidate(client, id),
  });
}

export function useWorkflowActivation(action: 'activate' | 'disable') {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiOf<WorkflowDetail>(`/workflows/${id}/${action}`, 'workflow', { method: 'POST' }),
    onSuccess: (workflow) => invalidate(client, workflow.id),
  });
}

export interface RunWorkflowInput {
  agentId?: string;
  goalId?: string;
  taskId?: string;
  input?: Record<string, unknown>;
}

export function useRunWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: RunWorkflowInput }) =>
      request(`/workflows/${id}/run`, { method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.runs.all });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}
