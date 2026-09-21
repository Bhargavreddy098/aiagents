/**
 * Skills — versioned prompt templates (`types/skills.ts`).
 *
 * The whole `/api/skills` prefix had no client at all before this module: the service and the
 * router were built and the UI never called either. This is the frontend half.
 *
 * ## Why a skill is not a tool, restated for the UI's benefit
 *
 * A skill changes *what the model is asked to do*; a tool *does* something. That distinction is
 * why the Skills section renders a prompt template and an argument schema, and why it offers no
 * "invoke" button — the only way to use a skill is to point a run at it. The page says so rather
 * than leaving the absence of a button to be interpreted as a missing feature.
 *
 * ## Versions are immutable
 *
 * Editing means publishing version N+1. The detail page shows every version rather than only the
 * latest, because a run that used version 3 must still be able to show what version 3 said —
 * so the versions list is the feature, not a debug view.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SkillDetail, SkillSummary, SkillVersionSummary } from '@nexs/shared';
import { apiOf, qs, request } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

export function useSkills(
  filters: { status?: string; q?: string; limit?: number } = {},
) {
  return useQuery({
    queryKey: [...queryKeys.skills.all, filters] as const,
    queryFn: () => apiOf<SkillSummary[]>(`/skills${qs({ ...filters, limit: filters.limit ?? 200 })}`, 'skills'),
  });
}

export function useSkill(id: string | null) {
  return useQuery({
    queryKey: queryKeys.skills.one(id ?? ''),
    queryFn: () => apiOf<SkillDetail>(`/skills/${id ?? ''}`, 'skill'),
    enabled: id !== null && id !== '',
  });
}

/**
 * The version history, on its own.
 *
 * `SkillDetail` already inlines `versions`, so the detail page does not need this — it calls it
 * because publishing a version invalidates *this* key and the detail query is a different one,
 * and a page that read versions out of the detail would have to refetch the whole skill to see
 * the new row.
 */
export function useSkillVersions(id: string | null) {
  return useQuery({
    queryKey: queryKeys.skills.versions(id ?? ''),
    queryFn: () => apiOf<SkillVersionSummary[]>(`/skills/${id ?? ''}/versions`, 'versions'),
    enabled: id !== null && id !== '',
  });
}

export interface CreateSkillInput {
  name: string;
  description?: string;
  promptTemplate: string;
  argsSchema?: unknown;
}

export function useCreateSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSkillInput) =>
      apiOf<SkillDetail>('/skills', 'skill', { method: 'POST', body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.skills.all }),
  });
}

export function useUpdateSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; name?: string; description?: string; status?: string }) =>
      apiOf<SkillDetail>(`/skills/${id}`, 'skill', { method: 'PATCH', body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.skills.all }),
  });
}

/**
 * Publish a new version.
 *
 * The immutable-version rule made visible: this does not edit version 3, it creates version 4.
 * The mutation reports the created version so the page can point at it rather than making the
 * operator find it in the list.
 */
export function usePublishSkillVersion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, promptTemplate, argsSchema }: { id: string; promptTemplate: string; argsSchema?: unknown }) =>
      apiOf<SkillVersionSummary>(`/skills/${id}/versions`, 'version', {
        method: 'POST',
        body: { promptTemplate, ...(argsSchema === undefined ? {} : { argsSchema }) },
      }),
    onSuccess: (_version, variables) => {
      void client.invalidateQueries({ queryKey: queryKeys.skills.versions(variables.id) });
      void client.invalidateQueries({ queryKey: queryKeys.skills.one(variables.id) });
      void client.invalidateQueries({ queryKey: queryKeys.skills.all });
    },
  });
}

export function useDeleteSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request(`/skills/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.skills.all }),
  });
}
