/**
 * Hook: tool settings list and update.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ToolSettingsDescriptor,
  UpdateToolSettingsBody,
} from '@mangostudio/shared/tool-settings';
import { toolSettingsKeys, toolSettingsListQueryOptions } from '../queries';
import { updateToolSetting } from '../api';

function syncToolSettingsListCache(
  queryClient: ReturnType<typeof useQueryClient>,
  descriptor: ToolSettingsDescriptor
) {
  queryClient.setQueryData(
    toolSettingsKeys.list(),
    (current: { tools: ToolSettingsDescriptor[] } | undefined) => {
      if (!current) return current;

      return {
        tools: current.tools.map((tool) => (tool.name === descriptor.name ? descriptor : tool)),
      };
    }
  );
}

export function useToolSettings() {
  const { data, isLoading, error, refetch } = useQuery(toolSettingsListQueryOptions());
  return { descriptors: data?.tools ?? [], isLoading, error, refetch };
}

export function useUpdateToolSetting() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ toolName, body }: { toolName: string; body: UpdateToolSettingsBody }) => {
      return updateToolSetting(toolName, body);
    },
    onSuccess: (descriptor) => {
      syncToolSettingsListCache(queryClient, descriptor);
    },
  });
}
