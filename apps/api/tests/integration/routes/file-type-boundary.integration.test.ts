import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import {
  InvalidAttachmentError,
  validateChatAttachmentFile,
} from '../../../src/modules/attachments/application/attachment-validation';
import {
  InvalidToolImageError,
  validateToolImageBytes,
} from '../../../src/modules/tool-identity/application/tool-image-validation';
import { errorHandler } from '../../../src/plugins/error-handler';
import { uploadRoutes } from '../../../src/routes/upload';
import fixtures from '../../support/fixtures/file-type/fixtures.json';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const FIXTURE_ROOT = join(import.meta.dir, '../../support/fixtures/file-type');
const IMAGE_FIXTURES = fixtures.cases.filter((fixture) => fixture.mime.startsWith('image/'));
const TOOL_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const TEST_USER = {
  id: 'file-type-boundary-user',
  name: 'File Type Boundary User',
  email: 'file-type-boundary@mangostudio.test',
};

describe('file-type boundary caller policies', () => {
  it.each(IMAGE_FIXTURES)(
    'accepts a real $mime image through the upload route',
    async (fixture) => {
      const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, errorHandler, uploadRoutes);
      try {
        const buffer = await Bun.file(join(FIXTURE_ROOT, fixture.file)).arrayBuffer();
        const form = new FormData();
        form.append('image', new File([buffer], fixture.file, { type: fixture.mime }));
        const response = await app.handle(
          new Request('http://localhost/upload', { method: 'POST', body: form })
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { imageUrl: string };
        expect(body.imageUrl).toStartWith('/uploads/');
      } finally {
        restore();
      }
    }
  );

  it.each(fixtures.cases)('accepts a real $mime as a chat attachment', async (fixture) => {
    const buffer = await Bun.file(join(FIXTURE_ROOT, fixture.file)).arrayBuffer();
    const validated = await validateChatAttachmentFile(
      new File([buffer], fixture.file, { type: 'application/octet-stream' })
    );
    expect(validated.mimeType).toBe(fixture.mime);
    expect(validated.extension).toBe(fixture.ext);
    expect(validated.kind).toBe(fixture.mime === 'application/pdf' ? 'pdf' : 'image');
  });

  it.each(fixtures.cases.filter((fixture) => TOOL_IMAGE_MIMES.includes(fixture.mime)))(
    'accepts a real $mime tool image',
    async (fixture) => {
      const buffer = await Bun.file(join(FIXTURE_ROOT, fixture.file)).arrayBuffer();
      const validated = await validateToolImageBytes(new Uint8Array(buffer));
      expect<string>(validated.mimeType).toBe(fixture.mime);
      expect(validated.extension).toBe(fixture.ext);
    }
  );

  it.each(
    fixtures.cases.filter((fixture) =>
      ['image/gif', 'image/avif', 'application/pdf'].includes(fixture.mime)
    )
  )('retains the narrower tool-image allowlist for $mime', async (fixture) => {
    const buffer = await Bun.file(join(FIXTURE_ROOT, fixture.file)).arrayBuffer();
    await expect(validateToolImageBytes(new Uint8Array(buffer))).rejects.toThrow(
      new InvalidToolImageError('The image must be a PNG, JPEG, or WebP file.')
    );
  });

  it('rejects a real PDF at the typed image upload schema with the existing 422 error', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, errorHandler, uploadRoutes);
    try {
      const buffer = await Bun.file(join(FIXTURE_ROOT, 'fixture-minimal.pdf')).arrayBuffer();
      const form = new FormData();
      form.append(
        'image',
        new File([buffer], 'pretends-to-be-an-image.png', { type: 'image/png' })
      );
      const response = await app.handle(
        new Request('http://localhost/upload', { method: 'POST', body: form })
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: 'Unsupported file type',
        code: ERROR_CODES.VALIDATION,
      });
    } finally {
      restore();
    }
  });

  it('retains the attachment and tool-image errors for unrecognized bytes', async () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    await expect(validateChatAttachmentFile(new File([bytes], 'unknown.bin'))).rejects.toThrow(
      new InvalidAttachmentError('Unsupported attachment file type.')
    );
    await expect(validateToolImageBytes(bytes)).rejects.toThrow(
      new InvalidToolImageError('The image must be a PNG, JPEG, or WebP file.')
    );
  });
});
