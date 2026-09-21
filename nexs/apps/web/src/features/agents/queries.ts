/**
 * Agent queries.
 *
 * The status actions are one mutation factory: `activate`, `pause`, `resume`, `disable` and
 * `duplicate` are all `POST /agents/:id/<verb>` returning `{ agent }`, and writing five
 * near-identical hooks would mean five places for the invalidation list to fall out of date.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentDetail, AgentSummary, CreateAgentInput, UpdateAgentInput } from '@nexs/shared';
import { apiOf, qs, request } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

export interface AgentFilters {
  status?: string;
  limit?: number;
}

export function useAgents(filters: AgentFilters = {}) {
  return useQuery({
    queryKey: [...queryKeys.agents.all, filters] as const,
    queryFn: () => apiOf<AgentSummary[]>(`/agents${qs({ ...filters })}`, 'agents'),
  });
}

export function useAgent(id: string | null) {
  return useQuery({
    queryKey: queryKeys.agents.one(id ?? ''),
    queryFn: () => apiOf<AgentDetail>(`/agents/${id ?? ''}`, 'agent'),
    enabled: id !== null && id !== '',
  });
}

function invalidateAgentTree(client: ReturnType<typeof useQueryClient>, id?: string): void {
  void client.invalidateQueries({ queryKey: queryKeys.agents.all });
  if (id !== undefined) void client.invalidateQueries({ queryKey: queryKeys.agents.one(id) });
}

export function useCreateAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentInput) =>
      apiOf<AgentDetail>('/agents', 'agent', { method: 'POST', body: input }),
    onSuccess: (agent) => invalidateAgentTree(client, agent.id),
  });
}

export function useUpdateAgent(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAgentInput) =>
      apiOf<AgentDetail>(`/agents/${id}`, 'agent', { method: 'PATCH', body: input }),
    onSuccess: () => invalidateAgentTree(client, id),
  });
}

export type AgentAction = 'activate' | 'pause' | 'resume' | 'disable' | 'duplicate' | 'archive';

export function useAgentAction(action: AgentAction) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiOf<AgentDetail>(`/agents/${id}/${action}`, 'agent', { method: 'POST' }),
    onSuccess: (agent) => {
      invalidateAgentTree(client, agent.id);
      // A duplicated agent is a *new* agent, so the list is the only place it shows up —
      // which is why the list invalidation above is not conditional on the action.
    },
  });
}

/**
 * Delete is the one action with no response body: the row is archived and the API answers
 * 204. `request` handles that, and returning `undefined` is the honest result.
 */
export function useArchiveAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request(`/agents/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateAgentTree(client),
  });
}
