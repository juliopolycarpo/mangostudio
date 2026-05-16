import { isAbsolute, relative, resolve } from 'node:path';
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
    messageId: string;
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
