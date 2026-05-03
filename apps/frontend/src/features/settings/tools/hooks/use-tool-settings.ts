/**
 * Hook: tool settings list and update.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateToolSettingsBody } from '@mangostudio/shared/tool-settings';
import { toolSettingsKeys, toolSettingsListQueryOptions } from '../queries';
import { updateToolSetting } from '../api';

export function useToolSettings() {
  const { data, isLoading, error, refetch } = useQuery(toolSettingsListQueryOptions());
  return { descriptors: data?.tools ?? [], isLoading, error, refetch };
}

export function useUpdateToolSetting() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ toolName, body }: { toolName: string; body: UpdateToolSettingsBody }) => {
      await updateToolSetting(toolName, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: toolSettingsKeys.list() });
    },
  });
}
