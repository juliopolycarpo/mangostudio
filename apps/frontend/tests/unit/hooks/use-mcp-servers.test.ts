/**
 * Unit tests for MCP server query/mutation hooks: list fetch, mutation
 * requests, and cache invalidation of the server list, per-server tools,
 * and the shared tool-settings listing.
 */

import type { McpServer } from '@mangostudio/shared/mcp';
import { useQueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  useAddMcpServer,
  useDeleteMcpServer,
  useImportMcpServers,
  useMcpServers,
  useTestMcpServer,
} from '../../../src/features/settings/mcp/hooks/use-mcp-servers';
import { mcpServerKeys } from '../../../src/features/settings/mcp/queries';
import { toolSettingsKeys } from '../../../src/features/settings/tools/queries';
import { act, renderHook, waitFor } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const SERVER: McpServer = {
  id: 'srv-1',
  name: 'Everything',
  slug: 'everything',
  transport: 'stdio',
  command: 'bunx',
  args: [],
  env: {},
  url: null,
  headerNames: [],
  enabled: true,
  timeoutMs: null,
  status: 'disconnected',
  createdAt: 1,
  updatedAt: 1,
};

describe('MCP server hooks', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('useMcpServers returns the fetched server list', async () => {
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', {
      body: { servers: [SERVER] },
    });

    const { result } = renderHook(() => useMcpServers());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.servers).toEqual([SERVER]);
  });

  it('useAddMcpServer refetches the rendered server list after invalidation', async () => {
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', { body: { servers: [] } });
    fetchScenario.respondWithJson('POST', '/api/mcp/servers', { status: 201, body: SERVER });

    const { result } = renderHook(() => {
      const query = useMcpServers();
      return { servers: query.servers, mutation: useAddMcpServer() };
    });

    await waitFor(() => expect(result.current.servers).toEqual([]));
    fetchScenario.respondWithJson('GET', '/api/mcp/servers', { body: { servers: [SERVER] } });

    await act(async () => {
      await result.current.mutation.mutateAsync({
        name: 'Everything',
        slug: 'everything',
        enabled: true,
        timeoutMs: null,
        transport: 'stdio',
        command: 'bunx',
        args: [],
        env: {},
      });
    });

    await waitFor(() => expect(result.current.servers).toEqual([SERVER]));
  });

  it('useImportMcpServers posts and invalidates server-list and tool-settings caches', async () => {
    fetchScenario.respondWithJson('POST', '/api/mcp/servers/import', {
      body: { results: [{ slug: 'everything', result: 'created', serverId: 'srv-1' }] },
    });

    const { result } = renderHook(() => ({
      mutation: useImportMcpServers(),
      queryClient: useQueryClient(),
    }));

    result.current.queryClient.setQueryData(mcpServerKeys.list(), { servers: [] });
    result.current.queryClient.setQueryData(toolSettingsKeys.list(), { tools: [] });

    let response: unknown;
    await act(async () => {
      response = await result.current.mutation.mutateAsync({
        json: '{"mcpServers":{"everything":{"command":"bunx"}}}',
        slugs: ['everything'],
      });
    });

    expect(response).toMatchObject({ results: [{ slug: 'everything', result: 'created' }] });
    expect(result.current.queryClient.getQueryState(mcpServerKeys.list())?.isInvalidated).toBe(
      true
    );
    expect(result.current.queryClient.getQueryState(toolSettingsKeys.list())?.isInvalidated).toBe(
      true
    );
  });

  it('useTestMcpServer posts to the test endpoint and invalidates the tools cache', async () => {
    fetchScenario.respondWithJson('POST', '/api/mcp/servers/srv-1/test', {
      body: {
        ok: true,
        status: 'connected',
        tools: [{ name: 'echo', description: '', inputSchema: {} }],
      },
    });

    const { result } = renderHook(() => ({
      mutation: useTestMcpServer(),
      queryClient: useQueryClient(),
    }));

    result.current.queryClient.setQueryData(mcpServerKeys.tools('srv-1'), { tools: [] });

    let response: unknown;
    await act(async () => {
      response = await result.current.mutation.mutateAsync('srv-1');
    });

    expect(response).toMatchObject({ ok: true, status: 'connected' });
    expect(
      result.current.queryClient.getQueryState(mcpServerKeys.tools('srv-1'))?.isInvalidated
    ).toBe(true);
  });

  it('useDeleteMcpServer surfaces the typed API error message', async () => {
    fetchScenario.respondWithJson('DELETE', '/api/mcp/servers/srv-1', {
      status: 404,
      body: { error: 'Server not found.', code: 'NOT_FOUND' },
    });

    const { result } = renderHook(() => useDeleteMcpServer());

    await expect(
      act(async () => {
        await result.current.mutateAsync('srv-1');
      })
    ).rejects.toThrow('Server not found.');
  });
});
