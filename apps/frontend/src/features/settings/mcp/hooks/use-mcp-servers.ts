/**
 * Hooks: MCP server list plus create/update/delete/test/import mutations.
 */

import type {
  AddMcpServerBody,
  ApplyMcpPortabilityImportBody,
  UpdateMcpServerBody,
} from '@mangostudio/shared/mcp';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toolSettingsKeys } from '@/features/settings/tools/queries';
import {
  addMcpServer,
  applyPortableMcpImport,
  deleteMcpServer,
  exportPortableMcpServers,
  importMcpServers,
  previewPortableMcpImport,
  testMcpServer,
  updateMcpServer,
} from '../api';
import { mcpServerKeys, mcpServerListQueryOptions } from '../queries';

export function useMcpServers() {
  const { data, isLoading, error, refetch } = useQuery(mcpServerListQueryOptions());
  return { servers: data?.servers ?? [], isLoading, error, refetch };
}

/**
 * Server changes ripple into the global tool registry (Settings → Tools shows
 * `mcp__<slug>__<tool>` entries), so every mutation also invalidates the
 * tool-settings listing.
 */
function useInvalidateMcpCaches() {
  const queryClient = useQueryClient();
  return (serverId?: string) => {
    void queryClient.invalidateQueries({ queryKey: mcpServerKeys.list() });
    void queryClient.invalidateQueries({ queryKey: toolSettingsKeys.all });
    if (serverId) {
      void queryClient.invalidateQueries({ queryKey: mcpServerKeys.tools(serverId) });
    }
  };
}

export function useAddMcpServer() {
  const invalidate = useInvalidateMcpCaches();
  return useMutation({
    mutationFn: (body: AddMcpServerBody) => addMcpServer(body),
    onSuccess: (server) => invalidate(server.id),
  });
}

export function useUpdateMcpServer() {
  const invalidate = useInvalidateMcpCaches();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateMcpServerBody }) =>
      updateMcpServer(id, body),
    onSuccess: (server) => invalidate(server.id),
  });
}

export function useDeleteMcpServer() {
  const invalidate = useInvalidateMcpCaches();
  return useMutation({
    mutationFn: (id: string) => deleteMcpServer(id),
    onSuccess: () => invalidate(),
  });
}

export function useImportMcpServers() {
  const invalidate = useInvalidateMcpCaches();
  return useMutation({
    mutationFn: importMcpServers,
    onSuccess: () => invalidate(),
  });
}

export function useExportPortableMcpServers() {
  return useMutation({ mutationFn: exportPortableMcpServers });
}

export function usePreviewPortableMcpImport() {
  return useMutation({ mutationFn: previewPortableMcpImport });
}

export function useApplyPortableMcpImport() {
  const invalidate = useInvalidateMcpCaches();
  return useMutation({
    mutationFn: (body: ApplyMcpPortabilityImportBody) => applyPortableMcpImport(body),
    onSuccess: () => invalidate(),
  });
}

/** Explicit probe: refreshes last-known status and the discovered tool list. */
export function useTestMcpServer() {
  const invalidate = useInvalidateMcpCaches();
  return useMutation({
    mutationFn: (id: string) => testMcpServer(id),
    onSettled: (_result, _error, id) => invalidate(id),
  });
}
