/**
 * MCP server API mutation functions.
 */

import { en } from '@mangostudio/shared/i18n';
import type {
  AddMcpServerBody,
  McpServer,
  TestMcpServerResponse,
  UpdateMcpServerBody,
} from '@mangostudio/shared/mcp';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

const fallback = en.settings.mcp;

export async function addMcpServer(body: AddMcpServerBody): Promise<McpServer> {
  const { data, error } = await client.api.mcp.servers.post(body);
  if (error) throw new Error(extractApiError(error.value, fallback.failedToAdd));
  return data as McpServer;
}

export async function updateMcpServer(id: string, body: UpdateMcpServerBody): Promise<McpServer> {
  const { data, error } = await client.api.mcp.servers({ id }).put(body);
  if (error) throw new Error(extractApiError(error.value, fallback.failedToUpdate));
  return data as McpServer;
}

export async function deleteMcpServer(id: string): Promise<void> {
  const { error } = await client.api.mcp.servers({ id }).delete();
  if (error) throw new Error(extractApiError(error.value, fallback.failedToDelete));
}

export async function testMcpServer(id: string): Promise<TestMcpServerResponse> {
  const { data, error } = await client.api.mcp.servers({ id }).test.post();
  if (error) throw new Error(extractApiError(error.value, fallback.testFailed));
  return data as TestMcpServerResponse;
}
