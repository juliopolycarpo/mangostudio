import { isAbsolute, relative, resolve } from 'node:path';
import type { ExternalAgentAttachment } from '@mangostudio/shared/external-agents';
import type { Kysely } from 'kysely';
import type { ChatAttachmentSelect, Database } from '../../../db/types';
import { getConfig } from '../../../lib/config';
import type { ProviderRuntimeAttachment } from '../../../services/providers/types';
import { assertChatAttachmentIdsAvailable } from '../infrastructure/attachment-repository';

export class ChatAttachmentFileUnavailableError extends Error {
  constructor() {
    super('One or more attachment files could not be loaded.');
    this.name = 'ChatAttachmentFileUnavailableError';
  }
}

export async function resolveProviderRuntimeAttachments(
  input: {
    attachmentIds: string[];
    userId: string;
    chatId: string;
    /**
     * Optional, because an external turn resolves its attachments *before* the
     * message row exists — the bytes have to be in hand before the response is
     * committed, or a missing file becomes a stream that opens and then dies.
     * `assertChatAttachmentIdsAvailable` has always accepted an absent one; the
     * ownership check that matters is the chat's, not the message's.
     */
    messageId?: string;
  },
  db: Kysely<Database>
): Promise<ProviderRuntimeAttachment[]> {
  const attachmentIds = uniqueAttachmentIds(input.attachmentIds);
  if (attachmentIds.length === 0) return [];

  const attachments = await assertChatAttachmentIdsAvailable(
    {
      attachmentIds,
      userId: input.userId,
      chatId: input.chatId,
      messageId: input.messageId,
    },
    db
  );

  const rowsById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const uploadsRoot = resolve(getConfig().uploads.dir);

  return Promise.all(
    attachmentIds.map(async (attachmentId) => {
      const attachment = rowsById.get(attachmentId);
      if (!attachment) throw new ChatAttachmentFileUnavailableError();

      const absolutePath = resolveAttachmentPath(uploadsRoot, attachment.relativePath);
      const file = Bun.file(absolutePath);
      if (!(await file.exists())) throw new ChatAttachmentFileUnavailableError();

      const bytes = new Uint8Array(await file.arrayBuffer());
      return mapRuntimeAttachment(attachment, bytes);
    })
  );
}

function resolveAttachmentPath(uploadsRoot: string, attachmentRelativePath: string): string {
  if (!attachmentRelativePath.trim() || isAbsolute(attachmentRelativePath)) {
    throw new ChatAttachmentFileUnavailableError();
  }

  const absolutePath = resolve(uploadsRoot, attachmentRelativePath);
  const pathFromRoot = relative(uploadsRoot, absolutePath);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new ChatAttachmentFileUnavailableError();
  }

  return absolutePath;
}

function mapRuntimeAttachment(
  attachment: ChatAttachmentSelect,
  bytes: Uint8Array
): ProviderRuntimeAttachment {
  return {
    id: attachment.id,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    bytes,
  };
}

function uniqueAttachmentIds(attachmentIds: string[]): string[] {
  return Array.from(new Set(attachmentIds.filter((id) => id.trim().length > 0)));
}

/**
 * The same attachments, shaped for an external agent's own wire.
 *
 * Two differences from the provider path above, and both are the vendors':
 *
 * - **Images only.** Codex maps every attachment it is given as an image
 *   regardless of kind, so handing it a PDF would send a broken image rather
 *   than a document. Filtering here rather than in the adapter keeps that from
 *   being a rule each adapter has to remember.
 * - **Base64, not bytes.** The runtime protocol is JSON, so the schema takes an
 *   encoded string; `ExternalAgentAttachmentSchema` bounds it.
 *
 * Reuses `resolveProviderRuntimeAttachments`, so the traversal guard and the
 * "file is gone" failure are the same ones the internal path has rather than a
 * second implementation of both.
 */
export async function resolveExternalAgentAttachments(
  input: {
    attachmentIds: string[];
    userId: string;
    chatId: string;
    messageId?: string;
  },
  db: Kysely<Database>
): Promise<ExternalAgentAttachment[]> {
  const resolved = await resolveProviderRuntimeAttachments(input, db);
  return resolved
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment) => ({
      id: attachment.id,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      kind: 'image' as const,
      bytesBase64: Buffer.from(attachment.bytes).toString('base64'),
    }));
}
