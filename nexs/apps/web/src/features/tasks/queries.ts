/**
 * Task queries.
 *
 * `triggerType: 'immediate'` is how work actually starts in this system — there is no
 * `POST /runs`. Creating an immediate task is what produces a run, which is why the agent
 * workspace's "Run" action and the task list's "New task" both land here.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateTaskInput, TaskDetail, TaskSummary } from '@nexs/shared';
import { apiOf, qs } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

export interface TaskFilters {
  status?: string;
  goalId?: string;
  agentId?: string;
}

export function useTasks(filters: TaskFilters = {}) {
  return useQuery({
    queryKey: [...queryKeys.tasks.all, filters] as const,
    queryFn: () => apiOf<TaskSummary[]>(`/tasks${qs({ ...filters })}`, 'tasks'),
  });
}

export function useTask(id: string | null) {
  return useQuery({
    queryKey: queryKeys.tasks.one(id ?? ''),
    queryFn: () => apiOf<TaskDetail>(`/tasks/${id ?? ''}`, 'task'),
    enabled: id !== null && id !== '',
  });
}

function invalidateTasks(client: ReturnType<typeof useQueryClient>, id?: string): void {
  void client.invalidateQueries({ queryKey: queryKeys.tasks.all });
  void client.invalidateQueries({ queryKey: queryKeys.dashboard });
  if (id !== undefined) void client.invalidateQueries({ queryKey: queryKeys.tasks.one(id) });
}

export function useCreateTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) =>
      apiOf<TaskDetail>('/tasks', 'task', { method: 'POST', body: input }),
    onSuccess: (task) => {
      invalidateTasks(client, task.id);
      // An immediate task starts a run, so the run list is stale the moment this returns.
      void client.invalidateQueries({ queryKey: queryKeys.runs.all });
    },
  });
}

export function useTaskAction(action: 'cancel' | 'retry') {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiOf<TaskDetail>(`/tasks/${id}/${action}`, 'task', { method: 'POST' }),
    onSuccess: (task) => {
      invalidateTasks(client, task.id);
      void client.invalidateQueries({ queryKey: queryKeys.runs.all });
    },
  });
}
