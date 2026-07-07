/**
 * Hook: skills settings list and per-skill toggle.
 */

import type { SkillDescriptor, UpdateSkillSettingsBody } from '@mangostudio/shared/skills';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { updateSkillSetting } from '../api';
import { skillSettingsKeys, skillSettingsListQueryOptions } from '../queries';

function syncSkillsListCache(
  queryClient: ReturnType<typeof useQueryClient>,
  descriptor: SkillDescriptor
) {
  queryClient.setQueryData(skillSettingsKeys.list(), (current: SkillListResponse | undefined) => {
    if (!current) return current;
    return {
      ...current,
      skills: current.skills.map((skill) => (skill.key === descriptor.key ? descriptor : skill)),
    };
  });
}

type SkillListResponse = import('@mangostudio/shared/skills').SkillListResponse;

export function useSkillsSettings() {
  const { data, isLoading, error, refetch } = useQuery(skillSettingsListQueryOptions());
  return {
    skills: data?.skills ?? [],
    sources: data?.sources,
    isLoading,
    error,
    refetch,
  };
}

export function useUpdateSkillSetting() {
  const queryClient = useQueryClient();

  return useMutation({
    // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
    mutationFn: async ({ skillKey, body }: { skillKey: string; body: UpdateSkillSettingsBody }) => {
      return updateSkillSetting(skillKey, body);
    },
    onMutate: ({ skillKey, body }) => {
      // Optimistic toggle: flip enabled immediately, roll back on error.
      const current = queryClient.getQueryData<SkillListResponse>(skillSettingsKeys.list());
      if (current) {
        queryClient.setQueryData(skillSettingsKeys.list(), {
          ...current,
          skills: current.skills.map((skill) =>
            skill.key === skillKey ? { ...skill, enabled: body.enabled } : skill
          ),
        });
      }
      return { previous: current };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(skillSettingsKeys.list(), context.previous);
      }
    },
    onSuccess: (descriptor) => {
      syncSkillsListCache(queryClient, descriptor);
    },
  });
}
