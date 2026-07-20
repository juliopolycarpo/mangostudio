/**
 * Hook: tool settings list and update.
 */

import type {
  ToolSettingsDescriptor,
  UpdateToolSettingsBody,
} from '@mangostudio/shared/tool-settings';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidateChatCapabilities } from '@/features/chat/hooks/capability-invalidation';
import { updateToolSetting } from '../api';
import { toolSettingsKeys, toolSettingsListQueryOptions } from '../queries';

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
    // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
    mutationFn: async ({ toolName, body }: { toolName: string; body: UpdateToolSettingsBody }) => {
      return updateToolSetting(toolName, body);
    },
    onSuccess: (descriptor) => {
      syncToolSettingsListCache(queryClient, descriptor);
      // The sync above no-ops when the list was never fetched (e.g. toggling from
      // CapabilityInspector without visiting Settings → Tools), emitting no cache
      // event for the registry to observe. Invalidate unconditionally.
      return invalidateChatCapabilities(queryClient);
    },
  });
}
