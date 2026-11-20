import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  createGeneratedImageRoutes,
  resolveGeneratedImagePath,
} from '../../../src/routes/generated-images';
import { removeFixtureDirSync } from '../../support/remove-fixture-dir';

const TMP_DIR = join('/tmp', `mango-generated-image-routes-${process.pid}`);

afterEach(() => {
  removeFixtureDirSync({ role: 'generated-images-routes', path: TMP_DIR });
});

describe('generated image routes', () => {
  it('serves generated images from the configured images directory', async () => {
    const imagesDir = join(TMP_DIR, 'images');
    mkdirSync(imagesDir, { recursive: true });
    await Bun.write(join(imagesDir, 'generated.png'), 'png-data');

    const app = createGeneratedImageRoutes(imagesDir);
    const response = await app.handle(new Request('http://localhost/images/generated.png'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.has('etag')).toBe(false);
    expect(await response.text()).toBe('png-data');
  });

  it('answers a missing image with the plain-text 404 body and no cache header', async () => {
    const imagesDir = join(TMP_DIR, 'images');
    mkdirSync(imagesDir, { recursive: true });

    const app = createGeneratedImageRoutes(imagesDir);
    const response = await app.handle(new Request('http://localhost/images/missing.png'));

    expect(response.status).toBe(404);
    expect(response.headers.has('cache-control')).toBe(false);
    expect(await response.text()).toBe('Not found');
  });

  it('rejects paths outside the images directory', () => {
    const imagesDir = join(TMP_DIR, 'images');

    expect(resolveGeneratedImagePath(imagesDir, '../secret.png')).toBeNull();
  });
});
