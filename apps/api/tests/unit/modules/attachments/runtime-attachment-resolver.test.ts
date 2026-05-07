import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Kysely } from 'kysely';
import { loadConfigForTest, resetConfig } from '../../../../src/lib/config';
import type { ChatAttachmentSelect, Database } from '../../../../src/db/types';
import {
  ChatAttachmentFileUnavailableError,
  resolveProviderRuntimeAttachments,
} from '../../../../src/modules/attachments/application/runtime-attachment-resolver';

const TMP_DIR = join('/tmp', `mango-runtime-attachments-test-${process.pid}`);

describe('resolveProviderRuntimeAttachments', () => {
  afterEach(() => {
    resetConfig();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('loads linked attachment bytes in requested order without exposing storage fields', async () => {
    const uploadsDir = join(TMP_DIR, 'uploads');
    loadConfigForTest({ uploads: { dir: uploadsDir } });
    writeUploadFile('chat-1/1700000000000/image-a.png', new Uint8Array([1, 2, 3]));
    writeUploadFile('chat-1/1700000000000/notes.txt', new Uint8Array([4, 5]));

    const imageRow = attachmentRow({
      id: 'image-a',
      originalName: 'reference.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      kind: 'image',
      relativePath: 'chat-1/1700000000000/image-a.png',
    });
    const textRow = attachmentRow({
      id: 'text-a',
      originalName: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: 2,
      kind: 'text',
      relativePath: 'chat-1/1700000000000/notes.txt',
    });

    const resolved = await resolveProviderRuntimeAttachments(
      {
        attachmentIds: ['text-a', 'image-a', 'text-a', '   '],
        userId: 'user-1',
        chatId: 'chat-1',
        messageId: 'message-1',
      },
      attachmentDb([imageRow, textRow])
    );

    expect(resolved.map((attachment) => attachment.id)).toEqual(['text-a', 'image-a']);
    expect(Array.from(resolved[0]?.bytes ?? [])).toEqual([4, 5]);
    expect(Array.from(resolved[1]?.bytes ?? [])).toEqual([1, 2, 3]);
    expect(resolved[0]).not.toHaveProperty('relativePath');
    expect(resolved[0]).not.toHaveProperty('storedName');
  });

  it('rejects attachment paths that escape the upload directory', async () => {
    const uploadsDir = join(TMP_DIR, 'uploads');
    loadConfigForTest({ uploads: { dir: uploadsDir } });

    let caughtError: unknown;
    try {
      await resolveProviderRuntimeAttachments(
        {
          attachmentIds: ['unsafe-a'],
          userId: 'user-1',
          chatId: 'chat-1',
          messageId: 'message-1',
        },
        attachmentDb([
          attachmentRow({
            id: 'unsafe-a',
            relativePath: '../outside.png',
          }),
        ])
      );
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(ChatAttachmentFileUnavailableError);
    expect((caughtError as Error).message).toBe(
      'One or more attachment files could not be loaded.'
    );
    expect((caughtError as Error).message).not.toContain('../outside.png');
  });

  it('uses the same generic error when a stored file is missing', async () => {
    const uploadsDir = join(TMP_DIR, 'uploads');
    loadConfigForTest({ uploads: { dir: uploadsDir } });

    let caughtError: unknown;
    try {
      await resolveProviderRuntimeAttachments(
        {
          attachmentIds: ['missing-a'],
          userId: 'user-1',
          chatId: 'chat-1',
          messageId: 'message-1',
        },
        attachmentDb([
          attachmentRow({
            id: 'missing-a',
            relativePath: 'chat-1/1700000000000/missing.png',
          }),
        ])
      );
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(ChatAttachmentFileUnavailableError);
  });
});

function writeUploadFile(relativePath: string, bytes: Uint8Array): void {
  const filePath = join(TMP_DIR, 'uploads', relativePath);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, bytes);
}

function attachmentDb(rows: ChatAttachmentSelect[]): Kysely<Database> {
  const chain: Record<string, unknown> = {
    selectAll: () => chain,
    where: () => chain,
    execute: () => Promise.resolve(rows),
  };

  return {
    selectFrom: () => chain,
  } as unknown as Kysely<Database>;
}

function attachmentRow(overrides: Partial<ChatAttachmentSelect> = {}): ChatAttachmentSelect {
  return {
    id: 'attachment-a',
    userId: 'user-1',
    chatId: 'chat-1',
    messageId: 'message-1',
    originalName: 'attachment.png',
    storedName: 'attachment-a-attachment.png',
    relativePath: 'chat-1/1700000000000/attachment-a-attachment.png',
    url: '/uploads/chat-1/1700000000000/attachment-a-attachment.png',
    mimeType: 'image/png',
    sizeBytes: 1,
    kind: 'image',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}
