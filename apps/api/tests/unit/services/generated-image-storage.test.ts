import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfigForTest, resetConfig } from '../../../src/lib/config';
import {
  deleteStoredGeneratedImage,
  findGeneratedImageFilenames,
  generatedImageFilenameFromUrl,
  isGeneratedImageFilename,
  listStoredGeneratedImages,
  normalizeGeneratedImageMimeType,
  saveGeneratedImage,
} from '../../../src/services/generated-images/generated-image-storage';
import {
  type GeneratedImageDirectory,
  useGeneratedImageDirectory,
} from '../../support/generated-image-fixtures';
import { removeFixtureDirSync } from '../../support/remove-fixture-dir';

const TMP_DIR = join('/tmp', `mango-generated-images-test-${process.pid}`);

describe('generated-image-storage', () => {
  afterEach(() => {
    resetConfig();
    removeFixtureDirSync({ role: 'generated-image-storage', path: TMP_DIR });
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

describe('generated image file names', () => {
  const NAME = 'generated-1700000000000-123e4567-e89b-12d3-a456-426614174000.png';

  it('accepts what saveGeneratedImage writes, whatever the prefix and extension', () => {
    expect(isGeneratedImageFilename(NAME)).toBe(true);
    expect(
      isGeneratedImageFilename(NAME.replace('generated', 'mcp').replace('.png', '.webp'))
    ).toBe(true);
  });

  it.each([
    ['a user photo', 'holiday.png'],
    ['an unsupported extension', NAME.replace('.png', '.svg')],
    ['a nested path', `nested/${NAME}`],
    ['a parent escape', `../${NAME}`],
    ['an empty name', ''],
  ])('rejects %s', (_label, candidate) => {
    expect(isGeneratedImageFilename(candidate)).toBe(false);
  });

  it('reads the name out of an /images URL and nothing else', () => {
    expect({
      images: generatedImageFilenameFromUrl(`/images/${NAME}`),
      uploads: generatedImageFilenameFromUrl(`/uploads/${NAME}`),
      foreign: generatedImageFilenameFromUrl('/images/holiday.png'),
    }).toEqual({ images: NAME, uploads: null, foreign: null });
  });

  it('finds every /images name inside JSON and prose, ignoring other paths', () => {
    const text = JSON.stringify({
      imageUrl: `/images/${NAME}`,
      note: `also /images/holiday.png and /uploads/${NAME}`,
    });

    expect(findGeneratedImageFilenames(text)).toEqual([NAME]);
  });
});

describe('generated image directory listing and removal', () => {
  let images: GeneratedImageDirectory;

  beforeEach(() => {
    images = useGeneratedImageDirectory();
  });

  afterEach(() => {
    images.cleanup();
  });

  it('lists only generated image files, with their modification time', async () => {
    const imageUrl = await images.save();
    writeFileSync(join(images.dir, 'holiday.png'), 'not ours');
    await images.age(imageUrl, 60 * 60 * 1000);

    const listed = await listStoredGeneratedImages();

    expect(listed.map((file) => `/images/${file.filename}`)).toEqual([imageUrl]);
    const ageMs = Date.now() - (listed[0]?.modifiedAtMs ?? Date.now());
    expect(ageMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
  });

  it('lists an images directory that does not exist yet as empty', async () => {
    images.cleanup();

    expect(await listStoredGeneratedImages()).toEqual([]);
  });

  it('deletes a stored file, tolerates one that is already gone, and refuses foreign names', async () => {
    const imageUrl = await images.save();
    const filename = generatedImageFilenameFromUrl(imageUrl) ?? '';
    writeFileSync(join(images.dir, 'holiday.png'), 'not ours');

    const results = {
      first: await deleteStoredGeneratedImage(filename),
      again: await deleteStoredGeneratedImage(filename),
      foreign: await deleteStoredGeneratedImage('holiday.png'),
    };

    expect({
      results,
      generatedExists: images.exists(imageUrl),
      foreignExists: existsSync(join(images.dir, 'holiday.png')),
    }).toEqual({
      results: { first: true, again: true, foreign: false },
      generatedExists: false,
      foreignExists: true,
    });
  });
});
