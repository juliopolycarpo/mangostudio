/**
 * MCP server query keys and options.
 */

import { en } from '@mangostudio/shared/i18n';
import type { McpServerListResponse, McpServerToolsResponse } from '@mangostudio/shared/mcp';
import { queryOptions } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export const mcpServerKeys = {
  all: ['mcp-servers'] as const,
  list: () => [...mcpServerKeys.all, 'list'] as const,
  tools: (serverId: string) => [...mcpServerKeys.all, 'tools', serverId] as const,
};

export function mcpServerListQueryOptions() {
  return queryOptions({
    queryKey: mcpServerKeys.list(),
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await client.api.mcp.servers.get();
      if (error) throw new Error(extractApiError(error.value, en.settings.mcp.loadError));
      return data as McpServerListResponse;
    },
  });
}

export function mcpServerToolsQueryOptions(serverId: string) {
  return queryOptions({
    queryKey: mcpServerKeys.tools(serverId),
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await client.api.mcp.servers({ id: serverId }).tools.get();
      if (error) throw new Error(extractApiError(error.value, en.settings.mcp.toolsLoadError));
      return data as McpServerToolsResponse;
    },
  });
}
