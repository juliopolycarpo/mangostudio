/**
 * Persists rich MCP tool-result blocks as message-part media: image content
 * blocks land in generated-image storage, binary embedded resources become
 * chat attachments. Persistence is best-effort per block — a failed or
 * disallowed block is logged and skipped, never failing the tool call.
 */

import type { ChatAttachment, ChatAttachmentKind } from '@mangostudio/shared/chat';
import type { McpMediaPart } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types';
import { createDiagnosticLogger } from '../../lib/logger';
import {
  buildAttachmentStoragePath,
  writeAttachmentFile,
} from '../../modules/attachments/application/attachment-storage';
import { insertChatAttachment } from '../../modules/attachments/infrastructure/attachment-repository';
import { getById as getChatById } from '../../modules/chats/infrastructure/chat-repository';
import { generateId } from '../../utils/id';
import { saveGeneratedImage } from '../generated-images/generated-image-storage';
import type { McpContentBlock } from './types';

/** Per-block ceiling on decoded media bytes accepted from an MCP server. */
export const MCP_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/** Image mime types persisted through generated-image storage. */
const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Non-image binary mime types persisted as chat attachments. */
const FILE_MIME_POLICIES: Record<string, { extension: string; kind: ChatAttachmentKind }> = {
  'application/pdf': { extension: 'pdf', kind: 'pdf' },
};

const logger = createDiagnosticLogger('mcp-media');

/** Provenance and storage scope for one tool call's media. */
export interface McpMediaContext {
  db: Kysely<Database>;
  userId: string;
  chatId: string;
  toolCallId: string;
  serverSlug: string;
  toolName: string;
}

/** Storage backends, injectable for tests. */
export interface McpMediaStorage {
  /** Persists image bytes and returns the public URL. */
  saveImage(input: { data: Uint8Array; mimeType: string }): Promise<string>;
  /** Persists a binary file as a chat attachment and returns the public URL. */
  saveFile(input: {
    data: Uint8Array;
    mimeType: string;
    originalName: string;
    extension: string;
    kind: ChatAttachmentKind;
  }): Promise<string>;
}

/** One persistable block extracted from a tool result. */
export type McpMediaCandidate =
  | { kind: 'image'; data: string; mimeType: string; uri?: string }
  | {
      kind: 'file';
      data: string;
      mimeType: string;
      extension: string;
      fileKind: ChatAttachmentKind;
      uri: string;
    };

/**
 * Pure selection of which content blocks are persistable media: image blocks
 * and blob resources with an allowlisted mime type. Text (inlined into the
 * flattened result), audio, and disallowed mimes are excluded.
 *
 * // Usage: const candidates = extractMcpMediaCandidates(result.content)
 */
export function extractMcpMediaCandidates(
  blocks: ReadonlyArray<McpContentBlock>
): McpMediaCandidate[] {
  const candidates: McpMediaCandidate[] = [];
  for (const block of blocks) {
    if (block.type === 'image' && block.mimeType in IMAGE_MIME_EXTENSIONS) {
      candidates.push({ kind: 'image', data: block.data, mimeType: block.mimeType });
      continue;
    }
    if (block.type !== 'resource' || block.blob === undefined || !block.mimeType) continue;
    if (block.mimeType in IMAGE_MIME_EXTENSIONS) {
      candidates.push({
        kind: 'image',
        data: block.blob,
        mimeType: block.mimeType,
        uri: block.uri,
      });
      continue;
    }
    const filePolicy = FILE_MIME_POLICIES[block.mimeType];
    if (filePolicy) {
      candidates.push({
        kind: 'file',
        data: block.blob,
        mimeType: block.mimeType,
        extension: filePolicy.extension,
        fileKind: filePolicy.kind,
        uri: block.uri,
      });
    }
  }
  return candidates;
}

/**
 * Persists every media candidate in a tool result and returns the message
 * parts describing the stored files. Never throws: oversized, malformed, or
 * failing blocks are logged and skipped.
 *
 * // Usage: const parts = await persistMcpMediaParts(result.content, ctx)
 */
export async function persistMcpMediaParts(
  blocks: ReadonlyArray<McpContentBlock>,
  ctx: McpMediaContext,
  storage: McpMediaStorage = createDefaultMcpMediaStorage(ctx)
): Promise<McpMediaPart[]> {
  const parts: McpMediaPart[] = [];
  for (const candidate of extractMcpMediaCandidates(blocks)) {
    try {
      const data = decodeMediaPayload(candidate.data);
      const url =
        candidate.kind === 'image'
          ? await storage.saveImage({ data, mimeType: candidate.mimeType })
          : await storage.saveFile({
              data,
              mimeType: candidate.mimeType,
              originalName: resourceFileName(candidate.uri, candidate.extension),
              extension: candidate.extension,
              kind: candidate.fileKind,
            });
      parts.push({
        type: 'mcp_media',
        toolCallId: ctx.toolCallId,
        serverSlug: ctx.serverSlug,
        toolName: ctx.toolName,
        kind: candidate.kind === 'image' ? 'image' : 'resource',
        mimeType: candidate.mimeType,
        url,
        ...(candidate.uri ? { uri: candidate.uri } : {}),
      });
    } catch (error) {
      logger.warn('media_persist_failed', {
        serverSlug: ctx.serverSlug,
        toolName: ctx.toolName,
        mimeType: candidate.mimeType,
        error,
      });
    }
  }
  return parts;
}

function decodeMediaPayload(base64: string): Uint8Array {
  const data = Buffer.from(base64, 'base64');
  if (data.byteLength === 0) throw new Error('Media block decoded to zero bytes.');
  if (data.byteLength > MCP_MEDIA_MAX_BYTES) {
    throw new Error(`Media block exceeds the ${MCP_MEDIA_MAX_BYTES / (1024 * 1024)} MiB limit.`);
  }
  return data;
}

/** Derives a display file name from the resource URI's last path segment. */
function resourceFileName(uri: string, extension: string): string {
  const lastSegment = uri.split(/[/\\]/).filter(Boolean).at(-1) ?? '';
  const base = lastSegment.replace(/\.[A-Za-z0-9]+$/, '').slice(0, 80);
  return `${base || 'resource'}.${extension}`;
}

function createDefaultMcpMediaStorage(
  ctx: Pick<McpMediaContext, 'db' | 'userId' | 'chatId'>
): McpMediaStorage {
  return {
    saveImage({ data, mimeType }) {
      const extension = IMAGE_MIME_EXTENSIONS[mimeType];
      if (!extension) throw new Error(`Unsupported MCP image mime type: ${mimeType}`);
      return saveGeneratedImage({
        data,
        mimeType: mimeType as Parameters<typeof saveGeneratedImage>[0]['mimeType'],
        filenamePrefix: 'mcp',
      });
    },
    async saveFile({ data, mimeType, originalName, extension, kind }) {
      const chat = await getChatById(ctx.chatId, ctx.db);
      if (!chat || chat.userId !== ctx.userId) {
        throw new Error('Chat not found for MCP media attachment.');
      }
      const attachment = await storeMcpResourceAttachment(
        { data, mimeType, originalName, extension, kind },
        { db: ctx.db, userId: ctx.userId, chatId: chat.id, chatTitle: chat.title }
      );
      return attachment.url;
    },
  };
}

/**
 * Writes binary content to attachment storage and records the chat-scoped
 * attachment row. Shared by tool-result media and the resource attach flow.
 */
export async function storeMcpResourceAttachment(
  file: {
    data: Uint8Array;
    mimeType: string;
    originalName: string;
    extension: string;
    kind: ChatAttachmentKind;
  },
  scope: { db: Kysely<Database>; userId: string; chatId: string; chatTitle: string }
): Promise<ChatAttachment> {
  const attachmentId = generateId();
  const uploadedAt = Date.now();
  const storagePath = buildAttachmentStoragePath({
    chatId: scope.chatId,
    chatTitle: scope.chatTitle,
    attachmentId,
    originalName: file.originalName,
    extension: file.extension,
    uploadedAt,
  });
  await writeAttachmentFile(
    storagePath.absolutePath,
    file.data.buffer.slice(
      file.data.byteOffset,
      file.data.byteOffset + file.data.byteLength
    ) as ArrayBuffer
  );
  return insertChatAttachment(
    {
      id: attachmentId,
      userId: scope.userId,
      chatId: scope.chatId,
      originalName: file.originalName,
      storedName: storagePath.storedName,
      relativePath: storagePath.relativePath,
      url: storagePath.url,
      mimeType: file.mimeType,
      sizeBytes: file.data.byteLength,
      kind: file.kind,
      createdAt: uploadedAt,
    },
    scope.db
  );
}
