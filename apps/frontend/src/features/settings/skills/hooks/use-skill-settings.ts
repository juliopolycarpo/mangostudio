/**
 * Hooks: skills settings list, per-skill toggle, and source opt-in toggle.
 */

import {
  type AppSettings,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
} from '@mangostudio/shared/app-settings';
import type { SkillDescriptor, SkillListResponse } from '@mangostudio/shared/skills';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidateChatCapabilities } from '@/features/chat/hooks/capability-invalidation';
import { updateAppSettings } from '@/features/settings/app/api';
import { appSettingsKeys, appSettingsQueryOptions } from '@/features/settings/app/queries';
import { updateSkillSetting } from '../api';
import { skillSettingsKeys, skillSettingsListQueryOptions } from '../queries';

export type SkillSourceKey = keyof SkillListResponse['sources'];

function syncSkillListCache(
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

export function useSkillSettings() {
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
    // biome-ignore lint/suspicious/useAwait: mirrors the tool-settings mutation shape
    mutationFn: async ({ skillKey, enabled }: { skillKey: string; enabled: boolean }) => {
      return updateSkillSetting(skillKey, { enabled });
    },
    onSuccess: (descriptor) => {
      syncSkillListCache(queryClient, descriptor);
      // syncSkillListCache no-ops when the skill list was never fetched, so the
      // registry sees no source event. Invalidate unconditionally.
      return invalidateChatCapabilities(queryClient);
    },
  });
}

/**
 * Toggles one third-party skill source through the app-settings endpoint
 * (source opt-ins live there, not in the skills API) and refreshes the skills
 * listing so newly (un)scanned skills appear immediately.
 */
export function useToggleSkillSource() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ source, enabled }: { source: SkillSourceKey; enabled: boolean }) => {
      const cached =
        queryClient.getQueryData<AppSettings>(appSettingsKeys.current()) ??
        (await queryClient.fetchQuery(appSettingsQueryOptions())) ??
        DEFAULT_APP_SETTINGS;
      const current = normalizeAppSettings(cached);

      return updateAppSettings({
        ...current,
        skillSources: { ...current.skillSources, [source]: enabled },
      });
    },
    onSuccess: async (savedSettings) => {
      queryClient.setQueryData(appSettingsKeys.current(), normalizeAppSettings(savedSettings));
      await queryClient.invalidateQueries({ queryKey: skillSettingsKeys.all });
    },
  });
}
