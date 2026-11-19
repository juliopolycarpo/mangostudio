import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getConfig } from '../../../../src/lib/config';
import {
  buildAttachmentStoragePath,
  removeAttachmentFile,
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
    // `relativePath` is the URL form (always `/`); the absolute path is native.
    expect(result.absolutePath).toBe(join(getConfig().uploads.dir, result.relativePath));
  });
});

describe('removeAttachmentFile', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'attachment-remove-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes an existing file', async () => {
    const path = join(root, 'file.png');
    writeFileSync(path, 'bytes');

    await removeAttachmentFile(path);

    expect(`file exists: ${existsSync(path)}`).toBe('file exists: false');
  });

  it('treats an already missing file as removed', async () => {
    const path = join(root, 'missing.png');

    await expect(removeAttachmentFile(path)).resolves.toBeUndefined();
  });

  it('rejects when the path cannot be removed as a file', async () => {
    const directory = join(root, 'dir');
    mkdirSync(directory);

    await expect(removeAttachmentFile(directory)).rejects.toThrow();
    expect(`directory exists: ${existsSync(directory)}`).toBe('directory exists: true');
  });
});
