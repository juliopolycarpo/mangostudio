import { describe, expect, it } from 'bun:test';
import {
  InvalidAttachmentError,
  validateChatAttachmentFile,
} from '../../../../src/modules/attachments/application/attachment-validation';

const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe('validateChatAttachmentFile', () => {
  it('accepts a PNG when content and extension match', async () => {
    const result = await validateChatAttachmentFile(
      new File([TINY_PNG], 'reference.png', { type: 'image/png' })
    );

    expect(result.mimeType).toBe('image/png');
    expect(result.extension).toBe('png');
    expect(result.kind).toBe('image');
    expect(result.sizeBytes).toBe(TINY_PNG.byteLength);
  });

  it('accepts markdown as UTF-8 text', async () => {
    const result = await validateChatAttachmentFile(
      new File(['# Attachment\nUse this context.'], 'notes.md', { type: 'text/markdown' })
    );

    expect(result.mimeType).toBe('text/markdown');
    expect(result.extension).toBe('md');
    expect(result.kind).toBe('text');
  });

  it('accepts PDFs by signature', async () => {
    const result = await validateChatAttachmentFile(
      new File(['%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'], 'brief.pdf', {
        type: 'application/octet-stream',
      })
    );

    expect(result.mimeType).toBe('application/pdf');
    expect(result.extension).toBe('pdf');
    expect(result.kind).toBe('pdf');
  });

  it('rejects empty files', async () => {
    await expectInvalidAttachment(new File([], 'empty.txt'));
  });

  it('rejects files whose extension does not match detected content', async () => {
    await expectInvalidAttachment(new File([TINY_PNG], 'reference.txt', { type: 'text/plain' }));
  });

  it('rejects unsupported binary files', async () => {
    await expectInvalidAttachment(
      new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], 'archive.bin', {
        type: 'application/octet-stream',
      })
    );
  });
});

async function expectInvalidAttachment(file: File): Promise<void> {
  let caughtError: unknown;
  try {
    await validateChatAttachmentFile(file);
  } catch (error) {
    caughtError = error;
  }

  expect(caughtError).toBeInstanceOf(InvalidAttachmentError);
}
