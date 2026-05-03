import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  createGeneratedImageRoutes,
  resolveGeneratedImagePath,
} from '../../../src/routes/generated-images';

const TMP_DIR = join('/tmp', `mango-generated-image-routes-${process.pid}`);

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
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

  it('rejects paths outside the images directory', () => {
    const imagesDir = join(TMP_DIR, 'images');

    expect(resolveGeneratedImagePath(imagesDir, '../secret.png')).toBeNull();
  });
});
