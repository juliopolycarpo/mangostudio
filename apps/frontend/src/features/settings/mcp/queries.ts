/**
 * MCP server query keys and options.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  McpServerListResponse,
  McpServerPromptsResponse,
  McpServerResourcesResponse,
  McpServerToolsResponse,
} from '@mangostudio/shared/mcp';
import { queryOptions } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

export const mcpServerKeys = {
  all: ['mcp-servers'] as const,
  list: () => [...mcpServerKeys.all, 'list'] as const,
  tools: (serverId: string) => [...mcpServerKeys.all, 'tools', serverId] as const,
  resources: (serverId: string) => [...mcpServerKeys.all, 'resources', serverId] as const,
  prompts: (serverId: string) => [...mcpServerKeys.all, 'prompts', serverId] as const,
};

/** True for the capability-gated 404 the API answers with UNSUPPORTED. */
function isUnsupportedCapability(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { code?: string }).code === ERROR_CODES.UNSUPPORTED
  );
}

export function mcpServerListQueryOptions() {
  return queryOptions({
    queryKey: mcpServerKeys.list(),
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await client.api.mcp.servers.get();
      if (error) throw new ApiError(error.value);
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
      if (error) throw new ApiError(error.value);
      return data as McpServerToolsResponse;
    },
  });
}

/** Resolves to `null` when the server does not advertise the resources capability. */
export function mcpServerResourcesQueryOptions(serverId: string) {
  return queryOptions({
    queryKey: mcpServerKeys.resources(serverId),
    staleTime: 30_000,
    queryFn: async (): Promise<McpServerResourcesResponse | null> => {
      const { data, error } = await client.api.mcp.servers({ id: serverId }).resources.get();
      if (error) {
        if (isUnsupportedCapability(error.value)) return null;
        throw new ApiError(error.value);
      }
      return data as McpServerResourcesResponse;
    },
  });
}

/** Resolves to `null` when the server does not advertise the prompts capability. */
export function mcpServerPromptsQueryOptions(serverId: string) {
  return queryOptions({
    queryKey: mcpServerKeys.prompts(serverId),
    staleTime: 30_000,
    queryFn: async (): Promise<McpServerPromptsResponse | null> => {
      const { data, error } = await client.api.mcp.servers({ id: serverId }).prompts.get();
      if (error) {
        if (isUnsupportedCapability(error.value)) return null;
        throw new ApiError(error.value);
      }
      return data as McpServerPromptsResponse;
    },
  });
}
