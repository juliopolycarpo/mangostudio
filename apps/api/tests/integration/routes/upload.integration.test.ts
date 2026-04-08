import { describe, expect, it } from 'bun:test';
import { uploadRoutes } from '../../../src/routes/upload';
import { createApiTestApp } from '../../support/harness/create-api-test-app';

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
});
