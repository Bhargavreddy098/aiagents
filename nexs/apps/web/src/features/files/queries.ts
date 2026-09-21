/**
 * Folder grants — the approved directories an agent may read and write.
 *
 * ## Why this is a separate module from the attachment picker in `chat/queries.ts`
 *
 * Both hit `/api/files`, and they are different resources: an attachment is a file you uploaded,
 * a grant is a directory you approved. The grant is the more dangerous of the two, because it is
 * the one that widens an agent's reach on the host — which is why the server refuses to return
 * `resolvedPath` at all (`types/files.ts`: "a host path never crosses this boundary"). The list
 * here shows `rootPath` — what the operator typed, which they already know — and never a realpath,
 * because there is no realpath to show.
 *
 * ## What the file browser reads
 *
 * `GET /grants/:id/entries` lists one level of a granted folder, with each entry's path relative
 * to the grant's root. The single-file read route (`GET /grants/:id/file`) is a `read`-only
 * affordance and returns the bytes rather than JSON, so it is a link target rather than a query
 * this module owns — see the page for how it is rendered.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FolderGrantSummary, GrantedEntry } from '@nexs/shared';
import { apiOf, qs, request } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

export interface CreateGrantInput {
  /** What the operator typed. The server resolves and stores the realpath itself. */
  rootPath: string;
  read?: boolean;
  write?: boolean;
  agentId?: string | null;
  taskId?: string | null;
}

export function useFolderGrants(filters: { agentId?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: [...queryKeys.grants.all, filters] as const,
    queryFn: () =>
      apiOf<FolderGrantSummary[]>(`/files/grants${qs({ ...filters, limit: filters.limit ?? 200 })}`, 'grants'),
  });
}

/**
 * One directory level inside a grant.
 *
 * `path` is relative to the grant's root and is what the caller turns back into a child listing —
 * so the pagination cursor here is a directory, not an offset, and the browser is a walk rather
 * than a scroll.
 */
export function useGrantEntries(grantId: string | null, path = '') {
  return useQuery({
    queryKey: [...queryKeys.grants.entries(grantId ?? ''), path] as const,
    queryFn: () =>
      apiOf<GrantedEntry[]>(`/files/grants/${grantId ?? ''}/entries${qs({ path })}`, 'entries'),
    enabled: grantId !== null && grantId !== '',
  });
}

export function useCreateGrant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateGrantInput) =>
      apiOf<FolderGrantSummary>('/files/grants', 'grant', { method: 'POST', body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.grants.all }),
  });
}

export function useRevokeGrant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request(`/files/grants/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.grants.all }),
  });
}
