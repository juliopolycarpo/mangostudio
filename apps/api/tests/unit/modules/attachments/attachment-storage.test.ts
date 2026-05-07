import { describe, expect, it } from 'bun:test';
import { getConfig } from '../../../../src/lib/config';
import {
  buildAttachmentStoragePath,
  sanitizePathSegment,
} from '../../../../src/modules/attachments/application/attachment-storage';

describe('attachment storage paths', () => {
  it('sanitizes unsafe path segments for upload paths', () => {
    expect(sanitizePathSegment('../Café chat / user\0 drop?.png')).toBe('Cafe-chat-user-drop.png');
  });

  it('builds nested paths below the configured uploads directory', () => {
    const uploadedAt = 1710000000000;
    const result = buildAttachmentStoragePath({
      chatId: 'chat/path:123',
      chatTitle: 'Design Review',
      attachmentId: 'attachment-storage-1',
      originalName: '../Reference Image?.png',
      extension: '.png',
      uploadedAt,
    });

    expect(result.storedName).toBe('attachment-storage-1-Reference-Image.png');
    expect(result.relativePath).toBe(
      'Design-Review_chat-path123/1710000000000/attachment-storage-1-Reference-Image.png'
    );
    expect(result.url).toBe(`/uploads/${result.relativePath}`);
    expect(result.absolutePath).toBe(`${getConfig().uploads.dir}/${result.relativePath}`);
  });
});
