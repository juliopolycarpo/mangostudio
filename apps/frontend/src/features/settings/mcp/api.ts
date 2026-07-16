/**
 * MCP server API mutation functions.
 */

import { en } from '@mangostudio/shared/i18n';
import type {
  AddMcpServerBody,
  ApplyMcpPortabilityImportBody,
  ExportMcpServersBody,
  ExportMcpServersResponse,
  GetMcpPromptBody,
  GetMcpPromptResponse,
  ImportMcpServersBody,
  ImportMcpServersResponse,
  McpImportPreviewResponse,
  McpPortabilityApplyResponse,
  McpPortabilityPreviewResponse,
  McpServer,
  PreviewMcpImportBody,
  PreviewMcpPortabilityImportBody,
  ReadMcpResourceBody,
  ReadMcpResourceResponse,
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

export async function readMcpResource(
  id: string,
  body: ReadMcpResourceBody
): Promise<ReadMcpResourceResponse> {
  const { data, error } = await client.api.mcp.servers({ id }).resources.read.post(body);
  if (error) throw new Error(extractApiError(error.value, fallback.resources.readFailed));
  return data as ReadMcpResourceResponse;
}

export async function getMcpPrompt(
  id: string,
  body: GetMcpPromptBody
): Promise<GetMcpPromptResponse> {
  const { data, error } = await client.api.mcp.servers({ id }).prompts.resolve.post(body);
  if (error) throw new Error(extractApiError(error.value, fallback.prompts.getFailed));
  return data as GetMcpPromptResponse;
}

export async function previewMcpImport(
  body: PreviewMcpImportBody
): Promise<McpImportPreviewResponse> {
  const { data, error } = await client.api.mcp.servers.import.preview.post(body);
  if (error) throw new Error(extractApiError(error.value, fallback.import.previewFailed));
  return data as McpImportPreviewResponse;
}

export async function importMcpServers(
  body: ImportMcpServersBody
): Promise<ImportMcpServersResponse> {
  const { data, error } = await client.api.mcp.servers.import.post(body);
  if (error) throw new Error(extractApiError(error.value, fallback.import.failed));
  return data as ImportMcpServersResponse;
}

export async function exportPortableMcpServers(
  body: ExportMcpServersBody
): Promise<ExportMcpServersResponse> {
  const { data, error } = await client.api.mcp.servers.portability.export.post(body);
  if (error) throw new Error(extractApiError(error.value, fallback.portability.exportFailed));
  return data as ExportMcpServersResponse;
}

export async function previewPortableMcpImport(
  body: PreviewMcpPortabilityImportBody
): Promise<McpPortabilityPreviewResponse> {
  const { data, error } = await client.api.mcp.servers.portability.import.preview.post(body);
  if (error) throw new Error(extractApiError(error.value, fallback.portability.previewFailed));
  return data as McpPortabilityPreviewResponse;
}

export async function applyPortableMcpImport(
  body: ApplyMcpPortabilityImportBody
): Promise<McpPortabilityApplyResponse> {
  const { data, error } = await client.api.mcp.servers.portability.import.apply.post(body);
  if (error) throw new Error(extractApiError(error.value, fallback.portability.applyFailed));
  return data as McpPortabilityApplyResponse;
}
