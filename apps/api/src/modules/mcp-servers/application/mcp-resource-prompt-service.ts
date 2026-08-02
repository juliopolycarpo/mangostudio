/**
 * User-driven browse surface for the MCP resources and prompts primitives:
 * list/read resources, list/resolve prompts, all capability-gated on what the
 * server advertised at initialize. Reading a resource can optionally persist
 * its contents as chat attachments so a turn carries them as context.
 */

import { capMcpResultText } from '@mangostudio/runtime';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  GetMcpPromptBody,
  GetMcpPromptResponse,
  McpResourceContent,
  McpServerPromptsResponse,
  McpServerResourcesResponse,
  ReadMcpResourceBody,
  ReadMcpResourceResponse,
} from '@mangostudio/shared/mcp';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { getMcpClient } from '../../../services/mcp/connection-manager';
import { persistMcpResourceAttachments } from '../../../services/mcp/rich-content';
import { toMcpRuntimeConfig } from '../../../services/mcp/runtime-config';
import type { McpClientHandle, McpServerCapabilities } from '../../../services/mcp/types';
import { getById as getChatById } from '../../chats/infrastructure/chat-repository';
import { McpServerError } from '../domain/mcp-server';
import { requireMcpServerRow } from './mcp-server-service';

type GatedCapability = Exclude<keyof McpServerCapabilities, 'tools'>;

export async function listMcpServerResources(
  db: Kysely<Database>,
  userId: string,
  id: string
): Promise<McpServerResourcesResponse> {
  const handle = await connectGated(db, userId, id, 'resources');
  return { resources: await wrapProviderError(() => handle.listResources()) };
}

export async function readMcpServerResource(
  db: Kysely<Database>,
  userId: string,
  id: string,
  body: ReadMcpResourceBody
): Promise<ReadMcpResourceResponse> {
  const handle = await connectGated(db, userId, id, 'resources');
  const contents = await wrapProviderError(() => handle.readResource(body.uri));

  const response: ReadMcpResourceResponse = {
    contents: contents.map(
      (entry): McpResourceContent => ({
        uri: entry.uri,
        ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
        ...(entry.text !== undefined ? { text: capMcpResultText(entry.text) } : {}),
        isBinary: entry.text === undefined && entry.blob !== undefined,
      })
    ),
  };

  if (body.chatId) {
    const chat = await getChatById(body.chatId, db);
    if (!chat || chat.userId !== userId) {
      throw new McpServerError('Chat not found.', 404, ERROR_CODES.NOT_FOUND);
    }
    response.attachments = await persistMcpResourceAttachments(contents, {
      db,
      userId,
      chatId: chat.id,
      chatTitle: chat.title,
    });
  }

  return response;
}

export async function listMcpServerPrompts(
  db: Kysely<Database>,
  userId: string,
  id: string
): Promise<McpServerPromptsResponse> {
  const handle = await connectGated(db, userId, id, 'prompts');
  return { prompts: await wrapProviderError(() => handle.listPrompts()) };
}

export async function getMcpServerPrompt(
  db: Kysely<Database>,
  userId: string,
  id: string,
  body: GetMcpPromptBody
): Promise<GetMcpPromptResponse> {
  const handle = await connectGated(db, userId, id, 'prompts');
  const prompt = await wrapProviderError(() => handle.getPrompt(body.name, body.arguments));
  return {
    ...(prompt.description !== undefined ? { description: prompt.description } : {}),
    messages: [...prompt.messages],
  };
}

/**
 * Connects to an owned server and enforces that it advertised the requested
 * capability — a server without it is a 404 with a machine-readable code so
 * the UI can hide the affordance rather than surface an error.
 */
async function connectGated(
  db: Kysely<Database>,
  userId: string,
  id: string,
  capability: GatedCapability
): Promise<McpClientHandle> {
  const row = await requireMcpServerRow(db, userId, id);
  const handle = await wrapProviderError(() => getMcpClient(userId, toMcpRuntimeConfig(row)));
  if (!handle.getCapabilities()[capability]) {
    throw new McpServerError(
      `MCP server "${row.slug}" does not support ${capability}.`,
      404,
      ERROR_CODES.UNSUPPORTED
    );
  }
  return handle;
}

/** Maps connection/request failures to a 502, mirroring the tools listing. */
async function wrapProviderError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof McpServerError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new McpServerError(detail, 502, ERROR_CODES.PROVIDER_ERROR);
  }
}
