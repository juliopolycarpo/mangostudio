import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { loadConfigForTest, resetConfig } from '../../../src/lib/config';
import {
  normalizeGeneratedImageMimeType,
  saveGeneratedImage,
} from '../../../src/services/generated-images/generated-image-storage';

const TMP_DIR = join('/tmp', `mango-generated-images-test-${process.pid}`);

describe('generated-image-storage', () => {
  afterEach(() => {
    resetConfig();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('creates the configured images directory and returns an /images URL', async () => {
    const imagesDir = join(TMP_DIR, 'nested', 'images');
    loadConfigForTest({ images: { dir: imagesDir } });

    const imageUrl = await saveGeneratedImage({
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png',
    });

    expect(imageUrl.startsWith('/images/')).toBe(true);
    expect(existsSync(imagesDir)).toBe(true);
    expect(readdirSync(imagesDir)).toHaveLength(1);
  });

  it('writes base64 image data using the MIME extension', async () => {
    const imagesDir = join(TMP_DIR, 'base64-images');
    loadConfigForTest({ images: { dir: imagesDir } });

    const imageUrl = await saveGeneratedImage({
      data: Buffer.from('hello-image').toString('base64'),
      encoding: 'base64',
      mimeType: 'image/webp',
    });

    const filename = imageUrl.replace('/images/', '');
    const filePath = join(imagesDir, filename);

    expect(filePath.endsWith('.webp')).toBe(true);
    expect(readFileSync(filePath).toString()).toBe('hello-image');
  });

  it('rejects unsupported MIME types', () => {
    expect(() => normalizeGeneratedImageMimeType('image/svg+xml')).toThrow(
      'Unsupported generated image MIME type: image/svg+xml'
    );
  });
});
