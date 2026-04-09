import { describe, expect, it, afterEach } from 'bun:test';
import { uploadRoutes } from '../../../src/routes/upload';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

// Minimal 1×1 PNG file (valid magic bytes: 89 50 4E 47)
const TINY_PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a, // PNG signature
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52, // IHDR chunk length + type
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01, // width=1, height=1
  0x08,
  0x02,
  0x00,
  0x00,
  0x00,
  0x90,
  0x77,
  0x53,
  0xde, // bit depth, color type, etc.
  0x00,
  0x00,
  0x00,
  0x0c,
  0x49,
  0x44,
  0x41,
  0x54, // IDAT chunk
  0x08,
  0xd7,
  0x63,
  0xf8,
  0xcf,
  0xc0,
  0x00,
  0x00,
  0x00,
  0x02,
  0x00,
  0x01,
  0xe2,
  0x21,
  0xbc,
  0x33,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82, // IEND chunk
]);

const TEST_USER = {
  id: 'test-user-upload',
  name: 'Upload User',
  email: 'upload@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

describe('POST /upload', () => {
  it('rejects unauthenticated requests (401 or body validation before auth)', async () => {
    const app = createApiTestApp(uploadRoutes);

    const formData = new FormData();
    formData.append('image', new Blob(['fake-content'], { type: 'image/png' }), 'test.png');

    const response = await app.handle(
      new Request('http://localhost/upload', {
        method: 'POST',
        body: formData,
      })
    );

    // Body validation (422) can fire before the auth middleware (401) depending on
    // Elysia's lifecycle order. Either way, unauthenticated access must not return 200.
    expect([401, 422]).toContain(response.status);
  });

  it('accepts a valid PNG upload and returns imageUrl', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, uploadRoutes);
    restoreAuth = restore;

    const formData = new FormData();
    formData.append('image', new File([TINY_PNG], 'tiny.png', { type: 'image/png' }));

    const response = await app.handle(
      new Request('http://localhost/upload', {
        method: 'POST',
        body: formData,
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('imageUrl');
    expect(typeof body['imageUrl']).toBe('string');
    expect((body['imageUrl'] as string).startsWith('/uploads/')).toBe(true);
  });

  it('rejects uploads with invalid file content (non-image bytes)', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, uploadRoutes);
    restoreAuth = restore;

    const formData = new FormData();
    formData.append(
      'image',
      new File([new TextEncoder().encode('this is plain text')], 'fake.png', {
        type: 'image/png',
      })
    );

    const response = await app.handle(
      new Request('http://localhost/upload', {
        method: 'POST',
        body: formData,
      })
    );

    // Elysia schema validation (422) or our magic-bytes check (400) — either rejects the payload
    expect([400, 422]).toContain(response.status);
  });
});
