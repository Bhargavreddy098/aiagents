/**
 * Provider and model queries.
 *
 * `POST /providers/:id/test` and `POST /providers/:id/sync` are the two operations that talk
 * to a vendor, and both are explicit user actions rather than something a page load
 * triggers — a page that probed every provider on mount would make the operator wait on
 * somebody else's API to read their own settings.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ModelSummary, ProviderDetail } from '@nexs/shared';
import { apiOf, qs, request } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import { useProviders } from '../catalog/queries';

export interface ProviderTestResult {
  providerId: string;
  status: string;
  httpStatus: number | null;
  reason: string | null;
}

export interface ProviderSyncResult {
  providerId: string;
  created: number;
  existing: number;
  total: number;
  warning: string | null;
}

export interface CreateProviderInput {
  name: string;
  type: string;
  baseUrl?: string;
  apiKey?: string;
  organizationId?: string;
  projectId?: string;
  enabled?: boolean;
  verify?: boolean;
}

export { useProviders };

export function useProvider(id: string | null) {
  return useQuery({
    queryKey: [...queryKeys.providers, id ?? ''] as const,
    queryFn: () => apiOf<ProviderDetail>(`/providers/${id ?? ''}`, 'provider'),
    enabled: id !== null && id !== '',
  });
}

export function useCreateProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProviderInput) =>
      apiOf<ProviderDetail>('/providers', 'provider', { method: 'POST', body: input }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.providers });
      // A provider created with `verify: true` syncs models as a side effect, so the model
      // list is stale the moment this resolves.
      void client.invalidateQueries({ queryKey: queryKeys.models });
    },
  });
}

export function useUpdateProvider(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<CreateProviderInput>) =>
      apiOf<ProviderDetail>(`/providers/${id}`, 'provider', { method: 'PATCH', body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.providers }),
  });
}

export function useTestProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiOf<ProviderTestResult>(`/providers/${id}/test`, 'test', { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.providers }),
  });
}

export function useSyncProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiOf<ProviderSyncResult>(`/providers/${id}/sync`, 'sync', { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.providers });
      void client.invalidateQueries({ queryKey: queryKeys.models });
    },
  });
}

/**
 * Delete a provider.
 *
 * `routes/providers.ts` has had `DELETE /:id` since the vault was surfaced, and nothing called
 * it — so a provider added by mistake could not be removed from the UI at all. It answers 204,
 * which is why this uses `request` rather than `apiOf`: there is no key to read out of an empty
 * body, and `apiOf` would throw `MALFORMED_RESPONSE` on a request that succeeded.
 *
 * The model catalogue is invalidated as well as the provider list: the rows a provider synced are
 * the provider's, and a deleted provider whose models were still listed would offer the composer
 * models that nothing can serve.
 */
export function useDeleteProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request(`/providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.providers });
      void client.invalidateQueries({ queryKey: queryKeys.models });
      // A model that was the chat default may have just gone away.
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export interface ModelFilters {
  providerId?: string;
  type?: string;
  enabled?: boolean;
}

export function useModelList(filters: ModelFilters = {}) {
  return useQuery({
    queryKey: [...queryKeys.models, filters] as const,
    queryFn: () => apiOf<ModelSummary[]>(`/models${qs({ ...filters })}`, 'models'),
  });
}

export function useUpdateModel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; enabled?: boolean; capabilities?: string[] }) =>
      apiOf<ModelSummary>(`/models/${id}`, 'model', { method: 'PATCH', body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.models }),
  });
}
